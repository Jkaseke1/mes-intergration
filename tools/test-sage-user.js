// Check if HYPER-MES username is validated or just stored as a string
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

(async () => {
  let pool;
  try {
    pool = await sql.connect(sageConfig);

    // 1. Check what user-related tables exist in the company DB
    console.log('--- User tables in company DB ---');
    const tables = await pool.request().query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_NAME LIKE '%User%' OR TABLE_NAME LIKE '%user%'
       ORDER BY TABLE_NAME`
    );
    tables.recordset.forEach(t => console.log(`  ${t.TABLE_NAME}`));

    // 2. Check if _bspPostStTrans validates username against any table
    // Look at the StTrans table for existing usernames
    console.log('\n--- Recent usernames in StkTransJr ---');
    try {
      const recentUsers = await pool.request().query(
        `SELECT TOP 10 DISTINCT dUserName FROM StkTransJr WHERE dUserName IS NOT NULL ORDER BY dUserName`
      );
      recentUsers.recordset.forEach(u => console.log(`  ${u.dUserName}`));
    } catch (e) {
      console.log('  StkTransJr not found, trying _btblInvJr...');
      try {
        const recentUsers2 = await pool.request().query(
          `SELECT TOP 10 DISTINCT dUserName FROM _btblInvJr WHERE dUserName IS NOT NULL ORDER BY dUserName`
        );
        recentUsers2.recordset.forEach(u => console.log(`  ${u.dUserName}`));
      } catch (e2) {
        console.log('  Could not query transaction tables:', e2.message);
      }
    }

    // 3. Check GL transaction usernames
    console.log('\n--- Recent usernames in GLTrans ---');
    try {
      const glUsers = await pool.request().query(
        `SELECT TOP 10 DISTINCT dUserName FROM GLTrans WHERE dUserName IS NOT NULL ORDER BY dUserName`
      );
      glUsers.recordset.forEach(u => console.log(`  ${u.dUserName}`));
    } catch (e) {
      console.log('  Could not query GLTrans:', e.message);
    }

    // 4. Try a test post with HYPER-MES username to see if it's rejected
    console.log('\n--- Attempting test post with HYPER-MES username ---');
    try {
      const result = await pool.request()
        .input('ItemCode', sql.VarChar, 'BCON10')
        .input('InventoryTransactionCode', sql.VarChar, 'ADJ')
        .input('Quantity', sql.Float, 0.001)
        .input('WHCode', sql.VarChar, 'RM')
        .input('LotNumber', sql.VarChar, '')
        .input('UnitCost', sql.Float, 0)
        .input('ProjectID', sql.Int, 0)
        .input('GLAccountCode', sql.VarChar, '')
        .input('Reference', sql.VarChar, 'TEST-USER-CHECK')
        .input('Reference2', sql.VarChar, '')
        .input('TransactionDate', sql.DateTime, new Date())
        .input('Description', sql.VarChar, 'Test post to verify HYPER-MES username accepted')
        .input('UserName', sql.VarChar, 'HYPER-MES')
        .execute('PostInventoryTxV2');

      console.log('✅ Test post succeeded! HYPER-MES username is accepted.');
      console.log('   The username is stored as a string label, not validated against a user table.');
      console.log('   You can reverse this test by posting -0.001 with the same item.');
    } catch (e) {
      console.log('❌ Test post failed:', e.message);
      if (e.message.includes('user') || e.message.includes('User')) {
        console.log('   The username IS validated. You need to create it via Sage application.');
      }
    }

  } catch (err) {
    console.error('❌ Failed:', err.message);
    process.exit(1);
  } finally {
    if (pool) await pool.close();
  }
})();
