const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const sql = require('mssql');
const { createClient } = require('@supabase/supabase-js');

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
          .input('WhseID', sql.Int, 18)
          .query(`
            SELECT TOP 1 AverageCost
            FROM _bvWarehouseStockFull
            WHERE Code = @Code AND WhseID = @WhseID
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

    await safeWrite(
      `FG receipt: ${netQty}kg of ${sageCode} into Despatch Warehouse`,
      async () => {
        await pool.request()
          .input('iInvJrBatchID', sql.Int,      1)
          .input('iStockID',      sql.Int,      stockLink)
          .input('iWarehouseID',  sql.Int,      20)
          .input('dTrDate',       sql.DateTime, new Date())
          .input('iTrCodeID',     sql.Int,      31)
          .input('iGLContraID',   sql.Int,      0)
          .input('cReference',    sql.VarChar,  reference)
          .input('cDescription',  sql.VarChar,  description)
          .input('fQtyIn',        sql.Float,    netQty)
          .input('fQtyOut',       sql.Float,    0)
          .input('fNewCost',      sql.Float,    costPerUnit)
          .input('bIsLotItem',    sql.Bit,      0)
          .input('bIsSerialItem', sql.Bit,      0)
          .query(`
            INSERT INTO _etblInvJrBatchLines (
              iInvJrBatchID, iStockID, iWarehouseID,
              dTrDate, iTrCodeID, iGLContraID,
              cReference, cDescription,
              fQtyIn, fQtyOut, fNewCost,
              bIsLotItem, bIsSerialItem
            ) VALUES (
              @iInvJrBatchID, @iStockID, @iWarehouseID,
              @dTrDate, @iTrCodeID, @iGLContraID,
              @cReference, @cDescription,
              @fQtyIn, @fQtyOut, @fNewCost,
              @bIsLotItem, @bIsSerialItem
            )
          `);

        const existing = await pool.request()
          .input('StockID', sql.Int, stockLink)
          .input('WhseID',  sql.Int, 20)
          .query(`SELECT idStockQtys FROM _etblStockQtys WHERE StockID = @StockID AND WhseID = @WhseID`);

        if (existing.recordset.length > 0) {
          await pool.request()
            .input('StockID', sql.Int,   stockLink)
            .input('WhseID',  sql.Int,   20)
            .input('QtyIn',   sql.Float, netQty)
            .query(`UPDATE _etblStockQtys SET QtyOnHand = QtyOnHand + @QtyIn WHERE StockID = @StockID AND WhseID = @WhseID`);
        } else {
          await pool.request()
            .input('StockID', sql.Int,   stockLink)
            .input('WhseID',  sql.Int,   20)
            .input('QtyIn',   sql.Float, netQty)
            .query(`INSERT INTO _etblStockQtys (StockID, WhseID, QtyOnHand) VALUES (@StockID, @WhseID, @QtyIn)`);
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