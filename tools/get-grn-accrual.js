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
      SELECT TOP 50 AccountLink, Master_Sub_Account, Account, Description
      FROM Accounts
      WHERE Description LIKE '%GRN%' OR Description LIKE '%ACCRUAL%' OR Master_Sub_Account LIKE '9310%'
      ORDER BY Master_Sub_Account
    `);
    console.table(r.recordset);
  } catch (err) {
    console.error('Failed:', err.message);
  } finally {
    if (pool) await sql.close();
  }
})();
