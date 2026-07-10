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
    const r = await pool.request().query(`
      SELECT TOP 10 si.Code, si.Description_1, sd.WhseID, g.StGroup, g.Description, g.StockAccLink
      FROM StkItem si
      INNER JOIN _etblStockDetails sd ON sd.StockID = si.StockLink
      LEFT JOIN GrpTbl g ON g.idGrpTbl = sd.GroupID
      WHERE sd.WhseID IN (19, 20) AND si.bLotItem = 0 AND si.ItemActive = 1
      ORDER BY si.Code
    `);
    console.table(r.recordset);

    const r2 = await pool.request().query(`
      SELECT WhseLink, Code, Name FROM Whsemst WHERE WhseLink IN (19, 20, 36)
    `);
    console.log('\n--- Warehouses ---');
    console.table(r2.recordset);
  } catch (err) {
    console.error('Failed:', err.message);
  } finally {
    if (pool) await sql.close();
  }
})();
