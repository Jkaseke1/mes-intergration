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
    const references = ['TEST-FLOW-GRN', 'TEST-FLOW-ISSUE', 'TEST-FLOW-PROD', 'TEST-FLOW-DSP', 'TEST-FLOW-DSP-RCV'];
    const inClause = references.map(r => `'${r}'`).join(',');

    const r = await pool.request().query(`
      SELECT pg.AutoIdx, pg.TxDate, pg.Reference, pg.Description, a.Master_Sub_Account, a.Account, a.Description AS AccountDesc, pg.Debit, pg.Credit
      FROM PostGL pg
      LEFT JOIN Accounts a ON a.AccountLink = pg.AccountLink
      WHERE pg.Reference IN (${inClause})
      ORDER BY pg.AutoIdx DESC
    `);
    console.log('--- PostGL entries ---');
    console.table(r.recordset);
  } catch (err) {
    console.error('Failed:', err.message);
  } finally {
    if (pool) await sql.close();
  }
})();
