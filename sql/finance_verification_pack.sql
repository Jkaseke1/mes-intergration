-- Finance verification pack for Sage Pastel / HYPER-MES bridge
-- Run in: Hyperfeeds 2024 Live

USE [Hyperfeeds 2024 Live];
GO

-- 1) Warehouse master reference
SELECT
  WhseLink AS WarehouseID,
  Code AS WarehouseCode,
  Description_1 AS WarehouseName
FROM WhseMst
ORDER BY Code;

-- 2) All MES (HYPER-MES) postings in the last 7 days
SELECT
  TxDate,
  Reference,
  Description,
  TrCode,
  TrCodeID,
  WarehouseID,
  WarehouseCode,
  WarehouseName,
  QtyIn,
  QtyOut,
  UserName
FROM _bvSTTransactionsFull
WHERE UserName = 'HYPER-MES'
  AND TxDate >= DATEADD(day, -7, GETDATE())
ORDER BY TxDate DESC, AutoIdx DESC;

-- 3) FG completions (MFMF / TrCodeID 43) by warehouse
SELECT
  v.WarehouseID,
  w.Code AS WarehouseCode,
  w.Description_1 AS WarehouseName,
  COUNT(*) AS Lines,
  SUM(ISNULL(v.QtyIn, 0)) AS TotalQtyIn,
  MIN(v.TxDate) AS FirstDate,
  MAX(v.TxDate) AS LastDate
FROM _bvSTTransactionsFull v
LEFT JOIN WhseMst w ON w.WhseLink = v.WarehouseID
WHERE (v.TrCode = 'MFMF' OR v.TrCodeID = 43)
GROUP BY v.WarehouseID, w.Code, w.Description_1
ORDER BY Lines DESC;

-- 4) WHT warehouse transfers by source/destination
SELECT
  v.WarehouseID,
  w.Code AS WarehouseCode,
  w.Description_1 AS WarehouseName,
  SUM(v.QtyIn) AS QtyIn,
  SUM(v.QtyOut) AS QtyOut,
  COUNT(*) AS Lines
FROM _bvSTTransactionsFull v
LEFT JOIN WhseMst w ON w.WhseLink = v.WarehouseID
WHERE v.TrCode = 'WHT'
GROUP BY v.WarehouseID, w.Code, w.Description_1
ORDER BY v.WarehouseID;

-- 5) Specific batch FG trail (replace WO-BATCH-2026-xxx with actual reference)
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
WHERE Reference = 'WO-BATCH-2026-xxx'
ORDER BY AutoIdx;

-- 6) Dispatch/WHT activity for a specific branch destination
-- Replace dispatch reference to check a specific dispatch
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
WHERE Reference = 'DSP-2026-xxx'
ORDER BY AutoIdx;
