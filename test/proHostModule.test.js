'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const hooks = require('../src/main/hooks');
const { createVerifier } = require('../src/main/proVerify');
const { createExtensionManager, createCore } = require('../src/main/extensions');
const { makeKeys, signLicense, buildPackage } = require('./helpers/pro');
const { loadLocalModelsWithHost } = require('./helpers/hostCore');

const HOST_SOURCE = `
exports.activate = (hostApi) => ({
  echo: async (value) => ({ value, packageDir: hostApi.packageDir, keys: Object.keys(hostApi).sort(), progressKeys: Object.keys(hostApi.progress).sort() }),
  fail: async () => { throw new Error('op failed'); },
  hang: () => new Promise(() => {}),
  logIt: async () => { hostApi.log('hello from host', { n: 1 }); return true; },
  badRequire: async () => require('left-pad'),
  builtin: async () => typeof require('node:path').join,
  'download:custom': async (model) => { globalThis.__downloaded = model; },
  'unload:model': async (model) => { globalThis.__unloaded = model; },
  seen: async () => [globalThis.__downloaded ?? null, globalThis.__unloaded ?? null],
});`;

const spec = (source = HOST_SOURCE) => ({ source, filename: 'host.cjs', packageDir: '/pkg' });

function withHost(t) {
  const fixture = loadLocalModelsWithHost();
  t.after(() => {
    fixture.dispose();
    hooks.reset();
  });
  return fixture;
}

test('a registered host module answers calls and gets the restricted require and hostApi surface', async (t) => {
  const { localModels, logs } = withHost(t);
  localModels.setHostModule(spec());
  const out = await localModels.hostCall('echo', 5);
  assert.equal(out.value, 5);
  assert.equal(out.packageDir, '/pkg');
  assert.deepEqual(out.keys, ['getPipeline', 'log', 'packageDir', 'progress', 'report', 'transformers']);
  assert.deepEqual(out.progressKeys, ['callback', 'clear', 'done']);
  assert.equal(await localModels.hostCall('builtin'), 'function');
  await assert.rejects(localModels.hostCall('badRequire'), /not allowed in extensions/);
  await assert.rejects(localModels.hostCall('fail'), /op failed/);
  await assert.rejects(localModels.hostCall('nope'), /unknown host op 'nope'/);
  await localModels.hostCall('logIt');
  assert.ok(logs.some(([scope, message, extra]) => scope === 'models' && message === 'hello from host' && extra.n === 1));
  assert.equal(await localModels.hostCall('unload', 'org/model'), true);
});

test('the module is registered again after every host restart and can be replaced or cleared live', async (t) => {
  const { localModels } = withHost(t);
  localModels.setHostModule(spec());
  await localModels.hostCall('echo', 1);
  const first = localModels.hostPid();
  assert.equal(typeof first, 'number');
  localModels.restartHost();
  assert.equal(localModels.hostPid(), null);
  assert.equal((await localModels.hostCall('echo', 2)).value, 2);
  assert.notEqual(localModels.hostPid(), first);

  localModels.setHostModule(spec('exports.activate = () => ({ other: async () => "replaced" });'));
  assert.equal(await localModels.hostCall('other'), 'replaced');
  await assert.rejects(localModels.hostCall('echo', 3), /unknown host op 'echo'/);
  localModels.setHostModule(null);
  await assert.rejects(localModels.hostCall('other'), /unknown host op 'other'/);
});

test('a failing registration leaves the core ops working and names the cause', async (t) => {
  const { localModels } = withHost(t);
  localModels.setHostModule(spec('exports.activate = () => ({ embed: async () => 1, ok: async () => 2 });'));
  await assert.rejects(localModels.hostCall('ok'), /host module failed: host op 'embed' is reserved/);
  assert.equal(await localModels.hostCall('unload', 'org/model'), true);
  localModels.setHostModule(spec('throw new Error("syntax boom");'));
  await assert.rejects(localModels.hostCall('echo'), /syntax boom/);
});

