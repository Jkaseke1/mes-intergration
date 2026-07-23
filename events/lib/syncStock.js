/**
 * On-demand stock sync helper
 * Syncs specific materials or all materials from Sage to MES
 */

const sql = require('mssql');

const RM_SAGE_WAREHOUSE_ID = parseInt(process.env.SAGE_RM_WAREHOUSE_ID, 10) || 18;

/**
 * Sync specific materials from Sage to MES
 * @param {Object} pool - SQL connection pool
 * @param {Object} supabase - Supabase client
 * @param {Array<string>} sageCodes - Array of Sage codes to sync (optional, syncs all if empty)
 * @returns {Promise<Object>} - { synced, errors, materials }
 */
async function syncMaterialStock(pool, supabase, sageCodes = []) {
  try {
    // Get RM warehouse
    const { data: rmWarehouse, error: whError } = await supabase
      .from('warehouses')
      .select('id')
      .eq('code', 'RM')
      .single();

    if (whError || !rmWarehouse) {
      throw new Error(`RM warehouse not found: ${whError?.message || 'No data'}`);
    }

    // Build query for materials
    let materialsQuery = supabase
      .from('raw_materials')
      .select('id, name, code, sage_code, unit')
      .eq('is_active', true)
      .not('sage_code', 'is', null);

    // Filter by sage codes if provided
    if (sageCodes && sageCodes.length > 0) {
      materialsQuery = materialsQuery.in('sage_code', sageCodes);
    }

    const { data: materials, error: matError } = await materialsQuery;
    if (matError) throw matError;

    if (!materials || materials.length === 0) {
      return { synced: 0, errors: 0, materials: [] };
    }

    let synced = 0;
    let errors = 0;
    const syncedMaterials = [];

    for (const material of materials) {
      try {
        // Query Sage for current stock
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

        // Update MES stock balance
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
          console.error(`  ⚠️  Sync failed for ${material.code}: ${upsertError.message}`);
          errors++;
        } else {
          synced++;
          syncedMaterials.push({
            code: material.code,
            sage_code: material.sage_code,
            quantity: sageQty,
            unit: material.unit
          });
        }
      } catch (err) {
        console.error(`  ⚠️  Sync failed for ${material.code}: ${err.message}`);
        errors++;
      }
    }

    return { synced, errors, materials: syncedMaterials };

  } catch (error) {
    console.error('❌ Stock sync error:', error.message);
    throw error;
  }
}

/**
 * Sync stock after a Sage posting operation
 * Call this immediately after posting to Sage to keep MES in sync
 * @param {Object} pool - SQL connection pool
 * @param {Object} supabase - Supabase client
 * @param {Array<string>} sageCodes - Array of Sage codes that were just posted
 * @param {string} operation - Operation name for logging (e.g., 'GRN', 'Issue', 'Complete')
 */
async function syncAfterPosting(pool, supabase, sageCodes, operation = 'Operation') {
  if (!sageCodes || sageCodes.length === 0) {
    console.log(`  ⚠️  No materials to sync after ${operation}`);
    return { synced: 0, errors: 0 };
  }

  console.log(`  🔄 Syncing ${sageCodes.length} materials after ${operation}...`);
  
  const result = await syncMaterialStock(pool, supabase, sageCodes);
  
  if (result.synced > 0) {
    console.log(`  ✅ Stock synced: ${result.synced} materials now match Sage`);
    result.materials.forEach(m => {
      console.log(`     ${m.code}: ${m.quantity.toLocaleString()} ${m.unit}`);
    });
  }
  
  if (result.errors > 0) {
    console.log(`  ⚠️  ${result.errors} materials failed to sync`);
  }
  
  return result;
}

module.exports = { syncMaterialStock, syncAfterPosting };
