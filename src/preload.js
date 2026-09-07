'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('epologue', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  detectFolders: () => ipcRenderer.invoke('folders:detect'),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  pickFiles: () => ipcRenderer.invoke('dialog:pickFiles'),
  indexFolder: (dir, recursive) => ipcRenderer.invoke('index:folder', dir, recursive),
  indexDestinations: () => ipcRenderer.invoke('dest:index'),
  indexFiles: (paths) => ipcRenderer.invoke('index:files', paths),
  storeStats: () => ipcRenderer.invoke('store:stats'),
  storeList: (options) => ipcRenderer.invoke('store:list', options),
  storeRecent: (n) => ipcRenderer.invoke('store:recent', n),
  assistantChat: (history) => ipcRenderer.invoke('assistant:chat', history),
  assistantResolveApproval: (id, approved) => ipcRenderer.invoke('assistant:approval', id, approved),
  storeRemove: (p) => ipcRenderer.invoke('store:remove', p),
  ask: (question, mode) => ipcRenderer.invoke('search:ask', question, mode),
  modelStatus: (model) => ipcRenderer.invoke('model:status', model),
  reportNetwork: (metered) => ipcRenderer.invoke('network:report', metered),
  modelDownload: (task, model) => ipcRenderer.invoke('model:download', task, model),
  modelDelete: (model) => ipcRenderer.invoke('model:delete', model),
  onModelProgress: (cb) => {
    const listener = (_e, p) => cb(p);
    ipcRenderer.on('model:progress', listener);
    return () => ipcRenderer.removeListener('model:progress', listener);
  },
  scanStale: (dirs, days) => ipcRenderer.invoke('stale:scan', dirs, days),
  scanCleanup: () => ipcRenderer.invoke('cleanup:scan'),
  powerStatus: () => ipcRenderer.invoke('power:status'),
  onAutoScan: (cb) => {
    const listener = (_e, found) => cb(found);
    ipcRenderer.on('stale:auto', listener);
    return () => ipcRenderer.removeListener('stale:auto', listener);
  },
  onViewOpen: (cb) => {
    const listener = (_e, view) => cb(view);
    ipcRenderer.on('view:open', listener);
    return () => ipcRenderer.removeListener('view:open', listener);
  },
  classifySuggest: (paths) => ipcRenderer.invoke('classify:suggest', paths),
  classifyApply: (moves) => ipcRenderer.invoke('classify:apply', moves),
  classifyUndoLatest: (transactionId) => ipcRenderer.invoke('classify:undoLatest', transactionId),
  classifyUndoStatus: () => ipcRenderer.invoke('classify:undoStatus'),
  listModels: (which, provider) => ipcRenderer.invoke('models:list', which, provider),
  providerTest: (type, provider) => ipcRenderer.invoke('provider:test', type, provider),
  providerCatalog: (force = false) => ipcRenderer.invoke('providers:catalog', force),
  providerSourceAdd: (sourceId) => ipcRenderer.invoke('providers:sourceAdd', sourceId),
  oauthAccounts: (provider) => ipcRenderer.invoke('oauth:accounts', provider),
  oauthAuthorize: (provider) => ipcRenderer.invoke('oauth:authorize', provider),
  oauthRemove: (provider, id) => ipcRenderer.invoke('oauth:remove', provider, id),
  modelAuthState: () => ipcRenderer.invoke('model-auth:state'),
  modelAuthExecute: (action, operationId) => ipcRenderer.invoke('model-auth:execute', action, operationId),
  modelAuthCancel: (operationId) => ipcRenderer.invoke('model-auth:cancel', operationId),
  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  copyText: (value) => ipcRenderer.invoke('clipboard:write', value),
  revealLog: () => ipcRenderer.invoke('log:reveal'),
  appVersion: () => ipcRenderer.invoke('app:version'),
  appDoc: (name) => ipcRenderer.invoke('app:doc', name),
  clearLog: () => ipcRenderer.invoke('log:clear'),
  storageStats: () => ipcRenderer.invoke('storage:stats'),
  storageCleanKind: (kind) => ipcRenderer.invoke('storage:cleanKind', kind),
  onIndexProgress: (cb) => {
    const listener = (_e, p) => cb(p);
    ipcRenderer.on('index:progress', listener);
    return () => ipcRenderer.removeListener('index:progress', listener);
  },
});
