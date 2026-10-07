'use strict';

const { app, BrowserWindow, globalShortcut, ipcMain, screen, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const settings = require('./settings');
const ipc = require('./ipc');
const { queryLibrary } = require('./libraryQuery');

const DEFAULT_ACCELERATOR = 'CommandOrControl+Shift+Space';
const SHORTCUTS = new Set([DEFAULT_ACCELERATOR, 'CommandOrControl+Alt+Space', 'CommandOrControl+Shift+F', '']);

function createQuickSearch({ openWindow, getMainWindow }) {
  let popup = null;
  let registered = false;
  let handlersRegistered = false;
  let activeShortcut = '';
  let status = 'disabled';

  function owns(event) {
    return Boolean(popup && !popup.isDestroyed() && event?.sender === popup.webContents && event?.senderFrame === popup.webContents.mainFrame);
  }

  async function indexedPath(filePath) {
    const value = String(filePath || '');
    if (!value || !path.isAbsolute(value) || !fs.existsSync(value)) return null;
    const record = await ipc.withStore((store) => store.get(value));
    return record?.filePath === value ? value : null;
  }

  function registerHandlers() {
    if (handlersRegistered) return;
    handlersRegistered = true;
    ipcMain.handle('quick-search:state', (event) => {
      if (!owns(event)) throw new Error('Rejected untrusted quick-search sender');
      return { language: settings.get().language, platform: process.platform, tosAccepted: settings.get().tosAccepted === true, shortcut: activeShortcut, shortcutRegistered: registered, shortcutStatus: status };
    });
    ipcMain.handle('quick-search:query', async (event, query) => {
      if (!owns(event)) throw new Error('Rejected untrusted quick-search sender');
      const text = String(query || '').trim().slice(0, 240);
      if (!text) return { hits: [] };
      const result = await ipc.withStore((store) => queryLibrary(store.all(), { query: text, limit: 12 }));
      return { hits: result.rows || [] };
    });
    ipcMain.handle('quick-search:open', async (event, filePath, reveal) => {
      if (!owns(event)) throw new Error('Rejected untrusted quick-search sender');
      const allowed = await indexedPath(filePath);
      if (!allowed) throw new Error('Search result is no longer indexed');
      if (!owns(event)) throw new Error('Search window closed');
      if (reveal === true) return shell.showItemInFolder(allowed);
      const error = await shell.openPath(allowed);
      if (error) throw new Error(error);
      return '';
    });
    ipcMain.handle('quick-search:hide', (event) => {
      if (!owns(event)) throw new Error('Rejected untrusted quick-search sender');
      popup.destroy();
    });
  }

  function position() {
    if (!popup || popup.isDestroyed()) return;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const bounds = popup.getBounds();
    const area = display.workArea;
    const x = Math.round(Math.max(area.x, Math.min(area.x + area.width - bounds.width, area.x + (area.width - bounds.width) / 2)));
    const y = Math.round(Math.max(area.y, Math.min(area.y + area.height - bounds.height, area.y + Math.min(area.height * 0.25, 180))));
    popup.setPosition(x, y, false);
  }

  function show() {
    if (settings.get().tosAccepted !== true) {
      openWindow();
      return false;
    }
    ipc.resumeStore();
    if (popup && !popup.isDestroyed()) {
      position();
      popup.show();
      popup.focus();
      popup.webContents.send('quick-search:focus');
      return true;
    }
    popup = new BrowserWindow({
      width: 720,
      height: 470,
      minWidth: 520,
      minHeight: 300,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      title: 'Epilogue Quick Search',
      webPreferences: {
        preload: path.join(__dirname, '..', 'quickSearchPreload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: true,
      },
    });
    registerHandlers();
    popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    popup.webContents.on('will-navigate', (event) => event.preventDefault());
    popup.setMenuBarVisibility(false);
    popup.loadFile(path.join(__dirname, '..', 'renderer', 'quick-search.html'));
    popup.once('ready-to-show', () => {
      position();
      popup.show();
      popup.focus();
    });
    popup.on('closed', () => {
      popup = null;
      if (!getMainWindow?.()) {
        ipc.unloadStore();
        require('./localModels').idleShutdown();
      }
    });
    popup.on('blur', () => {
      if (popup && !popup.isDestroyed()) popup.destroy();
    });
    return true;
  }

  function start() {
    applyShortcut(settings.get().app?.quickSearchShortcut);
    app.on('will-quit', () => { if (activeShortcut) globalShortcut.unregister(activeShortcut); });
    return registered;
  }

  function applyShortcut(value) {
    const next = String(value ?? DEFAULT_ACCELERATOR);
    if (!SHORTCUTS.has(next)) { if (activeShortcut) globalShortcut.unregister(activeShortcut); activeShortcut = ''; registered = false; status = 'unavailable'; return false; }
    if (next === activeShortcut) return registered;
    if (activeShortcut) globalShortcut.unregister(activeShortcut);
    activeShortcut = next;
    if (!next) { registered = false; status = 'disabled'; return true; }
    try { registered = globalShortcut.register(next, show) === true; status = registered ? 'registered' : 'unavailable'; }
    catch { registered = false; status = 'unavailable'; }
    return registered;
  }

  return { start, show, applyShortcut, status: () => ({ shortcut: activeShortcut, registered, status }), isOpen: () => Boolean(popup && !popup.isDestroyed()), get shortcutRegistered() { return registered; } };
}

module.exports = { createQuickSearch, DEFAULT_ACCELERATOR };
