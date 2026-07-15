// reviewQueue.js - Saves prepared Sage transactions for finance review instead of posting immediately
// Two-phase flow: prepare → finance review → post approved

const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Transaction code mapping (same as sagePost.js)
const TX_CODES = {
  grn: process.env.SAGE_TX_CODE_GRN || 'GRV',
  issue: process.env.SAGE_TX_CODE_ISSUE || 'MFDR',
  production: process.env.SAGE_TX_CODE_PRODUCTION || 'MFMF',
  dispatch: process.env.SAGE_TX_CODE_DISPATCH || 'WHT',
  recon: process.env.SAGE_TX_CODE_RECON || 'ADJ',
  macropack: process.env.SAGE_TX_CODE_MACROPACK || 'MFMF',
};

let sequenceCounter = 0;

/**
 * Save a prepared transaction to the review queue.
 * Same interface as postInventoryTransaction so handlers need minimal changes.
 */
async function saveForReview(syncEventId, eventType, eventDescription, {
  sageCode,
  transactionType,
  quantity,
  whseId,
  unitCost,
  reference,
  reference2 = '',
  description,
  transactionDate,
  whseCode = '',
}) {
  const txCode = TX_CODES[transactionType];
  if (!txCode) throw new Error(`Unknown transaction type: ${transactionType}`);

  const totalValue = Math.round((Math.abs(quantity) * (unitCost || 0)) * 10000) / 10000;

  const { data, error } = await supabase
    .from('sage_posting_reviews')
    .insert({
      sync_event_id: syncEventId,
      event_type: eventType,
      event_description: eventDescription,
      sequence_no: sequenceCounter++,
      sage_code: sageCode,
      transaction_type: transactionType,
      sage_tx_code: txCode,
      quantity: Math.round(quantity * 10000) / 10000,
      unit_cost: Math.round((unitCost || 0) * 10000) / 10000,
      total_value: totalValue,
      warehouse_id: whseId,
      warehouse_code: whseCode,
      reference: (reference || '').substring(0, 50),
      reference2: (reference2 || '').substring(0, 50),
      description: (description || '').substring(0, 255),
      transaction_date: transactionDate || new Date().toISOString(),
      status: 'pending',
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to save review: ${error.message}`);

  console.log(`  📋 Queued for review: ${sageCode} ${txCode} ${quantity}kg @ $${(unitCost || 0).toFixed(4)} → $${totalValue.toFixed(2)} (WhseID ${whseId})`);
  return data;
}

/**
 * Check if all reviews for a sync event are finalized (approved+posted or rejected).
 */
async function checkAllReviewsFinalized(syncEventId) {
  const { data, error } = await supabase
    .from('sage_posting_reviews')
    .select('id, status, posted_at')
    .eq('sync_event_id', syncEventId);

  if (error) throw new Error(`Failed to check reviews: ${error.message}`);
  if (!data || data.length === 0) return false;

  // All must be either (approved AND posted) or rejected
  return data.every(r => (r.status === 'approved' && r.posted_at) || r.status === 'rejected');
}

module.exports = { saveForReview, checkAllReviewsFinalized };
