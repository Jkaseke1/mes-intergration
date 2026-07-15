// Create HYPER-MES user in Sage _etblSysUsers so PostInventoryTxV2 can stamp transactions
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const sql = require('mssql');

const sageConfig = {
  server: process.env.SAGE_SERVER || 'localhost',
  port: parseInt(process.env.SAGE_PORT || '50119', 10),
  database: process.env.SAGE_DATABASE,
  user: process.env.SAGE_USER,
  password: process.env.SAGE_PASSWORD,
  options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true }
};

const SAGE_USER_NAME = process.env.SAGE_POST_USERNAME || 'HYPER-MES';

(async () => {
  let pool;
  try {
    pool = await sql.connect(sageConfig);

    // Check if user already exists
    const existing = await pool.request()
      .input('UserName', sql.VarChar, SAGE_USER_NAME)
      .query('SELECT idUser, dUserName FROM _etblSysUsers WHERE dUserName = @UserName');

    if (existing.recordset.length > 0) {
      console.log(`✅ User "${SAGE_USER_NAME}" already exists (idUser=${existing.recordset[0].idUser}). No action needed.`);
      return;
    }

    // Check table structure to know which columns are required
    const cols = await pool.request()
      .query(`SELECT COLUMN_NAME, IS_NULLABLE, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
              FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_NAME = '_etblSysUsers'
              ORDER BY ORDINAL_POSITION`);

    console.log('_etblSysUsers columns:');
    cols.recordset.forEach(c => {
      console.log(`  ${c.COLUMN_NAME} (${c.DATA_TYPE}${c.CHARACTER_MAXIMUM_LENGTH ? '('+c.CHARACTER_MAXIMUM_LENGTH+')' : ''}) ${c.IS_NULLABLE === 'YES' ? 'NULL' : 'NOT NULL'}`);
    });

    // Insert the HYPER-MES user with minimal required fields
    // Sage 200 Evolution _etblSysUsers typically requires: dUserName, dPassword (can be empty), idUser (auto)
    await pool.request()
      .input('UserName', sql.VarChar, SAGE_USER_NAME)
      .query(`INSERT INTO _etblSysUsers (dUserName, dPassword, bIsAdmin)
              VALUES (@UserName, '', 0)`);

    // Verify
    const created = await pool.request()
      .input('UserName', sql.VarChar, SAGE_USER_NAME)
      .query('SELECT idUser, dUserName FROM _etblSysUsers WHERE dUserName = @UserName');

    console.log(`✅ User "${SAGE_USER_NAME}" created successfully (idUser=${created.recordset[0].idUser}).`);

  } catch (err) {
    console.error('❌ Failed:', err.message);
    if (err.message.includes('column')) {
      console.error('   The table schema may differ. Check the column list above and adjust the INSERT.');
    }
    process.exit(1);
  } finally {
    if (pool) await sql.close();
  }
})();
