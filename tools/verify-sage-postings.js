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

    // Check stock transactions
    const st = await pool.request().query(`
      SELECT TOP 50 st.AutoIdx, si.Code AS StockCode, st.TrCode AS TransactionCode, st.TxDate, st.Reference, st.Description, st.Quantity, st.Cost, st.WarehouseID, st.cReference2
      FROM _bvSTTransactionsFull st
      LEFT JOIN StkItem si ON si.StockLink = st.AccountLink
      WHERE st.Reference IN (${inClause})
      ORDER BY st.AutoIdx DESC
    `);
    console.log('--- Stock transaction entries ---');
    console.table(st.recordset);

    // Check GL entries
    const gl = await pool.request().query(`
      SELECT TOP 50 gld.AutoIdx, gld.TxDate, gld.Reference, gld.Description, gld.Account, gld.AccountDesc, gld.Debit, gld.Credit, gld.ContraAccount, gld.ContraAccountDesc
      FROM _bvGLTransactionsFull gld
      WHERE gld.Reference IN (${inClause})
      ORDER BY gld.AutoIdx DESC
    `);
    console.log('--- GL entries ---');
    console.table(gl.recordset);

    // Check stock balances
    const sb = await pool.request().query(`
      SELECT sq.StockID, si.Code, sq.WhseID, w.Code AS WhCode, sq.QtyOnHand
      FROM _etblStockQtys sq
      JOIN StkItem si ON si.StockLink = sq.StockID
      JOIN Whsemst w ON w.WhseLink = sq.WhseID
      WHERE si.Code IN ('BCON10', '3K3') AND sq.WhseID IN (18, 20, 36)
      ORDER BY si.Code, sq.WhseID
    `);
    console.log('--- Stock balances for BCON10 and 3K3 ---');
    console.table(sb.recordset);
  } catch (err) {
    console.error('Failed:', err.message);
  } finally {
    if (pool) await sql.close();
  }
})();
