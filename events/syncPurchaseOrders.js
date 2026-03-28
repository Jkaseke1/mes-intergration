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

// ─── Event 5: Pull Purchase Orders from Sage into MES ────────────────────────
// Runs on a schedule (every 15 minutes or nightly)
// Reads open POs from Sage InvNum (DocType=2) and upserts into MES
async function syncPurchaseOrders() {
  console.log('\n─── Event 5: Sync Purchase Orders (Sage → MES) ───────────');
  console.log(`Mode          : ${DRY_RUN ? 'DRY RUN' : 'LIVE SYNC'}`);
  console.log(`Time          : ${new Date().toISOString()}`);
  console.log('──────────────────────────────────────────────────────────');

  let pool;

  try {
    pool = await sql.connect(sageConfig);

    // Step 1: Pull open POs from Sage (DocType=2, OrderStatusID=0 = open)
    console.log('\nReading open purchase orders from Sage...');
    const poResult = await pool.request()
      .query(`
        SELECT TOP 50
            n.AutoIndex        as sage_po_id,
            n.InvNumber        as po_number,
            n.GrvNumber        as grv_number,
            n.AccountID        as supplier_account_id,
            n.cAccountName     as supplier_name,
            n.InvDate          as po_date,
            n.DeliveryDate     as expected_delivery,
            n.OrdTotIncl       as total_value,
            n.OrderStatusID    as status_id,
            n.OrderNum         as order_reference
        FROM InvNum n
        WHERE n.DocType = 2
        AND n.OrderStatusID = 0
        AND n.InvDate >= DATEADD(day, -90, GETDATE())
        ORDER BY n.InvDate DESC
      `);

    console.log(`Found ${poResult.recordset.length} open POs in Sage`);

    if (poResult.recordset.length === 0) {
      console.log('No open POs to sync');
      return;
    }

    // Step 2: For each PO, get line items
    let synced = 0;
    let skipped = 0;

    for (const po of poResult.recordset) {
      console.log(`\nPO: ${po.po_number || po.grv_number} — ${po.supplier_name}`);
      console.log(`  Date     : ${po.po_date?.toISOString().split('T')[0]}`);
      console.log(`  Delivery : ${po.expected_delivery?.toISOString().split('T')[0]}`);
      console.log(`  Value    : ${po.total_value}`);

      // Get PO line items
      const linesResult = await pool.request()
        .input('InvoiceID', sql.BigInt, po.sage_po_id)
        .query(`
          SELECT
              l.idInvoiceLines  as line_id,
              l.iStockCodeID    as stock_id,
              s.Code            as stock_code,
              s.Description_1   as description,
              l.fQuantity       as quantity,
              l.fQtyToProcess   as qty_to_receive,
              l.fQtyProcessed   as qty_received,
              l.fUnitCostForeign as unit_cost,
              l.iWarehouseID    as warehouse_id
          FROM _btblInvoiceLines l
          LEFT JOIN StkItem s ON s.StockLink = l.iStockCodeID
          WHERE l.iInvoiceID = @InvoiceID
          AND l.fQuantity > 0
        `);

      console.log(`  Lines    : ${linesResult.recordset.length}`);

      // Find matching supplier in MES by sage_code
      const { data: supplier } = await supabase
        .from('suppliers')
        .select('id, name, sage_code')
        .eq('sage_code', po.supplier_name)
        .limit(1);

      // Find matching raw materials for each line
      const lines = [];
      for (const line of linesResult.recordset) {
        if (!line.stock_code) continue;

        const { data: rm } = await supabase
          .from('raw_materials')
          .select('id, name, sage_code')
          .eq('sage_code', line.stock_code)
          .limit(1);

        lines.push({
          sage_line_id:    line.line_id,
          stock_code:      line.stock_code,
          description:     line.description,
          raw_material_id: rm?.[0]?.id ?? null,
          quantity:        line.quantity,
          qty_to_receive:  line.qty_to_receive,
          qty_received:    line.qty_received,
          unit_cost:       line.unit_cost,
        });

        console.log(`    - ${line.stock_code}: ${line.description} — qty ${line.quantity}`);
      }

      if (DRY_RUN) {
        console.log(`  [DRY RUN] Would upsert PO ${po.po_number || po.grv_number} with ${lines.length} lines into MES`);
        skipped++;
        continue;
      }

      // Step 3: Upsert into MES purchase_orders table
      // Using sage_po_id as the unique key to prevent duplicates
      const poPayload = {
        sage_po_id:        po.sage_po_id.toString(),
        po_number:         po.po_number || po.grv_number || `SAGE-${po.sage_po_id}`,
        supplier_name:     po.supplier_name,
        po_date:           po.po_date,
        expected_delivery: po.expected_delivery,
        total_value:       po.total_value,
        status:            'open',
        lines:             lines,
        synced_at:         new Date().toISOString(),
      };

      // Check if purchase_orders table exists in MES
      const { error } = await supabase
        .from('purchase_orders')
        .upsert(poPayload, { onConflict: 'sage_po_id' });

      if (error) {
        console.log(`  ⚠️  purchase_orders table may not exist yet — logging only`);
        console.log(`  PO data: ${JSON.stringify(poPayload).substring(0, 100)}...`);
        skipped++;
      } else {
        console.log(`  ✅ Synced to MES`);
        synced++;
      }
    }

    console.log(`\n✅ Sync complete — ${synced} synced, ${skipped} skipped`);

  } catch (err) {
    console.error('\n❌ PO sync failed:', err.message);
    throw err;
  } finally {
    if (pool) await sql.close();
  }
}

syncPurchaseOrders();