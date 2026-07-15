// Find and create HYPER-MES user in Sage database
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

    // 1. Check SageCommon for _etblSysUsers
    console.log('--- Checking SageCommon._etblSysUsers ---');
    try {
      const cols = await pool.request().query(
        `SELECT COLUMN_NAME, IS_NULLABLE, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
         FROM [SageCommon].INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_NAME = '_etblSysUsers' ORDER BY ORDINAL_POSITION`
      );
      console.log('Columns:');
      cols.recordset.forEach(c => {
        console.log(`  ${c.COLUMN_NAME} (${c.DATA_TYPE}) ${c.IS_NULLABLE === 'YES' ? 'NULL' : 'NOT NULL'}`);
      });

      const users = await pool.request().query(
        'SELECT TOP 10 idUser, dUserName FROM [SageCommon].[dbo].[_etblSysUsers] ORDER BY idUser'
      );
      console.log('\nExisting users:');
      users.recordset.forEach(u => console.log(`  idUser=${u.idUser}, dUserName=${u.dUserName}`));

      // Check if HYPER-MES already exists
      const existing = await pool.request()
        .input('UserName', sql.VarChar, SAGE_USER_NAME)
        .query('SELECT idUser FROM [SageCommon].[dbo].[_etblSysUsers] WHERE dUserName = @UserName');

      if (existing.recordset.length > 0) {
        console.log(`\n✅ User "${SAGE_USER_NAME}" already exists (idUser=${existing.recordset[0].idUser}).`);
        return;
      }

      // Create the user
      try {
        await pool.request()
          .input('UserName', sql.VarChar, SAGE_USER_NAME)
          .query("INSERT INTO [SageCommon].[dbo].[_etblSysUsers] (dUserName, dPassword) VALUES (@UserName, '')");
      } catch (insertErr) {
        console.log('Minimal insert failed, trying with more columns...');
        const notNullCols = cols.recordset.filter(c => c.IS_NULLABLE === 'NO' && c.COLUMN_NAME !== 'idUser');
        console.log('NOT NULL columns (excluding idUser):', notNullCols.map(c => c.COLUMN_NAME).join(', '));
        throw insertErr;
      }

      const created = await pool.request()
        .input('UserName', sql.VarChar, SAGE_USER_NAME)
        .query('SELECT idUser, dUserName FROM [SageCommon].[dbo].[_etblSysUsers] WHERE dUserName = @UserName');

      console.log(`\n✅ User "${SAGE_USER_NAME}" created successfully (idUser=${created.recordset[0].idUser}).`);

    } catch (err) {
      console.error('Error with SageCommon._etblSysUsers:', err.message);

      // List all _etbl tables in SageCommon
      const etbl = await pool.request().query(
        `SELECT TABLE_NAME FROM [SageCommon].INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME LIKE '%etbl%' ORDER BY TABLE_NAME`
      );
      console.log('\nAll _etbl tables in SageCommon:');
      etbl.recordset.forEach(t => console.log(`  ${t.TABLE_NAME}`));

      // Also check the company database for user tables
      console.log('\n--- Checking company DB for user tables ---');
      const userTables = await pool.request().query(
        `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME LIKE '%User%' ORDER BY TABLE_NAME`
      );
      userTables.recordset.forEach(t => console.log(`  ${t.TABLE_NAME}`));
    }

  } catch (err) {
    console.error('❌ Failed:', err.message);
    process.exit(1);
  } finally {
    if (pool) await pool.close();
  }
})();
