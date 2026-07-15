# HYPER MES Integration Test — Actual Form Fields

## 🎯 Complete Flow: Weigh Bridge → GRN → Production → Dispatch

Based on your actual HYPER MES forms, here's the exact step-by-step guide with real field names.

---

## 📋 Pre-Test Setup

### ✅ Verify Before Starting:
1. **Bridge Worker Running** — Check VS Code terminal shows: `Polling for pending events`
2. **`.env` Configured** — `SAGE_FG_WAREHOUSE_ID=19`, `SAGE_FG_TRANSFER_WAREHOUSE_ID=17`
3. **Supabase Clean** — No failed/stuck events
4. **SSMS Ready** — Connected to `Hyperfeeds 2024 Live`

---

## 🚛 STEP 1: Create GRN (Goods Received Note)

### 1.1 Navigate
- Go to: **Inventory → Goods Received Notes**
- Click: **+ New GRN** button (top right)

### 1.2 Fill Header Section

| Field Label | Field Name | Test Value | Notes |
|-------------|------------|------------|-------|
| **Supplier*** | `supplier_id` | Select any active supplier | Dropdown — must exist |
| **Received Date*** | `received_date` | Today's date | Auto-filled, can change |
| **Weigh Bridge Ticket** | `weigh_bridge_ticket_id` | Leave blank or select | Optional — links to WB ticket |
| **Notes** | `notes` | `Integration test GRN` | Optional text area |

### 1.3 Add Line Items

Click **+ Add Item** button, then fill:

**Line Item 1:**
| Field Label | Field Name | Test Value | Notes |
|-------------|------------|------------|-------|
| **Raw Material*** | `raw_material_id` | Select: `Solvent Soya` | Must have `sage_code` |
| **Ordered Qty** | `ordered_qty` | `100` | From PO (optional) |
| **Received Qty*** | `received_qty` | `100` | Actual weighed qty |
| **Unit Cost** | `unit_cost` | `1.50` | Per kg |
| **Batch Number** | `batch_number` | `LOT-TEST-001` | Optional |
| **Expiry Date** | `expiry_date` | Leave blank | Optional |

### 1.4 Save GRN
- Click: **Create GRN** button (bottom right)
- Status will be: `pending`
- GRN Number auto-generated: `GRN-2026-XXX`

### 1.5 Approve GRN (Required for Sage Posting!)
- **IMPORTANT:** The GRN must be **approved** before it posts to Sage
- In the GRN list, find your new GRN
- Click **View** button
- Click **Approve** button (if you have approval rights)
- Status changes to: `approved` or `confirmed`

### 1.6 Monitor Bridge Worker
**Watch VS Code terminal (within 30 seconds):**
```
[timestamp] Found 1 pending event(s)

Processing: grn_confirmed — goods_receipts — [uuid]
  → Event 1: Goods Receipt (Auto)
  GRN: GRN-2026-XXX
  Solvent Soya: 100kg @ $1.50/kg
  [LIVE] ✅ Executed: GRN receipt: 100kg of [sage_code] into WhseID 18
  ✅ Sage posted: [sage_code] +100kg into WhseID 18 (RM)
  ✅ grn_confirmed processed successfully
```

### 1.7 Verify in Sage (SSMS)
```sql
USE [Hyperfeeds 2024 Live];
SELECT TOP 3 TxDate, Reference, TrCode, WarehouseCode, QtyIn, 
  DATEDIFF(SECOND, TxDate, GETDATE()) as seconds_ago
FROM _bvSTTransactionsFull
WHERE UserName = 'HYPER-MES'
ORDER BY TxDate DESC;
```

**✅ Expected:** `GRV` into `RM` with recent timestamp

---

## 🏭 STEP 2: Create Production Order

### 2.1 Navigate
- Go to: **Production → Production Orders**
- Click: **+ New Order** button (top right)

### 2.2 Fill Production Order Form

| Field Label | Field Name | Test Value | Notes |
|-------------|------------|------------|-------|
| **Batch Number** | `batch_number` | Auto-generated | e.g., `BATCH-2026-818` |
| **Production Plan** | `plan_id` | Leave blank | Optional |
| **Formulation*** | `formulation_id` | Select: `Broiler Starter/Grower 50kg` | Must have `sage_code` |
| **Production Line*** | `machine_id` | Select: `Main Plant` | **REQUIRED** |
| **Planned Quantity*** | `planned_qty` | `100` | In kg |
| **Unit** | `unit` | `kg` | Auto-filled |
| **Unit Size** | `unit_size` | `50` | Auto-filled from formulation |
| **Priority** | `priority` | `Normal` | Dropdown |
| **Planned Start** | `planned_start` | Today + time | Optional |
| **Planned End** | `planned_end` | Leave blank | Optional |
| **Operator** | `operator_id` | Select any | Optional |
| **Shift** | `shift` | `Day Shift` | Dropdown |
| **Operators** | `operators` | Leave blank | Optional text |
| **Labour Force** | `labour_force` | Leave blank | Optional number |
| **Week Number** | `week_number` | Leave blank | Optional |
| **Notes** | `notes` | `Integration test batch` | Optional |

