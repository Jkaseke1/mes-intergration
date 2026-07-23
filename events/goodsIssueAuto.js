const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const sql = require('mssql');
const { createClient } = require('@supabase/supabase-js');
const { saveForReview } = require('./lib/reviewQueue');
const { syncMaterialStock } = require('./lib/syncStock');

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

const RM_WAREHOUSE_ID = parseInt(process.env.SAGE_RM_WAREHOUSE_ID, 10) || 18;

async function queueIssueLine(pool, syncEvent, { sageCode, actualQty, batchNumber, materialName }) {
  if (!sageCode) throw new Error(`No sage_code for material ${materialName || 'unknown'}`);
  if (actualQty <= 0) throw new Error(`Invalid quantity for ${sageCode}: ${actualQty}`);

  const stockResult = await pool.request()
    .input('Code', sql.VarChar, sageCode)
    .query(`SELECT StockLink FROM StkItem WHERE Code = @Code AND ItemActive = 1`);

  if (stockResult.recordset.length === 0) {
    throw new Error(`${sageCode} not found in Sage`);
  }

  const stockLink = stockResult.recordset[0].StockLink;
  const reference = `WO-${batchNumber}`.substring(0, 20);
  const description = `Issue to ${batchNumber}`.substring(0, 40);

  const costResult = await pool.request()
    .input('Code', sql.VarChar, sageCode)
    .query(`SELECT TOP 1 AverageCost FROM _bvWarehouseStockFull WHERE Code = @Code`);
  const avgCost = costResult.recordset[0]?.AverageCost || 0;
  console.log(`  Sage AverageCost: ${sageCode} = $${avgCost.toFixed(4)}/kg`);

  const stockCheck = await pool.request()
    .input('StockID', sql.Int, stockLink)
    .input('WhseID',  sql.Int, RM_WAREHOUSE_ID)
    .query(`SELECT QtyOnHand FROM _etblStockQtys WHERE StockID = @StockID AND WhseID = @WhseID`);

  const currentStock = stockCheck.recordset.length > 0 ? stockCheck.recordset[0].QtyOnHand : 0;
  if (currentStock < actualQty) {
    throw new Error(`Insufficient stock: ${sageCode} has ${currentStock}kg but ${actualQty}kg requested`);
  }

  await saveForReview(syncEvent.id, 'materials_issued', `RM Issue ${batchNumber}`, {
    sageCode,
    transactionType: 'issue',
    quantity: -actualQty,
    whseId: RM_WAREHOUSE_ID,
    unitCost: avgCost,
    reference,
    description,
    transactionDate: new Date(),
  });
}

async function handleGoodsIssue(syncEvent) {
  console.log('\n  → Event 2: Goods Issue (Auto) — Review Queue Mode');

  const refId = syncEvent.reference_id;
  const refType = syncEvent.reference_type || '';

  let pool;
  try {
    pool = await sql.connect(sageConfig);

    // Preferred path: one event per production order (all issued lines)
    if (refType === 'production_orders') {
      const { data: order, error: orderErr } = await supabase
        .from('production_orders')
        .select('id, batch_number')
        .eq('id', refId)
        .single();

      if (orderErr || !order) throw new Error(`Production order not found: ${refId}`);

      const { data: materials, error: matErr } = await supabase
        .from('production_order_materials')
        .select('id, actual_qty, issued, raw_material_id, raw_materials(id, name, sage_code)')
        .eq('production_order_id', refId)
        .eq('issued', true);

      if (matErr) throw new Error(`Materials query failed: ${matErr.message}`);
      if (!materials || materials.length === 0) {
        throw new Error(`No issued materials for order ${order.batch_number}`);
      }

      console.log(`  Batch: ${order.batch_number}`);
      console.log(`  Issued lines: ${materials.length} (single finance approval package)`);

      for (const material of materials) {
        const rm = Array.isArray(material.raw_materials)
          ? material.raw_materials[0]
          : material.raw_materials;
        const sageCode = rm?.sage_code;
        const actualQty = Number(material.actual_qty || 0);
        console.log(`  Material: ${sageCode} — ${actualQty}kg`);
        await queueIssueLine(pool, syncEvent, {
          sageCode,
          actualQty,
          batchNumber: order.batch_number,
          materialName: rm?.name,
        });
      }
      return;
    }

    // Legacy path: one event per production_order_materials row
    const { data: material, error } = await supabase
      .from('production_order_materials')
      .select('id, actual_qty, unit_cost, issued_at, production_order_id, raw_material_id')
      .eq('id', refId)
      .single();

    if (error || !material) {
      throw new Error(`Material not found: ${refId}`);
    }

    const { data: order } = await supabase
      .from('production_orders')
      .select('id, batch_number')
      .eq('id', material.production_order_id)
      .single();

    const { data: rm } = await supabase
      .from('raw_materials')
      .select('id, name, sage_code')
      .eq('id', material.raw_material_id)
      .single();

    console.log(`  Batch: ${order?.batch_number}`);
    console.log(`  Material (legacy single-line): ${rm?.sage_code} — ${material.actual_qty}kg`);

    await queueIssueLine(pool, syncEvent, {
      sageCode: rm?.sage_code,
      actualQty: Number(material.actual_qty || 0),
      batchNumber: order?.batch_number,
      materialName: rm?.name,
    });
  } finally {
    if (pool) await sql.close();
  }
}

module.exports = { handleGoodsIssue };
