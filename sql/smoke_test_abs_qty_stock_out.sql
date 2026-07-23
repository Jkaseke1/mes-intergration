-- SMOKE TEST first (run AFTER deploying PostInventoryTxV2.sql)
-- Posts MFDR -1 on BSG50 PD, expects QtyOnHand to DROP by 1 and QtyOut = +1 (not -1)

USE [Hyperfeeds 2024 Live];
GO

DECLARE @ItemCode varchar(50) = 'BSG50';
DECLARE @Before float;
DECLARE @After float;
DECLARE @UnitCost float = 0;
DECLARE @Empty varchar(100) = '';
DECLARE @Ref varchar(50) = 'SMOKE-ABS-QTY';
DECLARE @TxDate datetime = GETDATE();
DECLARE @UserName varchar(50) = 'HYPER-MES';
DECLARE @WhCode varchar(50) = 'PD';
DECLARE @TxCode varchar(50) = 'MFDR';
DECLARE @Qty float = -1;
DECLARE @ProjectID int = 0;
DECLARE @Desc varchar(255) = 'Smoke test AbsQuantity stock-out';

SELECT @Before = q.QtyOnHand
FROM _etblStockQtys q
JOIN StkItem s ON s.StockLink = q.StockID
JOIN WhseMst w ON w.WhseLink = q.WhseID
WHERE s.Code = @ItemCode AND w.Code = 'PD';

SELECT TOP 1 @UnitCost = AverageCost FROM _bvWarehouseStockFull WHERE Code = @ItemCode;
IF @UnitCost IS NULL OR @UnitCost < 0 SET @UnitCost = 0;

PRINT 'BEFORE PD=' + CAST(@Before AS varchar(30));

EXEC dbo.PostInventoryTxV2
  @ItemCode = @ItemCode,
  @InventoryTransactionCode = @TxCode,
  @Quantity = @Qty,
  @WHCode = @WhCode,
  @LotNumber = @Empty,
  @UnitCost = @UnitCost,
  @ProjectID = @ProjectID,
  @GLAccountCode = @Empty,
  @Reference = @Ref,
  @Reference2 = 'SMOKE',
  @TransactionDate = @TxDate,
  @Description = @Desc,
  @UserName = @UserName;

SELECT @After = q.QtyOnHand
FROM _etblStockQtys q
JOIN StkItem s ON s.StockLink = q.StockID
JOIN WhseMst w ON w.WhseLink = q.WhseID
WHERE s.Code = @ItemCode AND w.Code = 'PD';

SELECT 'RESULT' AS stage, @Before AS before_qty, @After AS after_qty, (@Before - @After) AS decreased_by;

SELECT TOP 3 TxDate, Reference, TrCode, WarehouseCode, QtyIn, QtyOut, UserName
FROM _bvSTTransactionsFull
WHERE Reference = @Ref
ORDER BY TxDate DESC;

-- PASS if decreased_by = 1 and QtyOut is +1 (positive), not -1
GO
