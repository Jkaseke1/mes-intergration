require('dotenv').config();
const sql = require('mssql');
const { createClient } = require('@supabase/supabase-js');

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

const DRY_RUN = process.env.DRY_RUN === 'true';

async function testConnections() {
  console.log('==============================================');
  console.log(' HYPER Integration Bridge — Connection Test');
  console.log(` Mode: ${DRY_RUN ? 'DRY RUN (safe)' : 'LIVE'}`);
  console.log('==============================================\n');

  // Test Sage connection
  try {
    console.log('Testing Sage Pastel connection...');
    const pool = await sql.connect(sageConfig);
    const result = await pool.request()
      .query(`
        SELECT TOP 3
          Code,
          Description_1
        FROM StkItem
        WHERE ItemActive = 1
        AND Code != 'Service Item'
      `);
    console.log('✅ Sage connected successfully');
    console.log('   Sample stock items from Sage:');
    result.recordset.forEach(r => {
      console.log(`   - ${r.Code}: ${r.Description_1}`);
    });
    await sql.close();
  } catch (err) {
    console.error('❌ Sage connection failed:', err.message);
  }

  console.log('');

  // Test Supabase connection
  try {
    console.log('Testing Supabase connection...');
    const { data, error } = await supabase
      .from('raw_materials')
      .select('name, sage_code')
      .limit(3);
    if (error) throw error;
    console.log('✅ Supabase connected successfully');
    console.log('   Sample raw materials from MES:');
    data.forEach(r => {
      console.log(`   - ${r.name} (${r.sage_code})`);
    });
  } catch (err) {
    console.error('❌ Supabase connection failed:', err.message);
  }

  console.log('\n==============================================');
  console.log(' Connection test complete');
  console.log('==============================================');
}

testConnections();