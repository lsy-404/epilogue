'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');

const classifierPath = path.resolve(__dirname, '../src/main/classifier.js');

function loadClassifier(destinations) {
  const originalLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    if (parent?.filename === classifierPath) {
      if (request === './settings') return {
        get: () => ({ destinations, cleanup: { allowTrash: false }, stats: { archivedCount: 0 } }),
        set: () => {},
      };
      if (request === './llm') return {};
      if (request === './log') return { log() {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[classifierPath];
  const classifier = require(classifierPath);
  Module._load = originalLoad;
  delete require.cache[classifierPath];
  return classifier;
}

function journalStub() {
  let next = 0;
  return {
    begin: () => ({ id: `tx-${++next}` }),
    stage: (_id, operation) => ({ id: `op-${++next}`, ...operation }),
    markApplied() {},
  };
}

test('applyMoves rejects destinations outside configured roots', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilogue-classifier-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.txt');
  const allowed = path.join(root, 'archive');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  fs.writeFileSync(source, 'keep');
  const classifier = loadClassifier([allowed]);
  const [result] = await classifier.applyMoves(
    [{ filePath: source, destination: outside }],
    { updatePath() {} },
    { journal: journalStub() },
  );
  assert.match(result.error, /归类目标/);
  assert.equal(fs.existsSync(source), true);
  assert.equal(fs.existsSync(path.join(outside, 'source.txt')), false);
});

test('applyMoves permits a nested configured destination and updates the index', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilogue-classifier-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.txt');
  const allowed = path.join(root, 'archive');
  fs.mkdirSync(allowed);
  fs.writeFileSync(source, 'move');
  const updates = [];
  const classifier = loadClassifier([allowed]);
  const [result] = await classifier.applyMoves(
    [{ filePath: source, destination: allowed, subfolder: '2026/reports' }],
    { updatePath: (from, to) => updates.push([from, to]) },
    { journal: journalStub() },
  );
  const target = path.join(allowed, '2026', 'reports', 'source.txt');
  assert.equal(result.newPath, target);
  assert.deepEqual(updates, [[source, target]]);
  assert.equal(fs.readFileSync(target, 'utf8'), 'move');
});
