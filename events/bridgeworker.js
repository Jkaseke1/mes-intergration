const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const DRY_RUN = process.env.DRY_RUN === 'true';
const POLL_INTERVAL_MS = 30000;

// Import event handlers
const { handleGoodsReceipt }  = require('./goodsReceiptAuto');
const { handleGoodsIssue }    = require('./goodsIssueAuto');
const { handleBatchComplete } = require('./batchCompleteAuto');
const { handleDispatch }      = require('./dispatchAuto');

async function processPendingEvents() {
  const { data: pending, error } = await supabase
    .from('sync_log')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(10);

  if (error) {
    console.error('❌ Failed to read sync_log:', error.message);
    return;
  }

  if (!pending || pending.length === 0) return;

  console.log(`\n[${new Date().toISOString()}] Found ${pending.length} pending event(s)`);

  for (const event of pending) {

    // ── Idempotency check ──────────────────────────────────────
    // If this exact reference + event_type was already successfully
    // processed, skip it and mark as duplicate — do not process twice
    const { data: alreadyDone } = await supabase
      .from('sync_log')
      .select('id')
      .eq('reference_id', event.reference_id)
      .eq('event_type', event.event_type)
      .eq('status', 'success')
      .neq('id', event.id)
      .limit(1);

    if (alreadyDone && alreadyDone.length > 0) {
      console.log(`  ⚠️  Duplicate detected: ${event.event_type} for ${event.reference_id}`);
      console.log(`      Already processed — marking as duplicate and skipping`);
      await supabase
        .from('sync_log')
        .update({
          status:      'success',
          description: 'Duplicate — already processed successfully',
          updated_at:  new Date().toISOString(),
        })
        .eq('id', event.id);
      continue;
    }
    // ── End idempotency check ──────────────────────────────────

    console.log(`\nProcessing: ${event.event_type} — ${event.reference_type} — ${event.reference_id}`);

    try {
      // Mark as processing
      await supabase
        .from('sync_log')
        .update({
          status:     'processing',
          updated_at: new Date().toISOString(),
        })
        .eq('id', event.id);

      // Route to correct handler
      switch (event.event_type) {
        case 'grn_confirmed':
          await handleGoodsReceipt(event);
          break;
        case 'materials_issued':
          await handleGoodsIssue(event);
          break;
        case 'production_completed':
          await handleBatchComplete(event);
          break;
        case 'dispatch_delivered':
          await handleDispatch(event);
          break;
        default:
          console.log(`  ⚠️  Unknown event type: ${event.event_type} — skipping`);
          await supabase
            .from('sync_log')
            .update({
              status:      'success',
              description: `Unknown event type skipped: ${event.event_type}`,
              updated_at:  new Date().toISOString(),
            })
            .eq('id', event.id);
          continue;
      }

      // Mark as success
      await supabase
        .from('sync_log')
        .update({
          status:     'success',
          updated_at: new Date().toISOString(),
        })
        .eq('id', event.id);

      console.log(`  ✅ ${event.event_type} processed successfully`);

    } catch (err) {
      console.error(`  ❌ Failed: ${err.message}`);

      await supabase
        .from('sync_log')
        .update({
          status:        'failed',
          error_details: { message: err.message, stack: err.stack },
          retry_count:   (event.retry_count || 0) + 1,
          next_retry_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          updated_at:    new Date().toISOString(),
        })
        .eq('id', event.id);
    }
  }
}

async function startWorker() {
  console.log('==============================================');
  console.log(' HYPER Integration Bridge Worker');
  console.log(` Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(` Poll interval: ${POLL_INTERVAL_MS / 1000}s`);
  console.log('==============================================\n');
  console.log('Watching sync_log for pending events...');
  console.log('Idempotency check: ENABLED — no duplicate processing\n');

  await processPendingEvents();
  setInterval(processPendingEvents, POLL_INTERVAL_MS);
}

startWorker();