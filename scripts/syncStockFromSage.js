/**
 * Sync MES sage_stock_balances with Sage live quantities
 * Run this when MES stock is stale or out of sync
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
    requestTimeout: 120000,
    connectTimeout: 30000,
  },
};

async function syncStockFromSage() {
  function isRetryable(err) {
    return err && /timeout|etimeout|econnreset|socket|network|abort/i.test(err.message || '');
  }

  async function withRetry(fn, attempts = 3, baseDelay = 1000) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err) || i === attempts - 1) throw err;
        const wait = baseDelay * Math.pow(2, i);
        console.warn(`  ⚠️ Retry ${i + 1}/${attempts} for sync step in ${wait}ms (${err.message})`);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
    throw lastErr;
  }

  console.log('🔄 Starting stock sync from Sage to MES...');

  try {
    // Connect to Sage
    const pool = await sql.connect(sageConfig);
    console.log('✅ Connected to Sage database');

    // Get all active raw materials with sage codes
    const { data: materials, error: matError } = await supabase
      .from('raw_materials')
      .select('id, name, code, sage_code, unit')
      .eq('is_active', true)
      .not('sage_code', 'is', null);

    if (matError) throw matError;
    console.log(`📦 Found ${materials.length} active materials to sync`);

    const RM_SAGE_WAREHOUSE_ID = parseInt(process.env.SAGE_RM_WAREHOUSE_ID, 10) || 18;
    console.log(`🏭 Sage WhseID: ${RM_SAGE_WAREHOUSE_ID}`);

    let synced = 0;
    let errors = 0;

    // Sync each material
    for (const material of materials) {
      try {
        // Query Sage for current stock
        const result = await withRetry(async () =>
          pool.request()
            .input('Code', sql.VarChar, material.sage_code)
            .input('WhseID', sql.VarChar, RM_SAGE_WAREHOUSE_ID.toString())
            .query(`
              SELECT TOP 1 QtyOnHand 
              FROM _bvWarehouseStockFull 
              WHERE Code = @Code 
                AND WhseID = @WhseID
            `)
        );

        const sageQty = Number(result.recordset[0]?.QtyOnHand || 0);

        // Update MES sage_stock_balances
        const { error: rpcError } = await withRetry(async () =>
          supabase.rpc('set_sage_stock_balance', {
            p_sage_code: material.sage_code,
            p_warehouse_id: RM_SAGE_WAREHOUSE_ID,
            p_quantity: sageQty,
          })
        );

        if (rpcError) {
          console.error(`❌ ${material.code}: ${rpcError.message}`);
          errors++;
        } else {
          console.log(`✅ ${material.code} (${material.sage_code}): ${sageQty.toLocaleString()} ${material.unit}`);
          synced++;
        }
      } catch (err) {
        console.error(`❌ ${material.code}: ${err.message}`);
        errors++;
      }
    }

    await pool.close();

    console.log('\n📊 Sync Summary:');
    console.log(`   ✅ Synced: ${synced}`);
    console.log(`   ❌ Errors: ${errors}`);
    console.log(`   📦 Total: ${materials.length}`);
    console.log('\n✨ Stock sync complete!');

  } catch (error) {
    console.error('💥 Fatal error:', error);
    process.exit(1);
  }
}

syncStockFromSage();
