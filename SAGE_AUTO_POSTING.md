# Sage Auto-Posting Implementation

## Overview
The bridge worker now posts inventory movements directly to Sage Pastel 200 Evolution using a stored procedure (`PostInventoryTxV2`) instead of writing to unposted journal batches.

This fixes the issue where stock was updated manually but the journal batch lines were left unposted, causing reporting discrepancies and potential double-counting.

## Files changed
- `events/lib/sagePost.js` — new helper that calls the stored procedure
- `events/goodsReceiptAuto.js` — GRN now posts directly
- `events/goodsIssueAuto.js` — material issue now posts directly
- `events/batchCompleteAuto.js` — production completion now posts directly
- `events/dispatchAuto.js` — dispatch transfer now posts directly (both legs)
- `events/reconVarianceAuto.js` — reconciliation variance now posts directly
- `events/macroPackCompleteAuto.js` — macropack issue/receipt now posts directly
- `sql/PostInventoryTxV2.sql` — stored procedure to create in Sage
- `sql/fix_unposted_batch_lines.sql` — script to remove old unposted lines
- `sql/test_post_inventory_tx.sql` — test script for the stored procedure
- `.env.example` — new required env vars

## Prerequisites
1. Backup your Sage database.
2. Create the stored procedure in Sage:
   ```sql
   -- Run sql/PostInventoryTxV2.sql in SQL Server Management Studio
   ```
3. Find your valid transaction codes and GL account codes.
   ```sql
   -- Warehouse codes
   SELECT WhseLink, Code, Name FROM Whsemst;

   -- Inventory transaction codes (module 11)
   SELECT idTrCodes, Code, [Description] FROM TrCodes WHERE iModule = 11;

   -- GL account codes
   SELECT AccountLink, Master_Sub_Account, Account, Description FROM Accounts WHERE AccountType = 0 ORDER BY Master_Sub_Account;
   ```
4. Update `hyper-integration/.env` with the new values (see `.env.example`).

## Deployment steps
1. Stop the bridge worker.
2. Run `sql/PostInventoryTxV2.sql` in Sage.
3. Update `.env` with the correct transaction codes and GL account codes.
4. Review and run `sql/fix_unposted_batch_lines.sql` to clean old unposted lines.
5. Start the bridge worker.

## Testing the stored procedure
1. Edit `sql/test_post_inventory_tx.sql` with a test stock code, warehouse code, transaction code, and GL account.
2. Run it in SQL Server Management Studio.
3. Check `_bvSTTransactionsFull` and `PostGL` for the audit trail.

Or use the Node.js test scripts:
- `node tools/test-sage-flow-v2.js` — posts a tiny GRN → issue → production → dispatch flow.
- `node tools/verify-sage-postings-v2.js <suffix>` — inspect the resulting stock and GL transactions.

## What the new flow does
- Each event (GRN, issue, production, dispatch, etc.) calls `postInventoryTransaction()`.
- `postInventoryTransaction()` maps the event to a Sage transaction code (`GRV`, `MFDR`, `MFMF`, `WHT`, `ADJ`) and looks up the warehouse code by ID.
- `PostInventoryTxV2` posts:
  - A stock transaction (updates `_bvSTTransactionsFull` and `_etblStockQtys`).
  - A GL debit/credit pair in `PostGL`.
  - An audit number.
- No manual `_etblStockQtys` updates are needed.

## GL account resolution
`PostInventoryTxV2` resolves the stock-side GL account in this order:
1. `GrpTbl.StockAccLink` from `_etblStockDetails` for the specific warehouse.
2. `GrpTbl.StockAccLink` from the default `WhseID = -1` record.
3. The appropriate `TrCodes` side based on movement direction:
   - Stock IN (`Quantity >= 0`): uses `TrCodes.Account1Link`.
   - Stock OUT (`Quantity < 0`): uses `TrCodes.Account2Link`.

The contra-side GL account is resolved as:
1. `SAGE_GL_ACCOUNT_*` env variable if set.
2. For stock IN (`Quantity >= 0`): uses `TrCodes.Account2Link`.
3. For stock OUT (`Quantity < 0`): uses `TrCodes.Account1Link`.

## Notes
- The old unposted batch lines must be removed before switching to the new flow, because the new flow already updates stock. Posting the old lines would double-count.
- `DRY_RUN=true` in `.env` will still attempt to call the procedure? No — `safeWrite` honors `DRY_RUN` and will skip the SQL execution.
- For accurate GL entries, ensure every stock item has a valid `Stock Group` in `_etblStockDetails` for each warehouse used by the bridge worker.
