const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const sql = require('mssql');
const { createClient } = require('@supabase/supabase-js');
const { postInventoryTransaction } = require('./lib/sagePost');

const DRY_RUN = process.env.DRY_RUN === 'true';

const sageConfig = {
  server:   'localhost',
  port:      50119,
  database: process.env.SAGE_DATABASE,
  user:     process.env.SAGE_USER,
  password: process.env.SAGE_PASSWORD,
  options: {
    encrypt:                false,
    trustServerCertificate: true,
    enableArithAbort:       true,
  }
};

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const BRANCH_WAREHOUSE_MAP = {
  'GLE0002': 36, 'MAR0001': 8,  'MAS0001': 9,  'BUL0001': 3,
  'DAN0002': 32, 'SHO0001': 11, 'KAG0001': 5,  'MAK0001': 7,
  'MBU0001': 23, 'MAZ00001': 28,'EPW0001': 27, 'HAT0001': 35,
  'CHK0001': 40, 'MAINDOM0002': 38, 'DOM0002': 37, 'NGE0001': 10,
  'GWE0001': 44, 'MTR0002': 21, 'CHR0002': 43, 'FCS0001': 26,
  'AMT0002': 2,  'MSA0002': 31, 'SOU0001': 41, 'ZVI0001': 24,
  'CHI000001': 39,
};

async function safeWrite(description, sqlFn) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would execute: ${description}`);
    return { dryRun: true };
  }
  try {
    const result = await sqlFn();
    console.log(`[LIVE] ✅ Executed: ${description}`);
    return result;
  } catch (err) {
    console.error(`[LIVE] ❌ Failed: ${description}`, err.message);
    throw err;
  }
}

async function handleDispatch(syncEvent) {
  console.log('\n  → Event 4: Dispatch (Auto)');

  const dispatchId = syncEvent.reference_id;

  const { data: dispatch, error } = await supabase
    .from('dispatch_orders')
    .select(`
      id, dispatch_number, dispatch_date, status,
      branches ( id, name, sage_code )
    `)
    .eq('id', dispatchId)
    .single();

  if (error || !dispatch) throw new Error(`Dispatch not found: ${dispatchId}`);

  const branchSageCode = dispatch.branches?.sage_code;
  const destWhseLink   = BRANCH_WAREHOUSE_MAP[branchSageCode];

  console.log(`  Dispatch: ${dispatch.dispatch_number}`);
  console.log(`  Branch: ${dispatch.branches?.name} (${branchSageCode})`);

  if (!destWhseLink) throw new Error(`No warehouse mapping for ${branchSageCode}`);

  const { data: items, error: itemsError } = await supabase
    .from('dispatch_items')
    .select(`
      id, quantity, unit_price,
      formulations ( id, name, sage_code )
    `)
    .eq('dispatch_order_id', dispatchId);

  if (itemsError || !items || items.length === 0) {
    throw new Error(`No items for dispatch ${dispatch.dispatch_number}`);
  }

  let pool;
  try {
    pool = await sql.connect(sageConfig);

    for (const item of items) {
      const sageCode = item.formulations?.sage_code;
      const qty      = Number(item.quantity);

      if (!sageCode) {
        console.log(`  ⚠️  No sage_code for item — skipping`);
        continue;
      }

      const stockResult = await pool.request()
        .input('Code', sql.VarChar, sageCode)
        .query(`SELECT StockLink FROM StkItem WHERE Code = @Code AND ItemActive = 1`);

      if (stockResult.recordset.length === 0) {
        console.log(`  ⚠️  ${sageCode} not found in Sage — skipping`);
        continue;
      }

      const stockLink   = stockResult.recordset[0].StockLink;
      const reference   = dispatch.dispatch_number.substring(0, 20);
      const descOut     = `Dispatch to ${dispatch.branches?.name}`.substring(0, 40);
      const descIn      = `Receipt fr DSP ${dispatch.dispatch_number}`.substring(0, 40);

      console.log(`  Item: ${sageCode} — ${qty}kg to warehouse ${destWhseLink}`);

      // Check DSP warehouse stock before dispatching
      const stockCheck = await pool.request()
        .input('StockID', sql.Int, stockLink)
        .input('WhseID',  sql.Int, 20)
        .query(`SELECT QtyOnHand FROM _etblStockQtys WHERE StockID = @StockID AND WhseID = @WhseID`);

      const currentStock = stockCheck.recordset.length > 0 ? stockCheck.recordset[0].QtyOnHand : 0;
      
      if (currentStock < qty) {
        throw new Error(`Insufficient stock in DSP: ${sageCode} has ${currentStock}kg but ${qty}kg requested`);
      }

      await safeWrite(
        `Dispatch ${qty}kg of ${sageCode} to ${dispatch.branches?.name}`,
        async () => {
          // Post DSP issue (negative qty)
          await postInventoryTransaction(pool, {
            sageCode,
            transactionType: 'dispatch',
            quantity: -qty,
            whseId: 20,
            unitCost: Number(item.unit_price || 0),
            reference,
            reference2: dispatch.branches?.name || '',
            description: descOut,
            transactionDate: new Date(dispatch.dispatch_date)
          });

          console.log(`  ✅ Sage posted: ${sageCode} -${qty}kg from WhseID 20 (DSP)`);

          // Post branch receipt (positive qty)
          await postInventoryTransaction(pool, {
            sageCode,
            transactionType: 'dispatch',
            quantity: qty,
            whseId: destWhseLink,
            unitCost: Number(item.unit_price || 0),
            reference,
            reference2: dispatch.branches?.name || '',
            description: descIn,
            transactionDate: new Date(dispatch.dispatch_date)
          });

          console.log(`  ✅ Sage posted: ${sageCode} +${qty}kg into WhseID ${destWhseLink} (${dispatch.branches?.name})`);
        }
      );
    }
  } finally {
    if (pool) await sql.close();
  }
}

module.exports = { handleDispatch };