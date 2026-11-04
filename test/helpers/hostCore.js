'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { fork } = require('node:child_process');

const shim = path.join(__dirname, 'hostShim.cjs');
const hostFile = path.join(__dirname, '../../src/main/modelHost.js');
const localModelsPath = require.resolve('../../src/main/localModels');
const settingsPath = require.resolve('../../src/main/settings');
const logPath = require.resolve('../../src/main/log');

// Loads the real localModels with utilityProcess.fork backed by a Node child running the real modelHost.js.
function loadLocalModelsWithHost() {
  const logs = [];
  const forks = [];
  const modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epilogue-host-'));
  const originalLoad = Module._load;
  const saved = { settings: require.cache[settingsPath], log: require.cache[logPath] };
  const stub = (file, exports) => {
    require.cache[file] = { id: file, filename: file, loaded: true, exports };
  };
  stub(settingsPath, { get: () => ({ app: { hfMirror: '' } }) });
  stub(logPath, { log: (...entry) => logs.push(entry) });
  Module._load = (request, parent, isMain) => {
    if (request !== 'electron') return originalLoad(request, parent, isMain);
    return {
      app: { getPath: () => modelsDir },
      utilityProcess: {
        fork: (_file, _args, options) => {
          const child = fork(hostFile, [], { execArgv: ['--require', shim], env: options.env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
          child.postMessage = (message) => child.send(message);
          forks.push(child);
          return child;
        },
      },
    };
  };
  delete require.cache[localModelsPath];
  let localModels;
  try {
    localModels = require(localModelsPath);
  } finally {
    Module._load = originalLoad;
  }
  return {
    localModels,
    logs,
    forks,
    dispose() {
      localModels.restartHost();
      for (const child of forks) child.kill();
      delete require.cache[localModelsPath];
      for (const [file, entry] of [[settingsPath, saved.settings], [logPath, saved.log]]) {
        if (entry) require.cache[file] = entry;
        else delete require.cache[file];
      }
      fs.rmSync(modelsDir, { recursive: true, force: true });
    },
  };
}

module.exports = { loadLocalModelsWithHost };
