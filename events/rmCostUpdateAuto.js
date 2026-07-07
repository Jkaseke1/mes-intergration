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

async function handleRMCostUpdate(syncEvent) {
  console.log('\n  → Event 7: RM Cost Update (Auto)');

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

  // Skip circular updates from Sage sync
  if (costEntry.source === 'SAGE_SYNC') {
    console.log('  ⚠️  Source is SAGE_SYNC — skipping to avoid circular update');
    return;
  }

  console.log(`  Source: ${costEntry.source}`);
  console.log(`  Cost/tonne USD: ${costEntry.cost_per_tonne_usd}`);

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

  // Convert cost/tonne to cost/kg
  const costPerKg = Number(costEntry.cost_per_tonne_usd) / 1000;
  console.log(`  Cost/kg USD: ${costPerKg.toFixed(6)}`);

  if (DRY_RUN) {
    console.log(`[DRY RUN] Would update fAverageCost for ${rm.sage_code} to $${costPerKg.toFixed(6)}/kg`);
    return;
  }

  const pool = await sql.connect(sageConfig);

  try {
    // Find StockLink from StkItem — no cost column needed here
    const stockResult = await pool.request()
      .input('Code', sql.VarChar, rm.sage_code)
      .query(`SELECT StockLink, Description_1 FROM StkItem WHERE Code = @Code AND ItemActive = 1`);

    if (stockResult.recordset.length === 0) {
      throw new Error(`${rm.sage_code} not found in Sage StkItem`);
    }

    const stockLink = stockResult.recordset[0].StockLink;
    console.log(`  Sage StockLink: ${stockLink}`);

    // Update WhseStk.fAverageCost for RM warehouse (WhseID 18)
    // WhseStk uses WHStockLink and WHWhseID (confirmed from schema)
    const whseResult = await pool.request()
      .input('StockLink', sql.Int, stockLink)
      .input('WhseID',    sql.Int, 18)
      .query(`
        SELECT IdWhseStk, fAverageCost
        FROM WhseStk
        WHERE WHStockLink = @StockLink AND WHWhseID = @WhseID
      `);

    if (whseResult.recordset.length > 0) {
      const currentCost = whseResult.recordset[0].fAverageCost;
      console.log(`  Current Sage cost: $${currentCost}/kg`);

      await pool.request()
        .input('StockLink', sql.Int,   stockLink)
        .input('WhseID',    sql.Int,   18)
        .input('NewCost',   sql.Float, costPerKg)
        .query(`
          UPDATE WhseStk
          SET fAverageCost = @NewCost
          WHERE WHStockLink = @StockLink AND WHWhseID = @WhseID
        `);
      console.log(`  ✅ fAverageCost updated: ${rm.sage_code} $${currentCost} → $${costPerKg.toFixed(6)}/kg`);
    } else {
      // No WhseStk row — no INSERT permission, log as non-critical
      console.log(`  ℹ️  No WhseStk row for ${rm.sage_code} WhseID=18 — cost not updated (non-critical)`);
    }

  } finally {
    await sql.close();
    console.log(`  Connection closed.`);
  }
}

module.exports = { handleRMCostUpdate };