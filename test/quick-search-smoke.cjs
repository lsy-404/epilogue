'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (!process.versions.electron) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'epilogue-quick-search-'));
  try {
    const environment = { ...process.env, EPILOGUE_SEARCH_FIXTURE: fixture };
    delete environment.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require('electron'), [__filename], {
      env: environment, encoding: 'utf8', timeout: 35000,
    });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
  return;
}

const { app, BrowserWindow, globalShortcut, session, shell } = require('electron');
const fixture = process.env.EPILOGUE_SEARCH_FIXTURE;
if (!fixture) throw new Error('Run this smoke test with Node.js.');
app.setPath('userData', fixture);
app.on('window-all-closed', () => {});
const timeout = setTimeout(() => app.exit(1), 30000);

async function waitFor(condition, label) {
  const deadline = Date.now() + 5000;
  while (!await condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
  const settings = require('../src/main/settings');
  settings.set({ tosAccepted: false, language: 'en', cleanup: { autoScan: false, folders: [] } });
  const ipc = require('../src/main/ipc');
  const { createQuickSearch, DEFAULT_ACCELERATOR } = require('../src/main/quickSearch');
  let mainOpened = 0;
  let mainWindow = null;
  const controller = createQuickSearch({ openWindow: () => { mainOpened++; }, getMainWindow: () => mainWindow });
  assert.equal(controller.show(), false);
  assert.equal(mainOpened, 1);
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  settings.set({ tosAccepted: true });
  ipc.resumeStore();
  for (let index = 0; index < 15; index++) {
    const name = `Report ${String(index).padStart(2, '0')}.txt`;
    const filePath = path.join(fixture, name);
    fs.writeFileSync(filePath, 'Fixture only');
    ipc.getStore().upsert({ filePath, fileName: name, kind: 'text', summary: 'Research document', indexedAt: new Date().toISOString() });
  }
  ipc.getStore().flush();
  ipc.unloadStore();
  const registered = controller.start();
  assert.equal(globalShortcut.isRegistered(DEFAULT_ACCELERATOR), registered);
  const alternate = 'CommandOrControl+Alt+Space';
  const alternateRegistered = controller.applyShortcut(alternate);
  assert.equal(globalShortcut.isRegistered(alternate), alternateRegistered);
  assert.equal(globalShortcut.isRegistered(DEFAULT_ACCELERATOR), false);
  let popup;
  async function show() {
    controller.show();
    popup = BrowserWindow.getAllWindows()[0];
    popup.webContents.on('did-fail-load', (_event, code, description) => console.error('Popup load failed', code, description));
    popup.webContents.on('render-process-gone', (_event, details) => console.error('Popup renderer exited', details.reason));
    if (process.env.EPILOGUE_SMOKE_DEBUG) {
      popup.on('ready-to-show', () => console.log('Popup ready', popup.isVisible()));
      popup.webContents.on('did-finish-load', () => console.log('Popup loaded'));
    }
    await waitFor(() => popup.isVisible(), 'popup ready');
    await waitFor(() => popup.webContents.executeJavaScript('document.activeElement.id === "query"'), 'query focus');
    return popup;
  }
  async function search(query, count) {
    await popup.webContents.executeJavaScript(`document.querySelector('#query').value = ${JSON.stringify(query)}; document.querySelector('#query').dispatchEvent(new Event('input'));`);
    await waitFor(() => popup.webContents.executeJavaScript(`document.querySelectorAll('#results li').length === ${count}`), 'search results');
  }
  const opened = [];
  const revealed = [];
  shell.openPath = async (file) => { opened.push(file); return 'Fixture open failure'; };
  shell.showItemInFolder = (file) => { revealed.push(file); };
  await show();
  assert.match(await popup.webContents.executeJavaScript(`document.querySelector('#shortcut').textContent`), /Ctrl\+Alt\+Space|Cmd\+Alt\+Space/);
  assert.deepEqual(await popup.webContents.executeJavaScript(`({ bridge: Object.keys(window.epilogueQuickSearch).sort(), node: typeof require, main: typeof window.epologue })`), {
    bridge: ['hide', 'onFocus', 'open', 'query', 'state'], node: 'undefined', main: 'undefined',
  });
  await search('Report', 12);
  const geometry = await popup.webContents.executeJavaScript(`({ height: innerHeight, bottom: document.querySelector('.panel').getBoundingClientRect().bottom, overflow: document.documentElement.scrollHeight > innerHeight })`);
  assert.equal(geometry.overflow, false);
  assert.ok(geometry.bottom <= geometry.height);
  await popup.webContents.executeJavaScript(`document.querySelector('#query').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));`);
  assert.equal(opened.length, 0);
  popup.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  await waitFor(() => popup.webContents.executeJavaScript(`document.querySelector('#status').textContent.includes('Fixture open failure')`), 'open failure visible');
  assert.equal(popup.isDestroyed(), false);
  assert.equal(opened.length, 1);
  assert.match(await popup.webContents.executeJavaScript(`window.epilogueQuickSearch.open(${JSON.stringify(path.join(fixture, 'settings.json'))}).catch(error => error.message)`), /no longer indexed/);

  await search('Report', 12);
  await popup.webContents.executeJavaScript(`document.querySelector('#query').value = 'missing'; document.querySelector('#query').dispatchEvent(new Event('input')); document.querySelector('#query').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`);
  assert.equal(opened.length, 1);
  await waitFor(() => popup.webContents.executeJavaScript(`document.querySelector('#status').textContent === 'No matching files'`), 'empty state');
  const originalWithStore = ipc.withStore;
  let releaseQuery;
  ipc.withStore = (operation) => {
    ipc.withStore = originalWithStore;
    return new Promise((resolve, reject) => { releaseQuery = () => originalWithStore(operation).then(resolve, reject); });
  };
  await popup.webContents.executeJavaScript(`document.querySelector('#query').value = 'Report'; document.querySelector('#query').dispatchEvent(new Event('input'));`);
  await waitFor(() => Boolean(releaseQuery), 'delayed query started');
  await popup.webContents.executeJavaScript(`document.querySelector('#query').value = 'absent'; document.querySelector('#query').dispatchEvent(new Event('input'));`);
  await releaseQuery();
  assert.equal(await popup.webContents.executeJavaScript(`document.querySelectorAll('#results li').length`), 0);
  await waitFor(() => popup.webContents.executeJavaScript(`document.querySelector('#status').textContent === 'No matching files'`), 'stale query ignored');
  await search('Report', 12);
  for (let index = 0; index < 10; index++) popup.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
  await waitFor(() => popup.webContents.executeJavaScript(`document.querySelector('#results [aria-selected="true"] .name').textContent === 'Report 10.txt'`), 'arrow selection');
  const scroll = await popup.webContents.executeJavaScript(`(() => { const row = document.querySelector('#results .selected').getBoundingClientRect(); const list = document.querySelector('#results').getBoundingClientRect(); return { row: row.bottom, list: list.bottom }; })()`);
  assert.ok(scroll.row <= scroll.list + 1);
  const screenshot = process.env.EPILOGUE_SEARCH_SCREENSHOT;
  if (screenshot) fs.writeFileSync(screenshot, (await popup.webContents.capturePage()).toPNG());
  popup.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['shift'] });
  await waitFor(() => !controller.isOpen(), 'reveal closes popup');
  assert.equal(revealed[0], path.join(fixture, 'Report 10.txt'));
  await show();
  await search('Report 00', 1);
  shell.openPath = async (file) => { opened.push(file); return ''; };
  popup.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  await waitFor(() => !controller.isOpen(), 'open closes popup');
  assert.equal(opened.at(-1), path.join(fixture, 'Report 00.txt'));
  await show();
  await popup.webContents.executeJavaScript(`document.querySelector('#close').focus()`);
  popup.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await waitFor(() => !controller.isOpen(), 'escape closes popup');
  await show();
  popup.emit('blur');
  await waitFor(() => !controller.isOpen(), 'blur closes popup');
  assert.equal(await ipc.withStore((store) => store.stats().total), 15);
  settings.set({ app: { quickSearchShortcut: '' }, recordedFolders: [{ path: fixture }] });
  controller.applyShortcut('');
  assert.equal(controller.status().status, 'disabled');
  mainWindow = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(__dirname, '../src/preload.js'), sandbox: true, contextIsolation: true,
  } });
  ipc.register(() => mainWindow, {
    onSettingsChanged: (cfg) => controller.applyShortcut(cfg.app.quickSearchShortcut),
    getQuickSearchStatus: () => controller.status(),
  });
  await mainWindow.loadFile(path.join(__dirname, '../src/renderer/index.html'));
  await waitFor(() => mainWindow.webContents.executeJavaScript(`document.querySelector('#quickSearchStatus').textContent.includes('disabled')`), 'disabled status');
  assert.equal(await mainWindow.webContents.executeJavaScript(`document.querySelector('#prefQuickSearchShortcut').value`), '');
  await mainWindow.webContents.executeJavaScript(`document.querySelector('#prefQuickSearchShortcut').value = ${JSON.stringify(alternate)}; document.querySelector('#prefQuickSearchShortcut').dispatchEvent(new Event('input', { bubbles: true }));`);
  await waitFor(() => settings.get().app.quickSearchShortcut === alternate, 'shortcut preference saved');
  await mainWindow.loadFile(path.join(__dirname, '../src/renderer/index.html'));
  await waitFor(() => mainWindow.webContents.executeJavaScript(`document.querySelector('#quickSearchStatus').textContent.length > 0`), 'settings reloaded');
  assert.equal(await mainWindow.webContents.executeJavaScript(`document.querySelector('#prefQuickSearchShortcut').value`), alternate);
  await mainWindow.webContents.executeJavaScript(`document.querySelector('#prefQuickSearchShortcut').value = ''; document.querySelector('#prefQuickSearchShortcut').dispatchEvent(new Event('input', { bubbles: true }));`);
  await waitFor(() => settings.get().app.quickSearchShortcut === '', 'disabled preference saved');
  await mainWindow.loadFile(path.join(__dirname, '../src/renderer/index.html'));
  await waitFor(() => mainWindow.webContents.executeJavaScript(`document.querySelector('#quickSearchStatus').textContent.includes('disabled')`), 'disabled preference retained');
  assert.equal(await mainWindow.webContents.executeJavaScript(`document.querySelector('#prefQuickSearchShortcut').value`), '');
  mainWindow.destroy();
  mainWindow = null;
  globalShortcut.unregisterAll();
  clearTimeout(timeout);
  console.log(JSON.stringify({ quickSearch: 'passed', registered, alternateRegistered, records: 15, boundedResults: 12, open: opened.length, reveal: revealed.length, lifecycle: 'passed', settings: 'passed' }));
  app.exit(0);
}).catch((error) => {
  console.error(error);
  globalShortcut.unregisterAll();
  clearTimeout(timeout);
  app.exit(1);
});
