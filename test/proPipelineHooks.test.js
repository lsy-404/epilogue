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

const src = (name) => path.join(__dirname, '../src/main', name);
const tmp = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// Swaps modules in require.cache for the duration of a test; the loaded module under test is evicted afterwards.
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

test('registrations validate their input and refuse duplicates', (t) => {
  t.after(() => hooks.reset());
  assert.throws(() => hooks.registerExtractor([], () => {}), /non-empty array/);
  assert.throws(() => hooks.registerExtractor(['media'], null), /must be a function/);
  hooks.registerExtractor(['media'], async () => ({ content: '' }));
  assert.throws(() => hooks.registerExtractor(['audio', 'media'], async () => ({})), /already registered for kind 'media'/);

  const space = { id: 'image:clip', kinds: ['image'], embedFile: async () => [1], embedQuery: async () => [1] };
  assert.throws(() => hooks.registerVectorSpace({ ...space, id: 'text' }), /invalid vector space id/);
  assert.throws(() => hooks.registerVectorSpace({ ...space, id: 'Bad Id' }), /invalid vector space id/);
  assert.throws(() => hooks.registerVectorSpace({ ...space, embedQuery: null }), /embedFile and embedQuery/);
  hooks.registerVectorSpace(space);
  assert.throws(() => hooks.registerVectorSpace(space), /already registered/);
  assert.throws(() => hooks.registerVectorSpace({ ...space, id: 'image:other' }), /kind 'image' already belongs/);
  assert.equal(hooks.vectorSpaceFor('image').id, 'image:clip');
  assert.equal(hooks.vectorSpaceFor('pdf'), null);

  assert.throws(() => hooks.setStrategy('nope'), /must be a function/);
  assert.throws(() => hooks.setIntervalFilter(null), /must be a function/);
});

test('extractors get the signal, which aborts when the extension deactivates', async () => {
  let seen;
  hooks.registerExtractor(['media'], (filePath, opts) => {
    seen = { filePath, ...opts };
    return new Promise((resolve) => opts.signal.addEventListener('abort', () => resolve({ content: 'late' })));
  });
  const run = hooks.runExtractor('media', '/a/b.mp3', { maxChars: 10 });
  assert.equal(seen.filePath, '/a/b.mp3');
  assert.equal(seen.maxChars, 10);
  assert.equal(seen.signal.aborted, false);
  hooks.reset();
  assert.equal(seen.signal.aborted, true);
  assert.deepEqual(await run, { content: 'late', preview: undefined });
});

function vectorFixture(t) {
  const dir = tmp(t, 'epilogue-spaces-');
  const file = path.join(dir, 'index.json');
  const store = new VectorStore(file);
  const rec = (name, extra) => ({ filePath: path.join(dir, name), fileName: name, kind: 'text', ...extra });
  return { dir, file, store, rec };
}

test('vector search is confined to one space and legacy records follow the image rule', (t) => {
  const { file, store, rec } = vectorFixture(t);
  store.upsert(rec('text-new.txt', { vector: [1, 0], vecSpace: 'text' }));
  store.upsert(rec('text-legacy.txt', { vector: [1, 0] }));
  store.upsert(rec('clip-new.png', { kind: 'image', indexedMode: 'full', vector: [1, 0], vecSpace: 'image:clip' }));
  store.upsert(rec('clip-legacy.png', { kind: 'image', indexedMode: 'full', vector: [1, 0] }));
  store.upsert(rec('name-only.png', { kind: 'image', indexedMode: 'name', vector: [1, 0] }));
  store.upsert(rec('other-space.mp3', { kind: 'media', vector: [1, 0], vecSpace: 'audio:x' }));
  const names = (hits) => hits.map((h) => h.record.fileName).sort();

  const check = (s) => {
    assert.deepEqual(names(s.searchByVector([1, 0], 10)), ['name-only.png', 'text-legacy.txt', 'text-new.txt']);
    assert.deepEqual(names(s.searchByVector([1, 0], 10, 'text')), ['name-only.png', 'text-legacy.txt', 'text-new.txt']);
    assert.deepEqual(names(s.searchByVector([1, 0], 10, 'image:clip')), ['clip-legacy.png', 'clip-new.png']);
    assert.deepEqual(names(s.searchByVector([1, 0], 10, 'audio:x')), ['other-space.mp3']);
    assert.deepEqual(s.searchByVector([1, 0], 10, 'missing:space'), []);
  };
  check(store);
  store.flush();
  const reloaded = new VectorStore(file);
  check(reloaded);
  assert.equal(reloaded.get(path.join(path.dirname(file), 'clip-new.png')).vecSpace, 'image:clip');
});

