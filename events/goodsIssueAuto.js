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
        const journalResult = await pool.request()
          .input('iInvJrBatchID', sql.Int,      2)
          .input('iStockID',      sql.Int,      stockLink)
          .input('iWarehouseID',  sql.Int,      18)
          .input('dTrDate',       sql.DateTime, new Date())
          .input('iTrCodeID',     sql.Int,      31)
          .input('iGLContraID',   sql.Int,      0)
          .input('cReference',    sql.VarChar,  reference)
          .input('cDescription',  sql.VarChar,  description)
          .input('fQtyIn',        sql.Float,    0)
          .input('fQtyOut',       sql.Float,    actualQty)
          .input('fNewCost',      sql.Float,    Number(material.unit_cost || 0))
          .input('iProjectID',    sql.Int,      0)
          .input('iJobID',        sql.Int,      0)
          .input('bIsLotItem',    sql.Bit,      0)
          .input('bIsSerialItem', sql.Bit,      0)
          .query(`
            INSERT INTO _etblInvJrBatchLines (
              iInvJrBatchID, iStockID, iWarehouseID,
              dTrDate, iTrCodeID, iGLContraID,
              cReference, cDescription,
              fQtyIn, fQtyOut, fNewCost,
              iProjectID, iJobID,
              bIsLotItem, bIsSerialItem
            ) OUTPUT INSERTED.idInvJrBatchLines
            VALUES (
              @iInvJrBatchID, @iStockID, @iWarehouseID,
              @dTrDate, @iTrCodeID, @iGLContraID,
              @cReference, @cDescription,
              @fQtyIn, @fQtyOut, @fNewCost,
              @iProjectID, @iJobID,
              @bIsLotItem, @bIsSerialItem
            )
          `);

        const insertedId = journalResult.recordset?.[0]?.idInvJrBatchLines;
        console.log(`  📌 Sage journal line idInvJrBatchLines = ${insertedId}`);

        await pool.request()
          .input('StockID', sql.Int,   stockLink)
          .input('WhseID',  sql.Int,   18)
          .input('QtyOut',  sql.Float, actualQty)
          .query(`
            UPDATE _etblStockQtys 
            SET QtyOnHand = QtyOnHand - @QtyOut 
            WHERE StockID = @StockID AND WhseID = @WhseID
          `);
      }
    );
  } finally {
    if (pool) await sql.close();
  }
}

module.exports = { handleGoodsIssue };