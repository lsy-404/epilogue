'use strict';

const crypto = require('crypto');
const catalog = require('./providerCatalog');
const oauth = require('./providerOAuth');
const settings = require('./settings');

const OAUTH_PROVIDERS = new Map([
  ['oauth:anthropic', { oauthProvider: 'anthropic', name: 'Claude Official', catalogProviderId: 'anthropic' }],
  ['oauth:openai-codex', { oauthProvider: 'openai-codex', name: 'ChatGPT Codex', catalogProviderId: 'openai' }],
  ['oauth:workbuddy', { oauthProvider: 'workbuddy', name: 'WorkBuddy', catalogProviderId: 'workbuddy' }],
]);
const TRAE_PROVIDER_ID = 'oauth:trae-enterprise';

function routeId(provider) {
  if (provider?.protocol === 'trae-cli') return TRAE_PROVIDER_ID;
  if (provider?.authType === 'oauth' && provider.oauthProvider) return `oauth:${provider.oauthProvider}`;
  if (provider?.source?.provider) return `catalog:${provider.source.provider}`;
  return String(provider?.modelAuthProviderId || provider?.id || 'custom');
}

async function traeProvider(records) {
  const trae = require('./trae');
  const sessions = records.filter((record) => record.protocol === 'trae-cli');
  const probe = await trae.status({ homeDir: trae.sessionHome('probe') });
  const statuses = await Promise.all(sessions.map(async (record) => ({ record, status: await trae.status({ homeDir: record.traeHome, label: record.name, host: record.traeHost }) })));
  const models = [...new Set(statuses.flatMap(({ status }) => Array.isArray(status.models) ? status.models.filter((model) => typeof model === 'string') : []))];
  return {
    id: TRAE_PROVIDER_ID, name: 'Trae Enterprise CLI', description: probe.available ? 'Enterprise CLI session' : 'Enterprise CLI is not available on this device', authMethods: ['oauth'], available: probe.available === true,
    unavailableReason: probe.available === true ? null : 'Trae Enterprise CLI is not installed or cannot be started.', oauthEnabled: true, loadStrategy: 'failover', models, oauthModels: models,
    oauthCredentials: statuses.map(({ record, status }) => ({ id: credentialId(record), label: record.name || 'Trae Enterprise CLI', healthy: status.authenticated === true, enabled: record.enabled !== false, weight: Number.isInteger(record.weight) ? record.weight : 1, models, cooldownUntilUtc: null })),
  };
}
function credentialId(provider) { return String(provider.credentialId || provider.oauthAccountId || provider.id || ''); }
function health(account) { return Number(account?.expires || 0) > Date.now() ? 'healthy' : 'cooling-down'; }
function providerOptions(cfg, id) { return cfg.providerRouting?.[id] || { oauthEnabled: true, strategy: 'round-robin' }; }

