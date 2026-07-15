-- Check auto-posting status for production completions
-- Run in: HYPER MES Supabase (via psql or Supabase SQL Editor)

-- 1) Recent production_completed events in sync_log
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
WHERE event_type = 'production_completed'
ORDER BY created_at DESC
LIMIT 20;

-- 2) Count of sync_log events by status for production_completed
SELECT 
  status,
  COUNT(*) as count
FROM sync_log
WHERE event_type = 'production_completed'
GROUP BY status
ORDER BY count DESC;

-- 3) Any failed production_completed events with error details
SELECT 
  id,
  reference_id,
  status,
  description,
  error_details,
  retry_count,
  next_retry_at,
  created_at,
  updated_at
FROM sync_log
WHERE event_type = 'production_completed'
  AND status IN ('failed', 'processing')
ORDER BY created_at DESC
LIMIT 10;

-- 4) Recent production orders that should have triggered sync events
SELECT 
  po.id,
  po.batch_number,
  po.status,
  po.actual_qty,
  po.rejected_qty,
  po.actual_end,
  po.created_at,
  po.updated_at,
  f.sage_code,
  f.name as formulation_name
FROM production_orders po
LEFT JOIN formulations f ON po.formulation_id = f.id
WHERE po.status = 'completed'
ORDER BY po.actual_end DESC
LIMIT 10;

-- 5) Cross-check: production orders vs sync_log entries
-- Shows which completed batches have/haven't been synced
SELECT 
  po.id as order_id,
  po.batch_number,
  po.status as order_status,
  po.actual_end,
  sl.id as sync_log_id,
  sl.status as sync_status,
  sl.description as sync_description,
  sl.created_at as sync_created_at
FROM production_orders po
LEFT JOIN sync_log sl ON 
  sl.reference_id = po.id::text 
  AND sl.event_type = 'production_completed'
WHERE po.status = 'completed'
ORDER BY po.actual_end DESC
LIMIT 20;
