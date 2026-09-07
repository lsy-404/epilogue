'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { VectorStore } = require('../src/main/vectorstore');

function record(filePath, vector) {
  return {
    filePath,
    fileName: path.basename(filePath),
    kind: 'text',
    summary: path.basename(filePath),
    keywords: [],
    vector,
  };
}

test('vector store streams persisted vectors without reading vectors.bin wholesale', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilogue-vectors-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const indexFile = path.join(root, 'index.json');
  const store = new VectorStore(indexFile);
  store.upsert(record(path.join(root, 'alpha.txt'), [1, 0, 0]));
  store.upsert(record(path.join(root, 'beta.txt'), [0, 1, 0]));
  store.flush();

  const reloaded = new VectorStore(indexFile);
  const originalRead = fs.readFileSync;
  fs.readFileSync = function guardedRead(file, ...args) {
    if (path.resolve(String(file)) === path.join(root, 'vectors.bin')) {
      throw new Error('vectors.bin must be streamed');
    }
    return originalRead.call(this, file, ...args);
  };
  try {
    const hits = reloaded.searchByVector([0.9, 0.1, 0], 1);
    assert.equal(hits[0].record.fileName, 'alpha.txt');
  } finally {
    fs.readFileSync = originalRead;
  }
});

test('streaming rewrite preserves live vectors, replaces updates, and removes deleted records', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilogue-vectors-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const indexFile = path.join(root, 'index.json');
  const alpha = path.join(root, 'alpha.txt');
  const beta = path.join(root, 'beta.txt');
  const gamma = path.join(root, 'gamma.txt');
  const store = new VectorStore(indexFile);
  store.upsert(record(alpha, [1, 0]));
  store.upsert(record(beta, [0, 1]));
  store.upsert(record(gamma, [0.5, 0.5]));
  store.flush();

  store.upsert(record(alpha, [0, 1]));
  store.remove(beta);
  store.flush();

  const reloaded = new VectorStore(indexFile);
  assert.equal(reloaded.stats().total, 2);
  const hits = reloaded.searchByVector([0, 1], 3);
  assert.equal(hits[0].record.fileName, 'alpha.txt');
  assert.equal(hits.some((hit) => hit.record.fileName === 'beta.txt'), false);
  assert.equal(new Set(reloaded.all().map((item) => item.id)).size, 2);
});

test('vector search supports dimensions above the previous fixed scratch limit', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilogue-vectors-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const indexFile = path.join(root, 'index.json');
  const vector = new Float32Array(5000);
  vector[4999] = 1;
  const store = new VectorStore(indexFile);
  store.upsert(record(path.join(root, 'wide.txt'), vector));
  store.flush();

  const hits = new VectorStore(indexFile).searchByVector(vector, 1);
  assert.equal(hits[0].record.fileName, 'wide.txt');
  assert.equal(hits[0].score, 1);
});

test('stream scan combines each id and dimension read', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilogue-vectors-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const indexFile = path.join(root, 'index.json');
  const store = new VectorStore(indexFile);
  const count = 12;
  for (let i = 0; i < count; i += 1) {
    store.upsert(record(path.join(root, `record-${i}.txt`), [i + 1, 1, 0]));
  }
  store.flush();

  const reloaded = new VectorStore(indexFile);
  const originalRead = fs.readSync;
  let reads = 0;
  fs.readSync = function countedRead(...args) {
    reads += 1;
    return originalRead.apply(this, args);
  };
  try {
    reloaded.searchByVector([1, 1, 0], 3);
  } finally {
    fs.readSync = originalRead;
  }
  assert.ok(reads <= count * 3 + 1, `expected at most three reads per vector, received ${reads}`);
});

test('metadata-only upsert keeps the persisted vector without rewriting vectors.bin', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilogue-vectors-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const indexFile = path.join(root, 'index.json');
  const filePath = path.join(root, 'alpha.txt');
  const store = new VectorStore(indexFile);
  store.upsert(record(filePath, [1, 0]));
  store.flush();

  const originalRename = fs.renameSync;
  let vectorRenames = 0;
  fs.renameSync = function countedRename(from, to) {
    if (path.resolve(String(to)) === path.join(root, 'vectors.bin')) vectorRenames += 1;
    return originalRename.call(this, from, to);
  };
  try {
    store.upsert({ ...record(filePath), summary: 'updated summary' });
    store.flush();
  } finally {
    fs.renameSync = originalRename;
  }

  assert.equal(vectorRenames, 0);
  const hits = new VectorStore(indexFile).searchByVector([1, 0], 1);
  assert.equal(hits[0].record.summary, 'updated summary');
  assert.equal(hits[0].record.vecDim, 2);
});

test('vector search retains only the requested highest scoring hits', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilogue-vectors-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const indexFile = path.join(root, 'index.json');
  const store = new VectorStore(indexFile);
  for (let i = 0; i < 40; i += 1) {
    store.upsert(record(path.join(root, `rank-${i}.txt`), [i + 1, 1]));
  }
  store.flush();

  const hits = new VectorStore(indexFile).searchByVector([1, 0], 5);
  assert.equal(hits.length, 5);
  assert.deepEqual(hits.map((hit) => hit.record.fileName), [
    'rank-39.txt', 'rank-38.txt', 'rank-37.txt', 'rank-36.txt', 'rank-35.txt',
  ]);
});