function providerRecord(source, apiKey, label) {
  const record = catalog.providerSettingsFromSource(source, `key:${source.id}:${crypto.randomUUID()}`);
  return {
    ...record,
    name: label || source.name,
    apiKey,
    apiKeys: [apiKey],
    credentialId: record.id,
    modelAuthProviderId: `catalog:${source.id}`,
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
    const id = `catalog:${source.id}`;
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
    const accounts = oauth.listAccounts(definition.oauthProvider);
    const linked = records.filter((record) => record.authType === 'oauth' && (routeId(record) === id || record.oauthProvider === definition.oauthProvider));
    const models = listed.find((source) => source.id === definition.catalogProviderId)?.models.map((model) => model.id) || [];
    return {
      id, name: definition.name, description: 'Official OAuth', authMethods: ['oauth'], available: true,
      oauthEnabled: options.oauthEnabled !== false, loadStrategy: options.strategy, models, oauthModels: models,
      oauthCredentials: accounts.map((account) => {
        const record = linked.find((candidate) => credentialId(candidate) === account.id);
        return { id: account.id, label: account.label || definition.name, account: account.accountId, healthy: true,
          enabled: record ? record.enabled !== false : false, weight: Number.isInteger(record?.weight) ? record.weight : 1, models, cooldownUntilUtc: null };
      }),
    };
  });
  return { providers: [...oauthProviders, await traeProvider(records), ...apiProviders], model: cfg.modelAuthSelection || null, catalogStatus };
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
    if (providerId === TRAE_PROVIDER_ID) {
      const trae = require('./trae');
      const session = trae.newSession();
      const result = await trae.login(session, signal);
      const cfg = settings.get();
      const model = Array.isArray(result.models) && typeof result.models[0] === 'string' ? result.models[0] : '';
      settings.set({ providers: { chat: [...(cfg.providers.chat || []), { id: `trae-route:${session.id}`, name: 'Trae Enterprise CLI', protocol: 'trae-cli', authType: 'trae-cli', credentialId: session.id, modelAuthProviderId: TRAE_PROVIDER_ID, traeHome: session.homeDir, model, weight: 1, enabled: true }] } });
      return;
    }
    const definition = OAUTH_PROVIDERS.get(providerId);
    if (!definition) throw new Error('This provider does not offer OAuth in Epilogue.');
    const account = await oauth.authorize(definition.oauthProvider, { signal });
    const cfg = settings.get();
    const preset = await oauth.oauthProviderSettings(definition.oauthProvider);
    const id = account.id;
    const reconnectId = String(action.credentialId || '');
    const replaced = (cfg.providers.chat || []).find((record) => reconnectId && record.authType === 'oauth' && routeId(record) === providerId && credentialId(record) === reconnectId);
    const chat = (cfg.providers.chat || []).filter((record) => !(record.authType === 'oauth' && routeId(record) === providerId && (credentialId(record) === id || credentialId(record) === reconnectId)));
    chat.push({ ...preset, ...(replaced ? { enabled: replaced.enabled, weight: replaced.weight, model: replaced.model } : {}), id: `oauth-route:${definition.oauthProvider}:${id}`, oauthAccountId: id, credentialId: id, modelAuthProviderId: providerId, weight: replaced?.weight || 1, enabled: replaced?.enabled !== false });
    settings.set({ providers: { chat } });
    return;
  }
  if (action?.type === 'add-api-key') {
    const source = await catalog.sourceProvider(providerId.replace(/^catalog:/, ''));
    if (!source?.available) throw new Error('This provider is not supported by the bundled runtime.');
    const apiKey = String(action.payload.apiKey || '').trim();
    if (!apiKey) throw new Error('API key is required.');
    const record = providerRecord(source, apiKey, String(action.payload.label || '').trim());
    await require('./llm').testProvider('chat', record);
    const cfg = settings.get();
    settings.set({ providers: { chat: [...(cfg.providers.chat || []), record] } });
    return;
  }
  if (action?.type === 'remove-credential') {
    const cfg = settings.get();
    const id = String(action.credentialId || '');
    if (action.authMethod === 'oauth') {
      const definition = OAUTH_PROVIDERS.get(providerId);
      if (definition) oauth.removeAccount(definition.oauthProvider, id);
      if (providerId === TRAE_PROVIDER_ID) {
        const record = (cfg.providers.chat || []).find((item) => routeId(item) === providerId && credentialId(item) === id);
        if (record) await require('./trae').logout({ homeDir: record.traeHome, label: record.name, host: record.traeHost }, signal);
      }
    }
    settings.set({ providers: { chat: (cfg.providers.chat || []).filter((record) => !(routeId(record) === providerId && credentialId(record) === id)) } });
    return;
  }
  if (action?.type === 'update-credential') {
    const weight = Number(action.payload.weight);
    if (!Number.isInteger(weight) || weight < 1 || weight > 100) throw new Error('Invalid credential weight.');
    updateRecords(providerId, String(action.payload.credentialId), { enabled: action.payload.enabled === true, weight }); return;
  }
  if (action?.type === 'update-provider') { updateRouting(providerId, { oauthEnabled: action.payload.oauthEnabled === true }); return; }
  if (action?.type === 'update-strategy' || action?.type === 'update-provider-strategy') {
    const strategy = action.payload?.strategy || action.strategy;
    if (!['round-robin', 'weighted-round-robin', 'failover'].includes(strategy)) throw new Error('Unsupported routing strategy.');
    updateRouting(providerId, { strategy }); return;
  }
  if (action?.type === 'select-model') {
    const snapshot = await state();
    const provider = snapshot.providers.find((item) => item.id === providerId);
    const model = String(action.payload.model || '');
    if (!provider || !provider.models.includes(model)) throw new Error('The selected model is not available for this provider.');
    const cfg = settings.get();
    settings.set({ modelAuthSelection: { providerId, model }, providers: { chat: (cfg.providers.chat || []).map((record) => routeId(record) === providerId ? { ...record, model } : record) } });
    return;
  }
  throw new Error('Unsupported model-auth action.');
}

module.exports = { state, execute, routeId, credentialId, providerOptions };
