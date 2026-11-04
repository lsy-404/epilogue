'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const test = require('node:test');
const hooks = require('../src/main/hooks');
const { VectorStore } = require('../src/main/vectorstore');
const protocol = require('../src/shared/assistantProtocol');
const { createVerifier } = require('../src/main/proVerify');
const { createExtensionManager, createCore } = require('../src/main/extensions');
const { makeKeys, signLicense, buildPackage } = require('./helpers/pro');

const src = (name) => path.join(__dirname, '../src/main', name);
const tmp = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

function stubModules(t, stubs, loaded = []) {
  const saved = new Map();
  for (const [name, exports] of Object.entries(stubs)) {
    const file = require.resolve(src(name));
    saved.set(file, require.cache[file]);
    require.cache[file] = { id: file, filename: file, loaded: true, exports };
  }
  const evict = loaded.map((name) => require.resolve(src(name)));
  for (const file of evict) delete require.cache[file];
  t.after(() => {
    for (const [file, entry] of saved) {
      if (entry) require.cache[file] = entry;
      else delete require.cache[file];
    }
    for (const file of evict) delete require.cache[file];
    hooks.reset();
  });
}

const tool = (name, extra = {}) => ({
  definition: { name, description: `${name} tool`, parameters: { type: 'object', properties: { q: { type: 'string' } } } },
  execute: async (args) => ({ echoed: args }),
  ...extra,
});

/* ---------- registries ---------- */

test('search modes accept only the deep mode, once, and are aborted on reset', async (t) => {
  t.after(() => hooks.reset());
  assert.throws(() => hooks.registerMode('ai', () => {}), /unsupported search mode/);
  assert.throws(() => hooks.registerMode('deep', null), /must be a function/);
  assert.deepEqual(hooks.modeNames(), []);
  assert.equal(await hooks.runMode('deep', 'q'), null);

  let seen;
  hooks.registerMode('deep', (question, opts) => {
    seen = { question, signal: opts.signal };
    if (question === 'hang') return new Promise((resolve) => opts.signal.addEventListener('abort', () => resolve({ hits: [] })));
    return question === 'bad' ? {} : { answer: 'a', hits: [{ filePath: '/x' }], extra: 1 };
  });
  assert.throws(() => hooks.registerMode('deep', () => {}), /already registered/);
  assert.deepEqual(hooks.modeNames(), ['deep']);
  assert.deepEqual(await hooks.runMode('deep', 'q'), { answer: 'a', hits: [{ filePath: '/x' }], mode: 'deep' });
  assert.ok(seen.signal instanceof AbortSignal);
  await assert.rejects(hooks.runMode('deep', 'bad'), /must return \{ hits: \[\] \}/);

  const hanging = hooks.runMode('deep', 'hang');
  assert.equal(seen.signal.aborted, false);
  hooks.reset();
  assert.equal(seen.signal.aborted, true);
  assert.equal((await hanging).hits.length, 0);
  assert.deepEqual(hooks.modeNames(), []);
});

test('assistant tools are read-only, uniquely named and registered all or nothing', (t) => {
  t.after(() => hooks.reset());
  assert.throws(() => hooks.registerTools([]), /non-empty array/);
  assert.throws(() => hooks.registerTools([tool('Bad Name')]), /invalid tool name/);
  assert.throws(() => hooks.registerTools([tool('writer', { write: true })]), /not read-only/);
  const flagged = tool('flagged');
  flagged.definition.write = true;
  assert.throws(() => hooks.registerTools([flagged]), /not read-only/);
  assert.throws(() => hooks.registerTools([tool('search_files')]), /already registered/);
  assert.throws(() => hooks.registerTools([tool('update_settings')]), /already registered/);
  assert.throws(() => hooks.registerTools([tool('noexec', { execute: null })]), /execute function/);
  const noParams = tool('noparams');
  noParams.definition.parameters = { type: 'string' };
  assert.throws(() => hooks.registerTools([noParams]), /object parameters/);
  assert.throws(() => hooks.registerTools([tool('first'), tool('first')]), /already registered/);
  assert.deepEqual(hooks.toolDefinitions(), []);

  hooks.registerTools([tool('deep_search')]);
  assert.throws(() => hooks.registerTools([tool('deep_search')]), /already registered/);
  assert.deepEqual(hooks.toolDefinitions().map((d) => d.name), ['deep_search']);
  assert.equal(typeof hooks.getTool('deep_search').execute, 'function');
  assert.equal(hooks.getTool('missing'), null);
  hooks.reset();
  assert.deepEqual(hooks.toolDefinitions(), []);
});

