// get-sage-config.js — Query Sage and print recommended transaction codes and GL accounts
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const sql = require('mssql');

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

(async () => {
  let pool;
  try {
    pool = await sql.connect(sageConfig);

    console.log('--- Warehouses ---');
    const wh = await pool.request().query('SELECT WhseLink, Code, Name FROM Whsemst ORDER BY WhseLink');
    console.table(wh.recordset);

    console.log('\n--- Inventory Transaction Codes (iModule = 11) ---');
    const tx = await pool.request().query('SELECT idTrCodes, Code, [Description] FROM TrCodes WHERE iModule = 11 ORDER BY Code');
    console.table(tx.recordset);

    console.log('\n--- GL Accounts (review and pick control accounts) ---');
    const gl = await pool.request().query(`
      SELECT TOP 100 AccountLink, Master_Sub_Account, Account, Description, iAccountType
      FROM Accounts
      ORDER BY Master_Sub_Account
    `);
    console.table(gl.recordset);

    console.log('\n--- Recommended env vars to add to .env ---');
    console.log(`SAGE_TX_CODE_GRN=<GRV or other receipt code>`);
    console.log(`SAGE_TX_CODE_ISSUE=<MAM or other adjustment code>`);
    console.log(`SAGE_TX_CODE_PRODUCTION=<MAM or other adjustment code>`);
    console.log(`SAGE_TX_CODE_DISPATCH=<MAM or other adjustment code>`);
    console.log(`SAGE_TX_CODE_RECON=<ADJ or other adjustment code>`);
    console.log(`SAGE_TX_CODE_MACROPACK=<MAM or other adjustment code>`);
    console.log(`SAGE_GL_ACCOUNT_GRN=<GRV control account, e.g. 5400/000>`);
    console.log(`SAGE_GL_ACCOUNT_WIP=<WIP account, e.g. 5200/000>`);
    console.log(`SAGE_GL_ACCOUNT_COGS=<Cost of Sales, e.g. 5100/000>`);
    console.log(`SAGE_GL_ACCOUNT_RECON=<Adjustment account, e.g. 5400/000>`);
  } catch (err) {
    console.error('Failed to query Sage:', err.message);
  } finally {
    if (pool) await sql.close();
  }
})();
