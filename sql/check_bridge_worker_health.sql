-- Check bridge worker health and recent activity
-- Run in: HYPER MES Supabase (via psql or Supabase SQL Editor)

-- 1) All recent sync_log events (all event types) - shows if bridge is running
SELECT 
  event_type,
  status,
  COUNT(*) as count,
  MAX(updated_at) as last_activity
FROM sync_log
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY event_type, status
ORDER BY last_activity DESC;

-- 2) Pending events waiting to be processed
SELECT 
  id,
  event_type,
  reference_type,
  reference_id,
  status,
  retry_count,
  created_at,
  updated_at,
  EXTRACT(EPOCH FROM (NOW() - created_at))/60 as minutes_pending
FROM sync_log
WHERE status = 'pending'
ORDER BY created_at ASC
LIMIT 20;

-- 3) Events stuck in 'processing' status (may indicate bridge crash)
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
  AND updated_at < NOW() - INTERVAL '5 minutes'
ORDER BY updated_at ASC;

-- 4) Recent failures that need attention
SELECT 
  id,
  event_type,
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
  AND created_at > NOW() - INTERVAL '48 hours'
ORDER BY created_at DESC
LIMIT 20;

-- 5) Success rate by event type (last 7 days)
SELECT 
  event_type,
  COUNT(*) as total_events,
  SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful,
  SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
  SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
  SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
  ROUND(100.0 * SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) / COUNT(*), 2) as success_rate_pct
FROM sync_log
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY event_type
ORDER BY total_events DESC;
