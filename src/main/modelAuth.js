'use strict';

const crypto = require('crypto');
const catalog = require('./providerCatalog');
const oauth = require('./providerOAuth');
const settings = require('./settings');

const OAUTH_PROVIDERS = new Map([
  ['catalog:anthropic', { oauthProvider: 'anthropic', name: 'Anthropic', catalogProviderId: 'anthropic' }],
  ['catalog:openai', { oauthProvider: 'openai-codex', name: 'OpenAI', catalogProviderId: 'openai' }],
  ['oauth:workbuddy', { oauthProvider: 'workbuddy', name: 'WorkBuddy', catalogProviderId: 'workbuddy' }],
]);
const TRAE_PROVIDER_ID = 'oauth:trae';
const WORKBUDDY_RUNTIME_MODELS = new Set(['glm-5.2', 'glm-5.1', 'glm-5v-turbo', 'kimi-k2.7', 'minimax-m3-pay', 'hy3', 'deepseek-v4-pro', 'deepseek-v4-flash']);
const WORKBUDDY_CATALOG_PROVIDERS = new Set(['zhipuai', 'deepseek', 'tencent-tokenhub']);

function modelsForOauth(definition, listed) {
  if (definition.oauthProvider !== 'workbuddy') return listed.find((source) => source.id === definition.catalogProviderId)?.models.map((model) => model.id) || [];
  return listed.filter((source) => WORKBUDDY_CATALOG_PROVIDERS.has(source.id)).flatMap((source) => source.models.map((model) => model.id)).filter((id, index, all) => WORKBUDDY_RUNTIME_MODELS.has(id) && all.indexOf(id) === index);
}

function routeId(provider) {
  if (provider?.protocol === 'trae') return TRAE_PROVIDER_ID;
  if (provider?.authType === 'oauth' && provider.oauthProvider) return [...OAUTH_PROVIDERS].find(([, definition]) => definition.oauthProvider === provider.oauthProvider)?.[0] || `oauth:${provider.oauthProvider}`;
  if (provider?.source?.provider) return `catalog:${provider.source.provider}`;
  return String(provider?.modelAuthProviderId || provider?.id || 'custom');
}

