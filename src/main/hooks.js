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
let running = new Set(); // AbortController of in-flight extractor calls

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

module.exports = {
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
