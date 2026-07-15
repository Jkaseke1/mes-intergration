const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const sql = require('mssql');
const { createClient } = require('@supabase/supabase-js');
const { saveForReview } = require('./lib/reviewQueue');

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

async function handleBatchComplete(syncEvent) {
  console.log('\n  → Event 3: Batch Complete (Auto) — Review Queue Mode');

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
  let fgAvgCost = 0;

  let pool;
  try {
    pool = await sql.connect(sageConfig);

    // Fetch live average costs from Sage for each ingredient (reporting only)
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

    console.log(`  Total material cost (RM only): $${totalMaterialCost.toFixed(4)} / ${netQty}kg = $${costPerUnit.toFixed(4)}/kg`);

    const stockResult = await pool.request()
      .input('Code', sql.VarChar, sageCode)
      .query(`SELECT StockLink, Description_1 FROM StkItem WHERE Code = @Code AND ItemActive = 1`);

    if (stockResult.recordset.length === 0) throw new Error(`${sageCode} not found in Sage`);

    // Fetch live AverageCost from Sage for FG (pre-MES logic: MFMF uses moving average cost)
    const fgCostResult = await pool.request()
      .input('Code', sql.VarChar, sageCode)
      .query(`SELECT TOP 1 AverageCost FROM _bvWarehouseStockFull WHERE Code = @Code`);
    fgAvgCost = fgCostResult.recordset[0]?.AverageCost || 0;
    console.log(`  Sage FG AverageCost: ${sageCode} = $${fgAvgCost.toFixed(4)}/kg (using this for MFMF + transfer)`);

    const reference   = `WO-${order.batch_number}`.substring(0, 20);
    const description = `${order.formulations?.name} complete`.substring(0, 40);

    const doTransfer = FG_TRANSFER_WAREHOUSE_ID && FG_TRANSFER_WAREHOUSE_ID !== FG_WAREHOUSE_ID;

    // 1. FG Receipt (MFMF) — save for review
    await saveForReview(syncEvent.id, 'production_completed', `MFMF ${sageCode} — ${order.formulations?.name}`, {
      sageCode,
      transactionType: 'production',
      quantity: netQty,
      whseId: FG_WAREHOUSE_ID,
      unitCost: fgAvgCost,
      reference,
      description,
      transactionDate: new Date(),
    });

    if (doTransfer) {
      // 2. PD issue (WHT out) — save for review
      await saveForReview(syncEvent.id, 'production_completed', `Transfer PD→DEB ${sageCode}`, {
        sageCode,
        transactionType: 'dispatch',
        quantity: -netQty,
        whseId: FG_WAREHOUSE_ID,
        unitCost: fgAvgCost,
        reference,
        description: 'Transfer to DEB',
        transactionDate: new Date(),
      });

      // 3. DEB receipt (WHT in) — save for review
      await saveForReview(syncEvent.id, 'production_completed', `Transfer DEB receipt ${sageCode}`, {
        sageCode,
        transactionType: 'dispatch',
        quantity: netQty,
        whseId: FG_TRANSFER_WAREHOUSE_ID,
        unitCost: fgAvgCost,
        reference,
        description: 'Transfer from PD',
        transactionDate: new Date(),
      });
    }

  } finally {
    if (pool) await sql.close();
  }

  // Write calculated RM cost_per_unit back to Supabase production_orders (for reporting/margin analysis only)
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
      console.log(`  RM cost_per_unit saved to Supabase (reporting only): $${costPerUnit.toFixed(4)}/kg | Sage AverageCost: $${fgAvgCost ? fgAvgCost.toFixed(4) : 'N/A'}/kg`);
    }
  }
}

module.exports = { handleBatchComplete };