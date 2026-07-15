# Warehouse Configuration Checklist — Option 1 (Historical PD→DEB Flow)

## Issue Found
The last production completion (`BATCH-2026-817` on 2026-07-13) posted **1990kg** into **WarehouseID 20 (DSP)** instead of the expected historical flow:
- **PD (19)** for FG manufacturing receipt
- **DEB (17)** for FG transfer and dispatch source

This indicates the `.env` file had incorrect warehouse IDs at the time of posting.

---

## Required `.env` Configuration (Option 1)

To match the **historical Sage flow** verified in your data, your `.env` file **must** contain:

```env
# FG completion warehouse (WhseLink in WhseMst)
# Production = 19 (PD). Finance confirmed FG is manufactured in PD.
SAGE_FG_WAREHOUSE_ID=19

# Optional FG transfer warehouse (WhseLink in WhseMst)
# If different from SAGE_FG_WAREHOUSE_ID, a WHT transfer is posted after FG receipt.
# Finance confirmed FG is moved from PD to DEB (17) before dispatch.
SAGE_FG_TRANSFER_WAREHOUSE_ID=17

# Dispatch source warehouse (WhseLink in WhseMst)
# Finance confirmed dispatch picks from DEB (17).
SAGE_DISPATCH_SOURCE_WAREHOUSE_ID=17
```

---

## What This Configuration Does

### On Production Completion (`production_completed` event):
1. **MFMF** (Manufacturing Manufacture) transaction posts `+netQty` into **WhseID 19 (PD)**
2. **WHT** (Warehouse Transfer) pair automatically posts:
   - `-netQty` out of **WhseID 19 (PD)**
   - `+netQty` into **WhseID 17 (DEB)**

### On Dispatch (`dispatch_delivered` event):
1. **WHT** (Warehouse Transfer) pair posts:
   - `-qty` out of **WhseID 17 (DEB)**
   - `+qty` into destination branch warehouse (e.g., GLE, SHO, MAK)

---

## Verification Steps

### Step 1: Check your `.env` file
Open `c:\Users\Joseph Kaseke\CascadeProjects\hyper-integration\.env` and verify:
- [ ] `SAGE_FG_WAREHOUSE_ID=19`
- [ ] `SAGE_FG_TRANSFER_WAREHOUSE_ID=17`
- [ ] `SAGE_DISPATCH_SOURCE_WAREHOUSE_ID=17`
- [ ] `DRY_RUN=false` (or unset/commented out)

**IMPORTANT:** If any of these are set to `20` or other values, update them to match above.

### Step 2: Restart the bridge worker
After updating `.env`, restart the integration service to load the new configuration:
```powershell
# If running as a service, restart it
# If running manually, stop and restart node events/bridgeworker.js
```

### Step 3: Test with a new production completion
Complete a new production batch in HYPER-MES and verify the Sage posting:

Run this SQL in SSMS against `Hyperfeeds 2024 Live`:
```sql
-- Check the most recent HYPER-MES production posting
SELECT TOP 5
  TxDate,
  Reference,
  Description,
  TrCode,
  WarehouseID,
  WarehouseCode,
  WarehouseName,
  QtyIn,
  QtyOut
FROM _bvSTTransactionsFull
WHERE UserName = 'HYPER-MES'
  AND TrCode IN ('MFMF', 'WHT')
ORDER BY TxDate DESC, AutoIdx DESC;
```

**Expected result for a new batch (e.g., `WO-BATCH-2026-XXX`):**
| TxDate | Reference | TrCode | WarehouseID | WarehouseCode | QtyIn | QtyOut |
|--------|-----------|--------|-------------|---------------|-------|--------|
| [timestamp] | WO-BATCH-2026-XXX | WHT | 17 | DEB | [qty] | NULL |
| [timestamp] | WO-BATCH-2026-XXX | WHT | 19 | PD | NULL | -[qty] |
| [timestamp] | WO-BATCH-2026-XXX | MFMF | 19 | PD | [qty] | NULL |

This shows:
1. FG manufactured into PD (19)
2. Transferred out of PD (19)
3. Transferred into DEB (17)

---

## Sage Pastel Report Visibility

With this configuration, production completions will appear in:

### Inventory Reports
- **Inventory → Stock Movement Report**
  - Filter by Warehouse: `PD` or `DEB`
  - Filter by Transaction Type: `MFMF` (manufacturing) or `WHT` (transfer)
  - Filter by User: `HYPER-MES`

- **Inventory → Warehouse Transfer Report**
  - Shows the PD→DEB transfer legs
  - Reference format: `WO-BATCH-2026-XXX`

### GL Reports
- **General Ledger → Trial Balance**
  - WIP account will show debits/credits from `MFMF` transactions
  - COGS account will show debits/credits from `WHT` transfers

### Stock Queries
- **Inventory → Stock Query**
  - Check `PD` warehouse: Should show 0 or minimal FG stock (transferred out immediately)
  - Check `DEB` warehouse: Should show accumulated FG stock ready for dispatch

---

## Historical Flow Confirmation

Your historical data query confirmed this exact pattern:
- **GRN → RM (18)**: `GRV` transactions
- **RM → PD (19)**: `MFDR` raw material issues
- **FG in PD (19)**: `MFMF` manufacturing receipts
- **PD → DEB (17)**: `WHT` transfer pairs
- **DEB → Branches**: `WHT` dispatch pairs

The configuration above reproduces this flow exactly.

---

## Troubleshooting

### If the next batch still posts to DSP (20):
1. Verify `.env` file is in the correct location: `c:\Users\Joseph Kaseke\CascadeProjects\hyper-integration\.env`
2. Check for typos in variable names (must match exactly)
3. Ensure no trailing spaces or quotes around the values
4. Restart the bridge worker after changes
5. Check the bridge worker console logs for the loaded config values

### If no transfer occurs (only MFMF, no WHT):
- Verify `SAGE_FG_TRANSFER_WAREHOUSE_ID` is set to `17` (not `19`, not empty)
- The code checks: `doTransfer = FG_TRANSFER_WAREHOUSE_ID && FG_TRANSFER_WAREHOUSE_ID !== FG_WAREHOUSE_ID`
- If both are `19`, no transfer will occur

---

## Summary

✅ **Correct configuration:** `SAGE_FG_WAREHOUSE_ID=19`, `SAGE_FG_TRANSFER_WAREHOUSE_ID=17`, `SAGE_DISPATCH_SOURCE_WAREHOUSE_ID=17`

✅ **Expected posting:** MFMF into PD (19) → WHT transfer to DEB (17) → WHT dispatch from DEB (17)

✅ **Matches historical flow:** Verified via SQL queries against `_bvSTTransactionsFull`

✅ **Visible in Sage reports:** All transactions post live via `PostInventoryTxV2` stored procedure
