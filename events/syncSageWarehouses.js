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

// Sage codes that are raw-material / buffer warehouses in the MES
const RAW_MATERIAL_CODES = new Set(['RM', 'BUFFER']);

async function main() {
  let pool;
  try {
    pool = await sql.connect(sageConfig);

    // Discover Whsemst columns
    const colResult = await pool.request().query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'Whsemst'
    `);
    const colNames = colResult.recordset.map(r => r.COLUMN_NAME);

    if (!colNames.includes('WhseLink') || !colNames.includes('Code')) {
      throw new Error('Whsemst table does not have expected WhseLink and Code columns');
    }

    const nameCol =
      colNames.find(c => c.toLowerCase() === 'description') ||
      colNames.find(c => c.toLowerCase().includes('name')) ||
      'Code';

    const sageRows = await pool.request()
      .query(`SELECT WhseLink, Code, ${nameCol} AS Name FROM Whsemst ORDER BY Code`);

    const { data: existing, error: existingErr } = await supabase
      .from('warehouses')
      .select('id, code, type, name');

    if (existingErr) throw existingErr;

    const existingMap = new Map((existing || []).map(w => [w.code, w]));
    const results = [];

    for (const row of sageRows.recordset) {
      const code = row.Code?.toString().trim();
      const sageName = (row.Name || code).toString().trim() || code;
      if (!code) continue;

      const type = RAW_MATERIAL_CODES.has(code.toUpperCase()) ? 'raw_material' : 'finished_goods';
      const existingRow = existingMap.get(code);

      if (existingRow) {
        const updates = { name: sageName, updated_at: new Date().toISOString() };
        if (existingRow.type !== type && !RAW_MATERIAL_CODES.has(existingRow.type?.toUpperCase())) {
          updates.type = type;
        }
        const { error } = await supabase.from('warehouses').update(updates).eq('id', existingRow.id);
        results.push({ code, action: error ? 'update_error' : 'updated', name: sageName, error: error?.message });
      } else {
        const { error } = await supabase.from('warehouses').insert({
          name: sageName,
          code,
          type,
          branch_id: null,
          location: '',
          is_active: true,
        });
        results.push({ code, action: error ? 'insert_error' : 'inserted', name: sageName, error: error?.message });
      }
    }

    console.log('Sage warehouse sync complete');
    for (const r of results) {
      if (r.error) {
        console.log(`  ❌ ${r.code}: ${r.action} - ${r.error}`);
      } else {
        console.log(`  ✅ ${r.code}: ${r.action} - ${r.name}`);
      }
    }
  } catch (err) {
    console.error('Sync failed:', err.message);
    process.exit(1);
  } finally {
    if (pool) await sql.close();
  }
}

main();
