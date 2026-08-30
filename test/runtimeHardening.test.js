'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { isTrustedRendererNavigation, isTrustedIpcEvent } = require('../src/main/runtimeSecurity');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('renderer navigation is limited to the bundled entry file', () => {
  const entry = path.join(root, 'src', 'renderer', 'index.html');
  const entryUrl = pathToFileURL(entry).toString();
  assert.equal(isTrustedRendererNavigation(entryUrl, entry), true);
  assert.equal(isTrustedRendererNavigation(`${entryUrl}#settings`, entry), true);
  assert.equal(isTrustedRendererNavigation(`${entryUrl}?redirect=https://example.test`, entry), false);
  assert.equal(isTrustedRendererNavigation('https://example.test/', entry), false);
  assert.equal(isTrustedRendererNavigation('javascript:alert(1)', entry), false);
  assert.equal(isTrustedRendererNavigation(pathToFileURL(path.join(root, 'TERMS.txt')).toString(), entry), false);
});

test('IPC trust requires the live main WebContents and its top-level frame', () => {
  const mainFrame = {};
  const contents = { mainFrame, isDestroyed: () => false };
  const window = { webContents: contents, isDestroyed: () => false };
  assert.equal(isTrustedIpcEvent({ sender: contents, senderFrame: mainFrame }, () => window), true);
  assert.equal(isTrustedIpcEvent({ sender: contents, senderFrame: {} }, () => window), false);
  assert.equal(isTrustedIpcEvent({ sender: {}, senderFrame: mainFrame }, () => window), false);
  assert.equal(isTrustedIpcEvent({ sender: contents, senderFrame: mainFrame }, () => null), false);
});

test('Electron 44 runtime hardening is configured without removed macOS APIs', () => {
  const main = read('src/main/index.js');
  const ipc = read('src/main/ipc.js');
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.match(main, /wasOpenedAtLogin/);
  assert.doesNotMatch(main, /openAsHidden|wasOpenedAsHidden/);
  assert.match(main, /getLoginItemSettings\(options\)/);
  assert.match(ipc, /Rejected untrusted IPC sender/);
  assert.equal((ipc.match(/ipcMain\.handle\(/g) || []).length, 1);
});
