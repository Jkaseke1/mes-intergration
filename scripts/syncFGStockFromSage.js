/**
 * Sync MES sage_stock_balances with Sage live quantities for Finished Goods (DEB warehouse)
 * Run this when FG stock is stale or out of sync
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const sql = require('mssql');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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
  },
};

const DEB_SAGE_WAREHOUSE_ID = parseInt(process.env.SAGE_DEB_WAREHOUSE_ID, 10) || 17;

async function syncFGStockFromSage() {
  console.log('🔄 Starting FG stock sync from Sage to MES (DEB warehouse)...');
  
  try {
    const pool = await sql.connect(sageConfig);
    console.log('✅ Connected to Sage database');

    const { data: formulations, error: formError } = await supabase
      .from('formulations')
      .select('id, name, sage_code')
      .eq('status', 'active')
      .not('sage_code', 'is', null);

    if (formError) throw formError;
    console.log(`📦 Found ${formulations.length} active formulations to sync`);
    console.log(`🏭 Sage WhseID: ${DEB_SAGE_WAREHOUSE_ID}`);

    let synced = 0;
    let errors = 0;

    for (const form of formulations) {
      try {
        const result = await pool.request()
          .input('Code', sql.VarChar, form.sage_code)
          .input('WhseID', sql.VarChar, DEB_SAGE_WAREHOUSE_ID.toString())
          .query(`
            SELECT TOP 1 QtyOnHand 
            FROM _bvWarehouseStockFull 
            WHERE Code = @Code 
              AND WhseID = @WhseID
          `);

        const sageQty = Number(result.recordset[0]?.QtyOnHand || 0);

        const { error: rpcError } = await supabase.rpc('set_sage_stock_balance', {
          p_sage_code: form.sage_code,
          p_warehouse_id: DEB_SAGE_WAREHOUSE_ID,
          p_quantity: sageQty,
        });

        if (rpcError) {
          console.error(`❌ ${form.sage_code}: ${rpcError.message}`);
          errors++;
        } else {
          console.log(`✅ ${form.sage_code} (${form.name}): ${sageQty.toLocaleString()} kg`);
          synced++;
        }
      } catch (err) {
        console.error(`❌ ${form.sage_code}: ${err.message}`);
        errors++;
      }
    }

    await pool.close();

    console.log('\n📊 FG Sync Summary:');
    console.log(`   ✅ Synced: ${synced}`);
    console.log(`   ❌ Errors: ${errors}`);
    console.log(`   📦 Total: ${formulations.length}`);
    console.log('\n✨ FG stock sync complete!');

  } catch (error) {
    console.error('💥 Fatal error:', error);
    process.exit(1);
  }
}

syncFGStockFromSage();
