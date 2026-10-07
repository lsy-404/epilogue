'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const test = require('node:test');

function load(overrides = {}) {
  const handlers = new Map(); const windows = []; const app = new EventEmitter();
  const settings = { get: () => ({ tosAccepted: overrides.tosAccepted ?? true, language: 'en' }) };
  const file = process.execPath; const counters = { unload: 0, idle: 0, reveal: 0, focus: 0 };
  const store = { all: () => [], get: (p) => p === file ? { filePath: p } : null };
  const ipc = { resumeStore() {}, unloadStore: () => counters.unload++, withStore: async (fn) => fn(store) };
  const shell = { openPath: async () => overrides.openError || '', showItemInFolder: () => counters.reveal++ };
  const shortcutCalls = { register: [], unregister: [] };
  const shortcut = { register: (key) => { shortcutCalls.register.push(key); return overrides.shortcut ?? true; }, unregister: (key) => shortcutCalls.unregister.push(key) };
  class FakeWindow extends EventEmitter {
    constructor() { super(); this.destroyed = false; this.webContents = new EventEmitter(); this.webContents.mainFrame = 'main-frame'; this.webContents.setWindowOpenHandler = (fn) => { this.windowOpenHandler = fn; }; this.webContents.send = () => {}; windows.push(this); }
    isDestroyed() { return this.destroyed; } setMenuBarVisibility() {} loadFile() {} show() {} focus() { counters.focus++; }
    getBounds() { return { width: 720, height: 470 }; } setPosition() {}
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
  }
  const electron = { app, BrowserWindow: FakeWindow, globalShortcut: shortcut, ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }) }, shell };
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'quickSearch.js'), 'utf8'); const module = { exports: {} };
  const localRequire = (request) => ({ electron, './settings': settings, './ipc': ipc, './libraryQuery': { queryLibrary: () => ({ rows: [] }) }, './localModels': { idleShutdown: () => counters.idle++ } }[request] || require(request));
  vm.runInNewContext(source, { require: localRequire, module, exports: module.exports, __dirname: path.join(__dirname, '..', 'src', 'main'), process, console });
  let opened = 0; const controller = module.exports.createQuickSearch({ openWindow: () => opened++, getMainWindow: () => overrides.mainWindow || null });
  return { controller, handlers, windows, counters, opened: () => opened, file, shortcutCalls };
}

test('IPC accepts only the live popup top frame', async () => {
  const x = load(); x.controller.show(); const popup = x.windows[0]; const state = x.handlers.get('quick-search:state');
  await assert.rejects(Promise.resolve().then(() => state({ sender: {}, senderFrame: popup.webContents.mainFrame })), /Rejected untrusted/);
  await assert.rejects(Promise.resolve().then(() => state({ sender: popup.webContents, senderFrame: {} })), /Rejected untrusted/);
  assert.equal((await state({ sender: popup.webContents, senderFrame: popup.webContents.mainFrame })).tosAccepted, true);
});

test('consent gate and shortcut registration failures remain usable', () => {
  const consent = load({ tosAccepted: false }); assert.equal(consent.controller.show(), false); assert.equal(consent.opened(), 1); assert.equal(consent.windows.length, 0);
  const denied = load({ shortcut: false }); assert.equal(denied.controller.start(), false); assert.equal(denied.controller.shortcutRegistered, false);
  const thrown = load({ shortcut: () => { throw new Error('conflict'); } }); assert.equal(thrown.controller.start(), false);
});

test('shortcut preference rebinds once, disables cleanly, and rejects invalid values', () => {
  const x = load(); x.controller.start(); assert.deepEqual(x.shortcutCalls.register, ['CommandOrControl+Shift+Space']);
  assert.equal(x.controller.applyShortcut('CommandOrControl+Alt+Space'), true); assert.deepEqual(x.shortcutCalls.unregister, ['CommandOrControl+Shift+Space']);
  x.controller.applyShortcut('CommandOrControl+Alt+Space'); assert.equal(x.shortcutCalls.register.length, 2);
  assert.equal(x.controller.applyShortcut(''), true); assert.equal(x.controller.status().status, 'disabled'); assert.deepEqual(x.shortcutCalls.unregister, ['CommandOrControl+Shift+Space', 'CommandOrControl+Alt+Space']);
  assert.equal(x.controller.applyShortcut('bad'), false); assert.equal(x.controller.status().status, 'unavailable');
});

test('open and reveal require indexed existing paths and surface shell failures', async () => {
  const x = load({ openError: 'open failed' }); x.controller.show(); const popup = x.windows[0]; const event = { sender: popup.webContents, senderFrame: popup.webContents.mainFrame }; const open = x.handlers.get('quick-search:open');
  await assert.rejects(open(event, x.file, false), /open failed/); await assert.rejects(open(event, path.join(path.dirname(x.file), 'missing-file'), false), /no longer indexed/);
  await open(event, x.file, true); assert.equal(x.counters.reveal, 1);
});

test('popup reuse, navigation denial, and destruction respect lifecycle', () => {
  const live = load({ mainWindow: {} }); live.controller.show(); const first = live.windows[0]; assert.equal(first.windowOpenHandler().action, 'deny');
  const navigate = { preventDefault: () => { navigate.prevented = true; } }; first.webContents.emit('will-navigate', navigate); assert.equal(navigate.prevented, true);
  live.controller.show(); assert.equal(live.windows.length, 1); assert.equal(live.counters.focus > 0, true); first.destroy(); assert.equal(live.counters.unload, 0); assert.equal(live.counters.idle, 0);
  const idle = load(); idle.controller.show(); idle.windows[0].destroy(); assert.equal(idle.counters.unload, 1); assert.equal(idle.counters.idle, 1); idle.controller.show(); assert.equal(idle.windows.length, 2);
});
