'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function loadLibrary() {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const section = source.slice(source.indexOf('const LIB_PAGE ='), source.indexOf('async function runIndex('));
  const calls = [];
  const elements = new Map();
  let active = true;
  const list = {
    html: '',
    replaceChildren() { this.html = ''; },
    insertAdjacentHTML(_position, html) { this.html += html; },
    addEventListener() {},
    set innerHTML(value) { this.html = value; },
  };
  const $ = (selector) => {
    if (selector === '#libraryList') return list;
    if (selector === '#view-ask') return { classList: { contains: () => active } };
    if (selector === '#btnLibMore') return null;
    if (!elements.has(selector)) elements.set(selector, { value: selector === '#dateTo' ? 100 : '', addEventListener() {} });
    return elements.get(selector);
  };
  const context = vm.createContext({
    $, api: { storeList: (options) => new Promise((resolve, reject) => calls.push({ options, resolve, reject })) },
    fileItem: (record) => `<li>${record.fileName}</li>`, esc: (value) => value,
    t: (key) => key, setTimeout, clearTimeout,
  });
  vm.runInContext(section, context);
  const page = (name, total = 1) => ({ rows: [{ fileName: name }], total, recordsTotal: total, from: 0, to: 1 });
  return { context, calls, list, $, page, hide: () => { active = false; } };
}

test('library ignores stale filter responses and only appends the next page once', async () => {
  const h = loadLibrary();
  const old = h.context.renderLibrary();
  h.$('#libraryFilter').value = 'new';
  const latest = h.context.renderLibrary();
  h.calls[1].resolve(h.page('new', 2));
  await latest;
  h.calls[0].resolve(h.page('old'));
  await old;
  assert.match(h.list.html, /new/);
  assert.doesNotMatch(h.list.html, /old/);
  const more = h.context.renderLibrary(true);
  await h.context.renderLibrary(true);
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].options.offset, 1);
  h.calls[2].resolve(h.page('next', 2));
  await more;
  assert.match(h.list.html, /new/);
  assert.match(h.list.html, /next/);
});

test('hidden library refresh neither loads rows nor accepts pending responses', async () => {
  const h = loadLibrary();
  const pending = h.context.renderLibrary();
  h.hide();
  await h.context.refreshLibrary();
  assert.equal(h.calls.length, 1);
  h.calls[0].resolve(h.page('hidden'));
  await pending;
  assert.equal(h.list.html, '');
});

test('library can retry an initial request after a failed query', async () => {
  const h = loadLibrary();
  const pending = h.context.renderLibrary();
  h.calls[0].reject(new Error('read failed'));
  await pending;
  assert.match(h.list.html, /err/);
  const retry = h.context.refreshLibrary();
  h.calls[1].resolve(h.page('recovered'));
  await retry;
  assert.match(h.list.html, /recovered/);
});
