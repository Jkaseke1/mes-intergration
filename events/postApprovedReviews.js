// postApprovedReviews.js - Polls for finance-approved reviews and posts them to Sage
// This is the second phase of the two-phase posting flow

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const sql = require('mssql');
const { createClient } = require('@supabase/supabase-js');
const { postInventoryTransaction, getWarehouseCode } = require('./lib/sagePost');
const { checkAllReviewsFinalized } = require('./lib/reviewQueue');
const { syncAfterPosting } = require('./lib/syncStock');

const DRY_RUN = process.env.DRY_RUN === 'true';

const sageConfig = {
  server: 'localhost',
  port: 50119,
  database: process.env.SAGE_DATABASE,
  user: process.env.SAGE_USER,
  password: process.env.SAGE_PASSWORD,
  options: {
    encrypt: false,
    trustServerCertificate: true,
    enableArithAbort: true,
  }
};

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function postApprovedReviews() {
  // Fetch approved but not-yet-posted reviews
  const { data: approved, error } = await supabase
    .from('sage_posting_reviews')
    .select('*')
    .eq('status', 'approved')
    .is('posted_at', null)
    .order('created_at', { ascending: true })
    .limit(20);

  if (error) {
    console.error('❌ Failed to fetch approved reviews:', error.message);
    return;
  }

  if (!approved || approved.length === 0) return;

  console.log(`\n[${new Date().toISOString()}] Found ${approved.length} approved review(s) to post`);

  let pool;
  try {
    pool = await sql.connect(sageConfig);

    // Group by sync_event_id so we can update sync_log after all postings
    const eventsMap = new Map();

    for (const review of approved) {
      console.log(`\n  Posting: ${review.sage_code} ${review.sage_tx_code} ${review.quantity}kg @ $${review.unit_cost} (WhseID ${review.warehouse_id})`);

      try {
        if (DRY_RUN) {
          console.log(`  [DRY RUN] Would post to Sage`);
        } else {
          const result = await postInventoryTransaction(pool, {
            sageCode: review.sage_code,
            transactionType: review.transaction_type,
            quantity: review.quantity,
            whseId: review.warehouse_id,
            unitCost: review.unit_cost,
            reference: review.reference,
            reference2: review.reference2,
            description: review.description,
            transactionDate: new Date(review.transaction_date),
          });

          console.log(`  ✅ Sage posted: ${review.sage_code} ${review.sage_tx_code}`);

          // Mark as posted
          await supabase
            .from('sage_posting_reviews')
            .update({
              posted_at: new Date().toISOString(),
              sage_result: { success: true, posted_at: new Date().toISOString() },
              updated_at: new Date().toISOString(),
            })
            .eq('id', review.id);
        }

        // Track for sync_log completion
        if (!eventsMap.has(review.sync_event_id)) {
          eventsMap.set(review.sync_event_id, { total: 0, posted: 0, rejected: 0 });
        }
        eventsMap.get(review.sync_event_id).posted++;

        // Sync stock balance to Supabase
        await syncStockBalance(pool, review);

      } catch (err) {
        console.error(`  ❌ Failed to post: ${err.message}`);

        await supabase
          .from('sage_posting_reviews')
          .update({
            sage_result: { success: false, error: err.message, posted_at: new Date().toISOString() },
            updated_at: new Date().toISOString(),
          })
          .eq('id', review.id);
      }
    }

    // Batch sync all materials that were posted
    const postedSageCodes = [...new Set(approved.map(r => r.sage_code))];
    if (postedSageCodes.length > 0 && !DRY_RUN) {
      await syncAfterPosting(pool, supabase, postedSageCodes, 'Finance Posting');
    }

    // Check if all reviews for each event are finalized, then mark sync_log as success
    for (const [eventId, counts] of eventsMap) {
      const allDone = await checkAllReviewsFinalized(eventId);
      if (allDone) {
        await supabase
          .from('sync_log')
          .update({
            status: 'success',
            updated_at: new Date().toISOString(),
          })
          .eq('id', eventId);

        console.log(`  ✅ Sync event ${eventId} fully processed`);
      }
    }

  } catch (err) {
    console.error('❌ postApprovedReviews failed:', err.message);
  } finally {
    if (pool) await sql.close();
  }
}

async function syncStockBalance(pool, review) {
  try {
    // Get StockLink from StkItem
    const stockResult = await pool.request()
      .input('Code', sql.VarChar, review.sage_code)
      .query(`SELECT StockLink FROM StkItem WHERE Code = @Code AND ItemActive = 1`);

    if (stockResult.recordset.length === 0) return;

    const stockLink = stockResult.recordset[0].StockLink;

    // Get current QtyOnHand from Sage
    const qtyResult = await pool.request()
      .input('StockID', sql.Int, stockLink)
      .input('WhseID', sql.Int, review.warehouse_id)
      .query(`SELECT QtyOnHand FROM _etblStockQtys WHERE StockID = @StockID AND WhseID = @WhseID`);

    const newQty = qtyResult.recordset.length > 0 ? qtyResult.recordset[0].QtyOnHand : 0;

    // Sync to Supabase
    await supabase.rpc('set_sage_stock_balance', {
      p_sage_code: review.sage_code,
      p_warehouse_id: review.warehouse_id,
      p_quantity: newQty,
    });

    console.log(`  ✅ Stock synced: ${review.sage_code} → ${newQty}kg in WhseID ${review.warehouse_id}`);
  } catch (err) {
    console.warn(`  ⚠️  Stock sync failed: ${err.message}`);
  }
}

module.exports = { postApprovedReviews };
