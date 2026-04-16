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

async function handleRMCostUpdate(syncEvent) {
  console.log('\n  → Event 9: RM Cost Update (Auto)');

  const costEntryId = syncEvent.reference_id;
  console.log(`  Cost Entry ID: ${costEntryId}`);

  // Read the cost register entry
  const { data: costEntry, error: costError } = await supabase
    .from('rm_cost_register')
    .select('id, raw_material_id, cost_per_tonne_usd, effective_date, source')
    .eq('id', costEntryId)
    .single();

  if (costError || !costEntry) {
    throw new Error(`Cost entry not found: ${costEntryId} — ${costError?.message}`);
  }

  // Do NOT fire if source = 'SAGE_SYNC' to avoid circular updates
  if (costEntry.source === 'SAGE_SYNC') {
    console.log('  ⚠️  Source is SAGE_SYNC — skipping to avoid circular update');
    return;
  }

  console.log(`  Source: ${costEntry.source}`);
  console.log(`  Cost/tonne USD: ${costEntry.cost_per_tonne_usd}`);
  console.log(`  Effective date: ${costEntry.effective_date}`);

  // Get raw material sage_code
  const { data: rm, error: rmError } = await supabase
    .from('raw_materials')
    .select('id, name, sage_code, code')
    .eq('id', costEntry.raw_material_id)
    .single();

  if (rmError || !rm) {
    throw new Error(`Raw material not found: ${costEntry.raw_material_id} — ${rmError?.message}`);
  }

  if (!rm.sage_code) {
    throw new Error(`No sage_code for raw material ${rm.code} (${rm.name})`);
  }

  console.log(`  Material: ${rm.sage_code} — ${rm.name}`);

  // Convert cost/tonne to cost/kg for Sage (Sage typically stores per-unit cost)
  const costPerKg = Number(costEntry.cost_per_tonne_usd) / 1000;
  console.log(`  Cost/kg USD: ${costPerKg.toFixed(6)}`);

  let pool;
  try {
    pool = await sql.connect(sageConfig);

    // Find the matching item in Sage
    const stockResult = await pool.request()
      .input('Code', sql.VarChar, rm.sage_code)
      .query(`SELECT StockLink, Description_1, AveUCst FROM StkItem WHERE Code = @Code AND ItemActive = 1`);

    if (stockResult.recordset.length === 0) {
      throw new Error(`${rm.sage_code} not found in Sage StkItem`);
    }

    const stockLink  = stockResult.recordset[0].StockLink;
    const currentCost = stockResult.recordset[0].AveUCst;

    console.log(`  Sage StockLink: ${stockLink}`);
    console.log(`  Current Sage cost: ${currentCost}`);
    console.log(`  New cost/kg: ${costPerKg.toFixed(6)}`);

    // Update WhseStk.fAverageCost for warehouse 18 (RM warehouse)
    await safeWrite(
      `Update average cost for ${rm.sage_code} in WhseID 18 to ${costPerKg.toFixed(6)}`,
      async () => {
        // Update the warehouse-level average cost
        const whseResult = await pool.request()
          .input('StockID', sql.Int, stockLink)
          .input('WhseID',  sql.Int, 18)
          .query(`
            SELECT idWhseStk FROM WhseStk 
            WHERE StockID = @StockID AND WhseID = @WhseID
          `);

        if (whseResult.recordset.length > 0) {
          await pool.request()
            .input('StockID',  sql.Int,   stockLink)
            .input('WhseID',   sql.Int,   18)
            .input('NewCost',  sql.Float, costPerKg)
            .query(`
              UPDATE WhseStk 
              SET fAverageCost = @NewCost 
              WHERE StockID = @StockID AND WhseID = @WhseID
            `);
        } else {
          console.log(`  ⚠️  No WhseStk record for ${rm.sage_code} in WhseID 18 — creating`);
          await pool.request()
            .input('StockID',  sql.Int,   stockLink)
            .input('WhseID',   sql.Int,   18)
            .input('NewCost',  sql.Float, costPerKg)
            .query(`
              INSERT INTO WhseStk (StockID, WhseID, fAverageCost) 
              VALUES (@StockID, @WhseID, @NewCost)
            `);
        }

        // Also update the master StkItem average cost
        await pool.request()
          .input('StockLink', sql.Int,   stockLink)
          .input('NewCost',   sql.Float, costPerKg)
          .query(`
            UPDATE StkItem 
            SET AveUCst = @NewCost 
            WHERE StockLink = @StockLink
          `);
      }
    );

    console.log(`  Cost updated: ${rm.sage_code} → $${costPerKg.toFixed(6)}/kg`);
  } finally {
    if (pool) await sql.close();
  }
}

module.exports = { handleRMCostUpdate };
