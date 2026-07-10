// test_bridge_syntax.js - Verify all bridge handlers load correctly
// Run this in the hyper-integration folder

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

console.log('Testing active bridge module imports...\n');
console.log(`SAGE_DATABASE: ${process.env.SAGE_DATABASE || 'NOT SET'}`);
console.log(`DRY_RUN: ${process.env.DRY_RUN === 'true' ? 'true' : 'false'}\n`);

try {
  const { handleGoodsReceipt } = require('./events/goodsReceiptAuto');
  console.log('✅ goodsReceiptAuto.js imports OK');
} catch (err) {
  console.error('❌ goodsReceiptAuto.js import failed:', err.message);
}

try {
  const { handleGoodsIssue } = require('./events/goodsIssueAuto');
  console.log('✅ goodsIssueAuto.js imports OK');
} catch (err) {
  console.error('❌ goodsIssueAuto.js import failed:', err.message);
}

try {
  const { handleBatchComplete } = require('./events/batchCompleteAuto');
  console.log('✅ batchCompleteAuto.js imports OK');
} catch (err) {
  console.error('❌ batchCompleteAuto.js import failed:', err.message);
}

try {
  const { handleDispatch } = require('./events/dispatchAuto');
  console.log('✅ dispatchAuto.js imports OK');
} catch (err) {
  console.error('❌ dispatchAuto.js import failed:', err.message);
}

try {
  const { handleMacroPackComplete } = require('./events/macroPackCompleteAuto');
  console.log('✅ macroPackCompleteAuto.js imports OK');
} catch (err) {
  console.error('❌ macroPackCompleteAuto.js import failed:', err.message);
}

try {
  const { handleReconVariance } = require('./events/reconVarianceAuto');
  console.log('✅ reconVarianceAuto.js imports OK');
} catch (err) {
  console.error('❌ reconVarianceAuto.js import failed:', err.message);
}

try {
  const { handleRMCostUpdate } = require('./events/rmCostUpdateAuto');
  console.log('✅ rmCostUpdateAuto.js imports OK');
} catch (err) {
  console.error('❌ rmCostUpdateAuto.js import failed:', err.message);
}

try {
  require('./events/bridgeworker');
  console.log('✅ bridgeworker.js imports OK');
} catch (err) {
  console.error('❌ bridgeworker.js import failed:', err.message);
}

console.log('\n✅ All import checks completed.');
