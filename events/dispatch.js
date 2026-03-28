const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const sql = require('mssql');
const { createClient } = require('@supabase/supabase-js');

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

async function getStockLink(pool, sageCode) {
  const result = await pool.request()
    .input('Code', sql.VarChar, sageCode)
    .query(`
      SELECT StockLink, Code, Description_1
      FROM StkItem
      WHERE Code = @Code
      AND ItemActive = 1
    `);
  if (result.recordset.length === 0) {
    throw new Error(`Stock code ${sageCode} not found in Sage`);
  }
  return result.recordset[0];
}

// Get Sage WhseLink from branch sage_code
async function getWarehouseLink(pool, branchSageCode) {
  // Map branch sage codes to warehouse codes
  const branchWarehouseMap = {
    'GLE0002':    36,  // Glendale
    'MAR0001':     8,  // Marondera
    'MAS0001':     9,  // Masvingo
    'BUL0001':     3,  // Bulawayo
    'DAN0002':    32,  // Dangamvura
    'SHO0001':    11,  // Show Grounds
    'KAG0001':     5,  // Kaguvi
    'MAK0001':     7,  // Makoni
    'MBU0001':    23,  // Mbudzi
    'MAZ00001':   28,  // Simon Mazorodze
    'EPW0001':    27,  // Epworth
    'HAT0001':    35,  // Hatcliffe
    'CHK0001':    40,  // Chikanga
    'MAINDOM0002':38,  // Domboshava Main
    'DOM0002':    37,  // Domboshava Market
    'NGE0001':    10,  // Ngezi
    'GWE0001':    44,  // Gweru
    'MTR0002':    21,  // Mutare
    'CHR0002':    43,  // Chiredzi
    'FCS0001':    26,  // Factory Shop
    'AMT0002':     2,  // Amtec
    'MSA0002':    31,  // Msasa
    'SOU0001':    41,  // Southwinds
    'ZVI0001':    24,  // Zvishavane
    'CHI000001':  39,  // Chigovanyika
  };

  const whseLink = branchWarehouseMap[branchSageCode];
  if (!whseLink) {
    throw new Error(`No warehouse mapping for branch code ${branchSageCode}`);
  }
  return whseLink;
}

