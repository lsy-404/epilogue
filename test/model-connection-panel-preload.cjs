const { contextBridge } = require('electron');

const state = {
  model: { providerId: 'catalog:anthropic', model: 'claude-test' },
  catalogStatus: { state: 'ready', source: 'cached' },
  providers: [{
    id: 'catalog:anthropic', name: 'Anthropic', description: 'Fixture provider', authMethods: ['oauth', 'api-key'],
    available: true, oauthEnabled: true, loadStrategy: 'round-robin', models: ['claude-test'], oauthModels: ['claude-test'], apiKeyModels: [],
    oauthCredentials: [{ id: 'fixture-oauth', label: 'Fixture account', account: 'fixture-account', healthy: true, enabled: true, weight: 1, models: ['claude-test'] }],
    apiKeyCredentials: [],
  }],
};

contextBridge.exposeInMainWorld('epologue', {
  modelAuthState: async () => state,
  modelAuthExecute: async () => {},
  modelAuthCancel: async () => {},
});
