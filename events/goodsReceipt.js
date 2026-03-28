const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const sql = require('mssql');

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

// ─── Safe write wrapper ───────────────────────────────────────────────────────
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

// ─── Get StockLink from Sage by Code ─────────────────────────────────────────
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

// ─── Event 1: Goods Receipt ───────────────────────────────────────────────────
// Triggered when a GRN is confirmed in MES
// Writes a stock receipt line into the Raw Materials Journal Batch in Sage
async function handleGoodsReceipt(grnData) {
  console.log('\n─── Event 1: Goods Receipt ───────────────────────────────');
  console.log(`GRN Reference : ${grnData.grn_number}`);
  console.log(`Supplier      : ${grnData.supplier_name} (${grnData.supplier_sage_code})`);
  console.log(`Items         : ${grnData.items.length} line(s)`);
  console.log(`Mode          : ${DRY_RUN ? 'DRY RUN' : 'LIVE WRITE'}`);
  console.log('──────────────────────────────────────────────────────────');

  let pool;

  try {
    pool = await sql.connect(sageConfig);

    for (const item of grnData.items) {
      console.log(`\nProcessing: ${item.raw_material_name} (${item.sage_code})`);
      console.log(`  Qty received : ${item.quantity_received} kg`);
      console.log(`  Unit cost    : ${item.unit_cost}`);

      // Step 1: Look up StockLink from Sage
      let stockItem;
      try {
        stockItem = await getStockLink(pool, item.sage_code);
        console.log(`  Sage StockLink: ${stockItem.StockLink} — ${stockItem.Description_1}`);
      } catch (err) {
        console.error(`  ❌ ${err.message} — skipping this line`);
        continue;
      }

      // Step 2: Write journal line to Sage Raw Materials batch
      const description = 
        `GRN ${grnData.grn_number} — ${item.raw_material_name} — ` +
        `${item.quantity_received}kg @ ${item.unit_cost}`;

      await safeWrite(description, async () => {
        await pool.request()
          .input('iInvJrBatchID',  sql.Int,      2)
          .input('iStockID',       sql.Int,      stockItem.StockLink)
          .input('iWarehouseID',   sql.Int,      18)
          .input('dTrDate',        sql.DateTime, new Date(grnData.receipt_date))
          .input('iTrCodeID',      sql.Int,      31)
          .input('iGLContraID',    sql.Int,      0)
          .input('cReference',     sql.VarChar,  grnData.grn_number)
          .input('cDescription',   sql.VarChar,  item.raw_material_name)
          .input('fQtyIn',         sql.Float,    item.quantity_received)
          .input('fQtyOut',        sql.Float,    0)
          .input('fNewCost',       sql.Float,    item.unit_cost)
          .input('bIsLotItem',     sql.Bit,      0)
          .input('bIsSerialItem',  sql.Bit,      0)
          .query(`
            INSERT INTO _etblInvJrBatchLines (
              iInvJrBatchID,
              iStockID,
              iWarehouseID,
              dTrDate,
              iTrCodeID,
              iGLContraID,
              cReference,
              cDescription,
              fQtyIn,
              fQtyOut,
              fNewCost,
              bIsLotItem,
              bIsSerialItem
            ) VALUES (
              @iInvJrBatchID,
              @iStockID,
              @iWarehouseID,
              @dTrDate,
              @iTrCodeID,
              @iGLContraID,
              @cReference,
              @cDescription,
              @fQtyIn,
              @fQtyOut,
              @fNewCost,
              @bIsLotItem,
              @bIsSerialItem
            )
          `);
      });

      // Step 3: Update QtyOnHand in _etblStockQtys
      await safeWrite(
        `Update QtyOnHand: ${item.sage_code} +${item.quantity_received}kg in warehouse 18`,
        async () => {
          // Check if stock qty row exists
          const existing = await pool.request()
            .input('StockID',  sql.Int, stockItem.StockLink)
            .input('WhseID',   sql.Int, 18)
            .query(`
              SELECT idStockQtys, QtyOnHand
              FROM _etblStockQtys
              WHERE StockID = @StockID
              AND WhseID = @WhseID
            `);

          if (existing.recordset.length > 0) {
            // Update existing row
            await pool.request()
              .input('StockID',  sql.Int,   stockItem.StockLink)
              .input('WhseID',   sql.Int,   18)
              .input('QtyIn',    sql.Float, item.quantity_received)
              .query(`
                UPDATE _etblStockQtys
                SET QtyOnHand = QtyOnHand + @QtyIn
                WHERE StockID = @StockID
                AND WhseID = @WhseID
              `);
            console.log(`  Updated QtyOnHand: was ${existing.recordset[0].QtyOnHand}, adding ${item.quantity_received}`);
          } else {
            // Insert new row
            await pool.request()
              .input('StockID',  sql.Int,   stockItem.StockLink)
              .input('WhseID',   sql.Int,   18)
              .input('QtyIn',    sql.Float, item.quantity_received)
              .query(`
                INSERT INTO _etblStockQtys
                  (StockID, WhseID, QtyOnHand)
                VALUES
                  (@StockID, @WhseID, @QtyIn)
              `);
            console.log(`  Inserted new QtyOnHand row: ${item.quantity_received}kg`);
          }
        }
      );
    }

    console.log('\n✅ Goods receipt processing complete');

  } catch (err) {
    console.error('\n❌ Goods receipt failed:', err.message);
    throw err;
  } finally {
    if (pool) await sql.close();
  }
}

// ─── Test data ────────────────────────────────────────────────────────────────
// This simulates a GRN being confirmed in the MES
const testGRN = {
  grn_number:        'GRN-TEST-001',
  supplier_name:     'GMB',
  supplier_sage_code:'GMB0001',
  receipt_date:      '2026-03-28',
  items: [
    {
      raw_material_name: 'Maize Yellow',
      sage_code:         'MAY0001',
      quantity_received: 500,
      unit_cost:         0.45,
    },
    {
      raw_material_name: 'Wheat Bran',
      sage_code:         'WHB0001',
      quantity_received: 200,
      unit_cost:         0.18,
    }
  ]
};

// Run the test
handleGoodsReceipt(testGRN);