test('jobs run once per pass, collect failures, and ask for an early re-run through more', async (t) => {
  t.after(() => hooks.reset());
  assert.throws(() => hooks.registerJob(null), /must be a function/);
  assert.deepEqual(await hooks.runJobs(), { more: false, errors: [] });

  const calls = [];
  hooks.registerJob(async ({ signal }) => (calls.push(signal), { more: true }));
  let hang = false;
  hooks.registerJob(async () => {
    throw new Error('job failed');
  });
  hooks.registerJob(async ({ signal }) => {
    if (hang) await new Promise((resolve) => signal.addEventListener('abort', resolve));
    return { more: false };
  });
  const first = hooks.runJobs();
  const overlapping = await hooks.runJobs();
  assert.deepEqual(overlapping, { more: false, errors: [] });
  const out = await first;
  assert.equal(out.more, true);
  assert.equal(out.errors.length, 1);
  assert.equal(calls.length, 1);
  assert.ok(calls[0] instanceof AbortSignal);

  hang = true;
  const hanging = hooks.runJobs();
  await tick();
  assert.equal(calls[1].aborted, false);
  hooks.reset();
  assert.equal(calls[1].aborted, true);
  await hanging;
  assert.deepEqual(await hooks.runJobs(), { more: false, errors: [] });
});

/* ---------- index events ---------- */

function withSink(t) {
  const events = [];
  hooks.attach((event, payload) => events.push([event, payload]));
  t.after(() => hooks.reset());
  return events;
}

test('the vector store reports removals, bulk removals and path changes', (t) => {
  const events = withSink(t);
  const dir = tmp(t, 'epilogue-deep-store-');
  const store = new VectorStore(path.join(dir, 'index.json'));
  const rec = (name, kind = 'text') => ({ filePath: path.join(dir, name), fileName: name, kind });
  const a = store.upsert(rec('a.txt'));
  const b = store.upsert(rec('b.png', 'image'));
  const c = store.upsert(rec('c.png', 'image'));

  const movedPath = path.join(dir, 'moved.txt');
  const originalPath = a.filePath;
  store.updatePath(originalPath, movedPath);
  store.updatePath(path.join(dir, 'nothing.txt'), path.join(dir, 'x.txt'));
  store.remove(movedPath);
  store.remove(path.join(dir, 'nothing.txt'));
  assert.equal(store.removeKind('image'), 2);
  assert.deepEqual(events, [
    ['index:moved', { id: a.id, filePath: movedPath, previousPath: originalPath }],
    ['index:removed', { id: a.id, filePath: movedPath }],
    ['index:removed', { id: b.id, filePath: b.filePath }],
    ['index:removed', { id: c.id, filePath: c.filePath }],
  ]);
});

test('the indexer reports each stored record with the full extracted content', async (t) => {
  const cfg = { extraction: { maxChars: 20 }, providers: { embeddings: [] }, app: { avoidCloudOnMetered: false }, language: 'zh' };
  stubModules(
    t,
    {
      'settings.js': { get: () => cfg },
      'log.js': { log() {} },
      'localModels.js': { extractRemote: async () => ({ content: 'remote text for the file' }), embed: async () => [] },
    },
    ['indexer.js', 'llm.js']
  );
  const indexer = require('../src/main/indexer');
  const events = withSink(t);
  const dir = tmp(t, 'epilogue-deep-indexer-');
  const file = path.join(dir, 'doc.txt');
  fs.writeFileSync(file, 'bytes');
  const store = { upsert: (record) => ({ ...record, id: 'f_1' }) };

  const record = await indexer.indexFile(file, store);
  await indexer.indexFile(file, store, () => {}, { nameOnly: true });
  assert.equal(events.length, 2);
  assert.equal(events[0][0], 'index:indexed');
  assert.equal(events[0][1].content, 'remote text for the file');
  assert.equal(events[0][1].record.id, 'f_1');
  assert.deepEqual(events[0][1].record, record);
  assert.notEqual(events[0][1].record, record);
  assert.equal(events[1][1].content, '');
  assert.equal(events[1][1].record.indexedMode, 'name');
});

