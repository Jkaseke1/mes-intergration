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

    // Find tables with columns matching GrpTbl PK or StockAccLink
    const r1 = await pool.request().query(`
      SELECT TABLE_NAME, COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE COLUMN_NAME IN ('StGroup', 'StockGroup', 'iStockGroupID', 'iGroupID', 'StockAccLink', 'iStockAccLink')
      ORDER BY TABLE_NAME, COLUMN_NAME
    `);
    console.log('--- Columns matching stock group patterns ---');
    console.table(r1.recordset);

    // Check foreign keys from any table referencing GrpTbl
    const r2 = await pool.request().query(`
      SELECT 
        fk.name AS FK_Name,
        OBJECT_NAME(fk.parent_object_id) AS ParentTable,
        c.name AS ParentColumn,
        OBJECT_NAME(fk.referenced_object_id) AS ReferencedTable,
        rc.name AS ReferencedColumn
      FROM sys.foreign_keys fk
      INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
      INNER JOIN sys.columns c ON fkc.parent_object_id = c.object_id AND fkc.parent_column_id = c.column_id
      INNER JOIN sys.columns rc ON fkc.referenced_object_id = rc.object_id AND fkc.referenced_column_id = rc.column_id
      WHERE OBJECT_NAME(fk.referenced_object_id) = 'GrpTbl'
    `);
    console.log('--- Foreign keys referencing GrpTbl ---');
    console.table(r2.recordset);
  } catch (err) {
    console.error('Failed:', err.message);
  } finally {
    if (pool) await sql.close();
  }
})();
