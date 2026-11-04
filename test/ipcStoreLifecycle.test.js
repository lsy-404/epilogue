'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const test = require('node:test');
const { VectorStore } = require('../src/main/vectorstore');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilogue-store-lifecycle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(__dirname, '../src/main/ipc.js');
  const nativeRequire = createRequire(file);
  const context = vm.createContext({
    module: { exports: {} },
    require: (name) => {
      if (name === 'electron') return { app: { getPath: () => root } };
      if (name === './settings') return {};
      if (name === './log') return { log() {} };
      return nativeRequire(name);
    },
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  const ipc = context.module.exports;
  t.after(() => ipc.dropStore());
  const record = (name) => ({ filePath: path.join(root, name), fileName: name, vector: [1, 0] });
  return { ipc, root, record };
}

test('dropStore refuses while an operation uses the store and both writes survive the later drop', async (t) => {
  const { ipc, root, record } = fixture(t);
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  let original;
  const indexing = ipc.withStore(async (store) => {
    original = store;
    await wait;
    store.upsert(record('old-operation.txt'));
  });
  assert.equal(ipc.dropStore(), false);
  await ipc.withStore((store) => {
    assert.equal(store, original);
    store.upsert(record('new-operation.txt'));
  });
  assert.equal(ipc.dropStore(), false);
  release();
  await indexing;
  assert.equal(ipc.dropStore(), true);
  const saved = new VectorStore(path.join(root, 'index.json'));
  assert.deepEqual(saved.all().map((r) => r.fileName).sort(), ['new-operation.txt', 'old-operation.txt']);
  assert.equal(saved.searchByVector([1, 0]).length, 2);
});

test('the store is released only after the final user finishes and is rebuilt on demand', async (t) => {
  const { ipc } = fixture(t);
  assert.equal(ipc.dropStore(), true);
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  let original;
  const task = ipc.withStore(async (store) => { original = store; await wait; });
  await ipc.withStore((store) => assert.equal(store, original));
  assert.equal(ipc.dropStore(), false);
  release();
  await task;
  assert.equal(ipc.dropStore(), true);
  await ipc.withStore((store) => assert.notEqual(store, original));
});

test('failed operations still release the store and dropStore flushes their writes', async (t) => {
  const { ipc, record } = fixture(t);
  let original;
  await assert.rejects(ipc.withStore((store) => {
    original = store;
    store.upsert(record('saved-before-error.txt'));
    throw new Error('index operation failed');
  }), /index operation failed/);
  assert.equal(ipc.dropStore(), true);
  await ipc.withStore((store) => {
    assert.notEqual(store, original);
    assert.equal(store.stats().total, 1);
  });
});
