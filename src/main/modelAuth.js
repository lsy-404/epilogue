'use strict';

const catalog = require('./providerCatalog');
const oauth = require('./providerOAuth');
const settings = require('./settings');

const OAUTH_PROVIDERS = new Map([
  ['anthropic', { name: 'Claude Official', models: ['claude-sonnet-4-6'] }],
  ['openai-codex', { name: 'ChatGPT Codex', models: ['gpt-5.4'] }],
  ['workbuddy', { name: 'WorkBuddy', models: ['glm-5.2', 'glm-5.1', 'glm-5v-turbo', 'kimi-k2.7', 'minimax-m3-pay', 'hy3', 'deepseek-v4-pro', 'deepseek-v4-flash'] }],
]);

function routeId(provider) { return String(provider.modelAuthProviderId || provider.oauthProvider || provider.source?.provider || provider.id || 'custom'); }
function credentialId(provider) { return String(provider.credentialId || provider.oauthAccountId || provider.id || ''); }
function health(account) { return Number(account?.expires || 0) > Date.now() ? 'healthy' : 'cooling-down'; }
function providerOptions(cfg, id) { return cfg.providerRouting?.[id] || { oauthEnabled: true, strategy: 'round-robin' }; }

function providerRecord(source, apiKey, label) {
  const record = catalog.providerSettingsFromSource(source, `key:${source.id}:${Date.now().toString(36)}`);
  return {
    ...record,
    name: label || source.name,
    apiKey,
    apiKeys: [apiKey],
    credentialId: record.id,
    modelAuthProviderId: source.id,
    weight: 1,
  };
}

async function state() {
  const cfg = settings.get();
  let listed = [];
  let catalogStatus = { state: 'ready', source: 'models.dev', checkedAt: new Date().toISOString() };
  try {
    const result = await catalog.getCatalog(false);
    listed = result.providers;
    if (result.catalogError) catalogStatus = { state: 'error', source: 'cached', checkedAt: new Date(result.generatedAt).toISOString(), error: result.catalogError };
    else if (result.generatedAt) catalogStatus.checkedAt = new Date(result.generatedAt).toISOString();
  } catch (error) {
    catalogStatus = { state: 'error', error: String(error.message || error) };
  }
  const records = cfg.providers.chat || [];
  const apiProviders = listed.filter((source) => source.available).map((source) => {
    const id = source.id;
    const options = providerOptions(cfg, id);
    const credentials = records.filter((record) => record.authType !== 'oauth' && routeId(record) === id).map((record) => ({
      id: credentialId(record), label: record.name || source.name, healthy: true, enabled: record.enabled !== false,
      weight: Number.isInteger(record.weight) ? record.weight : 1, models: source.models.map((model) => model.id),
    }));
    return { id, name: source.name, description: source.package, authMethods: ['api-key'], available: true,
      loadStrategy: options.strategy, models: source.models.map((model) => model.id), apiKeyModels: source.models.map((model) => model.id), apiKeyCredentials: credentials };
  });
  const oauthProviders = [...OAUTH_PROVIDERS].map(([id, definition]) => {
    const options = providerOptions(cfg, id);
    const accounts = oauth.listAccounts(id);
    const linked = records.filter((record) => record.authType === 'oauth' && routeId(record) === id);
    return {
      id, name: definition.name, description: 'Official OAuth', authMethods: ['oauth'], available: true,
      oauthEnabled: options.oauthEnabled !== false, loadStrategy: options.strategy, models: definition.models, oauthModels: definition.models,
      oauthCredentials: accounts.map((account) => {
        const record = linked.find((candidate) => credentialId(candidate) === account.id);
        return { id: account.id, label: account.label || definition.name, account: account.accountId, healthy: health(account) === 'healthy',
          enabled: record ? record.enabled !== false : false, weight: Number.isInteger(record?.weight) ? record.weight : 1, models: definition.models,
          cooldownUntilUtc: health(account) === 'healthy' ? null : new Date(Number(account.expires || 0)).toISOString() };
      }),
    };
  });
  return { providers: [...oauthProviders, ...apiProviders], model: null, catalogStatus };
}

function updateRecords(providerId, credential, update) {
  const cfg = settings.get();
  const chat = (cfg.providers.chat || []).map((record) => routeId(record) === providerId && credentialId(record) === credential ? { ...record, ...update } : record);
  return settings.set({ providers: { chat } });
}

function updateRouting(providerId, update) {
  const cfg = settings.get();
  return settings.set({ providerRouting: { ...(cfg.providerRouting || {}), [providerId]: { ...providerOptions(cfg, providerId), ...update } } });
}

async function execute(action, { signal } = {}) {
  const providerId = String(action?.providerId || action?.payload?.providerId || '');
  if (action?.type === 'refresh-catalog') { await catalog.getCatalog(true); return; }
  if (action?.type === 'authorize-oauth') {
    if (!OAUTH_PROVIDERS.has(providerId)) throw new Error('This provider does not offer OAuth in Epilogue.');
    const account = await oauth.authorize(providerId, { signal });
    const cfg = settings.get();
    const preset = await oauth.oauthProviderSettings(providerId);
    const id = account.id;
    const chat = (cfg.providers.chat || []).filter((record) => !(record.authType === 'oauth' && routeId(record) === providerId && credentialId(record) === id));
    chat.push({ ...preset, id: `oauth-route:${providerId}:${id}`, oauthAccountId: id, credentialId: id, modelAuthProviderId: providerId, weight: 1, enabled: true });
    settings.set({ providers: { chat } });
    return;
  }
  if (action?.type === 'add-api-key') {
    const source = await catalog.sourceProvider(providerId);
    if (!source?.available) throw new Error('This provider is not supported by the bundled runtime.');
    const apiKey = String(action.payload.apiKey || '').trim();
    if (!apiKey) throw new Error('API key is required.');
    const cfg = settings.get();
    settings.set({ providers: { chat: [...(cfg.providers.chat || []), providerRecord(source, apiKey, String(action.payload.label || '').trim())] } });
    return;
  }
  if (action?.type === 'remove-credential') {
    const cfg = settings.get();
    const id = String(action.credentialId || '');
    if (action.authMethod === 'oauth') oauth.removeAccount(providerId, id);
    settings.set({ providers: { chat: (cfg.providers.chat || []).filter((record) => !(routeId(record) === providerId && credentialId(record) === id)) } });
    return;
  }
  if (action?.type === 'update-credential') { updateRecords(providerId, String(action.payload.credentialId), { enabled: action.payload.enabled === true, weight: Number(action.payload.weight) }); return; }
  if (action?.type === 'update-provider') { updateRouting(providerId, { oauthEnabled: action.payload.oauthEnabled === true }); return; }
  if (action?.type === 'update-strategy' || action?.type === 'update-provider-strategy') {
    const strategy = action.payload?.strategy || action.strategy;
    if (!['round-robin', 'weighted-round-robin', 'failover'].includes(strategy)) throw new Error('Unsupported routing strategy.');
    updateRouting(providerId, { strategy }); return;
  }
  if (action?.type === 'select-model') {
    const cfg = settings.get();
    settings.set({ providers: { chat: (cfg.providers.chat || []).map((record) => routeId(record) === providerId ? { ...record, model: String(action.payload.model) } : record) } });
    return;
  }
  throw new Error('Unsupported model-auth action.');
}

module.exports = { state, execute, routeId, credentialId, providerOptions };
