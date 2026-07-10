# Bridge Integration Fixes Applied

## Date: June 29, 2026

## Issues Fixed

### 1. ✅ Added `safeWrite` Wrapper to goodsReceiptAuto.js
**Problem:** GRN handler wasn't respecting `DRY_RUN` mode properly after initial check.

**Fix:** Wrapped all Sage write operations (journal line, QtyOnHand update, cost update) in `safeWrite()` function.

**Impact:** Now properly logs operations in DRY_RUN mode without writing to Sage.

---

### 2. ✅ Added Negative Stock Validation to goodsIssueAuto.js
**Problem:** No check to prevent issuing more material than available in warehouse.

**Fix:** Added stock check before issuing:
```javascript
const stockCheck = await pool.request()
  .input('StockID', sql.Int, stockLink)
  .input('WhseID',  sql.Int, 18)
  .query(`SELECT QtyOnHand FROM _etblStockQtys WHERE StockID = @StockID AND WhseID = @WhseID`);

const currentStock = stockCheck.recordset.length > 0 ? stockCheck.recordset[0].QtyOnHand : 0;

if (currentStock < actualQty) {
  throw new Error(`Insufficient stock: ${sageCode} has ${currentStock}kg but ${actualQty}kg requested`);
}
```

**Impact:** Prevents negative stock in Sage RM warehouse (WhseID=18).

---

### 3. ✅ Added Negative Stock Validation to dispatchAuto.js
**Problem:** No check to prevent dispatching more FG than available in DSP warehouse.

**Fix:** Added stock check before dispatching:
```javascript
const stockCheck = await pool.request()
  .input('StockID', sql.Int, stockLink)
  .input('WhseID',  sql.Int, 20)
  .query(`SELECT QtyOnHand FROM _etblStockQtys WHERE StockID = @StockID AND WhseID = @WhseID`);

const currentStock = stockCheck.recordset.length > 0 ? stockCheck.recordset[0].QtyOnHand : 0;

if (currentStock < qty) {
  throw new Error(`Insufficient stock in DSP: ${sageCode} has ${currentStock}kg but ${qty}kg requested`);
}
```

**Impact:** Prevents negative stock in Sage DSP warehouse (WhseID=20).

---

## Files Modified

1. `C:\Users\Joseph Kaseke\CascadeProjects\hyper-integration\events\goodsReceiptAuto.js`
2. `C:\Users\Joseph Kaseke\CascadeProjects\hyper-integration\events\goodsIssueAuto.js`
3. `C:\Users\Joseph Kaseke\CascadeProjects\hyper-integration\events\dispatchAuto.js`

---

## Testing Checklist

- [ ] Test Event 1 (GRN) in DRY_RUN mode — verify logs show operations but no Sage writes
- [ ] Test Event 2 (Material Issue) with insufficient stock — verify error thrown
- [ ] Test Event 4 (Dispatch) with insufficient DSP stock — verify error thrown
- [ ] Test all events with DRY_RUN=false on test database
- [ ] Verify no duplicate entries in Sage
- [ ] Verify stock quantities match between MES and Sage

---

## Next Steps

1. Run bridge worker with `DRY_RUN=true` and test all 7 events
2. Review logs to verify correctness
3. Set `DRY_RUN=false` and test on test database
4. Proceed with full end-to-end testing per BRIDGE_TESTING_GUIDE.md
