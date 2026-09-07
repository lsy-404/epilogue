'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const path = require('node:path');

const localModelsPath = require.resolve('../src/main/localModels');
const settingsPath = require.resolve('../src/main/settings');
const logPath = require.resolve('../src/main/log');
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function loadLocalModels() {
  const hosts = [];
  const logs = [];
  const originalLoad = Module._load;
  const savedSettings = require.cache[settingsPath];
  const savedLog = require.cache[logPath];
  require.cache[settingsPath] = {
    id: settingsPath,
    filename: settingsPath,
    loaded: true,
    exports: { get: () => ({ app: {}, imageEmbed: {} }) },
  };
  require.cache[logPath] = {
    id: logPath,
    filename: logPath,
    loaded: true,
    exports: { log: (...entry) => logs.push(entry) },
  };
  Module._load = (request, parent, isMain) => {
    if (request === 'electron') {
      return {
        app: { getPath: () => path.join(process.cwd(), '.test-models') },
        utilityProcess: {
          fork: () => {
            const host = new EventEmitter();
            host.messages = [];
            host.kills = 0;
            host.postMessage = (message) => host.messages.push(message);
            host.kill = () => { host.kills += 1; };
            hosts.push(host);
            return host;
          },
        },
      };
    }
    return originalLoad(request, parent, isMain);
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
    hosts,
    logs,
    restore() {
      delete require.cache[localModelsPath];
      if (savedSettings) require.cache[settingsPath] = savedSettings;
      else delete require.cache[settingsPath];
      if (savedLog) require.cache[logPath] = savedLog;
      else delete require.cache[logPath];
    },
  };
}

test('idle shutdown waits for the active model request and then reclaims the host', async () => {
  const fixture = loadLocalModels();
  try {
    const request = fixture.localModels.embed(['document']);
    const host = fixture.hosts[0];
    fixture.localModels.idleShutdown();
    assert.equal(host.kills, 0);

    host.emit('message', { id: host.messages[0].id, ok: true, result: [[0.1]] });
    await assert.doesNotReject(request);
    await nextTurn();
    assert.equal(host.kills, 1);
  } finally {
    fixture.restore();
  }
});

test('reopening the window cancels a deferred idle shutdown', async () => {
  const fixture = loadLocalModels();
  try {
    const request = fixture.localModels.embed(['document']);
    const host = fixture.hosts[0];
    fixture.localModels.idleShutdown();
    fixture.localModels.cancelIdleShutdown();
    host.emit('message', { id: host.messages[0].id, ok: true, result: [[0.1]] });
    await request;
    await nextTurn();
    assert.equal(host.kills, 0);
  } finally {
    fixture.restore();
  }
});

test('an old host exit does not clear or reject a request sent to its replacement', async () => {
  const fixture = loadLocalModels();
  try {
    const first = fixture.localModels.embed(['first']);
    const oldHost = fixture.hosts[0];
    oldHost.emit('message', { id: oldHost.messages[0].id, ok: true, result: [[0.1]] });
    await first;

    fixture.localModels.restartHost();
    const replacementRequest = fixture.localModels.embed(['replacement']);
    const replacementHost = fixture.hosts[1];
    oldHost.emit('exit');
    assert.equal(fixture.logs.at(-1)[2].pendingCalls, 0);

    replacementHost.emit('message', { id: replacementHost.messages[0].id, ok: true, result: [[0.2]] });
    assert.deepEqual(await replacementRequest, [[0.2]]);
  } finally {
    fixture.restore();
  }
});
