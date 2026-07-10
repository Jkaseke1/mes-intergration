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
    const suffix = process.argv[2];
    if (!suffix) {
      console.error('Usage: node verify-sage-postings-v2.js <suffix>');
      process.exit(1);
    }

    const references = [`TEST-GRN-${suffix}`, `TEST-ISSUE-${suffix}`, `TEST-PROD-${suffix}`, `TEST-DSP-${suffix}`, `TEST-DSP-RCV-${suffix}`];
    const inClause = references.map(r => `'${r}'`).join(',');

    const st = await pool.request().query(`
      SELECT st.AutoIdx, si.Code AS StockCode, st.TrCode AS TransactionCode, st.TxDate, st.Reference, st.Description, st.Quantity, st.Cost, st.WarehouseID
      FROM _bvSTTransactionsFull st
      LEFT JOIN StkItem si ON si.StockLink = st.AccountLink
      WHERE st.Reference IN (${inClause})
      ORDER BY st.AutoIdx DESC
    `);
    console.log('--- Stock transactions ---');
    console.table(st.recordset);

    const gl = await pool.request().query(`
      SELECT pg.AutoIdx, pg.Reference, pg.Description, a1.Master_Sub_Account AS Account, a1.Description AS AccountDesc, pg.Debit, pg.Credit
      FROM PostGL pg
      LEFT JOIN Accounts a1 ON a1.AccountLink = pg.AccountLink
      WHERE pg.Reference IN (${inClause})
      ORDER BY pg.AutoIdx DESC
    `);
    console.log('--- GL entries ---');
    console.table(gl.recordset);
  } catch (err) {
    console.error('Failed:', err.message);
  } finally {
    if (pool) await sql.close();
  }
})();
