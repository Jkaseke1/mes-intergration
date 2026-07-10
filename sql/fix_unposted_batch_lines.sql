-- Fix existing unposted batch lines created by the old bridge worker.
-- IMPORTANT: Backup your Sage database before running this.
-- The old bridge worker manually updated _etblStockQtys and wrote journal lines
-- to _etblInvJrBatchLines but never posted them. Since stock is already correct,
-- these unposted lines need to be removed so they don't double-count if posted later.

-- Step 1: Review what will be deleted
SELECT idInvJrBatchLines, iInvJrBatchID, iStockID, iWarehouseID, dTrDate, cReference, cDescription, fQtyIn, fQtyOut
FROM _etblInvJrBatchLines
WHERE cReference LIKE 'GRN-%'
   OR cReference LIKE 'WO-%'
   OR cReference LIKE 'MP-%'
   OR cReference LIKE 'RECON-%'
   OR cDescription LIKE 'Issue to BATCH-%'
   OR cDescription LIKE '% complete'
   OR cDescription LIKE 'Dispatch to %'
   OR cDescription LIKE 'Receipt fr DSP %'
   OR cDescription LIKE 'Macropack %'
ORDER BY idInvJrBatchLines;

-- Step 2: After confirming the above are bridge worker entries, delete them.
-- UNCOMMENT THE NEXT TWO LINES ONLY AFTER BACKUP AND REVIEW:
-- DELETE FROM _etblInvJrBatchLines
-- WHERE cReference LIKE 'GRN-%' OR cReference LIKE 'WO-%' OR cReference LIKE 'MP-%' OR cReference LIKE 'RECON-%'
--    OR cDescription LIKE 'Issue to BATCH-%' OR cDescription LIKE '% complete' OR cDescription LIKE 'Dispatch to %'
--    OR cDescription LIKE 'Receipt fr DSP %' OR cDescription LIKE 'Macropack %';

-- Step 3: Verify no orphaned detail lines remain (details are for lot/serial tracking)
-- DELETE FROM _etblInvJrBatchLineDetails
-- WHERE idInvJrBatchLine NOT IN (SELECT idInvJrBatchLines FROM _etblInvJrBatchLines);
