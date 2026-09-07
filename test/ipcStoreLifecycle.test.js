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
  t.after(() => ipc.unloadStore());
  const record = (name) => ({ filePath: path.join(root, name), fileName: name, vector: [1, 0] });
  return { ipc, root, record };
}

test('closing and reopening during indexing shares one store and preserves both writes', async (t) => {
  const { ipc, root, record } = fixture(t);
  ipc.resumeStore();
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  let original;
  const indexing = ipc.withStore(async (store) => {
    original = store;
    await wait;
    store.upsert(record('old-operation.txt'));
  });
  ipc.unloadStore();
  ipc.resumeStore();
  await ipc.withStore((store) => {
    assert.equal(store, original);
    store.upsert(record('new-operation.txt'));
  });
  release();
  await indexing;
  ipc.unloadStore();
  const saved = new VectorStore(path.join(root, 'index.json'));
  assert.deepEqual(saved.all().map((r) => r.fileName).sort(), ['new-operation.txt', 'old-operation.txt']);
  assert.equal(saved.searchByVector([1, 0]).length, 2);
});

test('background store operations release metadata only after the final user finishes', async (t) => {
  const { ipc } = fixture(t);
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  let original;
  const task = ipc.withStore(async (store) => { original = store; await wait; });
  await ipc.withStore((store) => assert.equal(store, original));
  release();
  await task;
  await ipc.withStore((store) => assert.notEqual(store, original));
});

test('failed background operations still flush writes and release the store', async (t) => {
  const { ipc, record } = fixture(t);
  let original;
  await assert.rejects(ipc.withStore((store) => {
    original = store;
    store.upsert(record('saved-before-error.txt'));
    throw new Error('index operation failed');
  }), /index operation failed/);
  await ipc.withStore((store) => {
    assert.notEqual(store, original);
    assert.equal(store.stats().total, 1);
  });
});
