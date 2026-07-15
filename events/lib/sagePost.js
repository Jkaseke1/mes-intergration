// sagePost.js - Helper to post inventory transactions directly to Sage Pastel
// Uses the PostInventoryTxV2 stored procedure to bypass unposted journal batches.

const sql = require('mssql');

// Transaction codes from TrCodes table (iModule = 11)
// MFDR  = Manufacturing Draw (raw material issue to WIP, debit WIP, credit RM inventory)
// MFMF  = Manufacturing Manufacture (FG/WIP receipt, debit FG/WIP inventory, credit WIP)
// WHT   = Warehouse Transfer (dispatch/transfer, GL net zero)
// GRV   = Goods Received Voucher (GRN, debit inventory, credit GRN accrual)
// ADJ   = Adjustments (recon variances)
const TX_CODE_GRN = process.env.SAGE_TX_CODE_GRN || 'GRV';
const TX_CODE_ISSUE = process.env.SAGE_TX_CODE_ISSUE || 'MFDR';
const TX_CODE_PRODUCTION = process.env.SAGE_TX_CODE_PRODUCTION || 'MFMF';
const TX_CODE_DISPATCH = process.env.SAGE_TX_CODE_DISPATCH || 'WHT';
const TX_CODE_RECON = process.env.SAGE_TX_CODE_RECON || 'ADJ';
const TX_CODE_MACROPACK = process.env.SAGE_TX_CODE_MACROPACK || 'MFMF';

// GL account codes (leave empty to use TrCodes default accounts; override only if needed)
const GL_ACCOUNT_GRN = process.env.SAGE_GL_ACCOUNT_GRN || '';
const GL_ACCOUNT_WIP = process.env.SAGE_GL_ACCOUNT_WIP || '';
const GL_ACCOUNT_COGS = process.env.SAGE_GL_ACCOUNT_COGS || '';
const GL_ACCOUNT_RECON = process.env.SAGE_GL_ACCOUNT_RECON || '2200-DEB-1120';

const USERNAME = process.env.SAGE_POST_USERNAME || 'HYPER-MES';

// Cache warehouse code lookups
const warehouseCodeCache = new Map();

async function getWarehouseCode(pool, whseId) {
  if (warehouseCodeCache.has(whseId)) return warehouseCodeCache.get(whseId);
  const result = await pool.request()
    .input('WhseLink', sql.Int, whseId)
    .query(`SELECT Code FROM Whsemst WHERE WhseLink = @WhseLink`);
  if (result.recordset.length === 0) throw new Error(`Warehouse WhseLink=${whseId} not found in Whsemst`);
  const code = result.recordset[0].Code;
  warehouseCodeCache.set(whseId, code);
  return code;
}

async function getWarehouseLink(pool, code) {
  const result = await pool.request()
    .input('Code', sql.VarChar, code)
    .query(`SELECT WhseLink FROM Whsemst WHERE Code = @Code`);
  return result.recordset.length > 0 ? result.recordset[0].WhseLink : null;
}

async function postInventoryTransaction(pool, {
  sageCode,
  transactionType,
  quantity,
  whseId,
  unitCost,
  reference,
  reference2 = '',
  description,
  transactionDate,
  lotNumber = '',
  projectId = 0,
}) {
  if (quantity === 0) throw new Error('Quantity cannot be zero');

  const whCode = await getWarehouseCode(pool, whseId);

  let txCode, glAccount;
  switch (transactionType) {
    case 'grn':
      txCode = TX_CODE_GRN;
      glAccount = GL_ACCOUNT_GRN;
      break;
    case 'issue':
      txCode = TX_CODE_ISSUE;
      glAccount = GL_ACCOUNT_WIP;
      break;
    case 'production':
      txCode = TX_CODE_PRODUCTION;
      glAccount = GL_ACCOUNT_WIP;
      break;
    case 'dispatch':
      txCode = TX_CODE_DISPATCH;
      glAccount = GL_ACCOUNT_COGS;
      break;
    case 'recon':
      txCode = TX_CODE_RECON;
      glAccount = GL_ACCOUNT_RECON;
      break;
    case 'macropack':
      txCode = TX_CODE_MACROPACK;
      glAccount = GL_ACCOUNT_WIP;
      break;
    default:
      throw new Error(`Unknown transaction type: ${transactionType}`);
  }

  const result = await pool.request()
    .input('ItemCode', sql.VarChar, sageCode)
    .input('InventoryTransactionCode', sql.VarChar, txCode)
    .input('Quantity', sql.Float, quantity)
    .input('WHCode', sql.VarChar, whCode)
    .input('LotNumber', sql.VarChar, lotNumber)
    .input('UnitCost', sql.Float, unitCost || 0)
    .input('ProjectID', sql.Int, projectId)
    .input('GLAccountCode', sql.VarChar, glAccount)
    .input('Reference', sql.VarChar, reference.substring(0, 50))
    .input('Reference2', sql.VarChar, reference2.substring(0, 50))
    .input('TransactionDate', sql.DateTime, transactionDate || new Date())
    .input('Description', sql.VarChar, description.substring(0, 255))
    .input('UserName', sql.VarChar, USERNAME)
    .execute('PostInventoryTxV2');

  return result;
}

module.exports = {
  postInventoryTransaction,
  getWarehouseCode,
  getWarehouseLink,
};
