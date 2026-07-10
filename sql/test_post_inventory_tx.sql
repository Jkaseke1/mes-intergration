-- Test script for PostInventoryTxV2 stored procedure
-- Run this after creating the stored procedure in Sage.
-- It posts a tiny quantity (1.0e-09) to avoid affecting real stock.

-- Before running, set these values to a valid stock code, warehouse code, transaction code, and GL account:
DECLARE @TestItemCode VARCHAR(50) = 'YOUR-TEST-STOCK-CODE';
DECLARE @TestWHCode VARCHAR(50) = 'YOUR-TEST-WAREHOUSE-CODE';  -- e.g. 'RM' or 'Raw'
DECLARE @TestTxCode VARCHAR(50) = 'YOUR-TEST-TRANSACTION-CODE'; -- e.g. 'MAM' or 'ADJ'
DECLARE @TestGLAccount VARCHAR(100) = 'YOUR-TEST-GL-ACCOUNT';   -- e.g. '5200/000'

EXEC PostInventoryTxV2
    @ItemCode = @TestItemCode,
    @InventoryTransactionCode = @TestTxCode,
    @Quantity = 1.0e-09,
    @WHCode = @TestWHCode,
    @LotNumber = '',
    @UnitCost = 0,
    @ProjectID = 0,
    @GLAccountCode = @TestGLAccount,
    @Reference = 'TEST-POST',
    @Reference2 = '',
    @TransactionDate = GETDATE(),
    @Description = 'Test auto-post from HYPER-MES',
    @UserName = 'HYPER-MES-TEST';

-- Check StkTrans for the test record
SELECT TOP 5 * FROM StkTrans WHERE StockCode = @TestItemCode AND cAuditNumber LIKE (SELECT CAST(MAX(AuditNo) AS VARCHAR) FROM _etblSysLog) + '.%' ORDER BY idStkTrans DESC;
