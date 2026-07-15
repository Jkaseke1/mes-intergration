-- Find the last HYPER-MES production completion and trace where it posted in Sage
-- Run in: Hyperfeeds 2024 Live

USE [Hyperfeeds 2024 Live];
GO

-- 1) All postings made by the HYPER-MES integration user, most recent first
SELECT TOP 50
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
WHERE UserName = 'HYPER-MES'
ORDER BY TxDate DESC, AutoIdx DESC;

-- 2) Any batch completion references (WO-<batch_number>) regardless of user
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
WHERE Reference LIKE 'WO-%'
ORDER BY TxDate DESC, AutoIdx DESC;