### 2.3 Review BOM Preview
- After selecting formulation, BOM ingredients auto-load
- **Verify:** BOM preview table shows all ingredients with percentages
- **Check:** No error message about missing BOM

### 2.4 Create Order
- Click: **Create Order** button (bottom right)
- Status will be: `pending`
- Order appears in the list

---

## 📦 STEP 3: Issue Materials to Production

### 3.1 Open Production Order
- In Production Orders list, find `BATCH-2026-818`
- Click on the batch number to open detail view

### 3.2 Navigate to Materials Tab
- Click: **Materials** tab (if not already selected)
- You'll see the BOM ingredients list with `planned_qty` for each

### 3.3 Issue Materials
**Option A: Issue All at Once**
- Click: **Issue All Materials** button (if available)
- Confirms all ingredients at planned quantities

**Option B: Issue Individual Ingredients**
- For each ingredient row:
  - Enter `actual_qty` (same as `planned_qty` for this test)
  - Click **Issue** button for that row
- Repeat for all ingredients

### 3.4 Confirm Issue
- After issuing all materials, status changes to: `materials_issued`

### 3.5 Monitor Bridge Worker
**Watch VS Code terminal:**
```
[timestamp] Found 1 pending event(s)

Processing: materials_issued — production_orders — [uuid]
  → Event 2: Goods Issue (Auto)
  Batch: BATCH-2026-818
  Issuing 12 ingredients to production
  [LIVE] ✅ Executed: Issue: 45kg of [soya_code] from WhseID 18
  [LIVE] ✅ Executed: Issue: 30kg of [maize_code] from WhseID 18
  ...
  ✅ materials_issued processed successfully
```

### 3.6 Verify in Sage (SSMS)
```sql
SELECT TOP 15 TxDate, Reference, TrCode, WarehouseCode, QtyOut,
  DATEDIFF(SECOND, TxDate, GETDATE()) as seconds_ago
FROM _bvSTTransactionsFull
WHERE UserName = 'HYPER-MES' AND TrCode = 'MFDR'
ORDER BY TxDate DESC;
```

**✅ Expected:** Multiple `MFDR` rows from `RM`, one per ingredient

---

## ⚙️ STEP 4: Complete Production (CRITICAL TEST)

### 4.1 Start Production (if required)
- In the production order detail view
- If there's a **Start Production** button, click it
- Status changes to: `in_progress`

### 4.2 Navigate to Output Tab
- Click: **Output** tab in the detail view

### 4.3 Fill Completion Form

| Field Label | Field Name | Test Value | Notes |
|-------------|------------|------------|-------|
| **Actual Quantity Produced** | `actual_qty` | `98` | Slightly less than planned (100kg) |
| **Rejected Quantity** | `rejected_qty` | `2` | Quality issues |
| **Wastage Quantity** | `wastage_qty` | `0` | Optional |
| **Actual Hours** | `actual_hours` | Leave blank or enter | Optional |
| **Average Throughput** | `average_throughput` | Auto-calculated | Read-only |

**Net Good Quantity = 98 - 2 = 96kg** (auto-calculated)

### 4.4 Complete the Batch
- Click: **Complete Production** or **Finish Batch** button
- Confirm in any dialog that appears
- Status changes to: `completed`

### 4.5 Monitor Bridge Worker ⭐ **CRITICAL**
**Watch VS Code terminal:**
```
[timestamp] Found 1 pending event(s)

Processing: production_completed — production_orders — [uuid]
  → Event 3: Batch Complete (Auto)
  Batch: BATCH-2026-818
  Product: [sage_code] — 96kg net
  Cost: Solvent Soya @ $1.50/kg × 45kg = $67.50
  ...
  Total material cost: $150.00 / 96kg = $1.5625/kg
  [LIVE] ✅ Executed: FG receipt + transfer to DEB: 96kg of [sage_code] into WhseID 19 then 17
  ✅ Sage posted: [sage_code] +96kg into WhseID 19
  ✅ Transferred 96kg from WhseID 19 to WhseID 17
  ✅ Supabase sage_stock_balances synced: [sage_code] → 96kg in WhseID 17
  ✅ production_completed processed successfully
```