/* ---------- search dispatch ---------- */

function loadIpc(t) {
  const dir = tmp(t, 'epilogue-deep-ipc-');
  const file = src('ipc.js');
  const nativeRequire = Module.createRequire(file);
  const stubs = {
    electron: { app: { getPath: () => dir } },
    './settings': { get: () => ({ providers: { embeddings: [] }, app: { avoidCloudOnMetered: false } }) },
    './log': { log() {} },
    './network': { isMetered: () => false },
    './llm': { localOnlyFilter: (list) => list, embeddingsConfigured: () => false },
  };
  const context = vm.createContext({ module: { exports: {} }, require: (name) => stubs[name] ?? nativeRequire(name) });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  const ipc = context.module.exports;
  t.after(() => {
    ipc.dropStore();
    hooks.reset();
  });
  return ipc;
}

test('ask dispatches the deep mode to the extension and leaves the other modes alone', async (t) => {
  const ipc = loadIpc(t);
  const first = await ipc.ask('anything', 'keyword');
  assert.equal(first.mode, 'keyword');
  assert.deepEqual(Array.from(first.hits), []);

  const seen = [];
  hooks.registerMode('deep', async (question) => (seen.push(question), { answer: 'cited', hits: [{ filePath: '/a', passages: [{ text: 't', highlights: [[0, 1]] }] }] }));
  const result = await ipc.ask('where is it', 'deep');
  assert.deepEqual(seen, ['where is it']);
  assert.equal(result.mode, 'deep');
  assert.equal(result.answer, 'cited');
  assert.deepEqual(result.hits[0].passages, [{ text: 't', highlights: [[0, 1]] }]);
  assert.equal((await ipc.ask('x', 'keyword')).mode, 'keyword');
  assert.equal(seen.length, 1);
});

/* ---------- assistant ---------- */

const LITE_TOOL_LINE = '无需工具时 actions=[]。可用工具仅为 update_settings、search_files、get_status。';

function loadAssistant(t, chatCompletionF) {
  const cfg = {
    language: 'zh',
    searchMode: 'ai',
    staleDays: 30,
    rules: '',
    destinations: [],
    cleanup: { autoScan: true, scanIntervalHours: 6, folders: [] },
    extraction: {},
    app: { avoidCloudOnMetered: false },
    providers: { chat: [] },
  };
  stubModules(
    t,
    {
      'settings.js': { get: () => cfg },
      'log.js': { log() {} },
      'llm.js': { chatCompletionF, parseJsonLoose: (text) => JSON.parse(text) },
    },
    ['assistant.js', 'assistantTools.js']
  );
  return { assistant: require('../src/main/assistant'), cfg };
}

test('without extensions the assistant prompt and protocol keep the three static tools', (t) => {
  const { assistant, cfg } = loadAssistant(t, async () => ({}));
  const prompt = assistant.buildSystemPrompt(cfg);
  assert.ok(prompt.includes(LITE_TOOL_LINE));
  assert.ok(!prompt.includes('同样是只读工具'));
  assert.deepEqual(protocol.TOOL_NAMES, ['update_settings', 'search_files', 'get_status']);
  assert.deepEqual(protocol.normalizeNativeToolCalls([{ name: 'deep_search', arguments: {} }]), []);
  assert.equal(protocol.parseAssistantOutput('{"reply":"r","actions":[{"tool":"deep_search"}]}', JSON.parse).actions.length, 0);
});

