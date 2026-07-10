const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const sql = require('mssql');
const { postInventoryTransaction } = require('../events/lib/sagePost');

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

    // Find a non-lot item in the RM warehouse (WhseID 18)
    const r = await pool.request().query(`
      SELECT TOP 5 si.Code, si.StockLink, si.bLotItem
      FROM StkItem si
      INNER JOIN _etblStockDetails sd ON sd.StockID = si.StockLink
      WHERE sd.WhseID = 18 AND si.bLotItem = 0 AND si.ItemActive = 1
    `);
    console.log('Sample RM items:');
    console.table(r.recordset);

    if (r.recordset.length === 0) {
      console.error('No non-lot active item found in RM warehouse');
      process.exit(1);
    }

    const testItem = r.recordset[0].Code;
    const testQty = 0.001; // tiny positive GRN
    const testCost = 1.0;

    console.log(`\nTesting GRN with item ${testItem}, qty ${testQty}, cost ${testCost} in warehouse 18`);
    await postInventoryTransaction(pool, {
      sageCode: testItem,
      transactionType: 'grn',
      quantity: testQty,
      whseId: 18,
      unitCost: testCost,
      reference: 'TEST-GRN-001',
      description: 'Test auto-post GRN from HYPER-MES',
      transactionDate: new Date()
    });

    console.log('✅ Test GRN posted successfully');
  } catch (err) {
    console.error('❌ Test failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    if (pool) await sql.close();
  }
})();
