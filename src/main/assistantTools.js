'use strict';
// Tool registry for the Epilogue agent runtime. The orchestrator decides when
// a tool may run; this module owns validation and execution only.

const settings = require('./settings');
const proto = require('../shared/assistantProtocol');

function settingsDigest(cfg) {
  return {
    language: cfg.language,
    searchMode: cfg.searchMode,
    staleDays: cfg.staleDays,
    rules: (cfg.rules || '').slice(0, 1500),
    destinations: cfg.destinations,
    cleanup: {
      autoScan: cfg.cleanup.autoScan,
      scanIntervalHours: cfg.cleanup.scanIntervalHours,
      folders: cfg.cleanup.folders.map((folder) => folder.path),
    },
    extraction: cfg.extraction,
    app: { lowPower: cfg.app.lowPower, avoidCloudOnMetered: cfg.app.avoidCloudOnMetered },
  };
}

function flattenKeys(value, prefix = '') {
  const keys = [];
  for (const [key, entry] of Object.entries(value || {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) keys.push(...flattenKeys(entry, path));
    else keys.push(path);
  }
  return keys;
}

function flattenEntries(value, prefix = '') {
  const entries = [];
  for (const [key, entry] of Object.entries(value || {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) entries.push(...flattenEntries(entry, path));
    else entries.push({ path, value: entry });
  }
  return entries;
}

function prepareSettingsUpdate(args) {
  const { patch, rejected } = proto.sanitizeSettingsPatch(args?.patch || args);
  return {
    ok: Object.keys(patch).length > 0,
    patch,
    rejected,
    summary: flattenKeys(patch).join(', '),
    changes: flattenEntries(patch),
  };
}

async function executeReadTool(tool, args, events) {
  if (tool === 'search_files') {
    const query = String(args?.query ?? '').trim().slice(0, 500);
    if (!query) return { tool, ok: false, error: 'empty query' };
    const ipc = require('./ipc');
    const result = await ipc.ask(query, args?.mode === 'ai' ? 'ai' : 'match');
    events.push({ type: 'search', detail: query });
    return {
      tool,
      ok: true,
      answer: result.answer || undefined,
      hits: result.hits.slice(0, 6).map((hit) => ({
        path: hit.filePath,
        summary: (hit.summary || '').slice(0, 160),
        score: +(hit.score ?? 0).toFixed(2),
      })),
    };
  }
  if (tool === 'get_status') {
    const ipc = require('./ipc');
    events.push({ type: 'status_read', detail: '' });
    return ipc.withStore((store) => ({ tool, ok: true, stats: store.stats(), settings: settingsDigest(settings.get()) }));
  }
  return { tool, ok: false, error: 'unknown or mutating tool' };
}

function applySettingsUpdate(patch, hooks = {}) {
  const cfg = settings.set(patch);
  hooks.onSettingsChanged?.(cfg);
  return cfg;
}

module.exports = {
  settingsDigest,
  flattenKeys,
  flattenEntries,
  prepareSettingsUpdate,
  executeReadTool,
  applySettingsUpdate,
};
