'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('Windows and Linux clear Electron default File/Edit application menus', () => {
  const source = read('src/main/index.js');
  assert.match(source, /process\.platform !== 'darwin'\) Menu\.setApplicationMenu\(null\)/);
});

test('chat Add opens the shared model-auth element through the trusted host', () => {
  const html = read('src/renderer/index.html');
  const renderer = read('src/renderer/app.js');
  const preload = read('src/preload.js');
  const shared = read('src/renderer/modelAuth.js');
  const ipc = read('src/main/ipc.js');
  assert.match(html, /<model-auth-dialog><\/model-auth-dialog>/);
  assert.match(html, /id="modelAuthOpen"/);
  assert.doesNotMatch(html, /id="providerSourceOverlay"/);
  assert.match(shared, /registerModelAuthElement/);
  assert.match(shared, /modelAuthExecute/);
  assert.match(shared, /modelAuthCancel/);
  assert.match(preload, /modelAuthState/);
  assert.match(preload, /modelAuthCancel/);
  assert.match(ipc, /model-auth:execute/);
  assert.match(ipc, /model-auth:cancel/);
  assert.match(read('src/main/modelAuth.js'), /trae-account-default/);
});

test('file moves expose a persisted undo action through the trusted preload bridge', () => {
  const html = read('src/renderer/index.html');
  const renderer = read('src/renderer/app.js');
  const preload = read('src/preload.js');
  const ipc = read('src/main/ipc.js');
  assert.match(html, /id="btnUndoMoves"/);
  assert.match(renderer, /classifyUndoLatest/);
  assert.match(renderer, /restoreUndoStatus/);
  assert.match(preload, /classifyUndoLatest/);
  assert.match(ipc, /classify:undoLatest/);
});
