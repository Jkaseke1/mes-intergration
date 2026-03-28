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

  // Read the specific material line
  const { data: material, error } = await supabase
    .from('production_order_materials')
    .select(`
      id, actual_qty, unit_cost, issued_at,
      production_orders ( id, batch_number ),
      raw_materials ( id, name, sage_code )
    `)
    .eq('id', materialId)
    .single();

  if (error || !material) {
    throw new Error(`Material not found: ${materialId}`);
  }

  const sageCode   = material.raw_materials?.sage_code;
  const rmName     = material.raw_materials?.name;
  const batchNumber = material.production_orders?.batch_number;
  const actualQty  = Number(material.actual_qty || 0);

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

    await safeWrite(
      `Issue ${actualQty}kg of ${sageCode} for ${batchNumber}`,
      async () => {
        await pool.request()
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

        await pool.request()
          .input('StockID', sql.Int,   stockLink)
          .input('WhseID',  sql.Int,   18)
          .input('QtyOut',  sql.Float, actualQty)
          .query(`UPDATE _etblStockQtys SET QtyOnHand = QtyOnHand - @QtyOut WHERE StockID = @StockID AND WhseID = @WhseID`);
      }
    );
  } finally {
    if (pool) await sql.close();
  }
}

module.exports = { handleGoodsIssue };