test('download:<task> and unload:model ops take over loading for custom tasks', async (t) => {
  const { localModels } = withHost(t);
  localModels.setHostModule(spec());
  await localModels.download('custom', 'org/model');
  assert.deepEqual(await localModels.hostCall('seen'), ['org/model', null]);
  const hanging = localModels.hostCall('hang').catch(() => {});
  localModels.remove('org/model');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(await localModels.hostCall('seen'), ['org/model', 'org/model']);
  localModels.restartHost();
  await hanging;
});

test('host:busy and host:idle bracket pending calls and stopHost refuses while one is pending', async (t) => {
  const { localModels } = withHost(t);
  const events = [];
  hooks.attach((event) => events.push(event));
  localModels.setHostModule(spec());
  await Promise.all([localModels.hostCall('echo', 1), localModels.hostCall('echo', 2)]);
  assert.deepEqual(events, ['host:busy', 'host:idle']);

  events.length = 0;
  const settled = localModels.hostCall('hang').catch((error) => error.message);
  assert.deepEqual(events, ['host:busy']);
  assert.equal(localModels.stopHostIfIdle(), false);
  assert.equal(typeof localModels.hostPid(), 'number');
  localModels.restartHost();
  assert.match(await settled, /模型进程已退出/);
  assert.deepEqual(events, ['host:busy', 'host:idle']);
  assert.equal(localModels.stopHostIfIdle(), true);
});

const keys = makeKeys();
const verifier = createVerifier(keys.verifierKeys);

function manager({ platform, core, chmod } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'epilogue-pro-hooks-'));
  const mgr = createExtensionManager({
    verifier,
    userData,
    coreVersion: '0.0.0-test',
    platform,
    settings: { get: () => ({}), patch: (p) => p },
    ipcHandle: () => {},
    core,
    chmod,
  });
  mgr.importLicense(signLicense(keys.license, {}));
  return { mgr, userData };
}

const MAIN = Buffer.from('exports.activate = (api) => { globalThis.__proApi = api; };');
const hostPackage = ({ manifest = {}, files = {}, platform = process.platform } = {}) =>
  buildPackage(keys.extension, {
    files: { 'main.cjs': MAIN, 'renderer.js': Buffer.from('//'), 'host.cjs': Buffer.from(HOST_SOURCE), ffmpeg: Buffer.from('binary'), ...files },
    manifest: {
      platform,
      entries: { main: 'main.cjs', renderer: 'renderer.js', host: 'host.cjs' },
      executables: ['ffmpeg'],
      ...manifest,
    },
  });

test('executables get mode 0755 outside Windows only', () => {
  const calls = [];
  const chmod = (file, mode) => calls.push([path.basename(file), mode]);
  manager({ platform: 'linux', chmod }).mgr.installPackage(hostPackage({ platform: 'linux' }));
  assert.deepEqual(calls, [['ffmpeg', 0o755]]);

  calls.length = 0;
  manager({ platform: 'win32', chmod }).mgr.installPackage(hostPackage({ platform: 'win32' }));
  assert.deepEqual(calls, []);
});

test('installed executables are executable on POSIX hosts', { skip: process.platform === 'win32' }, () => {
  const { mgr, userData } = manager();
  mgr.installPackage(hostPackage());
  const file = path.join(userData, 'pro', 'ext', '1.0.0', 'ffmpeg');
  assert.equal(fs.statSync(file).mode & 0o777, 0o755);
});

test('host and executables entries must name files of the package', () => {
  const { mgr } = manager();
  const rejects = (zip) => assert.throws(() => mgr.installPackage(zip), (error) => error.code === 'manifest_format');
  rejects(hostPackage({ manifest: { entries: { main: 'main.cjs', renderer: 'renderer.js', host: 'missing.cjs' } } }));
  rejects(hostPackage({ manifest: { executables: ['missing'] } }));
  rejects(hostPackage({ manifest: { executables: 'ffmpeg' } }));
  rejects(hostPackage({ manifest: { executables: Array.from({ length: 9 }, () => 'ffmpeg') } }));
});

