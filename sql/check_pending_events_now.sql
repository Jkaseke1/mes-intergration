-- Check pending events in Supabase sync_log
-- Run in: Supabase SQL Editor (HYPER MES database)

-- 1) All pending events waiting to be processed
SELECT 
  id,
  event_type,
  reference_type,
  reference_id,
  status,
  description,
  retry_count,
  created_at,
  updated_at,
  EXTRACT(EPOCH FROM (NOW() - created_at))/60 as minutes_pending
FROM sync_log
WHERE status = 'pending'
ORDER BY created_at ASC;

-- 2) Events currently being processed (should be quick, if stuck = problem)
SELECT 
  id,
  event_type,
  reference_type,
  reference_id,
  status,
  description,
  created_at,
  updated_at,
  EXTRACT(EPOCH FROM (NOW() - updated_at))/60 as minutes_in_processing
FROM sync_log
WHERE status = 'processing'
ORDER BY updated_at ASC;

-- 3) Recent successful events (shows bridge is working)
SELECT 
  id,
  event_type,
  reference_type,
  reference_id,
  status,
  description,
  created_at,
  updated_at
FROM sync_log
WHERE status = 'success'
ORDER BY updated_at DESC
LIMIT 20;

-- 4) Recent failed events (need attention)
SELECT 
  id,
  event_type,
  reference_type,
  reference_id,
  status,
  description,
  error_details,
  retry_count,
  next_retry_at,
  created_at,
  updated_at
FROM sync_log
WHERE status = 'failed'
ORDER BY updated_at DESC
LIMIT 10;

-- 5) Summary by status (quick health check)
SELECT 
  status,
  COUNT(*) as count,
  MAX(updated_at) as last_updated
FROM sync_log
GROUP BY status
ORDER BY last_updated DESC;
