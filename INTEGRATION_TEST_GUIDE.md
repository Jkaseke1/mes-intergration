# Complete Integration Test Guide — Weigh Bridge to Sage Posting

## 🎯 Test Objective
Verify the complete flow from weigh bridge entry through to Sage Pastel posting with the corrected warehouse configuration (PD 19 → DEB 17).

---

## 📋 Pre-Test Checklist

### ✅ Before Starting:
- [ ] Bridge worker is running in VS Code
- [ ] `.env` has correct warehouse IDs (19, 17, 17)
- [ ] Supabase sync_log is clean (0 failed, 0 stuck)
- [ ] SSMS connected to `Hyperfeeds 2024 Live`
- [ ] HYPER-MES web app is open

### 📊 Monitoring Windows:
1. **VS Code Terminal** — Bridge worker console output
2. **SSMS Query Window** — Sage transaction verification
3. **HYPER-MES Browser** — Application interface

---

## 🚛 STEP 1: Weigh Bridge Entry (Goods Receipt)

### 1.1 Navigate to Goods Receipt
- Go to: **Inventory → Goods Receipt** (or Weigh Bridge module)
- Click: **+ New GRN** or **Create Goods Receipt**

### 1.2 Fill in GRN Form

| Field | Test Value | Notes |
|-------|------------|-------|
| **Supplier** | Select any supplier (e.g., "Soya Supplier") | Must exist in system |
| **Purchase Order** | Select existing PO or leave blank | Optional |
| **Delivery Note #** | `TEST-GRN-${timestamp}` | e.g., TEST-GRN-20260714 |
| **Delivery Date** | Today's date | Auto-filled |
| **Vehicle Reg** | `TEST-001` | Any format |
| **Driver Name** | `Test Driver` | Optional |

### 1.3 Add Line Items

**Line 1: Raw Material**
| Field | Test Value | Notes |
|-------|------------|-------|
| **Raw Material** | Select: `Solvent Soya` (or any RM with Sage code) | Must have sage_code |
| **Expected Qty** | `100` kg | From PO |
| **Actual Qty** | `100` kg | Weighed quantity |
| **Unit Price** | `1.50` | Per kg |
| **Batch/Lot #** | `LOT-TEST-001` | Optional |

**Optional: Add more lines if testing multiple items**

### 1.4 Confirm GRN
- Review totals
- Click: **Confirm GRN** or **Submit**
- Status should change to: `confirmed`

### 1.5 Monitor Bridge Worker (VS Code Terminal)
**Expected output within 30 seconds:**
```
[2026-07-14T11:25:00.000Z] Found 1 pending event(s)

Processing: grn_confirmed — goods_receipts — [uuid]
  → Event 1: Goods Receipt (Auto)
  GRN: TEST-GRN-20260714
  Solvent Soya: 100kg @ $1.50/kg
  [LIVE] ✅ Executed: GRN receipt: 100kg of [sage_code] into WhseID 18
  ✅ Sage posted: [sage_code] +100kg into WhseID 18 (RM)
  ✅ Supabase sage_stock_balances synced
  ✅ grn_confirmed processed successfully
```

### 1.6 Verify in Sage (SSMS)
```sql
USE [Hyperfeeds 2024 Live];
SELECT TOP 3 
  TxDate, 
  Reference, 
  Description,
  TrCode, 
  WarehouseCode, 
  QtyIn,
  DATEDIFF(SECOND, TxDate, GETDATE()) as seconds_ago
FROM _bvSTTransactionsFull
WHERE UserName = 'HYPER-MES'
ORDER BY TxDate DESC;
```

**Expected Result:**
| TxDate | Reference | TrCode | WarehouseCode | QtyIn | seconds_ago |
|--------|-----------|--------|---------------|-------|-------------|
| [now] | TEST-GRN-20260714 | GRV | RM | 100 | <60 |

✅ **PASS:** GRV posted to RM (18)  
❌ **FAIL:** No transaction or wrong warehouse

---

## 🏭 STEP 2: Create Production Order

### 2.1 Navigate to Production
- Go to: **Production → Production Orders**
- Click: **+ New Production Order**

### 2.2 Fill in Production Order Form