test('loading registers the verified host source with the model host and deactivating clears it', async () => {
  const registered = [];
  const { mgr, userData } = manager({ core: { modelHost: { setModule: (module) => registered.push(module) } } });
  mgr.installPackage(hostPackage());
  assert.equal((await mgr.load()).active, true);
  const dir = path.join(userData, 'pro', 'ext', '1.0.0');
  assert.deepEqual(registered, [{ source: HOST_SOURCE, filename: path.join(dir, 'host.cjs'), packageDir: dir }]);
  assert.equal(globalThis.__proApi.paths.packageDir, dir);
  mgr.deactivate();
  assert.deepEqual(registered.at(-1), null);
});

test('the api object exposes exactly the documented members', async () => {
  const { mgr } = manager();
  mgr.installPackage(hostPackage());
  await mgr.load();
  const api = globalThis.__proApi;
  const shape = (value) => Object.keys(value).sort();
  assert.deepEqual(shape(api), ['PRO_API', 'assistant', 'chat', 'embedLocal', 'events', 'extract', 'extractors', 'index', 'ipc', 'license', 'lifecycle', 'log', 'modelHost', 'paths', 'power', 'providers', 'scheduler', 'search', 'settings', 'vectorSpaces', 'version']);
  assert.deepEqual(shape(api.paths), ['extDir', 'packageDir', 'proDir', 'userData']);
  assert.deepEqual(shape(api.modelHost), ['call', 'pid']);
  assert.deepEqual(shape(api.extractors), ['register']);
  assert.deepEqual(shape(api.vectorSpaces), ['register']);
  assert.deepEqual(shape(api.providers), ['setStrategy']);
  assert.deepEqual(shape(api.lifecycle), ['dropStore', 'stopHost']);
  assert.deepEqual(shape(api.scheduler), ['onTick', 'rearm', 'setIntervalFilter']);
  assert.deepEqual(shape(api.index), ['onIndexed', 'onMoved', 'onRemoved', 'records']);
  assert.deepEqual(shape(api.search), ['registerMode', 'spaceHits']);
  assert.deepEqual(shape(api.assistant), ['registerTools']);
  assert.deepEqual(shape(api.power), ['onBattery']);
  mgr.deactivate();
});

test('api hooks reach the runtime: model host calls, stopHost, dropStore, rearm and power', async (t) => {
  const { localModels } = withHost(t);
  const seen = { dropped: 0, rearmed: 0 };
  const core = createCore({
    localModels,
    ipc: { dropStore: () => { seen.dropped += 1; return false; } },
    scheduler: { rearm: () => { seen.rearmed += 1; } },
    onBattery: () => true,
  });
  const { mgr } = manager({ core });
  mgr.installPackage(hostPackage());
  assert.equal((await mgr.load()).active, true);
  const { modelHost, lifecycle, scheduler, power } = globalThis.__proApi;

  assert.equal((await modelHost.call('echo', 'via-api')).value, 'via-api');
  assert.equal(typeof modelHost.pid(), 'number');
  assert.throws(() => modelHost.call('__register', {}), /Invalid model host op/);
  assert.equal(lifecycle.stopHost(), true);
  assert.equal(modelHost.pid(), null);
  assert.equal((await modelHost.call('echo', 'again')).value, 'again');

  assert.equal(lifecycle.dropStore(), false);
  scheduler.rearm();
  assert.deepEqual(seen, { dropped: 1, rearmed: 1 });
  assert.equal(power.onBattery(), true);
  mgr.deactivate();
});

test('hooks registered by an extension are cleared when it deactivates', async () => {
  const { mgr } = manager();
  mgr.installPackage(hostPackage());
  await mgr.load();
  const { extractors, vectorSpaces, providers, scheduler } = globalThis.__proApi;
  extractors.register(['media'], async () => ({ content: '' }));
  vectorSpaces.register({ id: 'image:test', kinds: ['image'], embedFile: async () => [1], embedQuery: async () => [1] });
  providers.setStrategy(async () => null);
  scheduler.setIntervalFilter((ms) => ms);
  assert.ok(hooks.vectorSpaceFor('image'));
  assert.ok(hooks.getStrategy());
  mgr.deactivate();
  assert.equal(hooks.vectorSpaceFor('image'), null);
  assert.equal(hooks.getStrategy(), null);
  assert.equal(hooks.getIntervalFilter(), null);
  assert.equal(await hooks.runExtractor('media', 'x', { maxChars: 1 }), null);
});
