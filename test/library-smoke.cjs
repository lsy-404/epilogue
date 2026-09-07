'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (!process.versions.electron) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'epilogue-library-smoke-'));
  try {
    const result = spawnSync(require('electron'), [__filename], {
      env: { ...process.env, EPILOGUE_SMOKE_DIR: fixture }, windowsHide: true, encoding: 'utf8', timeout: 25000,
    });
    if (result.error) throw result.error;
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    process.exitCode = result.status ?? 1;
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
  return;
}

const { app, BrowserWindow, session } = require('electron');

const fixture = process.env.EPILOGUE_SMOKE_DIR;
if (!fixture) throw new Error('Run this smoke test with Node.js.');
app.setPath('userData', fixture);
const timeout = setTimeout(() => app.exit(1), 20000);

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: /^https?:/.test(details.url) });
  });
  const settings = require('../src/main/settings');
  settings.set({ tosAccepted: true, recordedFolders: [{ path: fixture }], cleanup: { autoScan: false, folders: [] } });
  const ipc = require('../src/main/ipc');
  ipc.resumeStore();
  const store = ipc.getStore();
  for (let index = 0; index < 1001; index++) store.upsert({
    filePath: path.join(fixture, `${index}.txt`), fileName: `${index}.txt`,
    kind: 'text', summary: `Document ${index}`, fileMtime: 1700000000000 + index * 1000,
    indexedAt: new Date(1700000000000 + index * 1000).toISOString(),
  });
  store.flush();
  const window = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, '../src/preload.js'), contextIsolation: true, sandbox: true },
  });
  ipc.register(() => window);
  await window.loadFile(path.join(__dirname, '../src/renderer/index.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const waitFor = async (condition) => {
      const deadline = Date.now() + 5000;
      while (!condition()) {
        if (Date.now() > deadline) throw new Error('Renderer did not reach the expected state');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await waitFor(() => document.querySelector('#statTracked').textContent === '1001');
    const count = () => document.querySelectorAll('#libraryList [data-file-path]').length;
    const initial = count();
    document.querySelector('[data-view="ask"]').click();
    await waitFor(() => count() === 400);
    const first = count();
    document.querySelector('#btnLibMore').click();
    await waitFor(() => count() === 800);
    const second = count();
    const filter = document.querySelector('#libraryFilter');
    filter.value = '1000.txt';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => count() === 1);
    return { initial, first, second, filtered: count(), file: document.querySelector('#libraryList .item-title').textContent };
  })()`);
  assert.deepEqual(result, { initial: 0, first: 400, second: 800, filtered: 1, file: '1000.txt' });
  console.log(JSON.stringify(result));
  window.destroy();
  clearTimeout(timeout);
  app.exit(0);
}).catch((error) => {
  console.error(error);
  clearTimeout(timeout);
  app.exit(1);
});
