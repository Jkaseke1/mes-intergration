-- Verify cleanup was successful
-- Run in: Supabase SQL Editor (HYPER MES database)

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1) Status summary - should only show 'success' and maybe 'pending'
-- ═══════════════════════════════════════════════════════════════════════════════
SELECT 
  status,
  COUNT(*) as count,
  MIN(created_at) as oldest_event,
  MAX(updated_at) as newest_event
FROM sync_log
GROUP BY status
ORDER BY newest_event DESC;

-- Expected after cleanup:
-- status   | count | oldest_event | newest_event
-- success  | 137   | ...          | 2026-07-13 14:01:04...
-- pending  | 0-X   | ...          | ... (if any new events)
-- NO 'failed' or 'processing' rows should appear

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2) Verify NO failed events remain
-- ═══════════════════════════════════════════════════════════════════════════════
SELECT COUNT(*) as failed_count
FROM sync_log
WHERE status = 'failed';

-- Expected: 0

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3) Verify NO stuck processing events remain
-- ═══════════════════════════════════════════════════════════════════════════════
SELECT COUNT(*) as stuck_processing_count
FROM sync_log
WHERE status = 'processing'
  AND updated_at < NOW() - INTERVAL '10 minutes';

-- Expected: 0

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4) Check if there are any NEW pending events waiting
-- ═══════════════════════════════════════════════════════════════════════════════
SELECT 
  id,
  event_type,
  reference_type,
  reference_id,
  status,
  created_at,
  EXTRACT(EPOCH FROM (NOW() - created_at))/60 as minutes_pending
FROM sync_log
WHERE status = 'pending'
ORDER BY created_at ASC;

-- Expected: 0 rows (unless new events were created during cleanup)

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5) Last 10 successful events (confirm history is intact)
-- ═══════════════════════════════════════════════════════════════════════════════
SELECT 
  id,
  event_type,
  reference_type,
  reference_id,
  status,
  description,
  updated_at
FROM sync_log
WHERE status = 'success'
ORDER BY updated_at DESC
LIMIT 10;

-- Expected: Should see BATCH-2026-817 events from July 13

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6) Total event count (before vs after)
-- ═══════════════════════════════════════════════════════════════════════════════
SELECT 
  COUNT(*) as total_events_remaining,
  COUNT(*) FILTER (WHERE status = 'success') as success_count,
  COUNT(*) FILTER (WHERE status = 'pending') as pending_count,
  COUNT(*) FILTER (WHERE status = 'processing') as processing_count,
  COUNT(*) FILTER (WHERE status = 'failed') as failed_count
FROM sync_log;

-- Expected:
-- total_events_remaining: 137 (or 137 + any new pending)
-- success_count: 137
-- pending_count: 0 (or more if new events created)
-- processing_count: 0
-- failed_count: 0

-- ═══════════════════════════════════════════════════════════════════════════════
-- ✅ CLEANUP SUCCESSFUL IF:
-- ═══════════════════════════════════════════════════════════════════════════════
-- - Query 2 returns: 0 failed events
-- - Query 3 returns: 0 stuck processing events
-- - Query 6 shows: failed_count = 0, processing_count = 0
-- - Query 1 shows: only 'success' (and maybe 'pending') statuses
