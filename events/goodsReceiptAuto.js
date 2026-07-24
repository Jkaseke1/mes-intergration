const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const sql = require('mssql');
const { createClient } = require('@supabase/supabase-js');
const { saveForReview } = require('./lib/reviewQueue');

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

async function handleGoodsReceipt(syncEvent) {
  console.log('\n  → Event 1: Goods Receipt (Auto) — Review Queue Mode');

  const grnId = syncEvent.reference_id;
  console.log(`  GRN ID: ${grnId}`);

  // Read GRN header
  const { data: grn, error: grnError } = await supabase
    .from('goods_received_notes')
    .select('id, grn_number, received_date, status, supplier_id')
    .eq('id', grnId)
    .single();

  if (grnError || !grn) {
    throw new Error(`GRN not found: ${grnId} — ${grnError?.message}`);
  }

  // Read supplier
  const { data: supplier } = await supabase
    .from('suppliers')
    .select('id, name, sage_code')
    .eq('id', grn.supplier_id)
    .single();

  console.log(`  GRN: ${grn.grn_number} — ${supplier?.name}`);

  // Read GRN line items
  const { data: items, error: itemsError } = await supabase
    .from('grn_items')
    .select('id, received_qty, unit_cost, raw_material_id')
    .eq('grn_id', grnId);

  console.log(`  Items: count=${items?.length} error=${itemsError?.message}`);

  if (itemsError) throw new Error(`Items query error: ${itemsError.message}`);
  if (!items || items.length === 0) throw new Error(`No items found for GRN: ${grn.grn_number}`);

  // Fetch raw material details
  for (const item of items) {
    const { data: rm } = await supabase
      .from('raw_materials')
      .select('id, name, sage_code')
      .eq('id', item.raw_material_id)
      .single();
    item.raw_materials = rm;
    console.log(`  RM: ${item.raw_material_id} → ${rm?.name} (${rm?.sage_code})`);
  }

  // Validate items exist in Sage (read-only check, no posting)
  let pool;
  try {
    pool = await sql.connect(sageConfig);

    // Resolve supplier account from Sage Vendor table if not already in MES
    let supplierAccount = supplier?.sage_code ? supplier.sage_code.trim() : '';
    if (supplier?.name && !supplierAccount) {
      const vendor = await pool.request()
        .input('Name', sql.VarChar, supplier.name)
        .query('SELECT TOP 1 Account FROM Vendor WHERE LTRIM(RTRIM(Name)) = LTRIM(RTRIM(@Name))');
      if (vendor.recordset && vendor.recordset.length > 0) {
        supplierAccount = vendor.recordset[0].Account;
      }
    }

    for (const item of items) {
      const sageCode = item.raw_materials?.sage_code;
      const rmName   = item.raw_materials?.name;

      if (!sageCode) {
        console.log(`  ⚠️  No sage_code for item — skipping`);
        continue;
      }

      // Look up StockLink (validation only)
      const stockResult = await pool.request()
        .input('Code', sql.VarChar, sageCode)
        .query(`SELECT StockLink FROM StkItem WHERE Code = @Code AND ItemActive = 1`);

      if (stockResult.recordset.length === 0) {
        console.log(`  ⚠️  ${sageCode} not found in Sage — skipping`);
        continue;
      }

      const reference   = grn.grn_number.substring(0, 20);
      const supplierName = supplier?.name || 'Unknown Supplier';
      const description  = `${rmName || sageCode} — ${supplierName}`.substring(0, 255);
      const qty          = Number(item.received_qty);
      const cost         = Number(item.unit_cost || 0);

      console.log(`  Preparing: ${sageCode} — ${qty}kg @ $${cost} (Supplier: ${supplierName})`);

      // Save to review queue instead of posting to Sage
      await saveForReview(syncEvent.id, 'grn_confirmed', `GRN ${grn.grn_number} — ${rmName || sageCode} (${supplierName})`, {
        sageCode,
        transactionType: 'grn',
        quantity: qty,
        whseId: 18,
        unitCost: cost,
        reference,
        reference2: supplierAccount || '',
        description,
        transactionDate: new Date(grn.received_date),
      });
    }

  } finally {
    if (pool) await sql.close();
    console.log(`  Connection closed.`);
  }
}

module.exports = { handleGoodsReceipt };
