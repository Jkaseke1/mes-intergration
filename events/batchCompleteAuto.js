const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const sql = require('mssql');
const { createClient } = require('@supabase/supabase-js');
const { postInventoryTransaction } = require('./lib/sagePost');

const DRY_RUN = process.env.DRY_RUN === 'true';
const FG_WAREHOUSE_ID = parseInt(process.env.SAGE_FG_WAREHOUSE_ID, 10) || 19;
const FG_TRANSFER_WAREHOUSE_ID = parseInt(process.env.SAGE_FG_TRANSFER_WAREHOUSE_ID, 10) || 17;

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

async function handleBatchComplete(syncEvent) {
  console.log('\n  → Event 3: Batch Complete (Auto)');

  const orderId = syncEvent.reference_id;

  const { data: order, error } = await supabase
    .from('production_orders')
    .select(`
      id, batch_number, actual_qty, actual_end,
      cost_per_unit, rejected_qty,
      formulations ( id, name, sage_code )
    `)
    .eq('id', orderId)
    .single();

  if (error || !order) throw new Error(`Production order not found: ${orderId}`);

  const sageCode = order.formulations?.sage_code;
  const netQty   = Number(order.actual_qty || 0) - Number(order.rejected_qty || 0);

  console.log(`  Batch: ${order.batch_number}`);
  console.log(`  Product: ${sageCode} — ${netQty}kg net`);

  if (!sageCode) throw new Error(`No sage_code for formulation`);
  if (netQty <= 0) throw new Error(`Invalid net quantity: ${netQty}`);

  // Fetch production order materials with sage_code for cost lookup
  const { data: materials } = await supabase
    .from('production_order_materials')
    .select('actual_qty, raw_material_id, raw_materials(sage_code, name)')
    .eq('production_order_id', orderId);

  // Cost calculated after Sage connection using live fAverageCost
  let totalMaterialCost = 0;
  let costPerUnit = 0;

  let pool;
  try {
    pool = await sql.connect(sageConfig);

    // Fetch live average costs from Sage WhseStk for each ingredient
    if (materials && materials.length > 0) {
      for (const mat of materials) {
        const matSageCode = mat.raw_materials?.sage_code;
        const actualQtyKg = Number(mat.actual_qty || 0);
        if (!matSageCode || actualQtyKg <= 0) continue;

        const costResult = await pool.request()
          .input('Code', sql.VarChar, matSageCode)
          .query(`
            SELECT TOP 1 AverageCost
            FROM _bvWarehouseStockFull
            WHERE Code = @Code
          `);

        const avgCost = costResult.recordset[0]?.AverageCost || 0;
        const lineCost = actualQtyKg * avgCost;
        totalMaterialCost += lineCost;
        console.log(`  Cost: ${matSageCode} @ $${avgCost}/kg \u00d7 ${actualQtyKg.toFixed(4)}kg = $${lineCost.toFixed(4)}`);
      }
    }

    costPerUnit = netQty > 0
      ? Math.round((totalMaterialCost / netQty) * 10000) / 10000
      : 0;

    console.log(`  Total material cost: $${totalMaterialCost.toFixed(4)} / ${netQty}kg = $${costPerUnit.toFixed(4)}/kg`);

    const stockResult = await pool.request()
      .input('Code', sql.VarChar, sageCode)
      .query(`SELECT StockLink, Description_1 FROM StkItem WHERE Code = @Code AND ItemActive = 1`);

    if (stockResult.recordset.length === 0) throw new Error(`${sageCode} not found in Sage`);

    const stockLink   = stockResult.recordset[0].StockLink;
    const reference   = `WO-${order.batch_number}`.substring(0, 20);
    const description = `${order.formulations?.name} complete`.substring(0, 40);

    const doTransfer = FG_TRANSFER_WAREHOUSE_ID && FG_TRANSFER_WAREHOUSE_ID !== FG_WAREHOUSE_ID;

    await safeWrite(
      `FG receipt${doTransfer ? ' + transfer to DEB' : ''}: ${netQty}kg of ${sageCode} into WhseID ${FG_WAREHOUSE_ID}${doTransfer ? ` then ${FG_TRANSFER_WAREHOUSE_ID}` : ''}`,
      async () => {
        await postInventoryTransaction(pool, {
          sageCode,
          transactionType: 'production',
          quantity: netQty,
          whseId: FG_WAREHOUSE_ID,
          unitCost: costPerUnit,
          reference,
          description,
          transactionDate: new Date()
        });

        console.log(`  ✅ Sage posted: ${sageCode} +${netQty}kg into WhseID ${FG_WAREHOUSE_ID}`);

        if (doTransfer) {
          await postInventoryTransaction(pool, {
            sageCode,
            transactionType: 'dispatch',
            quantity: -netQty,
            whseId: FG_WAREHOUSE_ID,
            unitCost: costPerUnit,
            reference,
            description: 'Transfer to DEB',
            transactionDate: new Date()
          });

          await postInventoryTransaction(pool, {
            sageCode,
            transactionType: 'dispatch',
            quantity: netQty,
            whseId: FG_TRANSFER_WAREHOUSE_ID,
            unitCost: costPerUnit,
            reference,
            description: 'Transfer from PD',
            transactionDate: new Date()
          });

          console.log(`  ✅ Transferred ${netQty}kg from WhseID ${FG_WAREHOUSE_ID} to WhseID ${FG_TRANSFER_WAREHOUSE_ID}`);
        }

        // Sync final balances to Supabase sage_stock_balances
        try {
          const finalWarehouseId = doTransfer ? FG_TRANSFER_WAREHOUSE_ID : FG_WAREHOUSE_ID;

          const existing = await pool.request()
            .input('StockID', sql.Int, stockLink)
            .input('WhseID',  sql.Int, finalWarehouseId)
            .query(`SELECT QtyOnHand FROM _etblStockQtys WHERE StockID = @StockID AND WhseID = @WhseID`);

          const newQty = existing.recordset.length > 0 ? existing.recordset[0].QtyOnHand : netQty;

          await supabase.rpc('set_sage_stock_balance', {
            p_sage_code: sageCode,
            p_warehouse_id: finalWarehouseId,
            p_quantity: newQty
          });
          console.log(`  ✅ Supabase sage_stock_balances synced: ${sageCode} → ${newQty}kg in WhseID ${finalWarehouseId}`);

          if (doTransfer) {
            const pdExisting = await pool.request()
              .input('StockID', sql.Int, stockLink)
              .input('WhseID',  sql.Int, FG_WAREHOUSE_ID)
              .query(`SELECT QtyOnHand FROM _etblStockQtys WHERE StockID = @StockID AND WhseID = @WhseID`);

            const pdQty = pdExisting.recordset.length > 0 ? pdExisting.recordset[0].QtyOnHand : 0;

            await supabase.rpc('set_sage_stock_balance', {
              p_sage_code: sageCode,
              p_warehouse_id: FG_WAREHOUSE_ID,
              p_quantity: pdQty
            });
            console.log(`  ✅ Supabase sage_stock_balances synced: ${sageCode} → ${pdQty}kg in WhseID ${FG_WAREHOUSE_ID}`);
          }
        } catch (supabaseError) {
          console.warn(`  ⚠️  Failed to sync to Supabase sage_stock_balances: ${supabaseError.message}`);
        }
      }
    );
  } finally {
    if (pool) await sql.close();
  }

  // Write calculated cost_per_unit back to Supabase production_orders
  if (costPerUnit > 0) {
    const { error: costUpdateError } = await supabase
      .from('production_orders')
      .update({
        cost_per_unit: costPerUnit,
        updated_at: new Date().toISOString()
      })
      .eq('id', orderId);

    if (costUpdateError) {
      console.warn(`  cost_per_unit write to Supabase failed: ${costUpdateError.message}`);
    } else {
      console.log(`  cost_per_unit saved to Supabase: $${costPerUnit.toFixed(4)}/kg`);
    }
  }
}

module.exports = { handleBatchComplete };