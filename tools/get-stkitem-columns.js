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
      SELECT COLUMN_NAME, DATA_TYPE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'StkItem'
      ORDER BY ORDINAL_POSITION
    `);
    console.log('All StkItem columns:');
    console.log(r.recordset.map(row => row.COLUMN_NAME).join(', '));

    const groupCols = r.recordset.filter(row =>
      row.COLUMN_NAME.toLowerCase().includes('group') ||
      row.COLUMN_NAME.toLowerCase().includes('grp') ||
      row.COLUMN_NAME.toLowerCase().includes('itemgroup') ||
      row.COLUMN_NAME.toLowerCase().includes('stockgroup') ||
      row.COLUMN_NAME.toLowerCase().includes('stgroup') ||
      row.COLUMN_NAME.toLowerCase().includes('grplink')
    );
    console.log('\nGroup-related columns:');
    console.table(groupCols);
  } catch (err) {
    console.error('Failed:', err.message);
  } finally {
    if (pool) await sql.close();
  }
})();
