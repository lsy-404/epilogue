'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const app = read('src/renderer/app.js');

function between(start, end) {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `section ${start} not found`);
  return app.slice(from, to);
}

function tab(html, id) {
  const from = html.indexOf(`id="tab-${id}"`);
  assert.ok(from >= 0, `tab ${id} not found`);
  const next = html.indexOf('class="tab-page', from);
  return html.slice(from, next < 0 ? undefined : next);
}

test('the settings pages carry the four extension slots where the removed sections lived', () => {
  const html = read('src/renderer/index.html');
  assert.match(tab(html, 'pro'), /data-ext-slot="pro:panels"/);
  assert.match(tab(html, 'capabilities'), /data-ext-slot="capability:image"/);
  assert.match(tab(html, 'capabilities'), /data-ext-slot="capability:transcription"/);
  assert.match(tab(html, 'general'), /data-ext-slot="prefs:performance"/);
  assert.equal((html.match(/data-ext-slot=/g) || []).length, 4);
});

function slotContext() {
  const events = [];
  const window = {
    dispatchEvent: (event) => events.push(event.detail.slot),
  };
  const context = vm.createContext({ window, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } }, document: {}, api: {}, $: () => null });
  vm.runInContext(between('window.epilogueExt =', '// 跨平台'), context);
  return { context, window, events };
}

test('window.epilogueExt starts single-enabled and slot dispatch names each slot', () => {
  const { context, window, events } = slotContext();
  assert.equal(window.epilogueExt.providerList.multi, false);
  assert.equal(vm.runInContext('providerListMulti()', context), false);
  window.epilogueExt.providerList.multi = true;
  assert.equal(vm.runInContext('providerListMulti()', context), true);
  vm.runInContext('SLOTS.forEach(dispatchSlot)', context);
  assert.deepEqual(events, ['pro:panels', 'capability:transcription', 'capability:image', 'prefs:performance']);
});

test('rendering the Pro view and the settings form announce the slots', () => {
  const { context, events } = slotContext();
  const stub = { classList: { toggle() {} }, textContent: '', replaceChildren() {}, append() {} };
  Object.assign(context, { proStatus: { active: true, license: { valid: true, name: 'n', sku: 'pro', upd: 'x', exp: null }, package: null, packageError: null, previousVersion: null, restartRequired: false }, $: () => stub, t: (key) => key, proErrorText: (c) => c, proFacts() {} });
  vm.runInContext(between('function renderProView()', 'function loadProRenderer()'), context);
  vm.runInContext('renderProView()', context);
  assert.deepEqual(events, ['pro:panels', 'capability:transcription', 'capability:image', 'prefs:performance']);
  const form = between('function loadSettingsForm(st)', '\n}\n');
  assert.match(form, /SLOTS\.slice\(1\)\.forEach\(dispatchSlot\)/);
});

function providerRenderer(multi) {
  const { context, window } = slotContext();
  window.epilogueExt.providerList.multi = multi;
  const hints = { providerSingleHint: [], providerMultiHint: [] };
  const container = { classes: {}, innerHTML: '', classList: { toggle: (name, on) => { container.classes[name] = on; } } };
  Object.assign(context, {
    currentSettings: { providers: { chat: [{ name: 'a', baseUrl: 'u', model: 'm' }, { name: 'b', enabled: false }, { name: 'c', enabled: true }], embeddings: [] } },
    $: (selector) => (selector === '#providers-chat' ? container : { classList: { toggle: (_name, on) => hints[selector.slice(1)].push(on) } }),
    t: (key) => key,
    esc: (value) => String(value ?? ''),
    upgradeSelects() {},
    refreshModelStatuses() {},
  });
  vm.runInContext(between('function renderProviders(type)', 'async function refreshModelStatuses'), context);
  vm.runInContext("renderProviders('chat')", context);
  return { container, hints };
}

const rows = (html) => html.split('<div class="provider-row').slice(1);
const checked = (row) => /data-p-en="[^"]+"\s+checked/.test(row);

test('without the multi flag the provider list keeps one enabled row and no drag UI', () => {
  const { container, hints } = providerRenderer(false);
  const list = rows(container.innerHTML);
  assert.equal(list.length, 3);
  assert.deepEqual(list.map(checked), [true, false, false]);
  assert.doesNotMatch(container.innerHTML, /draggable|drag-handle|data-drag/);
  assert.equal(container.classes.multi, false);
  assert.deepEqual([hints.providerSingleHint, hints.providerMultiHint], [[false], [true]]);
});

test('with the multi flag every enabled row is checked and rows can be dragged to reorder', () => {
  const { container, hints } = providerRenderer(true);
  const list = rows(container.innerHTML);
  assert.deepEqual(list.map(checked), [true, false, true]);
  assert.deepEqual(list.map((row) => /draggable="true" data-drag="chat\.\d"/.test(row) && row.includes('drag-handle')), [true, true, true]);
  assert.equal(container.classes.multi, true);
  assert.deepEqual([hints.providerSingleHint, hints.providerMultiHint], [[true], [false]]);
});

test('the preload bridge forwards the multi flag so the core keeps other providers enabled', () => {
  const preload = read('src/preload.js');
  assert.match(preload, /providerSourceAdd: \(sourceId, keepOthers\) =>[^\n]*keepOthers === true/);
  assert.match(preload, /oauthAuthorize: \(provider, keepOthers\) =>[^\n]*keepOthers === true/);
  const ipc = read('src/main/ipc.js');
  assert.match(ipc, /keepOthers === true \? cfg\.providers\.chat/);
  assert.match(app, /providerSourceAdd\(option\.dataset\.sourceId, providerListMulti\(\)\)/);
  assert.match(app, /oauthAuthorize\(provider, providerListMulti\(\)\)/);
});

test('the main process announces window and power lifecycle events', () => {
  const index = read('src/main/index.js');
  assert.match(index, /hooks\.emit\('window:open', \{ window: 'main' \}\)/);
  assert.match(index, /hooks\.emit\('window:closed', \{ window: 'main' \}\)/);
  assert.match(index, /powerMonitor\.on\('on-battery', \(\) => hooks\.emit\('power:battery'\)\)/);
  assert.match(index, /powerMonitor\.on\('on-ac', \(\) => hooks\.emit\('power:ac'\)\)/);
  assert.match(index, /createQuickSearch\(\{ openWindow, emit: hooks\.emit \}\)/);
});
