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
    const r = await pool.request().query(`
      SELECT TOP 5 sd.StockID, sd.WhseID, sd.GroupID, g.StGroup, g.StockAccLink, g.Description
      FROM _etblStockDetails sd
      LEFT JOIN GrpTbl g ON g.idGrpTbl = sd.GroupID
    `);
    console.table(r.recordset);

    const cols = await pool.request().query(`
      SELECT COLUMN_NAME, DATA_TYPE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = '_etblStockDetails'
    `);
    console.log('\n_etblStockDetails columns:');
    console.log(cols.recordset.map(row => row.COLUMN_NAME).join(', '));
  } catch (err) {
    console.error('Failed:', err.message);
  } finally {
    if (pool) await sql.close();
  }
})();