// ─── Event 4: Dispatch ────────────────────────────────────────────────────────
// Triggered when dispatch_order status = 'delivered'
// Moves FG stock from Despatch Warehouse (20) to branch warehouse
async function handleDispatch(dispatchData) {
  console.log('\n─── Event 4: Dispatch ────────────────────────────────────');
  console.log(`Dispatch no.  : ${dispatchData.dispatch_number}`);
  console.log(`Branch        : ${dispatchData.branch_name} (${dispatchData.branch_sage_code})`);
  console.log(`Dispatch date : ${dispatchData.dispatch_date}`);
  console.log(`Items         : ${dispatchData.items.length} line(s)`);
  console.log(`Mode          : ${DRY_RUN ? 'DRY RUN' : 'LIVE WRITE'}`);
  console.log('──────────────────────────────────────────────────────────');

  let pool;

  try {
    pool = await sql.connect(sageConfig);

    // Get destination warehouse
    let destWhseLink;
    try {
      destWhseLink = await getWarehouseLink(pool, dispatchData.branch_sage_code);
      console.log(`Destination warehouse: WhseLink ${destWhseLink}`);
    } catch (err) {
      console.error(`❌ ${err.message}`);
      return;
    }

    for (const item of dispatchData.items) {
      console.log(`\nProcessing: ${item.product_name} (${item.product_sage_code})`);
      console.log(`  Quantity  : ${item.quantity} ${item.unit}`);
      console.log(`  Unit price: ${item.unit_price}`);

      // Get StockLink
      let stockItem;
      try {
        stockItem = await getStockLink(pool, item.product_sage_code);
        console.log(`  StockLink : ${stockItem.StockLink} — ${stockItem.Description_1}`);
      } catch (err) {
        console.error(`  ❌ ${err.message} — skipping`);
        continue;
      }

      // Check current FG qty in Despatch Warehouse
      const qtyCheck = await pool.request()
        .input('StockID', sql.Int, stockItem.StockLink)
        .input('WhseID',  sql.Int, 20)
        .query(`
          SELECT QtyOnHand
          FROM _etblStockQtys
          WHERE StockID = @StockID
          AND WhseID = @WhseID
        `);

      const dspQty = qtyCheck.recordset[0]?.QtyOnHand ?? 0;
      console.log(`  DSP qty   : ${dspQty} (before dispatch)`);

      if (dspQty < item.quantity && !DRY_RUN) {
        console.warn(`  ⚠️  Only ${dspQty} available, dispatching ${item.quantity}`);
      }

      const reference   = dispatchData.dispatch_number.substring(0, 20);
      const descOut     = `Dispatch to ${dispatchData.branch_name}`.substring(0, 40);
      const descIn      = `Receipt fr DSP ${dispatchData.dispatch_number}`.substring(0, 40);

      // Step 1: Issue from Despatch Warehouse (fQtyOut)
      await safeWrite(
        `Issue ${item.quantity}${item.unit} of ${item.product_sage_code} from Despatch Warehouse`,
        async () => {
          await pool.request()
            .input('iInvJrBatchID', sql.Int,      1)
            .input('iStockID',      sql.Int,      stockItem.StockLink)
            .input('iWarehouseID',  sql.Int,      20)
            .input('dTrDate',       sql.DateTime, new Date(dispatchData.dispatch_date))
            .input('iTrCodeID',     sql.Int,      31)
            .input('iGLContraID',   sql.Int,      0)
            .input('cReference',    sql.VarChar,  reference)
            .input('cDescription',  sql.VarChar,  descOut)
            .input('fQtyIn',        sql.Float,    0)
            .input('fQtyOut',       sql.Float,    item.quantity)
            .input('fNewCost',      sql.Float,    item.unit_price ?? 0)
            .input('bIsLotItem',    sql.Bit,      0)
            .input('bIsSerialItem', sql.Bit,      0)
            .query(`
              INSERT INTO _etblInvJrBatchLines (
                iInvJrBatchID, iStockID, iWarehouseID,
                dTrDate, iTrCodeID, iGLContraID,
                cReference, cDescription,
                fQtyIn, fQtyOut, fNewCost,
                bIsLotItem, bIsSerialItem
              ) VALUES (
                @iInvJrBatchID, @iStockID, @iWarehouseID,
                @dTrDate, @iTrCodeID, @iGLContraID,
                @cReference, @cDescription,
                @fQtyIn, @fQtyOut, @fNewCost,
                @bIsLotItem, @bIsSerialItem
              )
            `);

          // Reduce DSP qty
          await pool.request()
            .input('StockID', sql.Int,   stockItem.StockLink)
            .input('WhseID',  sql.Int,   20)
            .input('QtyOut',  sql.Float, item.quantity)
            .query(`
              UPDATE _etblStockQtys
              SET QtyOnHand = QtyOnHand - @QtyOut
              WHERE StockID = @StockID
              AND WhseID = @WhseID
            `);
          console.log(`  DSP reduced: ${dspQty} → ${dspQty - item.quantity}`);
        }
      );

      // Step 2: Receive into branch warehouse (fQtyIn)
      await safeWrite(
        `Receive ${item.quantity}${item.unit} of ${item.product_sage_code} into warehouse ${destWhseLink}`,
        async () => {
          await pool.request()
            .input('iInvJrBatchID', sql.Int,      1)
            .input('iStockID',      sql.Int,      stockItem.StockLink)
            .input('iWarehouseID',  sql.Int,      destWhseLink)
            .input('dTrDate',       sql.DateTime, new Date(dispatchData.dispatch_date))
            .input('iTrCodeID',     sql.Int,      31)
            .input('iGLContraID',   sql.Int,      0)
            .input('cReference',    sql.VarChar,  reference)
            .input('cDescription',  sql.VarChar,  descIn)
            .input('fQtyIn',        sql.Float,    item.quantity)
            .input('fQtyOut',       sql.Float,    0)
            .input('fNewCost',      sql.Float,    item.unit_price ?? 0)
            .input('bIsLotItem',    sql.Bit,      0)
            .input('bIsSerialItem', sql.Bit,      0)
            .query(`
              INSERT INTO _etblInvJrBatchLines (
                iInvJrBatchID, iStockID, iWarehouseID,
                dTrDate, iTrCodeID, iGLContraID,
                cReference, cDescription,
                fQtyIn, fQtyOut, fNewCost,
                bIsLotItem, bIsSerialItem
              ) VALUES (
                @iInvJrBatchID, @iStockID, @iWarehouseID,
                @dTrDate, @iTrCodeID, @iGLContraID,
                @cReference, @cDescription,
                @fQtyIn, @fQtyOut, @fNewCost,
                @bIsLotItem, @bIsSerialItem
              )
            `);

          // Update branch warehouse qty
          const branchQty = await pool.request()
            .input('StockID', sql.Int, stockItem.StockLink)
            .input('WhseID',  sql.Int, destWhseLink)
            .query(`
              SELECT QtyOnHand
              FROM _etblStockQtys
              WHERE StockID = @StockID
              AND WhseID = @WhseID
            `);

          if (branchQty.recordset.length > 0) {
            const before = branchQty.recordset[0].QtyOnHand;
            await pool.request()
              .input('StockID', sql.Int,   stockItem.StockLink)
              .input('WhseID',  sql.Int,   destWhseLink)
              .input('QtyIn',   sql.Float, item.quantity)
              .query(`
                UPDATE _etblStockQtys
                SET QtyOnHand = QtyOnHand + @QtyIn
                WHERE StockID = @StockID
                AND WhseID = @WhseID
              `);
            console.log(`  Branch qty updated: ${before} → ${before + item.quantity}`);
          } else {
            await pool.request()
              .input('StockID', sql.Int,   stockItem.StockLink)
              .input('WhseID',  sql.Int,   destWhseLink)
              .input('QtyIn',   sql.Float, item.quantity)
              .query(`
                INSERT INTO _etblStockQtys (StockID, WhseID, QtyOnHand)
                VALUES (@StockID, @WhseID, @QtyIn)
              `);
            console.log(`  Branch qty new row: ${item.quantity} ${item.unit}`);
          }
        }
      );
    }

    console.log('\n✅ Dispatch processing complete');
    console.log(`   ${dispatchData.dispatch_number} → ${dispatchData.branch_name}`);

  } catch (err) {
    console.error('\n❌ Dispatch failed:', err.message);
    throw err;
  } finally {
    if (pool) await sql.close();
  }
}

// ─── Test data ────────────────────────────────────────────────────────────────
const testDispatch = {
  dispatch_number:   'DSP-2026-001',
  branch_name:       'Glendale',
  branch_sage_code:  'GLE0002',
  dispatch_date:     '2026-03-28',
  items: [
    {
      product_name:       'Broiler Starter Crumbs 50kg',
      product_sage_code:  'BSC50',
      quantity:           500,
      unit:               'kg',
      unit_price:         0.85,
    },
    {
      product_name:       'Broiler Grower Mash 50kg',
      product_sage_code:  'BGM50',
      quantity:           300,
      unit:               'kg',
      unit_price:         0.78,
    }
  ]
};

handleDispatch(testDispatch);