| Field | Test Value | Notes |
|-------|------------|-------|
| **Formulation** | Select: `Broiler Starter/Grower 50kg` | Must have sage_code |
| **Planned Quantity** | `100` kg | Target output |
| **Planned Start** | Today's date + time | Auto-filled |
| **Batch Number** | Auto-generated | e.g., BATCH-2026-818 |
| **Priority** | `Normal` | Optional |
| **Notes** | `Integration test batch` | Optional |

### 2.3 Review BOM (Bill of Materials)
The system should auto-populate ingredients based on formulation:

**Example BOM for 100kg batch:**
| Ingredient | Required Qty | Unit | Available Stock |
|------------|--------------|------|-----------------|
| Solvent Soya | 45 kg | kg | [check] |
| Maize Meal | 30 kg | kg | [check] |
| Limestone | 10 kg | kg | [check] |
| Premix | 5 kg | kg | [check] |
| ... | ... | ... | ... |

### 2.4 Start Production Order
- Click: **Start Production** or **Begin Batch**
- Status should change to: `in_progress`

---

## 📦 STEP 3: Issue Materials to Production

### 3.1 Navigate to Material Issue
- From the production order detail page
- Click: **Issue Materials** or **Draw Ingredients**

### 3.2 Issue Each Ingredient

**For each ingredient in the BOM:**

| Field | Test Value | Notes |
|-------|------------|-------|
| **Ingredient** | Auto-filled from BOM | e.g., Solvent Soya |
| **Required Qty** | Auto-filled | e.g., 45 kg |
| **Actual Qty Issued** | Same as required | e.g., 45 kg |
| **Lot Number** | Select available lot | From stock |
| **Issue Date/Time** | Now | Auto-filled |

**Repeat for all ingredients** or use **Issue All** button if available.

### 3.3 Confirm Material Issue
- Review total issued quantities
- Click: **Confirm Issue** or **Submit**

### 3.4 Monitor Bridge Worker (VS Code Terminal)
**Expected output within 30 seconds:**
```
[2026-07-14T11:30:00.000Z] Found 1 pending event(s)

Processing: materials_issued — production_orders — [uuid]
  → Event 2: Goods Issue (Auto)
  Batch: BATCH-2026-818
  Issuing 12 ingredients to production
  [LIVE] ✅ Executed: Issue: 45kg of [soya_code] from WhseID 18
  [LIVE] ✅ Executed: Issue: 30kg of [maize_code] from WhseID 18
  [LIVE] ✅ Executed: Issue: 10kg of [limestone_code] from WhseID 18
  ...
  ✅ materials_issued processed successfully
```

### 3.5 Verify in Sage (SSMS)
```sql
USE [Hyperfeeds 2024 Live];
SELECT TOP 15
  TxDate, 
  Reference, 
  Description,
  TrCode, 
  WarehouseCode, 
  QtyOut,
  DATEDIFF(SECOND, TxDate, GETDATE()) as seconds_ago
FROM _bvSTTransactionsFull
WHERE UserName = 'HYPER-MES'
  AND TrCode = 'MFDR'
ORDER BY TxDate DESC;
```

**Expected Result (multiple rows, one per ingredient):**
| TxDate | Reference | TrCode | WarehouseCode | QtyOut | seconds_ago |
|--------|-----------|--------|---------------|--------|-------------|
| [now] | WO-BATCH-2026-818 | MFDR | RM | -45 | <60 |
| [now] | WO-BATCH-2026-818 | MFDR | RM | -30 | <60 |
| [now] | WO-BATCH-2026-818 | MFDR | RM | -10 | <60 |
| ... | ... | ... | ... | ... | ... |

✅ **PASS:** MFDR transactions issued from RM (18)  
❌ **FAIL:** No transactions or wrong warehouse

---

## ⚙️ STEP 4: Complete Production (CRITICAL TEST)

### 4.1 Navigate to Production Order
- Go back to: **Production → Production Orders**
- Open: `BATCH-2026-818` (in_progress)

### 4.2 Fill in Completion Form

| Field | Test Value | Notes |
|-------|------------|-------|
| **Actual Quantity Produced** | `98` kg | Slightly less than planned (100kg) |
| **Rejected Quantity** | `2` kg | Optional — quality issues |
| **Net Good Quantity** | `96` kg | Auto-calculated (98 - 2) |
| **Actual End Date/Time** | Now | Auto-filled |
| **Production Notes** | `Integration test — all OK` | Optional |
| **Quality Check** | Pass | If required |