test('re-indexing keeps or clears the stored space together with the vector', (t) => {
  const { store, rec } = vectorFixture(t);
  const first = store.upsert(rec('a.png', { kind: 'image', vector: [1, 0], vecSpace: 'image:clip' }));
  const kept = store.upsert({ filePath: first.filePath, fileName: 'a.png', kind: 'image' });
  assert.equal(kept.vecSpace, 'image:clip');
  assert.equal(kept.vecDim, 2);
  const cleared = store.upsert({ filePath: first.filePath, fileName: 'a.png', kind: 'image', vector: null, vecSpace: undefined });
  assert.equal(cleared.vecSpace, undefined);
  assert.equal(cleared.vecDim, undefined);
  assert.deepEqual(store.searchByVector([1, 0], 5, 'image:clip'), []);
});

function indexerFixture(t, overrides = {}) {
  const cfg = {
    extraction: { maxChars: 20 },
    providers: { embeddings: [{ name: 'local', type: 'local', model: 'm' }] },
    app: { avoidCloudOnMetered: false },
    language: 'zh',
    ...overrides,
  };
  const calls = { remote: 0, embed: [] };
  stubModules(
    t,
    {
      'settings.js': { get: () => cfg },
      'log.js': { log() {} },
      'localModels.js': {
        extractRemote: async (filePath) => {
          calls.remote += 1;
          return { content: filePath.endsWith('.png') ? '' : 'remote text' };
        },
        embed: async (texts) => {
          calls.embed.push(texts[0]);
          return texts.map(() => [0.5, 0.5]);
        },
      },
    },
    ['indexer.js', 'llm.js']
  );
  const indexer = require('../src/main/indexer');
  const dir = tmp(t, 'epilogue-indexer-hooks-');
  const files = {};
  for (const name of ['song.mp3', 'doc.txt', 'pic.png']) {
    files[name] = path.join(dir, name);
    fs.writeFileSync(files[name], 'bytes');
  }
  const records = [];
  const store = { upsert: (record) => (records.push(record), record) };
  return { indexer, files, records, store, calls };
}

test('an extractor registered for a kind supplies content and preview instead of the host extraction', async (t) => {
  const { indexer, files, records, store, calls } = indexerFixture(t);
  const seen = [];
  hooks.registerExtractor(['media'], async (filePath, opts) => {
    seen.push({ filePath, maxChars: opts.maxChars, signal: opts.signal });
    return { content: 'a transcript that is longer than twenty characters', preview: 'p'.repeat(600) };
  });
  const record = await indexer.indexFile(files['song.mp3'], store);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].filePath, files['song.mp3']);
  assert.equal(seen[0].maxChars, 20);
  assert.ok(seen[0].signal instanceof AbortSignal);
  assert.equal(calls.remote, 0);
  assert.equal(record.summary, 'a transcript that is');
  assert.equal(record.transcriptPreview.length, 500);
  assert.equal(record.vecSpace, 'text');
  assert.deepEqual(calls.embed.length, 1);
  assert.equal(records.length, 1);
});

test('kinds without an extractor, and name-only indexing, keep the host extraction', async (t) => {
  const { indexer, files, store, calls } = indexerFixture(t);
  let extractorCalls = 0;
  hooks.registerExtractor(['media'], async () => (extractorCalls += 1, { content: 'x' }));
  const text = await indexer.indexFile(files['doc.txt'], store);
  assert.equal(calls.remote, 1);
  assert.equal(text.summary, 'remote text');
  assert.equal('transcriptPreview' in text, false);
  const nameOnly = await indexer.indexFile(files['song.mp3'], store, () => {}, { nameOnly: true });
  assert.equal(extractorCalls, 0);
  assert.equal(nameOnly.indexedMode, 'name');
});

test('an extractor failure fails the file like any extraction error', async (t) => {
  const { indexer, files, records, store } = indexerFixture(t);
  hooks.registerExtractor(['media'], async () => {
    throw new Error('decode failed');
  });
  await assert.rejects(indexer.indexFile(files['song.mp3'], store), /decode failed/);
  assert.equal(records.length, 0);
});