test('registered tools join the prompt, the native definitions and the executable set', async (t) => {
  const requests = [];
  let round = 0;
  const { assistant, cfg } = loadAssistant(t, async (_providers, messages, options) => {
    requests.push({ tools: options.tools.map((d) => d.name), tail: messages.at(-1) });
    round += 1;
    if (round === 1) {
      return { text: '', toolCalls: [{ id: 'c1', name: 'deep_search', arguments: { q: 'plan' } }, { id: 'c2', name: 'not_registered', arguments: {} }], provider: {} };
    }
    return { text: 'done', toolCalls: [], provider: {} };
  });
  hooks.registerTools([tool('deep_search')]);
  const prompt = assistant.buildSystemPrompt(cfg);
  assert.ok(prompt.includes('无需工具时 actions=[]。可用工具仅为 update_settings、search_files、get_status、deep_search。'));
  assert.ok(prompt.includes('- deep_search: deep_search tool 参数: '));

  const out = await assistant.chatTurn([{ role: 'user', content: 'find the plan' }]);
  assert.equal(out.reply, 'done');
  assert.deepEqual(requests[0].tools, ['search_files', 'get_status', 'update_settings', 'deep_search']);
  assert.deepEqual(out.events.find((e) => e.type === 'tool'), { type: 'tool', detail: 'deep_search' });
  assert.equal(out.trace.toolCount, 1);
  assert.deepEqual(JSON.parse(requests[1].tail.content), { id: 'c1', tool: 'deep_search', ok: true, result: { echoed: { q: 'plan' } } });
});

test('an extension tool failure is reported to the model instead of failing the turn', async (t) => {
  let round = 0;
  const tails = [];
  const { assistant } = loadAssistant(t, async (_providers, messages) => {
    tails.push(messages.at(-1));
    round += 1;
    return round === 1 ? { text: '', toolCalls: [{ id: 'c1', name: 'broken', arguments: {} }], provider: {} } : { text: 'ok', toolCalls: [], provider: {} };
  });
  hooks.registerTools([
    tool('broken', {
      execute: async () => {
        throw new Error('engine offline');
      },
    }),
  ]);
  const out = await assistant.chatTurn([{ role: 'user', content: 'go' }]);
  assert.equal(out.reply, 'ok');
  assert.equal(JSON.parse(tails[1].content).error, 'engine offline');
});

/* ---------- scheduler ---------- */

test('the scheduler re-runs jobs after a minute only when a job asks for more', async (t) => {
  const originalLoad = Module._load;
  Module._load = (request, parent, isMain) => (request === 'electron' ? { Notification: { isSupported: () => false } } : originalLoad(request, parent, isMain));
  stubModules(t, { 'settings.js': { get: () => ({ cleanup: { scanIntervalHours: 2 } }) }, 'stale.js': {} }, ['scheduler.js']);
  const scheduler = require('../src/main/scheduler');
  Module._load = originalLoad;
  const delays = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (_fn, ms) => (delays.push(ms), { unref() {} });
  t.after(() => {
    global.setTimeout = realSetTimeout;
  });

  let more = true;
  hooks.registerJob(async () => ({ more }));
  await scheduler.runJobs();
  assert.deepEqual(delays, [60 * 1000]);
  more = false;
  await scheduler.runJobs();
  assert.deepEqual(delays, [60 * 1000]);
  scheduler.kickJobs();
  assert.deepEqual(delays, [60 * 1000, 30 * 1000]);
});

/* ---------- extension api ---------- */

const keys = makeKeys();
const verifier = createVerifier(keys.verifierKeys);

const PROBE = `
exports.activate = async (api) => {
  const seen = (globalThis.__deep = { events: [], api, offIndexed: null });
  seen.offIndexed = api.index.onIndexed((e) => seen.events.push(['indexed', e]));
  api.index.onRemoved((e) => seen.events.push(['removed', e]));
  api.index.onMoved((e) => seen.events.push(['moved', e]));
  api.index.onIndexed(async () => { throw new Error('listener boom'); });
  api.search.registerMode('deep', async (q) => ({ hits: [{ filePath: '/p', fileName: 'p', passages: [] }], answer: q }));
  api.assistant.registerTools([{ definition: { name: 'probe_tool', description: 'd', parameters: { type: 'object' } }, execute: async () => ({ ok: 1 }) }]);
  api.scheduler.onTick(async () => { seen.ticked = (seen.ticked || 0) + 1; });
};`;

