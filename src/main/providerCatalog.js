'use strict';

// Provider Source catalog. IRIS uses models.dev as its OpenCode registry;
// Epilogue exposes the same click-to-select source flow while only enabling
// packages that can be represented by the adapters bundled in this app.
const MODELS_DEV_URL = 'https://models.dev/api.json';
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_API_BASES = { openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1' };
const SUPPORTED_PACKAGES = new Set([
  '@ai-sdk/openai-compatible',
  '@ai-sdk/openai',
  '@ai-sdk/anthropic',
  '@openrouter/ai-sdk-provider',
]);

let cached = [];
let fetchedAt = 0;
let pending = null;

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function protocolFor(id, packageName) {
  if (packageName === '@ai-sdk/anthropic' || id === 'anthropic') return 'anthropic-messages';
  if (packageName === '@ai-sdk/openai' || id === 'openai') return 'openai-responses';
  return 'openai-compatible';
}

function parseCatalog(value) {
  const providers = [];
  for (const [id, raw] of Object.entries(object(value))) {
    const entry = object(raw);
    const packageName = typeof entry.npm === 'string' ? entry.npm.trim() : '';
    const models = Object.entries(object(entry.models)).map(([modelId, rawModel]) => {
      const model = object(rawModel);
      return {
        id: typeof model.id === 'string' && model.id.trim() ? model.id.trim() : modelId,
        name: typeof model.name === 'string' && model.name.trim() ? model.name.trim() : modelId,
      };
    }).filter((model) => model.id);
    if (!id || !packageName || !models.length) continue;
    const baseUrl = typeof entry.api === 'string' && entry.api.trim() ? entry.api.trim().replace(/\/+$/, '') : DEFAULT_API_BASES[id] || '';
    const protocol = protocolFor(id, packageName);
    const available = SUPPORTED_PACKAGES.has(packageName) && Boolean(baseUrl);
    providers.push({
      id,
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id,
      registry: 'opencode',
      package: packageName,
      baseUrl,
      protocol,
      env: Array.isArray(entry.env) ? entry.env.filter((item) => typeof item === 'string') : [],
      models,
      modelCount: models.length,
      available,
    });
  }
  return providers.sort((left, right) => {
    if (left.available !== right.available) return left.available ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

async function getCatalog(force = false, fetchImpl = fetch) {
  if (!force && cached.length && Date.now() - fetchedAt < CATALOG_TTL_MS) {
    return { providers: cached, generatedAt: fetchedAt };
  }
  if (pending) return pending;
  pending = (async () => {
    try {
      const response = await fetchImpl(MODELS_DEV_URL, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Provider source catalog failed: HTTP ${response.status}`);
      const providers = parseCatalog(await response.json());
      if (!providers.length) throw new Error('Provider source catalog is empty.');
      cached = providers;
      fetchedAt = Date.now();
      return { providers: cached, generatedAt: fetchedAt };
    } catch (error) {
      if (cached.length) return { providers: cached, generatedAt: fetchedAt, catalogError: error.message };
      throw error;
    }
  })().finally(() => { pending = null; });
  return pending;
}

async function sourceProvider(id, fetchImpl = fetch) {
  const { providers } = await getCatalog(false, fetchImpl);
  return providers.find((provider) => provider.id === id);
}

function providerSettingsFromSource(source, id = `source-${Date.now().toString(36)}`) {
  if (!source?.available) throw new Error('The selected Provider Source is not supported by this build.');
  const protocol = source.protocol || 'openai-compatible';
  const anthropic = protocol === 'anthropic-messages';
  const responses = protocol === 'openai-responses';
  return {
    id,
    name: source.name || source.id,
    enabled: true,
    source: { registry: source.registry || 'opencode', provider: source.id, package: source.package || '', env: source.env || [] },
    protocol,
    baseUrl: source.baseUrl,
    requestPath: anthropic ? '/messages' : responses ? '/responses' : '/chat/completions',
    modelsPath: '/models',
    authHeader: anthropic ? 'x-api-key' : 'Authorization',
    authPrefix: anthropic ? '' : 'Bearer ',
    apiKey: '',
    apiKeys: [],
    model: source.models?.[0]?.id || '',
  };
}

module.exports = {
  MODELS_DEV_URL,
  SUPPORTED_PACKAGES,
  parseCatalog,
  getCatalog,
  sourceProvider,
  providerSettingsFromSource,
  protocolFor,
};
