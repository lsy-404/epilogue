'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const catalog = require('../src/main/providerCatalog');

test('real host state exposes all OAuth entries and uniquely merges built-in API providers', async () => {
  const entry = require.resolve('../src/main/modelAuth');
  const load = Module._load;
  const fixture = catalog.parseCatalog({
    openai: { name: 'OpenAI', npm: '@ai-sdk/openai', models: { 'model-one': {} } },
    anthropic: { name: 'Anthropic', npm: '@ai-sdk/anthropic', models: { 'model-two': {} } },
  });
  let offline = false;
  const savedKey = { id: 'saved-key', name: 'Saved Anthropic', source: { provider: 'anthropic' }, model: 'model-two', apiKey: 'fixture-only', enabled: true, weight: 2 };
  delete require.cache[entry];
  Module._load = function(request, parent, main) {
    if (parent?.filename === entry) {
      if (request === './settings') return { get: () => ({ providers: { chat: offline ? [savedKey] : [] } }) };
      if (request === './providerOAuth') return { listAccounts: () => [] };
      if (request === './providerCatalog') return { getCatalog: async () => { if (offline) throw new Error('catalog unavailable'); return { providers: fixture }; } };
      if (request === './trae') return { store: () => ({ list: () => [], status: async () => ({ authenticated: false }) }), models: async () => [] };
    }
    return load.apply(this, arguments);
  };
  try {
    const host = require(entry);
    for (const degraded of [false, true]) {
      offline = degraded;
      const state = await host.state();
      const oauth = state.providers.filter(provider => provider.authMethods.includes('oauth'));
      assert.equal(oauth.length, 4);
      assert.equal(new Set(state.providers.map(provider => provider.id)).size, state.providers.length);
      for (const id of ['catalog:anthropic', 'catalog:openai', 'oauth:workbuddy']) {
        assert.equal(oauth.find(provider => provider.id === id).available, !(degraded && id === 'catalog:anthropic'));
      }
      if (!degraded) {
        assert.deepEqual(state.providers.find(provider => provider.id === 'catalog:anthropic').authMethods, ['oauth', 'api-key']);
      } else {
        const saved = state.providers.find(provider => provider.id === 'catalog:anthropic');
        assert.equal(saved.available, false);
        assert.deepEqual(saved.apiKeyCredentials.map(item => ({ id: item.id, label: item.label, models: item.models, weight: item.weight })), [{ id: 'saved-key', label: 'Saved Anthropic', models: ['model-two'], weight: 2 }]);
        assert.doesNotMatch(JSON.stringify(saved), /fixture-only/);
      }
    }
  } finally { Module._load = load; delete require.cache[entry]; }
});
