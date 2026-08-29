'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../src/shared/assistantProtocol');
const assistantTools = require('../src/main/assistantTools');

test('settings patches stay inside the agent allow-list', () => {
  const result = protocol.sanitizeSettingsPatch({
    staleDays: 45,
    providers: { chat: [{ apiKey: 'must-not-pass' }] },
    cleanup: { autoScan: true, soloMode: true },
    app: { lowPower: false },
  });
  assert.deepEqual(result.patch, {
    staleDays: 45,
    cleanup: { autoScan: true },
    app: { lowPower: false },
  });
  assert.deepEqual(result.rejected.sort(), ['cleanup.soloMode', 'providers']);
});

test('native tool calls are bounded and unknown tools are discarded', () => {
  const calls = protocol.normalizeNativeToolCalls([
    { id: 'a', name: 'search_files', arguments: { query: 'report' } },
    { id: 'b', name: 'delete_everything', arguments: {} },
    { id: 'c', name: 'get_status', arguments: {} },
  ]);
  assert.deepEqual(calls, [
    { id: 'a', tool: 'search_files', args: { query: 'report' } },
    { id: 'c', tool: 'get_status', args: {} },
  ]);
  assert.equal(protocol.WRITE_TOOLS.has('update_settings'), true);
  assert.equal(protocol.WRITE_TOOLS.has('search_files'), false);
});

test('approval preparation exposes only sanitized settings and reviewable values', () => {
  const prepared = assistantTools.prepareSettingsUpdate({
    patch: { staleDays: 60, cleanup: { autoScan: false, soloMode: true }, providers: { chat: [] } },
  });
  assert.equal(prepared.ok, true);
  assert.deepEqual(prepared.patch, { staleDays: 60, cleanup: { autoScan: false } });
  assert.deepEqual(prepared.changes, [
    { path: 'staleDays', value: 60 },
    { path: 'cleanup.autoScan', value: false },
  ]);
  assert.deepEqual(prepared.rejected.sort(), ['cleanup.soloMode', 'providers']);
});
