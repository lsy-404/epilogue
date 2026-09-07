'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const schedulerPath = path.resolve(__dirname, '../src/main/scheduler.js');

function loadScheduler(config, found) {
  const calls = { acquired: 0, released: 0, indexed: 0, soloIndexed: 0 };
  const store = { get: () => undefined };
  const originalLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    if (parent?.filename === schedulerPath) {
      if (request === 'electron') return {
        powerMonitor: { isOnBatteryPower: () => false, on() {} },
        Notification: { isSupported: () => false },
      };
      if (request === './settings') return { get: () => config };
      if (request === './stale') return { scanCleanup: () => found };
      if (request === './log') return { log() {} };
      if (request === './ipc') return {
        withStore: async (work) => {
          calls.acquired++;
          try {
            return await work(store);
          } finally {
            calls.released++;
          }
        },
      };
      if (request === './indexer') return {
        indexDestinations: async () => { calls.indexed++; },
        indexFile: async () => { calls.soloIndexed++; return { filePath: found[0].filePath }; },
      };
      if (request === './classifier') return { suggest: async () => [] };
      if (request === '../shared/locales') return { makeT: () => () => '' };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[schedulerPath];
  const scheduler = require(schedulerPath);
  return {
    scheduler,
    calls,
    dispose() {
      Module._load = originalLoad;
      delete require.cache[schedulerPath];
    },
  };
}

const tickDone = () => new Promise((resolve) => setImmediate(resolve));

test('automatic destination indexing retains the store until its background task settles', async (t) => {
  const { scheduler, calls, dispose } = loadScheduler({ cleanup: { autoScan: true }, destIndex: { enabled: true } }, []);
  t.after(dispose);
  assert.deepEqual(scheduler.tick(true), []);
  await tickDone();
  assert.deepEqual(calls, { acquired: 1, released: 1, indexed: 1, soloIndexed: 0 });
});

test('solo processing retains the store for the entire indexing workflow', async (t) => {
  const found = [{ filePath: '/files/old.txt', fileName: 'old.txt' }];
  const { scheduler, calls, dispose } = loadScheduler({
    cleanup: { autoScan: true, soloMode: true }, destIndex: { enabled: false }, language: 'en',
  }, found);
  t.after(dispose);
  assert.deepEqual(scheduler.tick(true), found);
  await tickDone();
  assert.deepEqual(calls, { acquired: 1, released: 1, indexed: 0, soloIndexed: 1 });
});
