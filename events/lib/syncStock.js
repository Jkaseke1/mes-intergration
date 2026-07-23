/**
 * On-demand stock sync helper
 * Syncs specific materials or all materials from Sage to MES sage_stock_balances
 */

const sql = require('mssql');

const RM_SAGE_WAREHOUSE_ID = parseInt(process.env.SAGE_RM_WAREHOUSE_ID, 10) || 18;
const FG_SAGE_WAREHOUSE_ID = parseInt(process.env.SAGE_FG_WAREHOUSE_ID, 10) || 17;

/**
 * Sync a single Sage code from Sage to MES, auto-detecting warehouse (RM=18, FG=17)
 * @param {Object} pool - SQL connection pool
 * @param {Object} supabase - Supabase client
 * @param {string} sageCode - Sage item code
 * @param {string} name - Display name for logging
 * @param {string} unit - Unit for logging
 * @returns {Promise<Object|null>} - { code, sage_code, quantity, unit } or null on error
 */
async function syncOneCode(pool, supabase, sageCode, name, unit) {
  for (const whseId of [RM_SAGE_WAREHOUSE_ID, FG_SAGE_WAREHOUSE_ID]) {
    try {
      const result = await pool.request()
        .input('Code', sql.VarChar, sageCode)
        .input('WhseID', sql.VarChar, whseId.toString())
        .query(`
          SELECT TOP 1 QtyOnHand 
          FROM _bvWarehouseStockFull 
          WHERE Code = @Code 
            AND WhseID = @WhseID
        `);

      const sageQty = Number(result.recordset[0]?.QtyOnHand || 0);

      const { error: rpcError } = await supabase.rpc('set_sage_stock_balance', {
        p_sage_code: sageCode,
        p_warehouse_id: whseId,
        p_quantity: sageQty,
      });

      if (rpcError) {
        // Likely not found in this table for this warehouse — try next
        continue;
      }

      return { code: name || sageCode, sage_code: sageCode, quantity: sageQty, unit: unit || 'kg', whseId };
    } catch (err) {
      // Try next warehouse
      continue;
    }
  }
  return null;
}

/**
 * Sync specific materials from Sage to MES (both RM and FG warehouses)
 * @param {Object} pool - SQL connection pool
 * @param {Object} supabase - Supabase client
 * @param {Array<string>} sageCodes - Array of Sage codes to sync (optional, syncs all if empty)
 * @returns {Promise<Object>} - { synced, errors, materials }
 */
async function syncMaterialStock(pool, supabase, sageCodes = []) {
  try {
    // Gather raw materials
    let rmQuery = supabase
      .from('raw_materials')
      .select('id, name, code, sage_code, unit')
      .eq('is_active', true)
      .not('sage_code', 'is', null);

    if (sageCodes && sageCodes.length > 0) {
      rmQuery = rmQuery.in('sage_code', sageCodes);
    }

    const { data: materials, error: matError } = await rmQuery;
    if (matError) throw matError;

    // Gather formulations (FG)
    let fgQuery = supabase
      .from('formulations')
      .select('id, name, sage_code')
      .eq('status', 'active')
      .not('sage_code', 'is', null);

    if (sageCodes && sageCodes.length > 0) {
      fgQuery = fgQuery.in('sage_code', sageCodes);
    }

    const { data: formulations, error: formError } = await fgQuery;
    if (formError) throw formError;

    if ((!materials || materials.length === 0) && (!formulations || formulations.length === 0)) {
      return { synced: 0, errors: 0, materials: [] };
    }

    let synced = 0;
    let errors = 0;
    const syncedMaterials = [];

    // Sync raw materials (WhseID 18)
    for (const material of materials || []) {
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

        const { error: rpcError } = await supabase.rpc('set_sage_stock_balance', {
          p_sage_code: material.sage_code,
          p_warehouse_id: RM_SAGE_WAREHOUSE_ID,
          p_quantity: sageQty,
        });

        if (rpcError) {
          console.error(`  ⚠️  Sync failed for ${material.code}: ${rpcError.message}`);
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

    // Sync formulations / FG (WhseID 17)
    for (const form of formulations || []) {
      try {
        const result = await pool.request()
          .input('Code', sql.VarChar, form.sage_code)
          .input('WhseID', sql.VarChar, FG_SAGE_WAREHOUSE_ID.toString())
          .query(`
            SELECT TOP 1 QtyOnHand 
            FROM _bvWarehouseStockFull 
            WHERE Code = @Code 
              AND WhseID = @WhseID
          `);

        const sageQty = Number(result.recordset[0]?.QtyOnHand || 0);

        const { error: rpcError } = await supabase.rpc('set_sage_stock_balance', {
          p_sage_code: form.sage_code,
          p_warehouse_id: FG_SAGE_WAREHOUSE_ID,
          p_quantity: sageQty,
        });

        if (rpcError) {
          console.error(`  ⚠️  Sync failed for ${form.sage_code}: ${rpcError.message}`);
          errors++;
        } else {
          synced++;
          syncedMaterials.push({
            code: form.sage_code,
            sage_code: form.sage_code,
            quantity: sageQty,
            unit: 'kg'
          });
        }
      } catch (err) {
        console.error(`  ⚠️  Sync failed for ${form.sage_code}: ${err.message}`);
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
