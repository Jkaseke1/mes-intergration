const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const sql = require('mssql');
const { createClient } = require('@supabase/supabase-js');

const sageConfig = {
  server: 'localhost',
  port: 50119,
  database: process.env.SAGE_DATABASE,
  user: process.env.SAGE_USER,
  password: process.env.SAGE_PASSWORD,
  options: {
    encrypt: false,
    trustServerCertificate: true,
    enableArithAbort: true,
  }
};

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function main() {
  let pool;
  try {
    pool = await sql.connect(sageConfig);

    // Fetch all raw materials from Supabase that have a sage_code
    const { data: materials, error } = await supabase
      .from('raw_materials')
      .select('id, name, sage_code, cost_per_unit')
      .not('sage_code', 'is', null);

    if (error) throw error;

    console.log(`Found ${materials.length} raw materials with sage_code`);

    let updated = 0;
    let skipped = 0;
    let notFound = 0;

    for (const mat of materials) {
      const sageCode = mat.sage_code?.toString().trim();
      if (!sageCode) continue;

      // Fetch live AverageCost from Sage
      const costResult = await pool.request()
        .input('Code', sql.VarChar, sageCode)
        .query(`SELECT TOP 1 AverageCost FROM _bvWarehouseStockFull WHERE Code = @Code`);

      const avgCost = costResult.recordset[0]?.AverageCost;

      if (avgCost === undefined || avgCost === null) {
        console.log(`  ⚠️  ${sageCode} (${mat.name}) — not found in Sage`);
        notFound++;
        continue;
      }

      // Round to 4 decimal places
      const roundedCost = Math.round(avgCost * 10000) / 10000;

      // Skip if cost hasn't changed
      if (mat.cost_per_unit === roundedCost) {
        skipped++;
        continue;
      }

      // Update Supabase
      const { error: updateError } = await supabase
        .from('raw_materials')
        .update({
          cost_per_unit: roundedCost,
          updated_at: new Date().toISOString()
        })
        .eq('id', mat.id);

      if (updateError) {
        console.log(`  ❌ ${sageCode} (${mat.name}) — update failed: ${updateError.message}`);
      } else {
        console.log(`  ✅ ${sageCode} (${mat.name}) — $${mat.cost_per_unit || 0} → $${roundedCost}`);
        updated++;
      }
    }

    console.log(`\nSync complete: ${updated} updated, ${skipped} unchanged, ${notFound} not found in Sage`);
  } catch (err) {
    console.error('Sync failed:', err.message);
    process.exit(1);
  } finally {
    if (pool) await sql.close();
  }
}

main();
