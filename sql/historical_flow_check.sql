-- Historical flow check: verify the previous GRN -> RM -> PD -> DEB -> Branch flow
-- Run in: Hyperfeeds 2024 Live

USE [Hyperfeeds 2024 Live];
GO

-- NOTE: _bvSTTransactionsFull has no 'Code' column for the stock item.
-- Run this first to find the correct column name, then add it back as a filter:
--   SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
--   WHERE TABLE_NAME = '_bvSTTransactionsFull' ORDER BY ORDINAL_POSITION;
DECLARE @BatchReference VARCHAR(20) = NULL;  -- e.g. 'WO-BATCH-2026-817'

-- 1) GRN receipts into RM warehouse (GRV)
SELECT
  'GRN receipt' AS Step,
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
WHERE TrCode = 'GRV'
  AND WarehouseID = 18
ORDER BY TxDate DESC;

-- 2) Material issues to Production (MFDR from RM to PD)
SELECT
  'Material issue' AS Step,
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
WHERE TrCode = 'MFDR'
  AND WarehouseID IN (18, 19)
ORDER BY TxDate DESC;

-- 3) FG production / manufacture into Production (MFMF to PD)
SELECT
  'FG production' AS Step,
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
WHERE (TrCode = 'MFMF' OR TrCodeID = 43)
  AND WarehouseID = 19
  AND (@BatchReference IS NULL OR Reference = @BatchReference)
ORDER BY TxDate DESC;

-- 4) WHT transfers out of Production (PD -> DEB)
SELECT
  'PD -> DEB transfer out' AS Step,
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
WHERE TrCode = 'WHT'
  AND WarehouseID = 19
  AND QtyOut > 0
ORDER BY TxDate DESC;

-- 5) WHT transfers into DEB (PD -> DEB)
SELECT
  'PD -> DEB transfer in' AS Step,
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
WHERE TrCode = 'WHT'
  AND WarehouseID = 17
  AND QtyIn > 0
ORDER BY TxDate DESC;

-- 6) Dispatch issues from DEB (WHT to branches)
SELECT
  'Dispatch from DEB' AS Step,
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
WHERE TrCode = 'WHT'
  AND WarehouseID = 17
  AND QtyOut > 0
ORDER BY TxDate DESC;

-- 7) Combined flow for a specific item code
SELECT
  CASE
    WHEN TrCode = 'GRV' AND WarehouseID = 18 THEN 'GRN -> RM'
    WHEN TrCode = 'MFDR' AND WarehouseID = 18 THEN 'RM issue'
    WHEN TrCode = 'MFDR' AND WarehouseID = 19 THEN 'PD receipt (material)'
    WHEN (TrCode = 'MFMF' OR TrCodeID = 43) AND WarehouseID = 19 THEN 'FG -> PD'
    WHEN TrCode = 'WHT' AND WarehouseID = 19 AND QtyOut > 0 THEN 'PD -> DEB'
    WHEN TrCode = 'WHT' AND WarehouseID = 17 AND QtyIn > 0 THEN 'DEB receipt (transfer)'
    WHEN TrCode = 'WHT' AND WarehouseID = 17 AND QtyOut > 0 THEN 'DEB -> dispatch'
    ELSE 'Other'
  END AS FlowStep,
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
WHERE (
    (TrCode = 'GRV' AND WarehouseID = 18)
    OR (TrCode = 'MFDR' AND WarehouseID IN (18, 19))
    OR ((TrCode = 'MFMF' OR TrCodeID = 43) AND WarehouseID = 19)
    OR (TrCode = 'WHT' AND WarehouseID IN (17, 19))
  )
ORDER BY TxDate, AutoIdx;
