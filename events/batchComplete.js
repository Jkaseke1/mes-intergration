const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const sql = require('mssql');
const { createClient } = require('@supabase/supabase-js');

const DRY_RUN = process.env.DRY_RUN === 'true';
const FG_WAREHOUSE_ID = parseInt(process.env.SAGE_FG_WAREHOUSE_ID, 10) || 19;

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

async function getStockLink(pool, sageCode) {
  const result = await pool.request()
    .input('Code', sql.VarChar, sageCode)
    .query(`
      SELECT StockLink, Code, Description_1
      FROM StkItem
      WHERE Code = @Code
      AND ItemActive = 1
    `);
  if (result.recordset.length === 0) {
    throw new Error(`Stock code ${sageCode} not found in Sage`);
  }
  return result.recordset[0];
}

// ─── Event 3: Batch Complete ──────────────────────────────────────────────────
// Triggered when production_order status = 'completed'
// Receives finished goods into Sage Despatch Warehouse (WhseLink 20)
async function handleBatchComplete(batchData) {
  console.log('\n─── Event 3: Batch Complete ──────────────────────────────');
  console.log(`Batch         : ${batchData.batch_number}`);
  console.log(`Product       : ${batchData.product_name} (${batchData.product_sage_code})`);
  console.log(`Qty produced  : ${batchData.quantity_produced} ${batchData.unit}`);
  console.log(`Qty rejected  : ${batchData.rejected_quantity} ${batchData.unit}`);
  console.log(`Net qty       : ${batchData.quantity_produced - batchData.rejected_quantity} ${batchData.unit}`);
  console.log(`Mode          : ${DRY_RUN ? 'DRY RUN' : 'LIVE WRITE'}`);
  console.log('──────────────────────────────────────────────────────────');

  const netQty = batchData.quantity_produced - batchData.rejected_quantity;

  if (netQty <= 0) {
    console.error('❌ Net quantity is zero or negative — nothing to receive');
    return;
  }

  let pool;

  try {
    pool = await sql.connect(sageConfig);

    // Step 1: Look up finished product StockLink in Sage
    let stockItem;
    try {
      stockItem = await getStockLink(pool, batchData.product_sage_code);
      console.log(`\nSage StockLink : ${stockItem.StockLink} — ${stockItem.Description_1}`);
    } catch (err) {
      console.error(`❌ ${err.message}`);
      return;
    }

    // Step 2: Check current FG qty in Production Warehouse (FG_WAREHOUSE_ID)
    const qtyCheck = await pool.request()
      .input('StockID', sql.Int, stockItem.StockLink)
      .input('WhseID',  sql.Int, FG_WAREHOUSE_ID)
      .query(`
        SELECT QtyOnHand
        FROM _etblStockQtys
        WHERE StockID = @StockID
        AND WhseID = @WhseID
      `);

    const currentQty = qtyCheck.recordset[0]?.QtyOnHand ?? 0;
    console.log(`Current FG qty : ${currentQty} ${batchData.unit} in Production Warehouse (WhseID ${FG_WAREHOUSE_ID})`);
    console.log(`Receiving      : ${netQty} ${batchData.unit}`);
    console.log(`Expected after : ${currentQty + netQty} ${batchData.unit}`);

    const reference   = `WO-${batchData.batch_number}`.substring(0, 20);
    const description = `${batchData.product_name} batch complete`.substring(0, 40);

    // Step 3: Write FG receipt journal line to Sage
    // fQtyIn on finished goods = production output received into stock
    await safeWrite(
      `FG receipt: ${netQty}${batchData.unit} of ${batchData.product_sage_code} into Production Warehouse (WhseID ${FG_WAREHOUSE_ID})`,
      async () => {
        await pool.request()
          .input('iInvJrBatchID', sql.Int,      1)
          .input('iStockID',      sql.Int,      stockItem.StockLink)
          .input('iWarehouseID',  sql.Int,      FG_WAREHOUSE_ID)
          .input('dTrDate',       sql.DateTime, new Date(batchData.completion_date))
          .input('iTrCodeID',     sql.Int,      31)
          .input('iGLContraID',   sql.Int,      0)
          .input('cReference',    sql.VarChar,  reference)
          .input('cDescription',  sql.VarChar,  description)
          .input('fQtyIn',        sql.Float,    netQty)
          .input('fQtyOut',       sql.Float,    0)
          .input('fNewCost',      sql.Float,    batchData.cost_per_unit ?? 0)
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
      }
    );

    // Step 4: Update FG QtyOnHand in Production Warehouse
    await safeWrite(
      `Update FG QtyOnHand: ${batchData.product_sage_code} +${netQty} in Production Warehouse (WhseID ${FG_WAREHOUSE_ID})`,
      async () => {
        const existing = await pool.request()
          .input('StockID', sql.Int, stockItem.StockLink)
          .input('WhseID',  sql.Int, FG_WAREHOUSE_ID)
          .query(`
            SELECT idStockQtys, QtyOnHand
            FROM _etblStockQtys
            WHERE StockID = @StockID
            AND WhseID = @WhseID
          `);

        if (existing.recordset.length > 0) {
          await pool.request()
            .input('StockID', sql.Int,   stockItem.StockLink)
            .input('WhseID',  sql.Int,   FG_WAREHOUSE_ID)
            .input('QtyIn',   sql.Float, netQty)
            .query(`
              UPDATE _etblStockQtys
              SET QtyOnHand = QtyOnHand + @QtyIn
              WHERE StockID = @StockID
              AND WhseID = @WhseID
            `);
          console.log(`  QtyOnHand updated: ${currentQty} → ${currentQty + netQty}`);
        } else {
          await pool.request()
            .input('StockID', sql.Int,   stockItem.StockLink)
            .input('WhseID',  sql.Int,   FG_WAREHOUSE_ID)
            .input('QtyIn',   sql.Float, netQty)
            .query(`
              INSERT INTO _etblStockQtys (StockID, WhseID, QtyOnHand)
              VALUES (@StockID, @WhseID, @QtyIn)
            `);
          console.log(`  New FG stock row created: ${netQty} ${batchData.unit}`);
        }
      }
    );

    // Step 5: Log rejected quantity if any
    if (batchData.rejected_quantity > 0) {
      console.log(`\n⚠️  Rejected qty: ${batchData.rejected_quantity} ${batchData.unit}`);
      console.log(`   This should be investigated and posted as a variance`);
    }

    console.log('\n✅ Batch completion processing complete');
    console.log(`   ${batchData.batch_number} — ${netQty}${batchData.unit} of ${batchData.product_name} received into Production Warehouse (WhseID ${FG_WAREHOUSE_ID})`);

  } catch (err) {
    console.error('\n❌ Batch complete failed:', err.message);
    throw err;
  } finally {
    if (pool) await sql.close();
  }
}

// ─── Test data ────────────────────────────────────────────────────────────────
const testBatch = {
  batch_number:       'BATCH-2026-001',
  product_name:       'Broiler Starter Crumbs 50kg',
  product_sage_code:  'BSC50',
  quantity_produced:  3480,
  rejected_quantity:  0,
  unit:               'kg',
  completion_date:    '2026-03-28',
  cost_per_unit:      0.52,
};

handleBatchComplete(testBatch);