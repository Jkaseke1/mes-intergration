/**
 * Stock Sync Scheduler
 * Automatically syncs MES stock balances with Sage every hour
 * Run this alongside the bridge worker
 */

require('dotenv').config();
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

const RM_SAGE_WAREHOUSE_ID = parseInt(process.env.SAGE_RM_WAREHOUSE_ID, 10) || 18;
const SYNC_INTERVAL_MS = parseInt(process.env.STOCK_SYNC_INTERVAL_MINUTES, 10) * 60 * 1000 || 3600000; // Default 1 hour

async function syncStockFromSage() {
  console.log(`\n🔄 [${new Date().toISOString()}] Starting automatic stock sync...`);
  
  try {
    const pool = await sql.connect(sageConfig);

    const { data: materials, error: matError } = await supabase
      .from('raw_materials')
      .select('id, name, code, sage_code, unit')
      .eq('is_active', true)
      .not('sage_code', 'is', null);

    if (matError) throw matError;

    const { data: rmWarehouse, error: whError } = await supabase
      .from('warehouses')
      .select('id')
      .eq('code', 'RM')
      .single();

    if (whError || !rmWarehouse) {
      throw new Error(`RM warehouse not found: ${whError?.message || 'No data'}`);
    }

    let synced = 0;
    let errors = 0;
    let changed = 0;

    for (const material of materials) {
      try {
        const result = await pool.request()
          .input('Code', sql.VarChar, material.sage_code)
          .input('WhseID', sql.VarChar, RM_SAGE_WAREHOUSE_ID.toString())
          .query(`
            SELECT TOP 1 QtyOnHand 
            FROM _bvWarehouseStockFull 
            WHERE Code = @Code 
              AND WhseID = @WhseID
          `);

        const sageQty = Number(result.recordset[0]?.QtyOnHand || 0);

        // Check if quantity changed
        const { data: existing } = await supabase
          .from('warehouse_stock_balances')
          .select('quantity')
          .eq('raw_material_id', material.id)
          .eq('warehouse_id', rmWarehouse.id)
          .single();

        const oldQty = Number(existing?.quantity || 0);
        const qtyChanged = Math.abs(sageQty - oldQty) > 0.001;

        const { error: upsertError } = await supabase
          .from('warehouse_stock_balances')
          .upsert({
            raw_material_id: material.id,
            warehouse_id: rmWarehouse.id,
            quantity: sageQty,
          }, {
            onConflict: 'raw_material_id,warehouse_id'
          });

        if (upsertError) {
          errors++;
        } else {
          synced++;
          if (qtyChanged) {
            changed++;
            console.log(`  📦 ${material.code}: ${oldQty.toLocaleString()} → ${sageQty.toLocaleString()} ${material.unit}`);
          }
        }
      } catch (err) {
        errors++;
      }
    }

    await pool.close();

    console.log(`✅ Sync complete: ${synced} synced, ${changed} changed, ${errors} errors`);

  } catch (error) {
    console.error('❌ Stock sync failed:', error.message);
  }
}

// Run immediately on start
syncStockFromSage();

// Then run on schedule
setInterval(syncStockFromSage, SYNC_INTERVAL_MS);

console.log(`📅 Stock sync scheduler started. Running every ${SYNC_INTERVAL_MS / 60000} minutes.`);
console.log(`   Press Ctrl+C to stop.`);