**🚨 KEY SUCCESS INDICATORS:**
- ✅ `into WhseID 19 then 17` — PD → DEB transfer
- ✅ `Transferred 96kg from WhseID 19 to WhseID 17`
- ✅ Two stock balance updates

### 4.6 Verify in Sage (SSMS) 🎯 **CRITICAL**
```sql
USE [Hyperfeeds 2024 Live];
SELECT TxDate, Reference, TrCode, WarehouseID, WarehouseCode, QtyIn, QtyOut,
  DATEDIFF(SECOND, TxDate, GETDATE()) as seconds_ago
FROM _bvSTTransactionsFull
WHERE UserName = 'HYPER-MES'
  AND Reference = 'WO-BATCH-2026-818'
  AND TrCode IN ('MFMF', 'WHT')
ORDER BY TxDate ASC, AutoIdx ASC;
```

**✅ EXPECTED RESULT (3 rows):**
| TxDate | Reference | TrCode | WarehouseID | WarehouseCode | QtyIn | QtyOut |
|--------|-----------|--------|-------------|---------------|-------|--------|
| [now] | WO-BATCH-2026-818 | MFMF | **19** | **PD** | **96** | NULL |
| [now] | WO-BATCH-2026-818 | WHT | **19** | **PD** | NULL | **-96** |
| [now] | WO-BATCH-2026-818 | WHT | **17** | **DEB** | **96** | NULL |

**✅ PASS:** All 3 rows present, correct warehouses (PD 19 → DEB 17)  
**❌ FAIL:** Only 1 row, or MFMF into DSP (20)

---

## 🚚 STEP 5: Create Dispatch

### 5.1 Navigate
- Go to: **Dispatch → Dispatch Orders**
- Click: **+ New Dispatch** button (top right)

### 5.2 Fill Dispatch Header

| Field Label | Field Name | Test Value | Notes |
|-------------|------------|------------|-------|
| **Branch/Customer*** | `branch_id` | Select: `Glendale` | Any active branch |
| **Source Warehouse*** | `warehouse_id` | Should auto-select `DSP` | **Should be DEB after fix** |
| **Dispatch Date*** | `dispatch_date` | Today | Auto-filled |
| **Vehicle Number** | `vehicle_number` | `TEST-TRUCK-01` | Optional |
| **Driver Name** | `driver_name` | `Test Driver` | Optional |
| **Delivery Notes** | `delivery_notes` | `Integration test dispatch` | Optional |

### 5.3 Add Dispatch Items

Click **+ Add Item**, then fill:

| Field Label | Field Name | Test Value | Notes |
|-------------|------------|------------|-------|
| **Product*** | `formulation_id` | Select the product you just made | Same as batch |
| **Batch Number** | `batch_number` | Select from dropdown | Shows available batches |
| **Quantity*** | `quantity` | `50` | Less than available (96kg) |
| **Unit** | `unit` | `kg` | Auto-filled |
| **Unit Price** | `unit_price` | `5.00` | Selling price |

### 5.4 Create Dispatch
- Click: **Create Dispatch** button
- Status will be: `pending`

### 5.5 Mark as Delivered
- In dispatch list, find your dispatch
- Click **View** or open detail
- Click: **Mark as Delivered** or **Deliver** button
- Status changes to: `delivered`

### 5.6 Monitor Bridge Worker
**Watch VS Code terminal:**
```
[timestamp] Found 1 pending event(s)

Processing: dispatch_delivered — dispatches — [uuid]
  → Event 4: Dispatch (Auto)
  Dispatch: DSP-2026-XXX to Glendale
  [LIVE] ✅ Executed: Dispatch: 50kg of [sage_code] from WhseID 17 to WhseID 36
  ✅ Sage posted: [sage_code] -50kg from WhseID 17 (DEB)
  ✅ Sage posted: [sage_code] +50kg into WhseID 36 (GLE)
  ✅ dispatch_delivered processed successfully
```

**🚨 KEY:** Should say `from WhseID 17` (DEB), not 20 (DSP)

### 5.7 Verify in Sage (SSMS)
```sql
SELECT TOP 5 TxDate, Reference, TrCode, WarehouseID, WarehouseCode, QtyIn, QtyOut,
  DATEDIFF(SECOND, TxDate, GETDATE()) as seconds_ago
FROM _bvSTTransactionsFull
WHERE UserName = 'HYPER-MES' AND TrCode = 'WHT'
ORDER BY TxDate DESC;
```

