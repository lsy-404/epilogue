'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { queryLibrary, recentRecords } = require('../src/main/libraryQuery');

const day = 86400000;
const records = Array.from({ length: 1001 }, (_, index) => ({
  filePath: `/files/${index}.txt`, fileName: `${index}.txt`, kind: 'text',
  summary: index % 2 ? '研究报告' : 'Notes', keywords: index % 3 ? [] : ['PROJECT'],
  fileMtime: day * (20000 + index), indexedAt: new Date(day * (20000 + index)).toISOString(),
  vecDim: index % 2 ? 384 : 0, transcriptPreview: 'private transcript',
}));

test('library pages cap transfer size and preserve record order across pages', () => {
  const first = queryLibrary(records, { limit: 100000 });
  const second = queryLibrary(records, { offset: 400 });
  const last = queryLibrary(records, { offset: 800 });
  assert.equal(first.total, 1001);
  assert.equal(first.rows.length, 400);
  assert.equal(last.rows.length, 201);
  assert.deepEqual([...first.rows, ...second.rows, ...last.rows].map((r) => r.filePath), records.map((r) => r.filePath));
  assert.deepEqual(Object.keys(first.rows[0]).sort(), ['fileName', 'filePath', 'hasVector', 'kind', 'summary']);
  assert.equal(first.rows[1].hasVector, true);
  assert.equal(queryLibrary(records, { offset: 1001 }).rows.length, 0);
});

test('library filters names, summaries and keywords before paging', () => {
  assert.equal(queryLibrary(records, { query: '  project ' }).total, 334);
  assert.equal(queryLibrary(records, { query: '研究' }).total, 500);
  const page = queryLibrary(records, { query: '研究', offset: 400 });
  assert.equal(page.rows.length, 100);
  assert.equal(page.rows[0].fileName, '801.txt');
  assert.deepEqual(queryLibrary(records, { query: '1000.txt' }).rows.map((r) => r.fileName), ['1000.txt']);
});

test('date sliders use the entire library range and accept reversed handles', () => {
  const page = queryLibrary(records, { from: 60, to: 40, query: 'PROJECT' });
  const expected = records.filter((r) => r.fileMtime >= day * 20399 && r.fileMtime <= day * 20601 && r.keywords.length);
  assert.deepEqual(page.rows.map((r) => r.filePath), expected.map((r) => r.filePath));
  assert.equal(page.from, day * 20400);
  assert.equal(page.to, day * 20600);
});

test('empty libraries and invalid paging values remain bounded', () => {
  assert.equal(queryLibrary([]).total, 0);
  assert.deepEqual(queryLibrary([]).rows, []);
  assert.equal(queryLibrary(records, null).rows.length, 400);
  assert.equal(queryLibrary(records, { offset: -5, limit: NaN, from: -100, to: Infinity }).rows.length, 400);
  const noDates = queryLibrary([{ fileName: 'undated' }]);
  assert.equal(noDates.rows.length, 1);
  assert.equal(noDates.from, 0);
});

test('recent records match stable full sorting without mutating the store', () => {
  const tied = [...records.slice(0, 50), { ...records[49], fileName: 'tied.txt' }];
  const expected = [...tied].sort((a, b) => b.indexedAt.localeCompare(a.indexedAt)).slice(0, 8);
  assert.deepEqual(recentRecords(tied).map((r) => r.fileName), expected.map((r) => r.fileName));
  assert.equal(tied[0].fileName, '0.txt');
  assert.equal(recentRecords(records, 100000).length, 400);
  assert.deepEqual(recentRecords(records, 0), []);
});

test('large libraries keep IPC response size independent of store size', () => {
  const large = Array.from({ length: 200000 }, (_, index) => records[index % records.length]);
  const page = queryLibrary(large);
  assert.equal(page.recordsTotal, 200000);
  assert.equal(page.rows.length, 400);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 80000);
});
