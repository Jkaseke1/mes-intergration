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
    const rmItem = 'BCON10';
    const fgItem = '3K3';
    const qty = 0.001;
    const cost = 1.0;
    const suffix = Date.now();

    // 1. GRN into RM
    console.log(`\n1. GRN: ${rmItem} +${qty} into WhseID 18`);
    await postInventoryTransaction(pool, {
      sageCode: rmItem,
      transactionType: 'grn',
      quantity: qty,
      whseId: 18,
      unitCost: cost,
      reference: `TEST-GRN-${suffix}`,
      description: 'Test GRN v2',
      transactionDate: new Date()
    });

    // 2. Material issue from RM
    console.log(`2. Issue: ${rmItem} ${-qty} from WhseID 18`);
    await postInventoryTransaction(pool, {
      sageCode: rmItem,
      transactionType: 'issue',
      quantity: -qty,
      whseId: 18,
      unitCost: cost,
      reference: `TEST-ISSUE-${suffix}`,
      description: 'Test issue v2',
      transactionDate: new Date()
    });

    // 3. Production receipt into DSP
    console.log(`3. Production: ${fgItem} +${qty} into WhseID 20`);
    await postInventoryTransaction(pool, {
      sageCode: fgItem,
      transactionType: 'production',
      quantity: qty,
      whseId: 20,
      unitCost: cost,
      reference: `TEST-PROD-${suffix}`,
      description: 'Test production v2',
      transactionDate: new Date()
    });

    // 4. Dispatch from DSP to GLE
    console.log(`4. Dispatch: ${fgItem} ${-qty} from WhseID 20`);
    await postInventoryTransaction(pool, {
      sageCode: fgItem,
      transactionType: 'dispatch',
      quantity: -qty,
      whseId: 20,
      unitCost: cost,
      reference: `TEST-DSP-${suffix}`,
      description: 'Test dispatch issue v2',
      transactionDate: new Date()
    });

    console.log(`5. Dispatch receipt: ${fgItem} +${qty} into WhseID 36`);
    await postInventoryTransaction(pool, {
      sageCode: fgItem,
      transactionType: 'dispatch',
      quantity: qty,
      whseId: 36,
      unitCost: cost,
      reference: `TEST-DSP-RCV-${suffix}`,
      description: 'Test dispatch receipt v2',
      transactionDate: new Date()
    });

    console.log('\n✅ Full flow v2 test completed successfully');
    console.log(`Use suffix ${suffix} to verify in verify-sage-postings.js`);
  } catch (err) {
    console.error('❌ Flow test failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    if (pool) await sql.close();
  }
})();
