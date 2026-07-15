const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const sql = require('mssql');
const { createClient } = require('@supabase/supabase-js');
const { saveForReview } = require('./lib/reviewQueue');

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

async function handleReconVariance(syncEvent) {
  console.log('\n  → Event 8: Reconciliation Variance Adjustment (Auto) — Review Queue Mode');

  const reconId = syncEvent.reference_id;
  console.log(`  Reference ID: ${reconId}`);

  // Read all approved reconciliation lines with non-zero variance
  const { data: lines, error: linesError } = await supabase
    .from('monthly_rm_reconciliation')
    .select('id, material_id, material_name, variance_kg, variance_reason_code, variance_comment, period_start, period_end, reconciliation_status')
    .eq('reconciliation_status', 'APPROVED')
    .not('variance_kg', 'eq', 0)
    .not('variance_kg', 'is', null);

  if (linesError) {
    throw new Error(`Reconciliation query error: ${linesError.message}`);
  }

  // Filter to lines matching the reference period
  let targetLines = lines || [];

  const { data: singleLine } = await supabase
    .from('monthly_rm_reconciliation')
    .select('period_start, period_end')
    .eq('id', reconId)
    .single();

  if (singleLine) {
    targetLines = targetLines.filter(l =>
      l.period_start === singleLine.period_start && l.period_end === singleLine.period_end
    );
    console.log(`  Period: ${singleLine.period_start} to ${singleLine.period_end}`);
  }

  if (targetLines.length === 0) {
    console.log('  No variance lines to adjust — skipping');
    return;
  }

  console.log(`  Variance lines: ${targetLines.length}`);

  // Fetch raw material sage_codes for each line
  for (const line of targetLines) {
    if (line.material_id) {
      const { data: rm } = await supabase
        .from('raw_materials')
        .select('id, name, sage_code')
        .eq('id', line.material_id)
        .single();
      line.raw_materials = rm;
      console.log(`  ${rm?.sage_code || 'NO_CODE'} — variance: ${line.variance_kg}kg — reason: ${line.variance_reason_code || 'none'}`);
    }
  }

  let pool;
  try {
    pool = await sql.connect(sageConfig);

    for (const line of targetLines) {
      const sageCode = line.raw_materials?.sage_code;
      if (!sageCode) {
        console.log(`  ⚠️  No sage_code for ${line.material_name} — skipping`);
        continue;
      }

      const varianceKg = Number(line.variance_kg);
      if (varianceKg === 0) continue;

      const stockResult = await pool.request()
        .input('Code', sql.VarChar, sageCode)
        .query(`SELECT StockLink FROM StkItem WHERE Code = @Code AND ItemActive = 1`);

      if (stockResult.recordset.length === 0) {
        console.log(`  ⚠️  ${sageCode} not found in Sage — skipping`);
        continue;
      }

      const isPositive = varianceKg > 0;
      const absQty     = Math.abs(varianceKg);

      const reasonCode = (line.variance_reason_code || '').replace(/_/g, ' ');
      const comment    = line.variance_comment || '';
      const reference  = `RECON-${line.period_start}`.substring(0, 20);
      const description = `${reasonCode} ${comment}`.trim().substring(0, 40) || `Recon adj ${sageCode}`;

      console.log(`  Preparing: ${sageCode} — ${isPositive ? '+' : '-'}${absQty.toFixed(2)}kg (${isPositive ? 'IN' : 'OUT'})`);

      // Fetch AverageCost for the review display
      const costResult = await pool.request()
        .input('Code', sql.VarChar, sageCode)
        .query(`SELECT TOP 1 AverageCost FROM _bvWarehouseStockFull WHERE Code = @Code`);
      const avgCost = costResult.recordset[0]?.AverageCost || 0;

      await saveForReview(syncEvent.id, 'reconciliation_variance_approved', `Recon adj ${sageCode} — ${reasonCode}`, {
        sageCode,
        transactionType: 'recon',
        quantity: isPositive ? absQty : -absQty,
        whseId: 18,
        unitCost: avgCost,
        reference,
        description,
        transactionDate: new Date(),
      });
    }
  } finally {
    if (pool) await sql.close();
  }
}

module.exports = { handleReconVariance };
