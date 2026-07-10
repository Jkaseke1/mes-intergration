const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const sql = require('mssql');

const sageConfig = {
  server: 'localhost',
  port: 50119,
  database: process.env.SAGE_DATABASE,
  user: process.env.SAGE_USER,
  password: process.env.SAGE_PASSWORD,
  options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true }
};

(async () => {
  let pool;
  try {
    pool = await sql.connect(sageConfig);
    const views = ['_bvStockGroups', '_bvWarehouseStockFull', '_etblStockQtys'];
    for (const view of views) {
      const r = await pool.request().input('view', sql.VarChar, view).query(`
        SELECT OBJECT_DEFINITION(OBJECT_ID(@view)) AS Definition
      `);
      console.log(`\n--- ${view} ---`);
      console.log(r.recordset[0]?.Definition || 'No definition found');
    }
  } catch (err) {
    console.error('Failed:', err.message);
  } finally {
    if (pool) await sql.close();
  }
})();
