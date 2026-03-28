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

// ─── Safe write wrapper ───────────────────────────────────────────────────────
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

// ─── Get StockLink from Sage by sage_code ─────────────────────────────────────
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

// ─── Event 2: Goods Issue ─────────────────────────────────────────────────────
// Triggered when production_order_materials.issued = true
// Writes a stock issue line into Sage — reduces QtyOnHand
async function handleGoodsIssue(issueData) {
  console.log('\n─── Event 2: Goods Issue ─────────────────────────────────');
  console.log(`Batch         : ${issueData.batch_number}`);
  console.log(`Formulation   : ${issueData.formulation_name}`);
  console.log(`Planned qty   : ${issueData.planned_qty} ${issueData.unit}`);
  console.log(`Materials     : ${issueData.materials.length} ingredient(s)`);
  console.log(`Mode          : ${DRY_RUN ? 'DRY RUN' : 'LIVE WRITE'}`);
  console.log('──────────────────────────────────────────────────────────');

  let pool;

  try {
    pool = await sql.connect(sageConfig);

    for (const material of issueData.materials) {
      console.log(`\nProcessing: ${material.raw_material_name} (${material.sage_code})`);
      console.log(`  Planned qty : ${material.planned_qty} kg`);
      console.log(`  Actual qty  : ${material.actual_qty} kg`);
      console.log(`  Variance    : ${(material.actual_qty - material.planned_qty).toFixed(3)} kg`);

      // Step 1: Look up StockLink from Sage
      let stockItem;
      try {
        stockItem = await getStockLink(pool, material.sage_code);
        console.log(`  Sage StockLink: ${stockItem.StockLink} — ${stockItem.Description_1}`);
      } catch (err) {
        console.error(`  ❌ ${err.message} — skipping`);
        continue;
      }

      // Step 2: Check current QtyOnHand — safety check
      const qtyCheck = await pool.request()
        .input('StockID', sql.Int, stockItem.StockLink)
        .input('WhseID',  sql.Int, 18)
        .query(`
          SELECT QtyOnHand
          FROM _etblStockQtys
          WHERE StockID = @StockID
          AND WhseID = @WhseID
        `);

      const currentQty = qtyCheck.recordset[0]?.QtyOnHand ?? 0;
      console.log(`  Current QtyOnHand: ${currentQty} kg`);

      if (currentQty < material.actual_qty && !DRY_RUN) {
        console.warn(`  ⚠️  WARNING: Issuing ${material.actual_qty}kg but only ${currentQty}kg on hand`);
        console.warn(`  ⚠️  Proceeding — Sage allows negative stock — but investigate`);
      }

      const reference = `WO-${issueData.batch_number}`;
      const description = `Issue to ${issueData.batch_number} — ${material.raw_material_name}`;

      // Step 3: Write goods issue journal line to Sage
      await safeWrite(
        `Issue ${material.actual_qty}kg of ${material.sage_code} for batch ${issueData.batch_number}`,
        async () => {
          await pool.request()
            .input('iInvJrBatchID', sql.Int,      2)
            .input('iStockID',      sql.Int,      stockItem.StockLink)
            .input('iWarehouseID',  sql.Int,      18)
            .input('dTrDate',       sql.DateTime, new Date(issueData.issue_date))
            .input('iTrCodeID',     sql.Int,      31)
            .input('iGLContraID',   sql.Int,      0)
            .input('cReference',    sql.VarChar,  reference.substring(0, 20))
            .input('cDescription',  sql.VarChar,  description.substring(0, 40))
            .input('fQtyIn',        sql.Float,    0)
            .input('fQtyOut',       sql.Float,    material.actual_qty)
            .input('fNewCost',      sql.Float,    material.unit_cost ?? 0)
            .input('bIsLotItem',    sql.Bit,      0)
            .input('bIsSerialItem', sql.Bit,      0)
            .query(`
              INSERT INTO _etblInvJrBatchLines (
                iInvJrBatchID,
                iStockID,
                iWarehouseID,
                dTrDate,
                iTrCodeID,
                iGLContraID,
                cReference,
                cDescription,
                fQtyIn,
                fQtyOut,
                fNewCost,
                bIsLotItem,
                bIsSerialItem
              ) VALUES (
                @iInvJrBatchID,
                @iStockID,
                @iWarehouseID,
                @dTrDate,
                @iTrCodeID,
                @iGLContraID,
                @cReference,
                @cDescription,
                @fQtyIn,
                @fQtyOut,
                @fNewCost,
                @bIsLotItem,
                @bIsSerialItem
              )
            `);
        }
      );

      // Step 4: Reduce QtyOnHand in Sage
      await safeWrite(
        `Reduce QtyOnHand: ${material.sage_code} -${material.actual_qty}kg in warehouse 18`,
        async () => {
          await pool.request()
            .input('StockID', sql.Int,   stockItem.StockLink)
            .input('WhseID',  sql.Int,   18)
            .input('QtyOut',  sql.Float, material.actual_qty)
            .query(`
              UPDATE _etblStockQtys
              SET QtyOnHand = QtyOnHand - @QtyOut
              WHERE StockID = @StockID
              AND WhseID = @WhseID
            `);
          console.log(`  QtyOnHand reduced: ${currentQty} → ${currentQty - material.actual_qty}`);
        }
      );
    }

    console.log('\n✅ Goods issue processing complete');
    console.log(`   Batch ${issueData.batch_number} — all ingredients issued to production`);

  } catch (err) {
    console.error('\n❌ Goods issue failed:', err.message);
    throw err;
  } finally {
    if (pool) await sql.close();
  }
}

// ─── Test data ────────────────────────────────────────────────────────────────
// Simulates a production batch starting and consuming ingredients
// This mirrors what production_order_materials looks like when issued = true
const testIssue = {
  batch_number:     'BATCH-2026-001',
  formulation_name: 'Broiler Starter Crumbles 50kg',
  planned_qty:      3500,
  unit:             'kg',
  issue_date:       '2026-03-28',
  materials: [
    {
      raw_material_name: 'Maize Yellow',
      sage_code:         'MAY0001',
      planned_qty:       2450,
      actual_qty:        2460,
      unit_cost:         0.45,
    },
    {
      raw_material_name: 'Full Fat Soya Meal',
      sage_code:         'FFS0001',
      planned_qty:       630,
      actual_qty:        625,
      unit_cost:         0.72,
    },
    {
      raw_material_name: 'Limestone Flour',
      sage_code:         'LIF0001',
      planned_qty:       210,
      actual_qty:        210,
      unit_cost:         0.12,
    },
  ]
};

// Run dry run first
handleGoodsIssue(testIssue);