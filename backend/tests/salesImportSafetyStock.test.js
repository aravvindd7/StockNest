const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const Sales = require('../models/Sales');
const Material = require('../models/Material');
const DatasetHistory = require('../models/DatasetHistory');
const safetyStockService = require('../services/safetyStockService');
// Keep the real validation/parser/controller, replacing only persistence and refresh.
const controller = require('../controllers/salesImportController');
const trigger = require('../services/safetyStockRefreshTrigger');

const validRow = { MatNo: 'MAT001', Material: 'Widget', Plant: 'A', FinancialYear: '2025-26', Month: 'April', SalesQty: 10 };
function request(mode = 'APPEND', rows = [validRow]) {
  const columns = Sales.SALES_COLUMNS.filter(c => Sales.USER_EDITABLE_KEYS.includes(c.key));
  const sheet = XLSX.utils.aoa_to_sheet([columns.map(c => c.label), ...rows.map(row => columns.map(c => row[c.key] ?? ''))]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Sales');
  return { body: { mode }, file: { buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), originalname: 'sales.xlsx' }, user: { username: 'tester' }, params: { id: '507f1f77bcf86cd799439011' } };
}
function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
function setup(t) {
  const events = [];
  t.mock.method(Material, 'find', () => ({ select: () => ({ lean: async () => [{ materialNo: 'MAT001' }] }) }));
  t.mock.method(Sales, 'find', () => ({ lean: async () => [] }));
  t.mock.method(Sales, 'findOne', async () => null);
  t.mock.method(Sales, 'create', async () => { events.push('create'); });
  t.mock.method(Sales, 'deleteMany', async () => { events.push('delete'); });
  t.mock.method(Sales, 'insertMany', async () => { events.push('insert'); });
  // archiveSnapshot destructures this dependency, so mock its underlying model calls.
  t.mock.method(DatasetHistory, 'countDocuments', async () => 0);
  t.mock.method(DatasetHistory, 'create', async () => { events.push('archive'); });
  t.mock.method(DatasetHistory, 'findOne', async () => ({ batchId: 'SAL-1', snapshotData: [validRow] }));
  t.mock.method(DatasetHistory, 'findOneAndDelete', async () => ({ batchId: 'SAL-1' }));
  t.mock.method(safetyStockService, 'refreshForecastErrorStats', async () => { events.push('refresh'); return { errors: 0 }; });
  t.mock.method(console, 'error', () => {});
  return events;
}
for (const mode of ['APPEND', 'REPLACE']) {
  test(`${mode} refreshes exactly once after persistence`, async t => {
    const events = setup(t), res = response();
    await controller.importSales(request(mode), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.addedCount, 1);
    assert.deepEqual(events, mode === 'APPEND' ? ['archive', 'create', 'refresh'] : ['archive', 'delete', 'insert', 'refresh']);
  });
  test(`failed ${mode} never refreshes`, async t => {
    const events = setup(t), res = response();
    t.mock.method(Sales, mode === 'APPEND' ? 'create' : 'insertMany', async () => { throw new Error('write failed'); });
    await controller.importSales(request(mode), res);
    assert.equal(res.statusCode, 500);
    assert.ok(!events.includes('refresh'));
  });
  test(`${mode} row validation failure never refreshes`, async t => {
    const events = setup(t), res = response();
    await controller.importSales(request(mode, [{ ...validRow, Month: 'invalid' }]), res);
    assert.equal(res.body.failedRecords, 1);
    assert.ok(!events.includes('refresh'));
  });
  test(`${mode} refresh failure preserves successful import`, async t => {
    const events = setup(t), res = response();
    t.mock.method(safetyStockService, 'refreshForecastErrorStats', async () => { throw new Error('ML unavailable'); });
    await controller.importSales(request(mode), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.addedCount, 1);
    assert.deepEqual(events, mode === 'APPEND' ? ['archive', 'create'] : ['archive', 'delete', 'insert']);
    assert.match(console.error.mock.calls[0].arguments.join(' '), /Sales mutation succeeded.*refresh failed.*ML unavailable/);
  });
}
test('APPEND update and partially valid import refresh after saved rows', async t => {
  const events = setup(t), res = response();
  t.mock.method(Sales, 'findOne', async () => ({ save: async () => { events.push('save'); } }));
  await controller.importSales(request('APPEND', [validRow, { ...validRow, Month: 'invalid' }]), res);
  assert.equal(res.body.updatedCount, 1);
  assert.equal(res.body.failedRecords, 1);
  assert.deepEqual(events, ['archive', 'save', 'refresh']);
});
test('preview mode is unsupported and performs no writes or refresh', async t => {
  const events = setup(t), res = response();
  await controller.importSales(request('PREVIEW'), res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(events, []);
});
test('missing file and missing headers never refresh', async t => {
  const events = setup(t);
  const req = request(); delete req.file;
  const res = response(); await controller.importSales(req, res);
  assert.equal(res.statusCode, 400);
  const bad = request();
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Wrong'], ['value']]), 'Sales');
  bad.file.buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  const badRes = response(); await controller.importSales(bad, badRes);
  assert.equal(badRes.statusCode, 422);
  assert.deepEqual(events, []);
});
test('restore refreshes after Sales replacement, including empty snapshot', async t => {
  const events = setup(t);
  await controller.viewImportHistory(request(), response());
  assert.deepEqual(events, ['archive', 'delete', 'insert', 'refresh']);
  events.length = 0;
  t.mock.method(DatasetHistory, 'findOne', async () => ({ batchId: 'SAL-1', snapshotData: [] }));
  await controller.viewImportHistory(request(), response());
  assert.deepEqual(events, ['archive', 'delete', 'refresh']);
});
test('failed restore does not refresh', async t => {
  const events = setup(t), res = response();
  t.mock.method(Sales, 'insertMany', async () => { throw new Error('restore failed'); });
  await controller.viewImportHistory(request(), res);
  assert.equal(res.statusCode, 500);
  assert.ok(!events.includes('refresh'));
});
test('removing history and reading history never refresh', async t => {
  const events = setup(t);
  t.mock.method(DatasetHistory, 'find', () => ({ sort: () => ({ select: async () => [] }) }));
  await controller.removeImportHistory(request(), response());
  await controller.getImportHistory(request(), response());
  assert.deepEqual(events, []);
});
test('overlapping successful imports coalesce into a trailing refresh without overlap', async t => {
  setup(t);
  let calls = 0, active = 0, maxActive = 0, release;
  const started = new Promise(resolve => {
    t.mock.method(safetyStockService, 'refreshForecastErrorStats', async () => {
      calls++; active++; maxActive = Math.max(maxActive, active);
      if (calls === 1) { resolve(); await new Promise(done => { release = done; }); }
      active--; return { errors: 0 };
    });
  });
  const first = controller.importSales(request(), response());
  await started;
  // These calls represent further completed Sales mutations while the first runs.
  const second = trigger.refreshAfterSalesMutation();
  const third = trigger.refreshAfterSalesMutation();
  release();
  await Promise.all([first, second, third]);
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
  await trigger.refreshAfterSalesMutation();
  assert.equal(calls, 3);
});
test('partial refresh failures are logged without failing import', async t => {
  setup(t); const res = response();
  t.mock.method(safetyStockService, 'refreshForecastErrorStats', async () => ({ errors: 2 }));
  await controller.importSales(request(), res);
  assert.equal(res.statusCode, 200);
  assert.match(console.error.mock.calls[0].arguments.join(' '), /updates failed: 2/);
});

test('a later successful import still refreshes after an earlier refresh fails', async t => {
  setup(t);
  let calls = 0, release;
  let started;
  const firstStarted = new Promise(resolve => { started = resolve; });
  t.mock.method(safetyStockService, 'refreshForecastErrorStats', async () => {
    calls++;
    if (calls === 1) {
      started();
      await new Promise(resolve => { release = resolve; });
      throw new Error('first refresh failed');
    }
    return { errors: 0 };
  });
  const firstRes = response(), secondRes = response();
  const first = controller.importSales(request('APPEND'), firstRes);
  await firstStarted;
  const second = controller.importSales(request('REPLACE'), secondRes);
  // Let the second controller finish its mocked writes and request a refresh.
  await new Promise(resolve => setImmediate(resolve));
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 2);
  assert.equal(firstRes.statusCode, 200);
  assert.equal(secondRes.statusCode, 200);
});