async function traeProvider(records) {
  const trae = require('./trae');
  const sessions = records.filter((record) => record.protocol === 'trae');
  const accounts = trae.store().list();
  const statuses = await Promise.all(sessions.map(async (record) => ({ record, status: await trae.store().status(record.credentialId) })));
  const options = providerOptions(settings.get(), TRAE_PROVIDER_ID);
  const modelLists = await Promise.all(sessions.map(async (record) => { try { return await trae.models(record.credentialId); } catch { return []; } }));
  const models = [...new Set(modelLists.flat().map((model) => model.name).filter(Boolean))];
  return {
    id: TRAE_PROVIDER_ID, name: 'TRAE', description: 'Official browser OAuth with authenticated model discovery.', authMethods: ['oauth'], available: true,
    unavailableReason: null, oauthEnabled: options.oauthEnabled !== false, loadStrategy: options.strategy, models, oauthModels: models,
    oauthCredentials: accounts.map((account) => { const record = sessions.find((candidate) => credentialId(candidate) === account.id); const status = statuses.find((item) => credentialId(item.record) === account.id)?.status; return { id: account.id, label: account.label, account: account.accountId, healthy: status?.authenticated === true, enabled: record ? record.enabled !== false : false, weight: Number.isInteger(record?.weight) ? record.weight : 1, models: record ? [record.model].filter(Boolean) : models, cooldownUntilUtc: null }; }),
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
    const oauthDefinition = OAUTH_PROVIDERS.get(id);
    const accounts = oauthDefinition ? oauth.listAccounts(oauthDefinition.oauthProvider) : [];
    const linked = oauthDefinition ? records.filter((record) => record.authType === 'oauth' && routeId(record) === id) : [];
    const models = source.models.map((model) => model.id);
    return { id, name: source.name, description: source.package, authMethods: oauthDefinition ? ['oauth', 'api-key'] : ['api-key'], available: true,
      oauthEnabled: options.oauthEnabled !== false, loadStrategy: options.strategy, models, oauthModels: oauthDefinition ? models : [], apiKeyModels: models, apiKeyCredentials: credentials,
      ...(oauthDefinition ? { oauthCredentials: accounts.map((account) => {
        const record = linked.find((candidate) => credentialId(candidate) === account.id);
        return { id: account.id, label: account.label || oauthDefinition.name, account: account.accountId, healthy: true, enabled: record ? record.enabled !== false : false, weight: Number.isInteger(record?.weight) ? record.weight : 1, models, cooldownUntilUtc: null };
      }) } : {}) };
  });
  const savedApiProviders = [...new Set(records.filter((record) => record.authType !== 'oauth').map(routeId))]
    .filter((id) => !apiProviders.some((provider) => provider.id === id))
    .map((id) => {
      const saved = records.filter((record) => record.authType !== 'oauth' && routeId(record) === id);
      const models = [...new Set(saved.map((record) => record.model).filter(Boolean))];
      const options = providerOptions(cfg, id);
      const oauthDefinition = OAUTH_PROVIDERS.get(id);
      const oauthModels = oauthDefinition ? modelsForOauth(oauthDefinition, listed) : [];
      const accounts = oauthDefinition ? oauth.listAccounts(oauthDefinition.oauthProvider) : [];
      const linked = oauthDefinition ? records.filter((record) => record.authType === 'oauth' && routeId(record) === id) : [];
      return {
        id,
        name: saved[0]?.name || id,
        description: 'Saved API key connection; provider directory is unavailable.',
        authMethods: oauthDefinition ? ['oauth', 'api-key'] : ['api-key'],
        available: Boolean(oauthDefinition),
        unavailableReason: oauthDefinition ? null : 'Provider directory is unavailable. The saved connection can still be reviewed or removed.',
        oauthEnabled: options.oauthEnabled !== false,
        loadStrategy: options.strategy,
        models: [...new Set([...oauthModels, ...models])],
        oauthModels,
        apiKeyModels: models,
        ...(oauthDefinition ? { oauthCredentials: accounts.map((account) => {
          const record = linked.find((candidate) => credentialId(candidate) === account.id);
          return { id: account.id, label: account.label || oauthDefinition.name, account: account.accountId, healthy: true, enabled: record ? record.enabled !== false : false, weight: Number.isInteger(record?.weight) ? record.weight : 1, models, cooldownUntilUtc: null };
        }) } : {}),
        apiKeyCredentials: saved.map((record) => ({
          id: credentialId(record),
          label: record.name || id,
          healthy: false,
          enabled: record.enabled !== false,
          weight: Number.isInteger(record.weight) ? record.weight : 1,
          models: record.model ? [record.model] : [],
        })),
      };
    });
  const oauthProviders = [...OAUTH_PROVIDERS].filter(([id]) => !apiProviders.some(provider => provider.id === id) && !savedApiProviders.some(provider => provider.id === id)).map(([id, definition]) => {
    const options = providerOptions(cfg, id);
    const accounts = oauth.listAccounts(definition.oauthProvider);
    const linked = records.filter((record) => record.authType === 'oauth' && (routeId(record) === id || record.oauthProvider === definition.oauthProvider));
    const models = modelsForOauth(definition, listed);
    return {
      id, name: definition.name, description: models.length ? 'Official OAuth' : 'OAuth 可连接；模型目录暂不可用。', authMethods: ['oauth'], available: true,
      unavailableReason: null, oauthEnabled: options.oauthEnabled !== false, loadStrategy: options.strategy, models, oauthModels: models,
      oauthCredentials: accounts.map((account) => {
        const record = linked.find((candidate) => credentialId(candidate) === account.id);
        return { id: account.id, label: account.label || definition.name, account: account.accountId, healthy: true,
          enabled: record ? record.enabled !== false : false, weight: Number.isInteger(record?.weight) ? record.weight : 1, models, cooldownUntilUtc: null };
      }),
    };
  });
  return { providers: [...oauthProviders, await traeProvider(records), ...apiProviders, ...savedApiProviders], model: cfg.modelAuthSelection || null, catalogStatus };
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
      const before = settings.get();
      const prior = (before.providers.chat || []).find((record) => routeId(record) === TRAE_PROVIDER_ID && credentialId(record) === String(action.credentialId || ''));
      const account = await trae.store().authorize({ signal });
      const discovered = await trae.models(account.id, { signal });
      if (!discovered.length) throw new Error('TRAE returned no models for this account.');
      const model = prior?.model && discovered.some((item) => item.name === prior.model) ? prior.model : discovered[0].name;
      const cfg = settings.get();
      const reconnectId = String(action.credentialId || '');
      const existing = (cfg.providers.chat || []).find((record) => routeId(record) === TRAE_PROVIDER_ID && credentialId(record) === (reconnectId || account.id));
      if (reconnectId && reconnectId !== account.id) trae.store().remove(reconnectId);
      const chat = (cfg.providers.chat || []).filter((record) => !(routeId(record) === TRAE_PROVIDER_ID && (credentialId(record) === account.id || credentialId(record) === reconnectId)));
      chat.push({ id: `trae-route:${account.id}`, name: account.label || 'TRAE', protocol: 'trae', authType: 'oauth', credentialId: account.id, modelAuthProviderId: TRAE_PROVIDER_ID, model, weight: existing?.weight || 1, enabled: existing?.enabled !== false });
      settings.set({ providers: { chat } });
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
    if (reconnectId && reconnectId !== id) oauth.removeAccount(definition.oauthProvider, reconnectId);
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
        require('./trae').store().remove(id);
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
