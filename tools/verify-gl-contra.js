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
      SELECT pg.AutoIdx, pg.Reference, pg.Description, pg.Debit, pg.Credit,
             a1.Master_Sub_Account AS Account, a1.Description AS AccountDesc,
             a2.Master_Sub_Account AS ContraAccount, a2.Description AS ContraAccountDesc
      FROM PostGL pg
      LEFT JOIN Accounts a1 ON a1.AccountLink = pg.AccountLink
      LEFT JOIN Accounts a2 ON a2.AccountLink = pg.DrCrAccount
      WHERE pg.Reference IN (${inClause})
      ORDER BY pg.AutoIdx DESC
    `);
    console.log('--- PostGL entries with ContraAccount ---');
    console.table(r.recordset);
  } catch (err) {
    console.error('Failed:', err.message);
  } finally {
    if (pool) await sql.close();
  }
})();
