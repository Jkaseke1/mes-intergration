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

async function handleGoodsIssue(syncEvent) {
  console.log('\n  → Event 2: Goods Issue (Auto)');

  const materialId = syncEvent.reference_id;

  const { data: material, error } = await supabase
    .from('production_order_materials')
    .select('id, actual_qty, unit_cost, issued_at, production_order_id, raw_material_id')
    .eq('id', materialId)
    .single();

  if (error || !material) {
    throw new Error(`Material not found: ${materialId}`);
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

  const sageCode    = rm?.sage_code;
  const batchNumber = order?.batch_number;
  const actualQty   = Number(material.actual_qty || 0);

  console.log(`  Batch: ${batchNumber}`);
  console.log(`  Material: ${sageCode} — ${actualQty}kg`);

  if (!sageCode) throw new Error(`No sage_code for material ${materialId}`);
  if (actualQty <= 0) throw new Error(`Invalid quantity: ${actualQty}`);

  let pool;
  try {
    pool = await sql.connect(sageConfig);

    const stockResult = await pool.request()
      .input('Code', sql.VarChar, sageCode)
      .query(`SELECT StockLink FROM StkItem WHERE Code = @Code AND ItemActive = 1`);

    if (stockResult.recordset.length === 0) {
      throw new Error(`${sageCode} not found in Sage`);
    }

    const stockLink   = stockResult.recordset[0].StockLink;
    const reference   = `WO-${batchNumber}`.substring(0, 20);
    const description = `Issue to ${batchNumber}`.substring(0, 40);

    // Fetch live AverageCost from Sage (pre-MES logic: MFDR uses moving average cost, not form cost)
    const costResult = await pool.request()
      .input('Code', sql.VarChar, sageCode)
      .query(`SELECT TOP 1 AverageCost FROM _bvWarehouseStockFull WHERE Code = @Code`);
    const avgCost = costResult.recordset[0]?.AverageCost || 0;
    console.log(`  Sage AverageCost: ${sageCode} = $${avgCost.toFixed(4)}/kg`);

    // Check current stock before issuing
    const stockCheck = await pool.request()
      .input('StockID', sql.Int, stockLink)
      .input('WhseID',  sql.Int, 18)
      .query(`SELECT QtyOnHand FROM _etblStockQtys WHERE StockID = @StockID AND WhseID = @WhseID`);

    const currentStock = stockCheck.recordset.length > 0 ? stockCheck.recordset[0].QtyOnHand : 0;
    
    if (currentStock < actualQty) {
      throw new Error(`Insufficient stock: ${sageCode} has ${currentStock}kg but ${actualQty}kg requested`);
    }

    await safeWrite(
      `Issue ${actualQty}kg of ${sageCode} for ${batchNumber}`,
      async () => {
        await postInventoryTransaction(pool, {
          sageCode,
          transactionType: 'issue',
          quantity: -actualQty,
          whseId: 18,
          unitCost: avgCost,
          reference,
          description,
          transactionDate: new Date()
        });

        console.log(`  ✅ Sage posted: ${sageCode} -${actualQty}kg from WhseID 18`);

        // Sync to Supabase sage_stock_balances
        try {
          const newQty = currentStock - actualQty;
          await supabase.rpc('set_sage_stock_balance', {
            p_sage_code: sageCode,
            p_warehouse_id: 18,
            p_quantity: newQty
          });
          console.log(`  ✅ Supabase sage_stock_balances synced: ${sageCode} → ${newQty}kg`);
        } catch (supabaseError) {
          console.warn(`  ⚠️  Failed to sync to Supabase sage_stock_balances: ${supabaseError.message}`);
        }
      }
    );
  } finally {
    if (pool) await sql.close();
  }
}

module.exports = { handleGoodsIssue };