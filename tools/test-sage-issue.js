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

    const testItem = 'BCON10';
    const testQty = -0.001;
    const testCost = 1.0;

    console.log(`Testing material issue with item ${testItem}, qty ${testQty}, cost ${testCost} in warehouse 18`);
    await postInventoryTransaction(pool, {
      sageCode: testItem,
      transactionType: 'issue',
      quantity: testQty,
      whseId: 18,
      unitCost: testCost,
      reference: 'TEST-ISSUE-001',
      description: 'Test auto-post issue from HYPER-MES',
      transactionDate: new Date()
    });

    console.log('✅ Test issue posted successfully');
  } catch (err) {
    console.error('❌ Test failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    if (pool) await sql.close();
  }
})();