**✅ Expected (2 rows):**
| TxDate | Reference | TrCode | WarehouseID | WarehouseCode | QtyIn | QtyOut |
|--------|-----------|--------|-------------|---------------|-------|--------|
| [now] | DSP-2026-XXX | WHT | **36** | **GLE** | **50** | NULL |
| [now] | DSP-2026-XXX | WHT | **17** | **DEB** | NULL | **-50** |

**✅ PASS:** Dispatch from DEB (17) to GLE (36)  
**❌ FAIL:** Dispatch from DSP (20)

---

## 📊 FINAL VERIFICATION

### Complete Flow Query (SSMS)
```sql
USE [Hyperfeeds 2024 Live];

-- All transactions for this test session
SELECT 
  TxDate,
  Reference,
  TrCode,
  WarehouseID,
  WarehouseCode,
  QtyIn,
  QtyOut
FROM _bvSTTransactionsFull
WHERE UserName = 'HYPER-MES'
  AND TxDate >= DATEADD(HOUR, -1, GETDATE())
ORDER BY TxDate ASC, AutoIdx ASC;
```

### Expected Complete Flow:
| Step | TrCode | Warehouse | QtyIn | QtyOut | Description |
|------|--------|-----------|-------|--------|-------------|
| 1 | GRV | RM (18) | 100 | - | GRN receipt |
| 2a | MFDR | RM (18) | - | -45 | Soya issue |
| 2b | MFDR | RM (18) | - | -30 | Maize issue |
| 2c | MFDR | RM (18) | - | ... | Other ingredients |
| 3a | MFMF | **PD (19)** | **96** | - | FG production ✅ |
| 3b | WHT | **PD (19)** | - | **-96** | Transfer out ✅ |
| 3c | WHT | **DEB (17)** | **96** | - | Transfer in ✅ |
| 4a | WHT | **DEB (17)** | - | **-50** | Dispatch out ✅ |
| 4b | WHT | GLE (36) | **50** | - | Dispatch in ✅ |

---

## ✅ Success Checklist

| Test | Expected | Status |
|------|----------|--------|
| **GRN Posted** | GRV into RM (18) | ⬜ |
| **Materials Issued** | MFDR from RM (18) | ⬜ |
| **FG Receipt** | MFMF into **PD (19)** | ⬜ |
| **PD → DEB Transfer** | 2 WHT legs (19 → 17) | ⬜ |
| **Stock in DEB** | FG balance in DEB (17) | ⬜ |
| **Dispatch from DEB** | WHT from **DEB (17)** | ⬜ |
| **All Timestamps Recent** | < 60 seconds ago | ⬜ |

**🎯 Test is SUCCESSFUL if all boxes checked!**

---

## 🐛 Common Issues

### Issue: GRN doesn't post to Sage
**Cause:** GRN not approved  
**Fix:** Approve the GRN in HYPER MES first

### Issue: Production posts to DSP (20) instead of PD (19)
**Cause:** Old `.env` config or bridge not restarted  
**Fix:** Verify `.env` has `SAGE_FG_WAREHOUSE_ID=19`, restart bridge

### Issue: No transfer (only MFMF, no WHT)
**Cause:** Transfer warehouse not configured  
**Fix:** Set `SAGE_FG_TRANSFER_WAREHOUSE_ID=17` in `.env`

### Issue: Dispatch from DSP (20) instead of DEB (17)
**Cause:** Old config  
**Fix:** Set `SAGE_DISPATCH_SOURCE_WAREHOUSE_ID=17` in `.env`

---

## 📝 Test Results Template

```
=== HYPER MES INTEGRATION TEST ===
Date: 2026-07-14
Tester: [Your Name]

STEP 1 - GRN:
✅ Created: GRN-2026-XXX
✅ Approved: Yes
✅ Bridge posted: GRV into RM (18)
✅ Sage verified: 100kg Solvent Soya

STEP 2 - Material Issue:
✅ Batch: BATCH-2026-818
✅ Bridge posted: 12 MFDR transactions
✅ Sage verified: All ingredients issued from RM

STEP 3 - Production Completion:
✅ Completed: 96kg net (98 - 2 rejected)
✅ Bridge posted: MFMF + 2 WHT
✅ Sage verified: PD (19) → DEB (17) ⭐
✅ Stock balance: 96kg in DEB (17)

STEP 4 - Dispatch:
✅ Created: DSP-2026-XXX to Glendale
✅ Delivered: 50kg
✅ Bridge posted: WHT from DEB (17)
✅ Sage verified: DEB → GLE transfer

FINAL RESULT: ✅ ALL TESTS PASSED
Configuration fix confirmed working!
PD (19) → DEB (17) flow restored!
```

---

**Ready to start? Begin with STEP 1 (GRN) and paste VS Code terminal output + SSMS results after each step!** 🚀