### 4.3 Complete the Batch
- Review all fields
- Click: **Complete Production** or **Finish Batch**
- Status should change to: `completed`

### 4.4 Monitor Bridge Worker (VS Code Terminal) ⭐ **CRITICAL**
**Expected output within 30 seconds:**
```
[2026-07-14T11:35:00.000Z] Found 1 pending event(s)

Processing: production_completed — production_orders — [uuid]
  → Event 3: Batch Complete (Auto)
  Batch: BATCH-2026-818
  Product: [sage_code] — 96kg net
  Cost: Solvent Soya @ $1.50/kg × 45kg = $67.50
  Cost: Maize Meal @ $1.20/kg × 30kg = $36.00
  ...
  Total material cost: $150.00 / 96kg = $1.5625/kg
  [LIVE] ✅ Executed: FG receipt + transfer to DEB: 96kg of [sage_code] into WhseID 19 then 17
  ✅ Sage posted: [sage_code] +96kg into WhseID 19
  ✅ Transferred 96kg from WhseID 19 to WhseID 17
  ✅ Supabase sage_stock_balances synced: [sage_code] → 96kg in WhseID 17
  ✅ Supabase sage_stock_balances synced: [sage_code] → 0kg in WhseID 19
  cost_per_unit saved to Supabase: $1.5625/kg
  ✅ production_completed processed successfully
```

**🚨 KEY INDICATORS:**
- ✅ `into WhseID 19 then 17` — confirms PD → DEB transfer
- ✅ `Transferred 96kg from WhseID 19 to WhseID 17` — transfer executed
- ✅ Two stock balance updates (PD and DEB)

### 4.5 Verify in Sage (SSMS) 🎯 **CRITICAL VERIFICATION**
```sql
USE [Hyperfeeds 2024 Live];
SELECT 
  TxDate, 
  Reference, 
  Description,
  TrCode, 
  WarehouseID,
  WarehouseCode, 
  QtyIn,
  QtyOut,
  DATEDIFF(SECOND, TxDate, GETDATE()) as seconds_ago
FROM _bvSTTransactionsFull
WHERE UserName = 'HYPER-MES'
  AND Reference = 'WO-BATCH-2026-818'
  AND TrCode IN ('MFMF', 'WHT')
ORDER BY TxDate ASC, AutoIdx ASC;
```

**Expected Result (3 rows in this exact order):**
| TxDate | Reference | TrCode | WarehouseID | WarehouseCode | QtyIn | QtyOut | seconds_ago |
|--------|-----------|--------|-------------|---------------|-------|--------|-------------|
| [now] | WO-BATCH-2026-818 | MFMF | **19** | **PD** | **96** | NULL | <60 |
| [now] | WO-BATCH-2026-818 | WHT | **19** | **PD** | NULL | **-96** | <60 |
| [now] | WO-BATCH-2026-818 | WHT | **17** | **DEB** | **96** | NULL | <60 |

**✅ PASS Criteria:**
1. Row 1: MFMF into **PD (19)** with +96kg
2. Row 2: WHT out of **PD (19)** with -96kg
3. Row 3: WHT into **DEB (17)** with +96kg
4. All 3 rows have same Reference and recent timestamp

**❌ FAIL Indicators:**
- Only 1 row (MFMF) = no transfer happened
- MFMF into **DSP (20)** = old config still active
- WHT into wrong warehouse = misconfiguration

### 4.6 Verify Stock Balances
```sql
USE [Hyperfeeds 2024 Live];
SELECT 
  w.Code as WarehouseCode,
  w.Description as WarehouseName,
  s.Code as ItemCode,
  sq.QtyOnHand
FROM _etblStockQtys sq
JOIN StkItem s ON sq.StockID = s.StockLink
JOIN Whsemst w ON sq.WhseID = w.WhseLink
WHERE s.Code = '[your_product_sage_code]'
  AND w.WhseLink IN (19, 17, 20)
ORDER BY w.WhseLink;
```

**Expected Result:**
| WarehouseCode | WarehouseName | ItemCode | QtyOnHand |
|---------------|---------------|----------|-----------|
| PD | Production | [code] | **0** or minimal |
| DEB | Debonairs | [code] | **96** (or accumulated) |
| DSP | Despatch | [code] | 1990 (old batch) |

✅ **PASS:** Stock is in DEB (17), PD (19) is empty  
❌ **FAIL:** Stock in DSP (20) or PD (19)

