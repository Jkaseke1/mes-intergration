const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const sql = require('mssql');

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
    const itemCode = process.argv[2] || '3K3';
    const r = await pool.request()
      .input('code', sql.VarChar, itemCode)
      .query(`
        SELECT sd.StockID, sd.WhseID, sd.GroupID, g.StGroup, g.StockAccLink, w.Code AS WhCode
        FROM _etblStockDetails sd
        LEFT JOIN GrpTbl g ON g.idGrpTbl = sd.GroupID
        LEFT JOIN Whsemst w ON w.WhseLink = sd.WhseID
        WHERE sd.StockID = (SELECT StockLink FROM StkItem WHERE Code = @code)
        ORDER BY sd.WhseID
      `);
    console.log(`Stock details for ${itemCode}:`);
    console.table(r.recordset);
  } catch (err) {
    console.error('Failed:', err.message);
  } finally {
    if (pool) await sql.close();
  }
})();