async function activeManager(t, { core = {}, providers = { chat: ['chat-provider'] } } = {}) {
  const userData = tmp(t, 'epilogue-deep-pro-');
  const logs = [];
  const manager = createExtensionManager({
    verifier,
    userData,
    coreVersion: '0.0.0-test',
    settings: { get: () => ({ providers }), patch: (p) => p },
    ipcHandle() {},
    ipcRemove() {},
    log: (...args) => logs.push(args),
    core,
  });
  manager.importLicense(signLicense(keys.license, { upd: '2027-12-01' }));
  manager.installPackage(buildPackage(keys.extension, { files: { 'main.cjs': Buffer.from(PROBE), 'renderer.js': Buffer.from('/* r */') } }));
  t.after(() => {
    manager.deactivate();
    delete globalThis.__deep;
    hooks.reset();
  });
  const status = await manager.load();
  assert.equal(status.active, true, status.loadError);
  return { manager, logs, seen: globalThis.__deep };
}

test('the api exposes the deep hooks and a failing listener is logged without breaking the pipeline', async (t) => {
  const kicks = [];
  const { logs, seen } = await activeManager(t, { core: { scheduler: { kickJobs: () => kicks.push(1) } } });
  assert.deepEqual(Object.keys(seen.api.index).sort(), ['onIndexed', 'onMoved', 'onRemoved', 'records']);
  assert.equal(typeof seen.api.extract, 'function');
  assert.equal(typeof seen.api.embedLocal, 'function');
  assert.equal(typeof seen.api.chat, 'function');
  assert.deepEqual(Object.keys(seen.api.search), ['registerMode', 'spaceHits']);
  assert.deepEqual(Object.keys(seen.api.assistant), ['registerTools']);
  assert.deepEqual(Object.keys(seen.api.scheduler).sort(), ['onTick', 'rearm', 'setIntervalFilter']);
  assert.deepEqual(kicks, [1]);
  assert.deepEqual(hooks.modeNames(), ['deep']);
  assert.deepEqual(hooks.toolDefinitions().map((d) => d.name), ['probe_tool']);
  assert.throws(() => seen.api.index.onIndexed('nope'), /must be a function/);

  hooks.emit('index:indexed', { record: { id: 'f_1' }, content: 'body' });
  hooks.emit('index:removed', { id: 'f_1', filePath: '/a' });
  hooks.emit('index:moved', { id: 'f_2', filePath: '/b', previousPath: '/c' });
  await tick();
  assert.deepEqual(seen.events, [
    ['indexed', { record: { id: 'f_1' }, content: 'body' }],
    ['removed', { id: 'f_1', filePath: '/a' }],
    ['moved', { id: 'f_2', filePath: '/b', previousPath: '/c' }],
  ]);
  assert.ok(logs.some(([scope, message, data]) => scope === 'pro' && message === 'event listener failed' && data.event === 'index:indexed' && /listener boom/.test(data.message)));

  seen.offIndexed();
  hooks.emit('index:indexed', { record: { id: 'f_3' }, content: '' });
  await tick();
  assert.equal(seen.events.length, 3);

  await hooks.runJobs();
  assert.equal(seen.ticked, 1);
});

test('records, extract and embedLocal pass through the core and validate their input', async (t) => {
  const calls = [];
  const core = {
    index: { records: async () => [{ id: 'f_1' }] },
    extract: async (filePath) => (calls.push(['extract', filePath]), { content: 'text' }),
    embedLocal: async (texts) => (calls.push(['embed', texts]), { model: 'm', dim: 2, vectors: texts.map(() => [1, 0]) }),
  };
  const { seen } = await activeManager(t, { core });
  const { api } = seen;
  assert.deepEqual(await api.index.records(), [{ id: 'f_1' }]);
  assert.throws(() => api.extract('relative.txt'), /absolute path/);
  assert.throws(() => api.extract(5), /absolute path/);
  const file = path.resolve('/abs/file.txt');
  assert.deepEqual(await api.extract(file), { content: 'text' });
  assert.throws(() => api.embedLocal('x'), /array of at most 256 strings/);
  assert.throws(() => api.embedLocal([1]), /array of at most 256 strings/);
  assert.throws(() => api.embedLocal(new Array(257).fill('x')), /array of at most 256 strings/);
  assert.deepEqual(await api.embedLocal(['a', 'b']), { model: 'm', dim: 2, vectors: [[1, 0], [1, 0]] });
  assert.deepEqual(calls, [['extract', file], ['embed', ['a', 'b']]]);
});

