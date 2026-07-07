const sql = require('mssql');
require('dotenv').config();
const config = {
  server: process.env.SAGE_SERVER,
  port: parseInt(process.env.SAGE_PORT),
  database: process.env.SAGE_DATABASE,
  user: process.env.SAGE_USER,
  password: process.env.SAGE_PASSWORD,
  options: { trustServerCertificate: true, encrypt: false }
};
console.log('Server:', config.server);
console.log('Port:', config.port);
console.log('Database:', config.database);
console.log('User:', config.user);
sql.connect(config)
  .then(pool => {
    console.log('CONNECTION OK');
    return pool.request().query('SELECT TOP 3 Code, Description_1 FROM StkItem ORDER BY Code');
  })
  .then(r => {
    console.log('QUERY OK');
    console.table(r.recordset);
    process.exit(0);
  })
  .catch(e => {
    console.error('FAILED:', e.message);
    process.exit(1);
  });
