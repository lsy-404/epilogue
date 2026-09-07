'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { listFiles, walkFiles } = require('../src/main/indexer');

test('walkFiles yields files lazily and preserves recursive filtering', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epilogue-indexer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'first.txt'), 'first');
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'nested', 'second.txt'), 'second');
  fs.mkdirSync(path.join(root, '.ignored'));
  fs.writeFileSync(path.join(root, '.ignored', 'hidden.txt'), 'hidden');

  const files = walkFiles(root, true);
  assert.equal(files.next().value, path.join(root, 'first.txt'));
  assert.deepEqual([...files], [path.join(root, 'nested', 'second.txt')]);
  assert.deepEqual(listFiles(root, false), [path.join(root, 'first.txt')]);
});
