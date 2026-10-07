'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('epilogueQuickSearch', {
  state: () => ipcRenderer.invoke('quick-search:state'),
  query: (value) => ipcRenderer.invoke('quick-search:query', value),
  open: (filePath, reveal = false) => ipcRenderer.invoke('quick-search:open', filePath, reveal),
  hide: () => ipcRenderer.invoke('quick-search:hide'),
  onFocus: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('quick-search:focus', listener);
    return () => ipcRenderer.removeListener('quick-search:focus', listener);
  },
});
