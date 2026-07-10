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
    const codes = ['GRV', 'IS', 'MFMF', 'MFDR', 'MFWA', 'MFVA', 'WHT', 'ADJ', 'RC', 'BOMM', 'BOMU', 'BOMB'];
    const inClause = codes.map(c => `'${c}'`).join(',');
    const tx = await pool.request().query(`
      SELECT idTrCodes, Code, [Description], Account1Link, Account2Link
      FROM TrCodes
      WHERE iModule = 11 AND Code IN (${inClause})
    `);
    console.log('--- Transaction Codes ---');
    console.table(tx.recordset);

    for (const row of tx.recordset) {
      for (const col of ['Account1Link', 'Account2Link']) {
        if (row[col]) {
          const a = await pool.request()
            .input('al', sql.BigInt, row[col])
            .query('SELECT Master_Sub_Account, Account, Description FROM Accounts WHERE AccountLink = @al');
          console.log(`${row.Code} ${col} => ${JSON.stringify(a.recordset[0] || 'NOT FOUND')}`);
        }
      }
    }
  } catch (err) {
    console.error('Failed:', err.message);
  } finally {
    if (pool) await sql.close();
  }
})();