test('a vector space stores its own vector and space id; failures fall back without failing the file', async (t) => {
  const { indexer, files, store, calls } = indexerFixture(t);
  let mode = 'vector';
  const embedded = [];
  hooks.registerVectorSpace({
    id: 'image:clip',
    kinds: ['image'],
    embedFile: async (filePath) => {
      embedded.push(filePath);
      if (mode === 'throw') throw new Error('model missing');
      return mode === 'vector' ? [0, 1] : null;
    },
    embedQuery: async () => [0, 1],
  });
  const stored = await indexer.indexFile(files['pic.png'], store);
  assert.deepEqual(embedded, [files['pic.png']]);
  assert.deepEqual(stored.vector, [0, 1]);
  assert.equal(stored.vecSpace, 'image:clip');
  assert.equal(calls.embed.length, 0);

  mode = 'throw';
  const failed = await indexer.indexFile(files['pic.png'], store);
  assert.equal(failed.vector, null);
  assert.equal(failed.vecSpace, undefined);
  mode = 'null';
  assert.equal((await indexer.indexFile(files['pic.png'], store)).vecSpace, undefined);

  embedded.length = 0;
  const nameOnly = await indexer.indexFile(files['pic.png'], store, () => {}, { nameOnly: true });
  assert.deepEqual(embedded, []);
  assert.equal(nameOnly.vecSpace, 'text');
  assert.equal(calls.embed.length, 1);
  const doc = await indexer.indexFile(files['doc.txt'], store);
  assert.equal(doc.vecSpace, 'text');
});

function loadIpc(t, { embedQuery }) {
  const dir = tmp(t, 'epilogue-ipc-search-');
  const file = path.join(src('ipc.js'));
  const nativeRequire = Module.createRequire(file);
  const stubs = {
    electron: { app: { getPath: () => dir } },
    './settings': { get: () => ({ providers: { embeddings: [] }, app: { avoidCloudOnMetered: false } }) },
    './log': { log() {} },
    './network': { isMetered: () => false },
    './llm': { localOnlyFilter: (list) => list, embeddingsConfigured: () => true, embedF: async () => [[1, 0]] },
  };
  const context = vm.createContext({ module: { exports: {} }, require: (name) => stubs[name] ?? nativeRequire(name) });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  const ipc = context.module.exports;
  t.after(() => {
    ipc.dropStore();
    hooks.reset();
  });
  const seed = new VectorStore(path.join(dir, 'index.json'));
  const rec = (name, extra) => ({ filePath: path.join(dir, name), fileName: name, kind: 'text', ...extra });
  seed.upsert(rec('notes.txt', { vector: [1, 0], vecSpace: 'text', keywords: ['sunset'] }));
  seed.upsert(rec('sunset.png', { kind: 'image', indexedMode: 'full', vector: [0, 1], vecSpace: 'image:clip' }));
  seed.upsert(rec('legacy.png', { kind: 'image', indexedMode: 'full', vector: [0, 1] }));
  seed.flush();
  hooks.registerVectorSpace({ id: 'image:clip', kinds: ['image'], embedFile: async () => [0, 1], embedQuery });
  return ipc;
}

test('search queries every registered space and merges its hits after the text hits', async (t) => {
  const queries = [];
  const ipc = loadIpc(t, { embedQuery: async (text) => (queries.push(text), [0, 1]) });
  const result = await ipc.ask('sunset beach', 'match');
  assert.deepEqual(queries, ['sunset beach']);
  assert.equal(result.mode, 'vector');
  const names = Array.from(result.hits, (h) => h.fileName);
  assert.equal(names[0], 'notes.txt');
  assert.deepEqual(names.slice(1).sort(), ['legacy.png', 'sunset.png']);
  assert.ok(result.hits.every((h) => h.vector === undefined));
});

test('keyword mode skips spaces and a failing space does not break the text results', async (t) => {
  let called = 0;
  const failing = loadIpc(t, { embedQuery: async () => { called += 1; throw new Error('model missing'); } });
  const keyword = await failing.ask('sunset', 'keyword');
  assert.equal(called, 0);
  assert.equal(keyword.mode, 'keyword');
  const vector = await failing.ask('sunset', 'match');
  assert.equal(called, 1);
  assert.deepEqual(Array.from(vector.hits, (h) => h.fileName), ['notes.txt']);
});

