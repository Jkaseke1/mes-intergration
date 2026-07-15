-- Verify auto-posting is working correctly in Sage
-- Run in: Hyperfeeds 2024 Live (SSMS)

USE [Hyperfeeds 2024 Live];
GO

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1) MOST RECENT HYPER-MES POSTINGS (ALL EVENT TYPES)
-- ═══════════════════════════════════════════════════════════════════════════════
-- Shows if the bridge is actively posting to Sage
SELECT TOP 30
  TxDate,
  Reference,
  Description,
  TrCode,
  WarehouseID,
  WarehouseCode,
  WarehouseName,
  QtyIn,
  QtyOut,
  UserName,
  DATEDIFF(MINUTE, TxDate, GETDATE()) as minutes_ago
FROM _bvSTTransactionsFull
WHERE UserName = 'HYPER-MES'
ORDER BY TxDate DESC, AutoIdx DESC;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2) PRODUCTION COMPLETIONS ONLY (MFMF transactions)
-- ═══════════════════════════════════════════════════════════════════════════════
-- Verify where FG is being posted
SELECT TOP 20
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
  AND TrCode = 'MFMF'
ORDER BY TxDate DESC, AutoIdx DESC;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3) PRODUCTION COMPLETION WITH TRANSFER LEGS (MFMF + WHT pairs)
-- ═══════════════════════════════════════════════════════════════════════════════
-- Check if PD→DEB transfers are happening
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
WHERE UserName = 'HYPER-MES'
  AND (TrCode = 'MFMF' OR TrCode = 'WHT')
  AND Reference LIKE 'WO-%'
ORDER BY TxDate DESC, Reference DESC, AutoIdx ASC;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4) BATCH-2026-817 DETAILED FLOW (the problematic batch)
-- ═══════════════════════════════════════════════════════════════════════════════
-- Full transaction history for the last completed batch
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
WHERE Reference = 'WO-BATCH-2026-817'
ORDER BY TxDate ASC, AutoIdx ASC;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5) WAREHOUSE POSTING SUMMARY (by warehouse, last 7 days)
-- ═══════════════════════════════════════════════════════════════════════════════
-- Shows which warehouses are receiving HYPER-MES postings
SELECT 
  WarehouseID,
  WarehouseCode,
  WarehouseName,
  TrCode,
  COUNT(*) as transaction_count,
  SUM(ISNULL(QtyIn, 0)) as total_qty_in,
  SUM(ISNULL(QtyOut, 0)) as total_qty_out
FROM _bvSTTransactionsFull
WHERE UserName = 'HYPER-MES'
  AND TxDate >= DATEADD(DAY, -7, GETDATE())
GROUP BY WarehouseID, WarehouseCode, WarehouseName, TrCode
ORDER BY WarehouseID, TrCode;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6) EXPECTED vs ACTUAL WAREHOUSE USAGE
-- ═══════════════════════════════════════════════════════════════════════════════
-- Check if postings match the expected PD(19) → DEB(17) flow
SELECT 
  'Expected: FG into PD (19)' as check_description,
  COUNT(*) as count
FROM _bvSTTransactionsFull
WHERE UserName = 'HYPER-MES'
  AND TrCode = 'MFMF'
  AND WarehouseID = 19
  AND TxDate >= DATEADD(DAY, -7, GETDATE())

UNION ALL

SELECT 
  'Expected: Transfer from PD (19) to DEB (17)' as check_description,
  COUNT(*) / 2 as count  -- Divide by 2 because each transfer = 2 WHT legs
FROM _bvSTTransactionsFull
WHERE UserName = 'HYPER-MES'
  AND TrCode = 'WHT'
  AND WarehouseID IN (19, 17)
  AND Reference LIKE 'WO-%'
  AND TxDate >= DATEADD(DAY, -7, GETDATE())

UNION ALL

SELECT 
  'PROBLEM: FG into DSP (20) instead of PD (19)' as check_description,
  COUNT(*) as count
FROM _bvSTTransactionsFull
WHERE UserName = 'HYPER-MES'
  AND TrCode = 'MFMF'
  AND WarehouseID = 20
  AND TxDate >= DATEADD(DAY, -7, GETDATE())

UNION ALL

SELECT 
  'Expected: Dispatch from DEB (17)' as check_description,
  COUNT(*) as count
FROM _bvSTTransactionsFull
WHERE UserName = 'HYPER-MES'
  AND TrCode = 'WHT'
  AND WarehouseID = 17
  AND QtyOut IS NOT NULL
  AND Reference NOT LIKE 'WO-%'  -- Exclude production transfers
  AND TxDate >= DATEADD(DAY, -7, GETDATE());

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7) LAST 24 HOURS ACTIVITY TIMELINE
-- ═══════════════════════════════════════════════════════════════════════════════
-- Chronological view of all HYPER-MES postings
SELECT 
  TxDate,
  Reference,
  CASE 
    WHEN TrCode = 'GRV' THEN '1-GRN'
    WHEN TrCode = 'MFDR' THEN '2-Issue'
    WHEN TrCode = 'MFMF' THEN '3-Production'
    WHEN TrCode = 'WHT' AND QtyOut IS NOT NULL THEN '4-Transfer Out'
    WHEN TrCode = 'WHT' AND QtyIn IS NOT NULL THEN '5-Transfer In'
    ELSE TrCode
  END as event_sequence,
  Description,
  WarehouseCode + ' (' + CAST(WarehouseID as VARCHAR) + ')' as warehouse,
  ISNULL(QtyIn, 0) as qty_in,
  ISNULL(QtyOut, 0) as qty_out
FROM _bvSTTransactionsFull
WHERE UserName = 'HYPER-MES'
  AND TxDate >= DATEADD(HOUR, -24, GETDATE())
ORDER BY TxDate ASC, AutoIdx ASC;
