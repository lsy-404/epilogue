'use strict';
// Registries and the event sink the core pipeline shares with the active Pro extension.
// Nothing here touches electron, so the indexer, scheduler and llm modules can read it freely.
const SPACE_ID = /^[a-z][a-z0-9:_.-]{0,63}$/;
const TEXT_SPACE = 'text';

let emitSink = null;
let extractors = new Map(); // kind -> fn
let spaces = new Map(); // id -> { id, kinds, embedFile, embedQuery }
let strategy = null;
let intervalFilter = null;
let running = new Set(); // AbortController of in-flight extractor, mode and job calls
let modes = new Map(); // name -> fn
let tools = new Map(); // name -> { definition, execute }
let jobs = [];
let jobsBusy = false;

function emit(event, payload) {
  emitSink?.(event, payload);
}

function attach(sink) {
  emitSink = sink;
}

function reset() {
  emitSink = null;
  extractors = new Map();
  spaces = new Map();
  strategy = null;
  intervalFilter = null;
  modes = new Map();
  tools = new Map();
  jobs = [];
  jobsBusy = false;
  for (const controller of running) controller.abort();
  running = new Set();
}

function checkKinds(kinds) {
  if (!Array.isArray(kinds) || !kinds.length || !kinds.every((k) => typeof k === 'string' && k)) {
    throw new Error('kinds must be a non-empty array of strings');
  }
  return [...new Set(kinds)];
}

function registerExtractor(kinds, fn) {
  const list = checkKinds(kinds);
  if (typeof fn !== 'function') throw new Error('extractor must be a function');
  for (const kind of list) {
    if (extractors.has(kind)) throw new Error(`an extractor is already registered for kind '${kind}'`);
  }
  for (const kind of list) extractors.set(kind, fn);
}

// Runs the extractor registered for `kind`; returns null when none is registered.
async function runExtractor(kind, filePath, { maxChars, manual = false }) {
  const fn = extractors.get(kind);
  if (!fn) return null;
  const controller = new AbortController();
  running.add(controller);
  try {
    const out = await fn(filePath, { maxChars, manual, signal: controller.signal });
    const content = typeof out?.content === 'string' ? out.content : '';
    const preview = typeof out?.preview === 'string' ? out.preview : undefined;
    return { content, preview };
  } finally {
    running.delete(controller);
  }
}

function registerVectorSpace(space) {
  const { id, embedFile, embedQuery } = space || {};
  if (typeof id !== 'string' || !SPACE_ID.test(id) || id === TEXT_SPACE) throw new Error('invalid vector space id');
  if (typeof embedFile !== 'function' || typeof embedQuery !== 'function') {
    throw new Error('a vector space needs embedFile and embedQuery functions');
  }
  const kinds = checkKinds(space.kinds);
  if (spaces.has(id)) throw new Error(`vector space '${id}' is already registered`);
  for (const other of spaces.values()) {
    const clash = kinds.find((k) => other.kinds.includes(k));
    if (clash) throw new Error(`kind '${clash}' already belongs to vector space '${other.id}'`);
  }
  spaces.set(id, { id, kinds, embedFile, embedQuery });
}

const vectorSpaces = () => [...spaces.values()];
const vectorSpaceFor = (kind) => vectorSpaces().find((space) => space.kinds.includes(kind)) || null;

function setStrategy(fn) {
  if (typeof fn !== 'function') throw new Error('strategy must be a function');
  strategy = fn;
}

function setIntervalFilter(fn) {
  if (typeof fn !== 'function') throw new Error('interval filter must be a function');
  intervalFilter = fn;
}

const MODE_NAMES = new Set(['deep']);
const TOOL_NAME = /^[a-z][a-z0-9_]{0,47}$/;
const BUILTIN_TOOLS = new Set(['update_settings', 'search_files', 'get_status']);

function registerMode(name, fn) {
  if (typeof name !== 'string' || !MODE_NAMES.has(name)) throw new Error('unsupported search mode');
  if (typeof fn !== 'function') throw new Error('search mode must be a function');
  if (modes.has(name)) throw new Error(`search mode '${name}' is already registered`);
  modes.set(name, fn);
}

// Runs the registered mode with an abort signal; returns null when the mode is not registered.
async function runMode(name, question) {
  const fn = modes.get(name);
  if (!fn) return null;
  const controller = new AbortController();
  running.add(controller);
  try {
    const out = await fn(question, { signal: controller.signal });
    if (!Array.isArray(out?.hits)) throw new Error('a search mode must return { hits: [] }');
    return { answer: typeof out.answer === 'string' && out.answer ? out.answer : null, hits: out.hits, mode: name };
  } finally {
    running.delete(controller);
  }
}

function registerTools(list) {
  if (!Array.isArray(list) || !list.length) throw new Error('tools must be a non-empty array');
  const staged = new Map();
  for (const tool of list) {
    const { definition, execute } = tool || {};
    const name = definition?.name;
    if (typeof name !== 'string' || !TOOL_NAME.test(name)) throw new Error('invalid tool name');
    if (tool.write || definition.write) throw new Error(`tool '${name}' is not read-only`);
    if (typeof definition.description !== 'string' || !definition.description) throw new Error(`tool '${name}' needs a description`);
    if (definition.parameters?.type !== 'object') throw new Error(`tool '${name}' needs object parameters`);
    if (typeof execute !== 'function') throw new Error(`tool '${name}' needs an execute function`);
    if (BUILTIN_TOOLS.has(name) || tools.has(name) || staged.has(name)) throw new Error(`tool '${name}' is already registered`);
    const { description, parameters } = definition;
    staged.set(name, { definition: { name, description, parameters }, execute });
  }
  for (const [name, tool] of staged) tools.set(name, tool);
}

function registerJob(fn) {
  if (typeof fn !== 'function') throw new Error('job must be a function');
  jobs.push(fn);
}

// Runs every job once and skips the pass while the previous one is still going; `more` asks the scheduler for an early re-run.
async function runJobs() {
  if (jobsBusy) return { more: false, errors: [] };
  jobsBusy = true;
  const controller = new AbortController();
  running.add(controller);
  const errors = [];
  let more = false;
  try {
    for (const job of [...jobs]) {
      try {
        const out = await job({ signal: controller.signal });
        if (out?.more === true) more = true;
      } catch (error) {
        errors.push(error);
      }
    }
  } finally {
    running.delete(controller);
    jobsBusy = false;
  }
  return { more, errors };
}

module.exports = {
  registerMode,
  runMode,
  modeNames: () => [...modes.keys()],
  registerTools,
  getTool: (name) => tools.get(name) || null,
  toolDefinitions: () => [...tools.values()].map((tool) => tool.definition),
  registerJob,
  runJobs,
  TEXT_SPACE,
  emit,
  attach,
  reset,
  registerExtractor,
  runExtractor,
  registerVectorSpace,
  vectorSpaces,
  vectorSpaceFor,
  setStrategy,
  getStrategy: () => strategy,
  setIntervalFilter,
  getIntervalFilter: () => intervalFilter,
};