---

## 🚚 STEP 5: Dispatch to Branch

### 5.1 Navigate to Dispatch
- Go to: **Dispatch → Create Dispatch** or **Sales Orders**
- Click: **+ New Dispatch**

### 5.2 Fill in Dispatch Form

| Field | Test Value | Notes |
|-------|------------|-------|
| **Customer/Branch** | Select: `Glendale` (or any branch) | Must exist |
| **Delivery Date** | Today | Auto-filled |
| **Vehicle Reg** | `TEST-TRUCK-01` | Optional |
| **Driver** | `Test Driver` | Optional |
| **Dispatch Note #** | Auto-generated | e.g., DSP-2026-XXX |

### 5.3 Add Dispatch Line Items

| Field | Test Value | Notes |
|-------|------------|-------|
| **Product** | Select the product just manufactured | Same as batch output |
| **Quantity** | `50` kg | Less than available (96kg) |
| **Unit Price** | `5.00` | Selling price |
| **Source Warehouse** | Should auto-select `DEB` | Verify it's DEB (17) |

### 5.4 Confirm Dispatch
- Review totals
- Click: **Confirm Dispatch** or **Mark as Delivered**
- Status should change to: `delivered`

### 5.5 Monitor Bridge Worker (VS Code Terminal)
**Expected output within 30 seconds:**
```
[2026-07-14T11:40:00.000Z] Found 1 pending event(s)

Processing: dispatch_delivered — dispatches — [uuid]
  → Event 4: Dispatch (Auto)
  Dispatch: DSP-2026-XXX to Glendale
  [LIVE] ✅ Executed: Dispatch: 50kg of [sage_code] from WhseID 17 to WhseID 36
  ✅ Sage posted: [sage_code] -50kg from WhseID 17 (DEB)
  ✅ Sage posted: [sage_code] +50kg into WhseID 36 (GLE)
  ✅ Supabase sage_stock_balances synced
  ✅ dispatch_delivered processed successfully
```

### 5.6 Verify in Sage (SSMS)
```sql
USE [Hyperfeeds 2024 Live];
SELECT TOP 5
  TxDate, 
  Reference, 
  Description,
  TrCode, 
  WarehouseID,
  WarehouseCode, 
  QtyIn,
  QtyOut,
  DATEDIFF(SECOND, TxDate, GETDATE()) as seconds_ago
FROM _bvSTTransactionsFull
WHERE UserName = 'HYPER-MES'
  AND TrCode = 'WHT'
ORDER BY TxDate DESC;
```

**Expected Result (2 rows for dispatch):**
| TxDate | Reference | TrCode | WarehouseID | WarehouseCode | QtyIn | QtyOut | seconds_ago |
|--------|-----------|--------|-------------|---------------|-------|--------|-------------|
| [now] | DSP-2026-XXX | WHT | **36** | **GLE** | **50** | NULL | <60 |
| [now] | DSP-2026-XXX | WHT | **17** | **DEB** | NULL | **-50** | <60 |

✅ **PASS:** WHT out of DEB (17), WHT into GLE (36)  
❌ **FAIL:** WHT from DSP (20) instead of DEB (17)

---

## 📊 FINAL VERIFICATION — Complete Flow Summary

### Run Complete Flow Query in SSMS:
```sql
USE [Hyperfeeds 2024 Live];

-- All transactions for this test session
SELECT 
  TxDate,
  Reference,
  Description,
  TrCode,
  WarehouseID,
  WarehouseCode,
  WarehouseName,
  QtyIn,
  QtyOut,
  UserName
FROM _bvSTTransactionsFull
WHERE UserName = 'HYPER-MES'
  AND TxDate >= DATEADD(HOUR, -1, GETDATE())
ORDER BY TxDate ASC, AutoIdx ASC;
```

### Expected Complete Flow:
| Step | TrCode | Warehouse | Description |
|------|--------|-----------|-------------|
| 1 | GRV | RM (18) | GRN receipt |
| 2 | MFDR | RM (18) | Material issues (multiple rows) |
| 3a | MFMF | **PD (19)** | FG production receipt ✅ |
| 3b | WHT | **PD (19)** | Transfer out ✅ |
| 3c | WHT | **DEB (17)** | Transfer in ✅ |
| 4a | WHT | **DEB (17)** | Dispatch out ✅ |
| 4b | WHT | GLE (36) | Dispatch in ✅ |

