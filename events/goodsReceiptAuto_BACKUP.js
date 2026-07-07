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

  // Read supplier separately
  const { data: supplier } = await supabase
    .from('suppliers')
    .select('id, name, sage_code')
    .eq('id', grn.supplier_id)
    .single();

  console.log(`  GRN: ${grn.grn_number} — ${supplier?.name}`);

  // Read GRN line items with debug
  const { data: items, error: itemsError } = await supabase
    .from('grn_items')
    .select('id, received_qty, unit_cost, raw_material_id')
    .eq('grn_id', grnId);

  console.log(`  Items debug: count=${items?.length} error=${itemsError?.message} data=${JSON.stringify(items)}`);

  if (itemsError) {
    throw new Error(`Items query error: ${itemsError.message}`);
  }

  if (!items || items.length === 0) {
    throw new Error(`No items found for GRN: ${grn.grn_number}`);
  }

  console.log(`  Items: ${items.length} line(s)`);

  // Fetch raw material details for each line
  for (const item of items) {
    const { data: rm } = await supabase
      .from('raw_materials')
      .select('id, name, sage_code')
      .eq('id', item.raw_material_id)
      .single();
    item.raw_materials = rm;
    console.log(`  RM lookup: ${item.raw_material_id} → ${rm?.name} (${rm?.sage_code})`);
  }

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

      const stockResult = await pool.request()
        .input('Code', sql.VarChar, sageCode)
        .query(`SELECT StockLink, Description_1 FROM StkItem WHERE Code = @Code AND ItemActive = 1`);

      if (stockResult.recordset.length === 0) {
        console.log(`  ⚠️  ${sageCode} not found in Sage — skipping`);
        continue;
      }

      const stockLink   = stockResult.recordset[0].StockLink;
      const reference   = grn.grn_number.substring(0, 20);
      const description = (rmName || sageCode).substring(0, 40);

      console.log(`  Processing: ${sageCode} — ${item.received_qty}kg`);

      await safeWrite(
        `GRN ${grn.grn_number} — ${sageCode} +${item.received_qty}kg`,
        async () => {
          await pool.request()
            .input('iInvJrBatchID', sql.Int,      2)
            .input('iStockID',      sql.Int,      stockLink)
            .input('iWarehouseID',  sql.Int,      18)
            .input('dTrDate',       sql.DateTime, new Date(grn.received_date))
            .input('iTrCodeID',     sql.Int,      31)
            .input('iGLContraID',   sql.Int,      0)
            .input('cReference',    sql.VarChar,  reference)
            .input('cDescription',  sql.VarChar,  description)
            .input('fQtyIn',        sql.Float,    Number(item.received_qty))
            .input('fQtyOut',       sql.Float,    0)
            .input('fNewCost',      sql.Float,    Number(item.unit_cost || 0))
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
            .input('WhseID',  sql.Int, 18)
            .query(`
              SELECT idStockQtys FROM _etblStockQtys 
              WHERE StockID = @StockID AND WhseID = @WhseID
            `);

          if (existing.recordset.length > 0) {
            await pool.request()
              .input('StockID', sql.Int,   stockLink)
              .input('WhseID',  sql.Int,   18)
              .input('QtyIn',   sql.Float, Number(item.received_qty))
              .query(`
                UPDATE _etblStockQtys 
                SET QtyOnHand = QtyOnHand + @QtyIn 
                WHERE StockID = @StockID AND WhseID = @WhseID
              `);
          } else {
            await pool.request()
              .input('StockID', sql.Int,   stockLink)
              .input('WhseID',  sql.Int,   18)
              .input('QtyIn',   sql.Float, Number(item.received_qty))
              .query(`
                INSERT INTO _etblStockQtys (StockID, WhseID, QtyOnHand) 
                VALUES (@StockID, @WhseID, @QtyIn)
              `);
          }
        }
      );
    }
  } finally {
    if (pool) await sql.close();
  }
}

module.exports = { handleGoodsReceipt };