function loadLlm(t, { embed }) {
  const cfg = { language: 'zh' };
  stubModules(t, { 'settings.js': { get: () => cfg }, 'log.js': { log() {} }, 'localModels.js': { embed } }, ['llm.js']);
  return require('../src/main/llm');
}

const local = (name, extra) => ({ name, type: 'local', model: `model-${name}`, ...extra });

test('the default strategy runs the first enabled provider once and keeps the friendly rate-limit message', async (t) => {
  const used = [];
  const llm = loadLlm(t, { embed: async (_texts, model) => (used.push(model), [[1]]) });
  const providers = [local('off', { enabled: false }), local('a'), local('b')];
  assert.deepEqual(await llm.embedF(providers, ['x']), [[1]]);
  assert.deepEqual(used, ['model-a']);

  const failing = loadLlm(t, { embed: async () => { throw new Error('embeddings failed: HTTP 429 slow down'); } });
  const { makeT } = require('../src/shared/locales');
  await assert.rejects(failing.embedF([local('a'), local('b')], ['x']), { message: makeT('zh')('err_busy') });
  await assert.rejects(failing.embedF([local('off', { enabled: false })], ['x']), /没有可用的 provider/);
});

test('an installed strategy receives the capability, the eligible providers and a per-provider attempt', async (t) => {
  const used = [];
  const llm = loadLlm(t, { embed: async (_texts, model) => (used.push(model), [[model.length]]) });
  const calls = [];
  hooks.setStrategy(async (capability, providers, attempt) => {
    calls.push({ capability, names: providers.map((p) => p.name) });
    const unusable = providers.find((p) => p.name === 'nokey');
    const refusal = await attempt(unusable).catch((error) => error.code);
    const first = await attempt(providers[0]);
    return { refusal, first };
  });
  const providers = [local('a'), { name: 'nokey', baseUrl: 'https://example.invalid', model: 'q' }, local('off', { enabled: false })];
  const out = await llm.embedF(providers, ['x']);
  assert.deepEqual(calls, [{ capability: 'embeddings', names: ['a', 'nokey'] }]);
  assert.deepEqual(out, { refusal: 'provider_unusable', first: [[7]] });
  assert.deepEqual(used, ['model-a']);

  hooks.setStrategy(async (capability) => capability);
  assert.equal(await llm.chatF([local('a')], []), 'chat');
  assert.equal(await llm.chatCompletionF([local('a')], []), 'chat');
  assert.equal(await llm.chatJsonF([local('a')], []), 'chat');

  let invoked = false;
  hooks.setStrategy(async () => { invoked = true; });
  await assert.rejects(llm.embedF([local('off', { enabled: false })], ['x']), /没有可用的 provider/);
  assert.equal(invoked, false);
  assert.deepEqual(used, ['model-a']);
});

function loadScheduler(t, intervalHours = 2) {
  const originalLoad = Module._load;
  Module._load = (request, parent, isMain) => (request === 'electron' ? { Notification: { isSupported: () => false } } : originalLoad(request, parent, isMain));
  stubModules(t, { 'settings.js': { get: () => ({ cleanup: { scanIntervalHours: intervalHours } }) }, 'stale.js': {} }, ['scheduler.js']);
  const scheduler = require('../src/main/scheduler');
  Module._load = originalLoad;
  const delays = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (_fn, ms) => (delays.push(ms), { unref() {} });
  t.after(() => {
    global.setTimeout = realSetTimeout;
  });
  return { scheduler, delays };
}

test('the interval filter rescales the scan interval and rearm applies it at once', (t) => {
  const { scheduler, delays } = loadScheduler(t);
  const base = 2 * 3600 * 1000;
  scheduler.rearm();
  assert.deepEqual(delays, [base]);

  hooks.setIntervalFilter((ms) => ms * 3);
  scheduler.rearm();
  assert.equal(delays.at(-1), base * 3);

  hooks.setIntervalFilter(() => 'soon');
  scheduler.rearm();
  assert.equal(delays.at(-1), base);
  hooks.setIntervalFilter(() => {
    throw new Error('filter failed');
  });
  scheduler.rearm();
  assert.equal(delays.at(-1), base);
  hooks.setIntervalFilter(() => 1e12);
  scheduler.rearm();
  assert.equal(delays.at(-1), 2 ** 31 - 1);
});