test('hooks without a core implementation throw instead of returning data', async (t) => {
  const { seen } = await activeManager(t);
  assert.throws(() => seen.api.index.records(), /not available/);
  assert.throws(() => seen.api.extract(path.resolve('/a.txt')), /not available/);
  assert.throws(() => seen.api.embedLocal([]), /not available/);
  assert.throws(() => seen.api.chat([{ role: 'user', content: 'x' }]), /not available/);
});

test('chat goes through the core provider entry with the configured chat providers and cleaned options', async (t) => {
  const calls = [];
  const core = { chat: async (providers, messages, options) => (calls.push({ providers, messages, options }), 'answer') };
  const { seen } = await activeManager(t, { core });
  const controller = new AbortController();
  const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
  assert.equal(await seen.api.chat(messages, { temperature: 0.2, maxTokens: 300, signal: controller.signal, json: true, tools: ['x'], model: 'other' }), 'answer');
  assert.equal(await seen.api.chat(messages), 'answer');
  assert.equal(await seen.api.chat(messages, { temperature: 'hot', maxTokens: -1, signal: {}, json: 'yes' }), 'answer');
  assert.deepEqual(calls[0].providers, ['chat-provider']);
  assert.deepEqual(calls[0].options, { temperature: 0.2, maxTokens: 300, signal: controller.signal, json: true });
  assert.deepEqual(calls[1].options, {});
  assert.deepEqual(calls[2].options, {});
  for (const bad of [[], 'hi', [{ role: 'tool', content: 'x' }], [{ role: 'user', content: 5 }], [null]]) {
    assert.throws(() => seen.api.chat(bad), /non-empty array of \{ role, content \}/);
  }
});

test('createCore maps the hooks onto the runtime modules and embedLocal needs a downloaded local model', async () => {
  const calls = [];
  let cfg = {
    extraction: { maxChars: 9 },
    providers: { embeddings: [{ name: 'cloud', model: 'c' }, { name: 'off', type: 'local', model: 'x', enabled: false }, { name: 'bge', type: 'local', model: 'bge' }] },
  };
  let downloaded = false;
  const core = createCore({
    localModels: {
      extractRemote: async (filePath, opts) => (calls.push(['extract', filePath, opts]), { content: 'body', kind: 'text' }),
      status: (model) => ({ downloaded: downloaded && model === 'bge' }),
      embed: async (texts, model) => (calls.push(['embed', texts, model]), texts.map(() => [0.1, 0.2, 0.3])),
    },
    ipc: { withStore: async (fn) => fn({ all: () => [{ id: 'f_1', filePath: '/a' }] }) },
    scheduler: { rearm() {}, kickJobs() {} },
    onBattery: () => false,
    llm: { chatF: async () => 'chat' },
    settings: { get: () => cfg },
  });
  assert.deepEqual(await core.index.records(), [{ id: 'f_1', filePath: '/a' }]);
  assert.deepEqual(await core.extract('/a.txt'), { content: 'body' });
  assert.equal(await core.embedLocal(['x']), null);
  downloaded = true;
  assert.deepEqual(await core.embedLocal(['x', 'y']), { model: 'bge', dim: 3, vectors: [[0.1, 0.2, 0.3], [0.1, 0.2, 0.3]] });
  assert.deepEqual(await core.embedLocal([]), { model: 'bge', dim: 0, vectors: [] });
  assert.deepEqual(calls[0], ['extract', '/a.txt', { maxChars: 9 }]);
  assert.deepEqual(calls[1], ['embed', ['x', 'y'], 'bge']);
  cfg = { ...cfg, providers: { embeddings: [{ name: 'cloud', model: 'c' }] } };
  assert.equal(await core.embedLocal(['x']), null);
  assert.equal(await core.chat(), 'chat');
});

/* ---------- renderer ---------- */

const appSource = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8').replace(/\r\n/g, '\n');
const between = (start, end) => appSource.slice(appSource.indexOf(start), appSource.indexOf(end, appSource.indexOf(start)));

