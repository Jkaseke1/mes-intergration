const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const sql = require('mssql');
const { createClient } = require('@supabase/supabase-js');
const { postInventoryTransaction } = require('./lib/sagePost');

const DRY_RUN = process.env.DRY_RUN === 'true';

const sageConfig = {
  server:   'localhost',
  port:      50119,
  database: process.env.SAGE_DATABASE,
  user:     process.env.SAGE_USER,
  password: process.env.SAGE_PASSWORD,
  options: {
    encrypt:                false,
    trustServerCertificate: true,
    enableArithAbort:       true,
  }
};

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function safeWrite(description, sqlFn) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would execute: ${description}`);
    return { dryRun: true };
  }
  try {
    const result = await sqlFn();
    console.log(`[LIVE] ✅ Executed: ${description}`);
    return result;
  } catch (err) {
    console.error(`[LIVE] ❌ Failed: ${description}`, err.message);
    throw err;
  }
}

async function handleGoodsReceipt(syncEvent) {
  console.log('\n  → Event 1: Goods Receipt (Auto)');

  const grnId = syncEvent.reference_id;
  console.log(`  GRN ID: ${grnId}`);

  // Read GRN header
  const { data: grn, error: grnError } = await supabase
    .from('goods_received_notes')
    .select('id, grn_number, received_date, status, supplier_id')
    .eq('id', grnId)
    .single();

  if (grnError || !grn) {
    throw new Error(`GRN not found: ${grnId} — ${grnError?.message}`);
  }

  // Read supplier
  const { data: supplier } = await supabase
    .from('suppliers')
    .select('id, name, sage_code')
    .eq('id', grn.supplier_id)
    .single();

  console.log(`  GRN: ${grn.grn_number} — ${supplier?.name}`);

  // Read GRN line items
  const { data: items, error: itemsError } = await supabase
    .from('grn_items')
    .select('id, received_qty, unit_cost, raw_material_id')
    .eq('grn_id', grnId);

  console.log(`  Items: count=${items?.length} error=${itemsError?.message}`);

  if (itemsError) throw new Error(`Items query error: ${itemsError.message}`);
  if (!items || items.length === 0) throw new Error(`No items found for GRN: ${grn.grn_number}`);

  // Fetch raw material details
  for (const item of items) {
    const { data: rm } = await supabase
      .from('raw_materials')
      .select('id, name, sage_code')
      .eq('id', item.raw_material_id)
      .single();
    item.raw_materials = rm;
    console.log(`  RM: ${item.raw_material_id} → ${rm?.name} (${rm?.sage_code})`);
  }

  // Single connection — held open for ALL operations
  let pool;
  try {
    pool = await sql.connect(sageConfig);

    for (const item of items) {
      const sageCode = item.raw_materials?.sage_code;
      const rmName   = item.raw_materials?.name;

      if (!sageCode) {
        console.log(`  ⚠️  No sage_code for item — skipping`);
        continue;
      }

      // Look up StockLink
      const stockResult = await pool.request()
        .input('Code', sql.VarChar, sageCode)
        .query(`SELECT StockLink FROM StkItem WHERE Code = @Code AND ItemActive = 1`);

      if (stockResult.recordset.length === 0) {
        console.log(`  ⚠️  ${sageCode} not found in Sage — skipping`);
        continue;
      }

      const stockLink   = stockResult.recordset[0].StockLink;
      const reference   = grn.grn_number.substring(0, 20);
      const description = (rmName || sageCode).substring(0, 40);
      const qty         = Number(item.received_qty);
      const cost        = Number(item.unit_cost || 0);

      console.log(`  Processing: ${sageCode} — ${qty}kg @ $${cost}`);

      await safeWrite(
        `GRN receipt: ${qty}kg of ${sageCode} @ $${cost}/kg`,
        async () => {
          // Post directly to Sage (no journal batch, no manual QtyOnHand)
          await postInventoryTransaction(pool, {
            sageCode,
            transactionType: 'grn',
            quantity: qty,
            whseId: 18,
            unitCost: cost,
            reference,
            description,
            transactionDate: new Date(grn.received_date)
          });

          console.log(`  ✅ Sage posted: ${sageCode} +${qty}kg into WhseID 18`);

          // Get current stock for Supabase sync
          const existing = await pool.request()
            .input('StockID', sql.Int, stockLink)
            .input('WhseID',  sql.Int, 18)
            .query(`SELECT QtyOnHand FROM _etblStockQtys WHERE StockID = @StockID AND WhseID = @WhseID`);

          const newQty = existing.recordset.length > 0 ? existing.recordset[0].QtyOnHand : qty;

          // Sync to Supabase sage_stock_balances
          try {
            await supabase.rpc('set_sage_stock_balance', {
              p_sage_code: sageCode,
              p_warehouse_id: 18,
              p_quantity: newQty
            });
            console.log(`  ✅ Supabase sage_stock_balances synced: ${sageCode} → ${newQty}kg`);
          } catch (supabaseError) {
            console.warn(`  ⚠️  Failed to sync to Supabase sage_stock_balances: ${supabaseError.message}`);
          }

          // Note: Do NOT overwrite fAverageCost — Sage's PostInventoryTxV2 handles weighted average calculation internally
          console.log(`  ℹ️  Sage handles weighted average cost internally (no manual overwrite)`);
        }
      );
    }

  } finally {
    // Close ONCE after all operations complete
    if (pool) await sql.close();
    console.log(`  Connection closed.`);
  }
}

module.exports = { handleGoodsReceipt };
