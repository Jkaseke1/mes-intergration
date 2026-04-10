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

async function runReconciliation() {
  console.log('\n─── Event 6: Nightly Reconciliation ─────────────────────');
  console.log(`Mode          : ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Time          : ${new Date().toISOString()}`);
  console.log('──────────────────────────────────────────────────────────');

  let pool;
  const results = [];
  let matched = 0;
  let variances = 0;
  let missing = 0;

  try {
    pool = await sql.connect(sageConfig);

    // Step 1: Get all raw material quantities from Sage
    console.log('\nReading stock quantities from Sage (warehouse 18)...');
    const sageQty = await pool.request()
      .query(`
        SELECT
            s.Code          as sage_code,
            s.Description_1 as description,
            q.QtyOnHand     as sage_qty,
            q.WhseID        as warehouse_id
        FROM _etblStockQtys q
        JOIN StkItem s ON s.StockLink = q.StockID
        WHERE q.WhseID = 18
        AND s.ItemActive = 1
        AND s.ServiceItem = 0
        ORDER BY s.Code
      `);

    console.log(`Found ${sageQty.recordset.length} items in Sage warehouse 18`);

    // Step 2: Get all raw materials from MES
    console.log('Reading raw materials from MES...');
    const { data: mesItems, error } = await supabase
      .from('raw_materials')
      .select('id, name, code, sage_code, current_stock')
      .order('name');

    if (error) throw error;
    console.log(`Found ${mesItems.length} raw materials in MES`);

    // Step 3: Compare item by item
    console.log('\nComparing quantities...\n');

    for (const sageItem of sageQty.recordset) {
      const mesItem = mesItems.find(m => m.sage_code === sageItem.sage_code);

      if (!mesItem) {
        results.push({
          sage_code:   sageItem.sage_code,
          description: sageItem.description,
          sage_qty:    sageItem.sage_qty,
          mes_qty:     null,
          variance:    null,
          status:      'NOT_IN_MES',
        });
        missing++;
        continue;
      }

      const mesQty     = mesItem.current_stock ?? 0;
      const sageQtyVal = sageItem.sage_qty ?? 0;
      const variance   = mesQty - sageQtyVal;
      const absVariance = Math.abs(variance);
      const threshold  = 0.5;

      let status = 'OK';
      if (absVariance > threshold) {
        status = absVariance > 100 ? 'HIGH_VARIANCE' : 'LOW_VARIANCE';
        variances++;
      } else {
        matched++;
      }

      results.push({
        sage_code:   sageItem.sage_code,
        description: sageItem.description,
        mes_name:    mesItem.name,
        sage_qty:    sageQtyVal,
        mes_qty:     mesQty,
        variance:    variance,
        status:      status,
      });
    }

    // Step 4: Check MES items not in Sage
    for (const mesItem of mesItems) {
      const inSage = sageQty.recordset.find(s => s.sage_code === mesItem.sage_code);
      if (!inSage && mesItem.sage_code) {
        results.push({
          sage_code:   mesItem.sage_code,
          description: mesItem.name,
          sage_qty:    null,
          mes_qty:     mesItem.current_stock ?? 0,
          variance:    null,
          status:      'NOT_IN_SAGE_WH18',
        });
      }
    }

    // Step 4b: Auto-update MES current_stock AND cost_per_unit from Sage
    if (!DRY_RUN) {
      console.log('\nUpdating MES current_stock from Sage...');
      let stockUpdated = 0;
      let costUpdated  = 0;

      for (const sageItem of sageQty.recordset) {
        const mesItem = mesItems.find(m => m.sage_code === sageItem.sage_code);
        if (!mesItem) continue;

        // Update current stock
        const { error: stockErr } = await supabase
          .from('raw_materials')
          .update({ current_stock: sageItem.sage_qty })
          .eq('sage_code', sageItem.sage_code);
        if (!stockErr) stockUpdated++;

        // ── Sync latest cost from Sage GRV ───────────────────────────────
        const latestCost = await pool.request()
          .input('Code', sql.VarChar, sageItem.sage_code)
          .query(`
            SELECT TOP 1
                l.fUnitCost
            FROM _btblInvoiceLines l
            JOIN StkItem s ON s.StockLink = l.iStockCodeID
            JOIN InvNum n ON n.AutoIndex = l.iInvoiceID
            WHERE s.Code = @Code
            AND n.DocType = 2
            AND l.fUnitCost > 0
            ORDER BY n.InvDate DESC
          `);

        if (latestCost.recordset.length > 0 && latestCost.recordset[0].fUnitCost > 0) {
          const { error: costErr } = await supabase
            .from('raw_materials')
            .update({ cost_per_unit: latestCost.recordset[0].fUnitCost })
            .eq('sage_code', sageItem.sage_code);
          if (!costErr) costUpdated++;
        }
        // ── End cost sync ─────────────────────────────────────────────────
      }

      console.log(`Updated current_stock for ${stockUpdated} raw materials from Sage`);
      console.log(`Updated cost_per_unit for ${costUpdated} raw materials from Sage`);
    }

    // Step 5: Print summary
    const variantItems = results.filter(r =>
      r.status === 'HIGH_VARIANCE' || r.status === 'LOW_VARIANCE'
    );

    console.log('─── RECONCILIATION RESULTS ───────────────────────────────');
    console.log(`✅ Matched (within 0.5kg)  : ${matched}`);
    console.log(`⚠️  Variances found        : ${variances}`);
    console.log(`❓ Not in MES              : ${missing}`);
    console.log('──────────────────────────────────────────────────────────\n');

    if (variantItems.length > 0) {
      console.log('VARIANCES REQUIRING REVIEW:');
      variantItems.forEach(r => {
        const diff = r.variance > 0
          ? `MES has +${r.variance.toFixed(2)} more than Sage`
          : `MES has ${r.variance.toFixed(2)} less than Sage`;
        console.log(`  ${r.sage_code}: ${r.description}`);
        console.log(`    Sage: ${r.sage_qty} kg | MES: ${r.mes_qty} kg | ${diff}`);
        console.log(`    Status: ${r.status}`);
      });
    } else {
      console.log('✅ No significant variances — MES and Sage are in sync');
    }

    const notInMes = results.filter(r => r.status === 'NOT_IN_MES');
    if (notInMes.length > 0) {
      console.log(`\nITEMS IN SAGE WH18 BUT NOT IN MES (${notInMes.length}):`);
      notInMes.slice(0, 10).forEach(r => {
        console.log(`  ${r.sage_code}: ${r.description} — ${r.sage_qty} kg in Sage`);
      });
      if (notInMes.length > 10) {
        console.log(`  ... and ${notInMes.length - 10} more`);
      }
    }

    // Step 6: Write to sync_log
    if (!DRY_RUN) {
      const { error: logError } = await supabase
        .from('sync_log')
        .insert({
          status:      variances > 0 ? 'variance' : 'success',
          description: `Nightly reconciliation: ${matched} matched, ${variances} variances, ${missing} not in MES (historical)`,
          environment: process.env.NODE_ENV,
          created_at:  new Date().toISOString(),
        });

      if (logError) {
        console.log('\n⚠️  Could not write to sync_log');
      } else {
        console.log('\n✅ Results logged to sync_log');
      }

      if (variantItems.length > 0) {
        console.log('\nWriting variance details to recon_raw_materials...');
        for (const item of variantItems) {
          const mesItem = mesItems.find(m => m.sage_code === item.sage_code);
          if (!mesItem) continue;
          await supabase
            .from('recon_raw_materials')
            .upsert({
              raw_material_id: mesItem.id,
              sage_qty:        item.sage_qty,
              variance:        item.variance,
              last_synced_at:  new Date().toISOString(),
            }, { onConflict: 'raw_material_id' });
        }
        console.log(`✅ ${variantItems.length} variance records written`);
      }
    }

    console.log('\n✅ Reconciliation complete');
    return results;

  } catch (err) {
    console.error('\n❌ Reconciliation failed:', err.message);
    throw err;
  } finally {
    if (pool) await sql.close();
  }
}

runReconciliation();