test('passages render as escaped text with highlight ranges wrapped in mark', () => {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const context = vm.createContext({ esc, t: (key) => key });
  vm.runInContext(between('// Escapes the text first', "document.body.addEventListener('click'"), context);
  const { markedText, fileItem } = vm.runInContext('({ markedText, fileItem })', context);
  assert.equal(markedText('a <b>x</b> c', [[2, 5]]), 'a <mark>&lt;b&gt;</mark>x&lt;/b&gt; c');
  assert.equal(markedText('abcdef', [[4, 6], [0, 2], [1, 3], [9, 12], [-5, 1], ['x', 2], null]), '<mark>abc</mark>d<mark>ef</mark>');
  assert.equal(markedText('plain', undefined), 'plain');
  const html = fileItem({ filePath: '/a', fileName: 'a', passages: [{ text: '<img src=x>', highlights: [[0, 4]] }] });
  assert.ok(html.includes('<p class="item-passage"><mark>&lt;img</mark> src=x&gt;</p>'));
  assert.ok(!html.includes('<img'));
  assert.ok(!fileItem({ filePath: '/a', fileName: 'a' }).includes('item-passages'));
});

test('the recall selector shows a deep button only while a mode is registered', () => {
  const buttons = [];
  const seg = {
    append: (button) => buttons.push(button),
    querySelector: (selector) => buttons.find((b) => selector === `[data-mode="${b.dataset.mode}"]`) || null,
    querySelectorAll: () => buttons,
  };
  const mk = (mode) => {
    const b = { dataset: { mode }, textContent: '', active: false, remove: () => buttons.splice(buttons.indexOf(b), 1) };
    b.classList = { toggle: (_name, on) => { b.active = on; } };
    return b;
  };
  for (const mode of ['keyword', 'match', 'ai']) buttons.push(mk(mode));
  const context = vm.createContext({
    $: () => seg,
    t: (key) => key,
    currentSettings: { searchMode: 'deep' },
    document: { createElement: () => mk(undefined) },
  });
  vm.runInContext(between('let searchModes = [];', "$('#searchModeSeg').addEventListener"), context);
  vm.runInContext('renderSearchSeg()', context);
  assert.deepEqual(buttons.map((b) => b.dataset.mode), ['keyword', 'match', 'ai']);
  assert.equal(vm.runInContext('effectiveSearchMode()', context), 'ai');
  assert.equal(buttons.find((b) => b.active).dataset.mode, 'ai');

  vm.runInContext("searchModes = ['deep']; renderSearchSeg()", context);
  assert.deepEqual(buttons.map((b) => b.dataset.mode), ['keyword', 'match', 'ai', 'deep']);
  assert.equal(buttons.at(-1).textContent, 'search_deep');
  assert.equal(buttons.find((b) => b.active).dataset.mode, 'deep');

  vm.runInContext('searchModes = []; renderSearchSeg()', context);
  assert.deepEqual(buttons.map((b) => b.dataset.mode), ['keyword', 'match', 'ai']);
});

test('the recall view ships exactly three static mode buttons', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const start = html.indexOf('id="searchModeSeg"');
  const seg = html.slice(start, html.indexOf('</div>', start));
  assert.equal((seg.match(/<button/g) || []).length, 3);
  assert.ok(!seg.includes('deep'));
});

test('spaceHits ranks records of a registered vector space for a text query', async (t) => {
  t.after(() => hooks.reset());
  const records = [
    { id: 'i_red', filePath: '/red.png' },
    { id: 'i_blue', filePath: '/blue.png' },
  ];
  const calls = [];
  const store = {
    searchByVector(vector, topK, space) {
      calls.push({ vector, topK, space });
      return records.map((record, i) => ({ record, score: 0.9 - i * 0.1 }));
    },
  };
  const core = createCore({ ipc: { withStore: (fn) => fn(store) }, localModels: {}, scheduler: {} });
  assert.deepEqual(await core.search.spaceHits('image:clip', '红色', 5), []);
  hooks.registerVectorSpace({ id: 'image:clip', kinds: ['image'], embedFile: async () => null, embedQuery: async (text) => (text ? [1, 0] : null) });
  assert.deepEqual(await core.search.spaceHits('image:clip', '红色', 5), [
    { id: 'i_red', filePath: '/red.png', score: 0.9 },
    { id: 'i_blue', filePath: '/blue.png', score: 0.8 },
  ]);
  assert.deepEqual(calls, [{ vector: [1, 0], topK: 5, space: 'image:clip' }]);
  assert.deepEqual(await core.search.spaceHits('image:clip', '', 5), []);
});