---

## ✅ Success Criteria Summary

| Test | Expected Result | Pass/Fail |
|------|-----------------|-----------|
| **GRN** | GRV into RM (18) | ⬜ |
| **Material Issue** | MFDR out of RM (18) | ⬜ |
| **Production Receipt** | MFMF into **PD (19)** | ⬜ |
| **PD → DEB Transfer** | 2 WHT legs (19 → 17) | ⬜ |
| **Dispatch** | WHT from **DEB (17)** to branch | ⬜ |
| **Stock Balance** | FG in DEB (17), not DSP (20) | ⬜ |

**🎯 Integration test is SUCCESSFUL if all boxes are checked!**

---

## 🐛 Troubleshooting

### Bridge Not Processing Events
**Symptoms:** No output in VS Code terminal after 30+ seconds

**Check:**
1. Bridge worker is running: Look for "Polling for pending events" message
2. Supabase connection: Check for connection errors in terminal
3. Pending events exist: Run `SELECT * FROM sync_log WHERE status = 'pending'`

**Fix:** Restart bridge worker

---

### Wrong Warehouse in Sage
**Symptoms:** MFMF into DSP (20) instead of PD (19)

**Check:**
1. `.env` file has `SAGE_FG_WAREHOUSE_ID=19`
2. Bridge worker was restarted after `.env` change
3. No cached config in memory

**Fix:** 
1. Verify `.env` settings
2. Restart bridge worker
3. Retry production completion

---

### No Transfer Happening
**Symptoms:** Only MFMF transaction, no WHT legs

**Check:**
1. `.env` has `SAGE_FG_TRANSFER_WAREHOUSE_ID=17`
2. Transfer warehouse ID is different from FG warehouse ID
3. Bridge logs show "transfer to DEB" message

**Fix:**
1. Set `SAGE_FG_TRANSFER_WAREHOUSE_ID=17` in `.env`
2. Restart bridge worker
3. Retry production completion

---

### Events Stuck in Processing
**Symptoms:** Event status = 'processing' for >5 minutes

**Check:**
1. Bridge worker crashed: Look for error in terminal
2. Database connection lost
3. Sage connection failed

**Fix:**
1. Check error details in sync_log
2. Restart bridge worker
3. Reset stuck events: `UPDATE sync_log SET status = 'pending' WHERE status = 'processing' AND updated_at < NOW() - INTERVAL '10 minutes'`

---

## 📝 Test Results Template

```
=== INTEGRATION TEST RESULTS ===
Date: 2026-07-14
Tester: [Your Name]
Environment: HYPER MES → Hyperfeeds 2024 Live

STEP 1 - GRN:
✅ Bridge processed: grn_confirmed
✅ Sage posted: GRV into RM (18)
Reference: TEST-GRN-20260714

STEP 2 - Material Issue:
✅ Bridge processed: materials_issued
✅ Sage posted: MFDR from RM (18) - 12 ingredients
Reference: WO-BATCH-2026-818

STEP 3 - Production Completion:
✅ Bridge processed: production_completed
✅ Sage posted: MFMF into PD (19) - 96kg
✅ Sage posted: WHT from PD (19) - 96kg
✅ Sage posted: WHT into DEB (17) - 96kg
Reference: WO-BATCH-2026-818
⭐ CRITICAL TEST PASSED: PD → DEB flow working!

STEP 4 - Dispatch:
✅ Bridge processed: dispatch_delivered
✅ Sage posted: WHT from DEB (17) - 50kg
✅ Sage posted: WHT into GLE (36) - 50kg
Reference: DSP-2026-XXX

FINAL RESULT: ✅ ALL TESTS PASSED
Configuration fix confirmed working.
Historical flow (PD → DEB) restored.
```

---

## 🎉 Next Steps After Successful Test

1. **Document the test results** — Save SSMS query outputs
2. **Notify finance team** — Confirm Sage reports will show correct warehouses
3. **Monitor production** — Watch first few real batches to ensure stability
4. **Update documentation** — Mark warehouse config as verified
5. **Archive old DSP (20) stock** — Decide how to handle BATCH-2026-817

---

**Ready to begin? Start with STEP 1 (GRN) and work through each step, pasting VS Code terminal output and SSMS results as you go!** 🚀
