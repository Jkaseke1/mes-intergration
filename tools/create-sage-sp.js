const fs = require('fs');
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
    const sqlFile = path.join(__dirname, '../sql/PostInventoryTxV2.sql');
    let sqlText = fs.readFileSync(sqlFile, 'utf8');
    sqlText = sqlText.replace(/CREATE\s+PROCEDURE\s+\[dbo\]\.\[PostInventoryTxV2\]/i, 'CREATE OR ALTER PROCEDURE [dbo].[PostInventoryTxV2]');

    pool = await sql.connect(sageConfig);
    await pool.request().batch(sqlText);
    console.log('✅ PostInventoryTxV2 stored procedure created/updated successfully.');
  } catch (err) {
    console.error('❌ Failed to create stored procedure:', err.message);
    process.exit(1);
  } finally {
    if (pool) await sql.close();
  }
})();
