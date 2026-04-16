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

async function handleMacroPackComplete(syncEvent) {
  console.log('\n  → Event 7: Macropack Manufactured (Auto)');

  const orderId = syncEvent.reference_id;
  console.log(`  Order ID: ${orderId}`);

  // Read manufacture order
  const { data: order, error: orderError } = await supabase
    .from('macropack_manufacture_orders')
    .select('id, macropack_bom_id, planned_units, actual_units, manufacture_date, status')
    .eq('id', orderId)
    .single();

  if (orderError || !order) {
    throw new Error(`Manufacture order not found: ${orderId} — ${orderError?.message}`);
  }

  if (order.status !== 'COMPLETED') {
    throw new Error(`Order ${orderId} is not COMPLETED (status: ${order.status})`);
  }

  // Read BOM info
  const { data: bom } = await supabase
    .from('macropack_boms')
    .select('id, macropack_code, macropack_name')
    .eq('id', order.macropack_bom_id)
    .single();

  console.log(`  Macropack: ${bom?.macropack_code} — ${bom?.macropack_name}`);
  console.log(`  Units: ${order.actual_units || order.planned_units}`);

  // Read all issues for this order
  const { data: issues, error: issuesError } = await supabase
    .from('macropack_manufacture_issues')
    .select('id, raw_material_id, expected_grams, actual_grams_dispensed')
    .eq('manufacture_order_id', orderId);

  if (issuesError) {
    throw new Error(`Issues query error: ${issuesError.message}`);
  }

  if (!issues || issues.length === 0) {
    throw new Error(`No issue lines found for order: ${orderId}`);
  }

  console.log(`  Issues: ${issues.length} ingredient(s)`);

  // Fetch raw material details for each issue line
  for (const issue of issues) {
    const { data: rm } = await supabase
      .from('raw_materials')
      .select('id, name, sage_code')
      .eq('id', issue.raw_material_id)
      .single();
    issue.raw_materials = rm;
    console.log(`  RM: ${rm?.sage_code} — dispensed ${issue.actual_grams_dispensed}g`);
  }

  let pool;
  try {
    pool = await sql.connect(sageConfig);
    const trDate = new Date(order.manufacture_date || new Date());
    const macroCode = bom?.macropack_code || 'MP';

    // Step 1: Issue each ingredient from RM warehouse (WhseID 18)
    for (const issue of issues) {
      const sageCode = issue.raw_materials?.sage_code;
      const rmName   = issue.raw_materials?.name;

      if (!sageCode) {
        console.log(`  ⚠️  No sage_code for ingredient — skipping`);
        continue;
      }

      const qtyKg = Number(issue.actual_grams_dispensed || 0) / 1000; // grams to kg
      if (qtyKg <= 0) {
        console.log(`  ⚠️  Zero qty for ${sageCode} — skipping`);
        continue;
      }

      const stockResult = await pool.request()
        .input('Code', sql.VarChar, sageCode)
        .query(`SELECT StockLink FROM StkItem WHERE Code = @Code AND ItemActive = 1`);

      if (stockResult.recordset.length === 0) {
        console.log(`  ⚠️  ${sageCode} not found in Sage — skipping`);
        continue;
      }

      const stockLink   = stockResult.recordset[0].StockLink;
      const reference   = `MP-${macroCode}`.substring(0, 20);
      const description = `Macropack issue ${rmName || sageCode}`.substring(0, 40);

      console.log(`  Issuing: ${sageCode} — ${qtyKg.toFixed(4)}kg from WhseID 18`);

      await safeWrite(
        `Issue ${qtyKg.toFixed(4)}kg of ${sageCode} for macropack ${macroCode}`,
        async () => {
          await pool.request()
            .input('iInvJrBatchID', sql.Int,      2)
            .input('iStockID',      sql.Int,      stockLink)
            .input('iWarehouseID',  sql.Int,      18)
            .input('dTrDate',       sql.DateTime, trDate)
            .input('iTrCodeID',     sql.Int,      31)
            .input('iGLContraID',   sql.Int,      0)
            .input('cReference',    sql.VarChar,  reference)
            .input('cDescription',  sql.VarChar,  description)
            .input('fQtyIn',        sql.Float,    0)
            .input('fQtyOut',       sql.Float,    qtyKg)
            .input('fNewCost',      sql.Float,    0)
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
            .input('QtyOut',  sql.Float, qtyKg)
            .query(`
              UPDATE _etblStockQtys 
              SET QtyOnHand = QtyOnHand - @QtyOut 
              WHERE StockID = @StockID AND WhseID = @WhseID
            `);
        }
      );
    }

    // Step 2: Receipt of macropack WIP into Production warehouse (WhseID 19)
    const wipUnits = Number(order.actual_units || order.planned_units || 0);

    if (wipUnits > 0 && bom?.macropack_code) {
      const wipStockResult = await pool.request()
        .input('Code', sql.VarChar, bom.macropack_code)
        .query(`SELECT StockLink FROM StkItem WHERE Code = @Code AND ItemActive = 1`);

      if (wipStockResult.recordset.length > 0) {
        const wipStockLink = wipStockResult.recordset[0].StockLink;
        const wipRef       = `MP-${macroCode}`.substring(0, 20);
        const wipDesc      = `Macropack WIP ${bom.macropack_name}`.substring(0, 40);

        console.log(`  Receipt: ${wipUnits} units of ${macroCode} into WhseID 19`);

        await safeWrite(
          `Receipt ${wipUnits} units of ${macroCode} into Production warehouse`,
          async () => {
            await pool.request()
              .input('iInvJrBatchID', sql.Int,      2)
              .input('iStockID',      sql.Int,      wipStockLink)
              .input('iWarehouseID',  sql.Int,      19)
              .input('dTrDate',       sql.DateTime, trDate)
              .input('iTrCodeID',     sql.Int,      31)
              .input('iGLContraID',   sql.Int,      0)
              .input('cReference',    sql.VarChar,  wipRef)
              .input('cDescription',  sql.VarChar,  wipDesc)
              .input('fQtyIn',        sql.Float,    wipUnits)
              .input('fQtyOut',       sql.Float,    0)
              .input('fNewCost',      sql.Float,    0)
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
              .input('StockID', sql.Int, wipStockLink)
              .input('WhseID',  sql.Int, 19)
              .query(`
                SELECT idStockQtys FROM _etblStockQtys 
                WHERE StockID = @StockID AND WhseID = @WhseID
              `);

            if (existing.recordset.length > 0) {
              await pool.request()
                .input('StockID', sql.Int,   wipStockLink)
                .input('WhseID',  sql.Int,   19)
                .input('QtyIn',   sql.Float, wipUnits)
                .query(`
                  UPDATE _etblStockQtys 
                  SET QtyOnHand = QtyOnHand + @QtyIn 
                  WHERE StockID = @StockID AND WhseID = @WhseID
                `);
            } else {
              await pool.request()
                .input('StockID', sql.Int,   wipStockLink)
                .input('WhseID',  sql.Int,   19)
                .input('QtyIn',   sql.Float, wipUnits)
                .query(`
                  INSERT INTO _etblStockQtys (StockID, WhseID, QtyOnHand) 
                  VALUES (@StockID, @WhseID, @QtyIn)
                `);
            }
          }
        );
      } else {
        console.log(`  ⚠️  Macropack ${macroCode} not found in Sage StkItem — skipping WIP receipt`);
      }
    }
  } finally {
    if (pool) await sql.close();
  }
}

module.exports = { handleMacroPackComplete };
