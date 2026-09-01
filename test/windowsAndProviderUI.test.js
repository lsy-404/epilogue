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

test('chat Add opens the Provider Source picker with OAuth actions', () => {
  const html = read('src/renderer/index.html');
  const renderer = read('src/renderer/app.js');
  const preload = read('src/preload.js');
  assert.match(html, /id="providerSourceOverlay"/);
  assert.match(html, /data-oauth-authorize="anthropic"/);
  assert.match(html, /data-oauth-authorize="openai-codex"/);
  assert.match(html, /data-oauth-authorize="workbuddy"/);
  assert.match(renderer, /if \(type === 'chat'\) \{\s*openProviderSource\(\)/);
  assert.match(renderer, /api\.providerSourceAdd/);
  assert.match(preload, /oauthAuthorize/);
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
