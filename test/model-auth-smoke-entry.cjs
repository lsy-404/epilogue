const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain } = require('electron');

const directory = path.resolve(__dirname, '.output', 'model-auth-smoke-profile');
fs.mkdirSync(directory, { recursive: true });
app.setPath('userData', directory);
app.setAppPath(path.resolve(__dirname, '..'));
app.setName('Epilogue Auth Test');
app.whenReady().then(() => {
  const modelAuth = require('../src/main/modelAuth');
  const operations = new Map();
  ipcMain.handle('model-auth:state', () => modelAuth.state());
  ipcMain.handle('model-auth:execute', async (_event, action, id) => {
    const controller = new AbortController();
    operations.set(id, controller);
    try { await modelAuth.execute(action, { signal: controller.signal }); }
    finally { operations.delete(id); }
  });
  ipcMain.handle('model-auth:cancel', (_event, id) => { operations.get(id)?.abort(); });
  const window = new BrowserWindow({ width: 1000, height: 750, title: 'Epilogue model-auth verification', webPreferences: {
    preload: path.resolve(__dirname, '../src/preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false,
  } });
  window.loadFile(path.resolve(__dirname, 'model-auth-smoke.html'));
});
app.on('window-all-closed', () => app.quit());
