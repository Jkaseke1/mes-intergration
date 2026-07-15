-- Cleanup failed and stuck events in sync_log
-- Run in: Supabase SQL Editor (HYPER MES database)
-- This will clear out old failures and stuck processing events so we start fresh

-- ═══════════════════════════════════════════════════════════════════════════════
-- STEP 1: Review what will be cleaned up (RUN THIS FIRST)
-- ═══════════════════════════════════════════════════════════════════════════════

-- Failed events that will be deleted
SELECT 
  id,
  event_type,
  reference_type,
  reference_id,
  status,
  description,
  error_details,
  retry_count,
  created_at,
  updated_at
FROM sync_log
WHERE status = 'failed'
ORDER BY updated_at DESC;

-- Stuck processing events that will be deleted
SELECT 
  id,
  event_type,
  reference_type,
  reference_id,
  status,
  description,
  created_at,
  updated_at,
  EXTRACT(EPOCH FROM (NOW() - updated_at))/60 as minutes_stuck
FROM sync_log
WHERE status = 'processing'
  AND updated_at < NOW() - INTERVAL '10 minutes'
ORDER BY updated_at ASC;

-- ═══════════════════════════════════════════════════════════════════════════════
-- STEP 2: Delete failed events (ONLY run after reviewing above)
-- ═══════════════════════════════════════════════════════════════════════════════

DELETE FROM sync_log
WHERE status = 'failed';

-- Check how many were deleted
-- Should show: 54 rows deleted

-- ═══════════════════════════════════════════════════════════════════════════════
-- STEP 3: Delete stuck processing events (ONLY run after reviewing above)
-- ═══════════════════════════════════════════════════════════════════════════════

DELETE FROM sync_log
WHERE status = 'processing'
  AND updated_at < NOW() - INTERVAL '10 minutes';

-- Check how many were deleted
-- Should show: 2 rows deleted

-- ═══════════════════════════════════════════════════════════════════════════════
-- STEP 4: Verify cleanup - should only see 'success' and fresh 'pending' events
-- ═══════════════════════════════════════════════════════════════════════════════

SELECT 
  status,
  COUNT(*) as count,
  MAX(updated_at) as last_updated
FROM sync_log
GROUP BY status
ORDER BY last_updated DESC;

-- Expected result after cleanup:
-- status   | count | last_updated
-- success  | 137   | 2026-07-13 14:01:04...
-- pending  | 0     | (or any new events created)

-- ═══════════════════════════════════════════════════════════════════════════════
-- OPTIONAL: If you want to keep a backup, archive failed events first
-- ═══════════════════════════════════════════════════════════════════════════════

-- Create archive table (only run once)
/*
CREATE TABLE IF NOT EXISTS sync_log_archive (
  LIKE sync_log INCLUDING ALL
);
*/

-- Archive failed events before deleting (optional)
/*
INSERT INTO sync_log_archive
SELECT * FROM sync_log
WHERE status IN ('failed', 'processing')
  AND (
    status = 'failed' 
    OR (status = 'processing' AND updated_at < NOW() - INTERVAL '10 minutes')
  );
*/
