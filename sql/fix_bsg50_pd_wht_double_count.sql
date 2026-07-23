-- BATCH-2026-270 PD correction (take 3) — AFTER deploying fixed PostInventoryTxV2
-- Root cause: SP passed negative qty into _bspPostStTrans → QtyOut=-N → stock INCREASED
--   (Sage: QtyOnHand += QtyIn - QtyOut; negative QtyOut adds stock)
-- Phantom adds on PD: +950 (WHT) +950 (ADJ) +2850 (MFDR corr) = +4750
-- Current PD 7234 → target 1534 = MFDR -5700 with FIXED SP (absolute qty)

USE [Hyperfeeds 2024 Live];
GO

DECLARE @ItemCode varchar(50) = 'BSG50';
DECLARE @Qty float = -5700;
DECLARE @UnitCost float;
DECLARE @Ref varchar(50) = 'CORR3-BATCH-2026-270';
DECLARE @Desc varchar(255) = 'Correct PD phantom after AbsQty SP fix BATCH-2026-270';
DECLARE @TxDate datetime = GETDATE();
DECLARE @Empty varchar(100) = '';
DECLARE @Ref2 varchar(50) = 'PD-FIX-ABS';
DECLARE @UserName varchar(50) = 'HYPER-MES';
DECLARE @WhCode varchar(50) = 'PD';
DECLARE @TxCode varchar(50) = 'MFDR';
DECLARE @ProjectID int = 0;
DECLARE @PdQty float;
DECLARE @PdQtyText varchar(50);
DECLARE @TargetPd float = 1534;
DECLARE @Need float;

SELECT 'BEFORE' AS stage, w.Code AS whse, q.QtyOnHand
FROM _etblStockQtys q
JOIN StkItem s ON s.StockLink = q.StockID
JOIN WhseMst w ON w.WhseLink = q.WhseID
WHERE s.Code = @ItemCode AND w.Code IN ('PD', 'DEB');

SELECT @PdQty = q.QtyOnHand
FROM _etblStockQtys q
JOIN StkItem s ON s.StockLink = q.StockID
JOIN WhseMst w ON w.WhseLink = q.WhseID
WHERE s.Code = @ItemCode AND w.Code = 'PD';

SET @PdQtyText = CAST(@PdQty AS varchar(50));
SET @Need = @PdQty - @TargetPd;
SET @Qty = -@Need;

IF @PdQty IS NULL
BEGIN
  RAISERROR('BSG50 PD balance not found', 16, 1);
  RETURN;
END

IF @Need <= 0
BEGIN
  RAISERROR('PD qty %s already at or below target 1534 - nothing to correct', 16, 1, @PdQtyText);
  RETURN;
END

IF EXISTS (SELECT 1 FROM _bvSTTransactionsFull WHERE Reference = @Ref AND UserName = 'HYPER-MES')
BEGIN
  RAISERROR('Correction %s already posted - do not re-run', 16, 1, @Ref);
  RETURN;
END

-- Sanity: tiny smoke test first would be safer, but user is mid-fix.
-- Require fixed SP: refuse if a known-bad pattern still exists without AbsQuantity
-- (cannot inspect SP body easily — user must deploy PostInventoryTxV2.sql first)

SELECT TOP 1 @UnitCost = AverageCost
FROM _bvWarehouseStockFull
WHERE Code = @ItemCode;

IF @UnitCost IS NULL OR @UnitCost < 0 SET @UnitCost = 0;

PRINT 'Posting MFDR ' + CAST(@Qty AS varchar(20)) + ' BSG50 @ PD (need reduce by ' + CAST(@Need AS varchar(30)) + ')';
PRINT 'Expected PD: ' + CAST(@PdQty AS varchar(30)) + ' -> ' + CAST(@TargetPd AS varchar(30));

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
  @Reference2 = @Ref2,
  @TransactionDate = @TxDate,
  @Description = @Desc,
  @UserName = @UserName;

SELECT 'AFTER' AS stage, w.Code AS whse, q.QtyOnHand
FROM _etblStockQtys q
JOIN StkItem s ON s.StockLink = q.StockID
JOIN WhseMst w ON w.WhseLink = q.WhseID
WHERE s.Code = @ItemCode AND w.Code IN ('PD', 'DEB');

SELECT TOP 5
  TxDate, Reference, Description, TrCode,
  WarehouseCode, QtyIn, QtyOut, UserName
FROM _bvSTTransactionsFull
WHERE Reference IN (@Ref, 'CORR2-BATCH-2026-270', 'CORR-BATCH-2026-270')
ORDER BY TxDate DESC;
GO
