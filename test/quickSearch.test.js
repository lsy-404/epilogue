'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const main = fs.readFileSync(require.resolve('../src/main/quickSearch.js'), 'utf8');
const renderer = fs.readFileSync(require.resolve('../src/renderer/quick-search.js'), 'utf8');

test('quick search keeps a separate trusted IPC surface and validates indexed files', () => {
  assert.match(main, /quick-search:query/);
  assert.match(main, /queryLibrary\(store\.all\(\), \{ query: text, limit: 12 \}\)/);
  assert.match(main, /event\?\.sender === popup\.webContents/);
  assert.match(main, /withStore\(\(store\) => store\.get\(value\)\)/);
  assert.match(main, /shell\.openPath\(allowed\)/);
  assert.match(main, /shell\.showItemInFolder\(allowed\)/);
});

test('quick search discards stale responses and supports keyboard dismissal/actions', () => {
  assert.match(renderer, /const current = sequence/);
  assert.match(renderer, /if \(current !== sequence\) return/);
  assert.match(renderer, /event\.key === 'Escape'/);
  assert.match(renderer, /choose\(selected, event\.shiftKey\)/);
  assert.match(main, /popup\.on\('blur'/);
});
