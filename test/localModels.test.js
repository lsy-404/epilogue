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
const hostSettings = (hfMirror = '', imageDevice = 'auto') => ({ app: { hfMirror }, imageEmbed: { device: imageDevice } });

function useFakeTimers() {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timers = [];
  global.setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false, unref: () => timer };
    timers.push(timer);
    return timer;
  };
  global.clearTimeout = (timer) => { timer.cleared = true; };
  return {
    timers,
    run(timer) {
      if (!timer.cleared) timer.callback();
    },
    restore() {
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    },
  };
}

function loadLocalModels({ postMessage } = {}) {
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
            host.postMessage = postMessage || ((message) => host.messages.push(message));
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
  const clock = useFakeTimers();
  const fixture = loadLocalModels();
  try {
    const request = fixture.localModels.embed(['document']);
    const host = fixture.hosts[0];
    fixture.localModels.idleShutdown();
    assert.equal(host.kills, 0);

    host.emit('message', { id: host.messages[0].id, ok: true, result: [[0.1]] });
    await assert.doesNotReject(request);
    assert.equal(clock.timers[0].delay, 5000);
    clock.run(clock.timers[0]);
    assert.equal(host.kills, 1);
  } finally {
    fixture.restore();
    clock.restore();
  }
});

test('reopening the window cancels a deferred idle shutdown', async () => {
  const clock = useFakeTimers();
  const fixture = loadLocalModels();
  try {
    const request = fixture.localModels.embed(['document']);
    const host = fixture.hosts[0];
    fixture.localModels.idleShutdown();
    fixture.localModels.cancelIdleShutdown();
    host.emit('message', { id: host.messages[0].id, ok: true, result: [[0.1]] });
    await request;
    assert.equal(clock.timers.length, 0);
    assert.equal(host.kills, 0);
  } finally {
    fixture.restore();
    clock.restore();
  }
});

test('an idle delay keeps the host alive across sequential batch requests', async () => {
  const clock = useFakeTimers();
  const fixture = loadLocalModels();
  try {
    const first = fixture.localModels.embed(['first']);
    const host = fixture.hosts[0];
    fixture.localModels.idleShutdown();
    host.emit('message', { id: host.messages[0].id, ok: true, result: [[0.1]] });
    await first;
    await nextTurn();

    const second = fixture.localModels.embed(['second']);
    assert.equal(clock.timers[0].cleared, true);
    host.emit('message', { id: host.messages[1].id, ok: true, result: [[0.2]] });
    await second;
    assert.equal(host.kills, 0);
    clock.run(clock.timers[1]);
    assert.equal(host.kills, 1);
  } finally {
    fixture.restore();
    clock.restore();
  }
});

test('only model-host environment setting changes restart the host', async () => {
  const clock = useFakeTimers();
  const fixture = loadLocalModels();
  try {
    fixture.localModels.applyHostSettings(hostSettings());
    const request = fixture.localModels.embed(['document']);
    const host = fixture.hosts[0];
    host.emit('message', { id: host.messages[0].id, ok: true, result: [[0.1]] });
    await request;

    fixture.localModels.applyHostSettings({ ...hostSettings(), language: 'zh' });
    assert.equal(host.kills, 0);
    fixture.localModels.applyHostSettings(hostSettings('https://mirror.example.test'));
    assert.equal(host.kills, 1);

    const replacement = fixture.localModels.embed(['replacement']);
    const replacementHost = fixture.hosts[1];
    replacementHost.emit('message', { id: replacementHost.messages[0].id, ok: true, result: [[0.2]] });
    await replacement;
    fixture.localModels.applyHostSettings(hostSettings('https://mirror.example.test', 'cpu'));
    assert.equal(replacementHost.kills, 1);
  } finally {
    fixture.restore();
    clock.restore();
  }
});

test('tray intent reclaims a later task after the first task was already reclaimed', async () => {
  const clock = useFakeTimers();
  const fixture = loadLocalModels();
  try {
    const first = fixture.localModels.embed(['first']);
    const firstHost = fixture.hosts[0];
    firstHost.emit('message', { id: firstHost.messages[0].id, ok: true, result: [[0.1]] });
    await first;
    clock.run(clock.timers[0]);
    assert.equal(firstHost.kills, 1);

    const second = fixture.localModels.embed(['second']);
    const secondHost = fixture.hosts[1];
    secondHost.emit('message', { id: secondHost.messages[0].id, ok: true, result: [[0.2]] });
    await second;
    clock.run(clock.timers[1]);
    assert.equal(secondHost.kills, 1);
  } finally {
    fixture.restore();
    clock.restore();
  }
});

test('a synchronous postMessage failure clears pending work and still schedules idle reclaim', async () => {
  const clock = useFakeTimers();
  const fixture = loadLocalModels({ postMessage: () => { throw new Error('host unavailable'); } });
  try {
    await assert.rejects(fixture.localModels.embed(['document']), /host unavailable/);
    const host = fixture.hosts[0];
    assert.equal(clock.timers[0].delay, 5000);
    clock.run(clock.timers[0]);
    assert.equal(host.kills, 1);
  } finally {
    fixture.restore();
    clock.restore();
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
