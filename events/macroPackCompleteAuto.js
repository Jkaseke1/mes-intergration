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

  const costMap = {}; // sageCode -> fAverageCost from Sage
  let totalCostUSD = 0;
  let costPerUnit = 0;

  let pool;
  try {
    pool = await sql.connect(sageConfig);
    const trDate = new Date(order.manufacture_date || new Date());
    const macroCode = bom?.macropack_code || 'MP';

    // Fetch average costs from Sage for each ingredient
    for (const issue of issues) {
      const sageCode = issue.raw_materials?.sage_code;
      if (!sageCode) continue;
      const costResult = await pool.request()
        .input('Code', sql.VarChar, sageCode)
        .query(`
          SELECT TOP 1 AverageCost
          FROM _bvWarehouseStockFull
          WHERE Code = @Code
        `);
      const avgCost = costResult.recordset[0]?.AverageCost || 0;
      costMap[sageCode] = avgCost;
      const qtyKg = Number(issue.actual_grams_dispensed || 0) / 1000;
      totalCostUSD += qtyKg * avgCost;
      console.log(`  Cost: ${sageCode} @ $${avgCost}/kg × ${qtyKg.toFixed(4)}kg = $${(qtyKg * avgCost).toFixed(4)}`);
    }

    const actualUnits = Number(order.actual_units || order.planned_units || 1);
    costPerUnit = actualUnits > 0 ? totalCostUSD / actualUnits : 0;
    console.log(`  Total ingredient cost: $${totalCostUSD.toFixed(4)} / ${actualUnits} units = $${costPerUnit.toFixed(4)}/unit`);

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
          await postInventoryTransaction(pool, {
            sageCode,
            transactionType: 'macropack',
            quantity: -qtyKg,
            whseId: 18,
            unitCost: costMap[sageCode] || 0,
            reference,
            description,
            transactionDate: trDate
          });

          console.log(`  ✅ Sage posted: ${sageCode} -${qtyKg.toFixed(4)}kg from WhseID 18`);
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
            await postInventoryTransaction(pool, {
              sageCode: bom.macropack_code,
              transactionType: 'macropack',
              quantity: wipUnits,
              whseId: 19,
              unitCost: costPerUnit,
              reference: wipRef,
              description: wipDesc,
              transactionDate: trDate
            });

            console.log(`  ✅ Sage posted: ${bom.macropack_code} +${wipUnits} units into WhseID 19`);
          }
        );
      } else {
        console.log(`  ⚠️  Macropack ${macroCode} not found in Sage StkItem — skipping WIP receipt`);
      }
    }
  } finally {
    if (pool) await sql.close();
  }

  // Write calculated cost back to Supabase
  if (costPerUnit > 0) {
    const { error: costUpdateError } = await supabase
      .from('macropack_manufacture_orders')
      .update({
        cost_per_unit: costPerUnit,
        updated_at: new Date().toISOString()
      })
      .eq('id', orderId);

    if (costUpdateError) {
      console.warn(`  ⚠️  cost_per_unit write to Supabase failed: ${costUpdateError.message}`);
    } else {
      console.log(`  ✅ cost_per_unit saved to Supabase: $${costPerUnit.toFixed(4)}`);
    }
  }
}

module.exports = { handleMacroPackComplete };
