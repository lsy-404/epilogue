'use strict';
// 多协议模型客户端：chat 走 provider adapter；Compatible 自动模式复用 IRIS 同款 AI SDK；
// embeddings / whisper 维持 OpenAI-compatible 的直接请求。
const fs = require('fs');
const path = require('path');
const adapters = require('./providerAdapters');
const compatibleKeyCursors = new Map();
let compatibleSdkPromise = null;
let credentialRouterPromise = null;

function headers(provider, extra = {}) {
  const h = { ...extra };
  if (provider.apiKey) h.Authorization = `Bearer ${provider.apiKey}`;
  if ((provider.baseUrl || '').includes('openrouter.ai')) {
    h['HTTP-Referer'] = 'https://github.com/Wuyilingwei/epilogue';
    h['X-Title'] = 'Epilogue';
  }
  return h;
}

// provider 可用：未被禁用，且为本机（type=local）/ 免 Key（内置）/ 已配 Key
function usable(p) {
  if (!p || p.enabled === false) return false;
  if (p.protocol === 'trae') return Boolean(p.credentialId && p.model);
  if (p.type === 'local') return true;
  if (p.authType === 'oauth' && p.oauthProvider) return Boolean(p.baseUrl && p.model);
  return Boolean(p.baseUrl && (p.keyless || p.apiKey || (Array.isArray(p.apiKeys) && p.apiKeys.some(Boolean))));
}

function routeAllowed(provider) {
  if (provider?.protocol === 'trae') return require('./settings').get().providerRouting?.[String(provider.modelAuthProviderId)]?.oauthEnabled !== false;
  if (provider?.authType !== 'oauth' || !provider.oauthProvider) return true;
  const routing = require('./settings').get().providerRouting?.[String(provider.modelAuthProviderId || provider.oauthProvider)];
  return routing?.oauthEnabled !== false;
}

// 计费网络时只保留本机 provider
function localOnlyFilter(providers, localOnly) {
  const list = Array.isArray(providers) ? providers : [providers];
  return localOnly ? list.filter((p) => p.type === 'local') : list;
}

function sharedPool(provider) { return Boolean(provider?.modelAuthProviderId); }
function routingModelId(provider) { return provider.model; }
function routerProviderId(provider) { return String(provider.modelAuthProviderId).replace(/[^a-zA-Z0-9._-]/g, '-'); }
function poolCredentialId(provider) { return String(provider.id || provider.credentialId); }
function errorForRouter(error) {
  const status = Number(String(error?.message || '').match(/HTTP\s+(\d{3})/)?.[1]);
  return Number.isInteger(status) ? { kind: 'http', status } : { kind: 'transport' };
}

async function routeCandidates(list) {
  const legacy = list.filter((provider) => !sharedPool(provider));
  const pooled = list.filter(sharedPool);
  if (!pooled.length) return legacy;
  const core = await import('@model-auth/core');
  credentialRouterPromise ||= Promise.resolve(new core.CredentialRouter([]));
  const router = await credentialRouterPromise;
  const cfg = require('./settings').get();
  const byCredential = new Map();
  const routeOrder = [];
  for (const provider of pooled) {
    const providerId = routerProviderId(provider);
    const credentialId = poolCredentialId(provider);
    const modelId = routingModelId(provider);
    if (!credentialId || !modelId) continue;
    if (!routeOrder.includes(providerId)) routeOrder.push(providerId);
    router.upsert(core.createCredentialMetadata({ id: credentialId, providerId, authMethod: provider.authType === 'oauth' || provider.protocol === 'trae' ? 'oauth' : 'api-key', enabled: provider.enabled !== false, weight: Number(provider.weight) || 1, modelIds: [modelId] }));
    router.setStrategy(cfg.providerRouting?.[provider.modelAuthProviderId]?.strategy || 'round-robin', providerId);
    router.setProviderOAuthEnabled(providerId, cfg.providerRouting?.[provider.modelAuthProviderId]?.oauthEnabled !== false);
    byCredential.set(credentialId, provider);
  }
  const ordered = [];
  for (const providerId of routeOrder) {
    const first = pooled.find((provider) => routerProviderId(provider) === providerId && routingModelId(provider));
    if (!first) continue;
    for (const credential of router.candidates({ providerId, modelId: routingModelId(first) })) {
      const provider = byCredential.get(credential.id);
      if (provider && !ordered.includes(provider)) ordered.push(provider);
    }
  }
  return [...ordered, ...legacy];
}

// 灾备：每个共享 provider 内按所选策略挑独立凭据；组间仍按用户配置顺序回退。
async function withFailover(providers, fn) {
  const list = await routeCandidates((Array.isArray(providers) ? providers : [providers]).filter((provider) => usable(provider) && routeAllowed(provider)));
  if (!list.length) throw new Error('没有可用的 provider（请在「设置 → 能力」选择 Provider Source、连接 OAuth 或配置自定义接口）');
  let lastErr;
  for (const p of list) {
    try {
      const result = await fn(p);
      if (sharedPool(p)) (await credentialRouterPromise)?.reportSuccess(poolCredentialId(p));
      return result;
    } catch (e) {
      lastErr = e;
      if (sharedPool(p)) (await credentialRouterPromise)?.reportError(poolCredentialId(p), errorForRouter(e));
      require('./log').log('llm', `provider failed: ${p.name || p.baseUrl || 'local'}`, { error: String(e.message || e).slice(0, 200) });
    }
  }
  // 全部失败且是限流/超时：换成可操作的友好提示
  const msg = lastErr?.message || '';
  if (/HTTP 429/.test(msg) || /timeout/.test(msg)) {
    const { makeT } = require('../shared/locales');
    const t = makeT(require('./settings').get().language);
    throw new Error(t(/HTTP 429/.test(msg) ? 'err_busy' : 'err_timeout'));
  }
  throw lastErr;
}

function apiUrl(provider, endpoint) {
  return `${(provider.baseUrl || '').replace(/\/+$/, '')}${endpoint}`;
}

async function raise(res, what) {
  const body = await res.text().catch(() => '');
  throw new Error(`${what} failed: HTTP ${res.status} ${body.slice(0, 500)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 各类请求超时：免费端点可能挂起连接不响应，无超时会让 UI 永远「思考中…」，
// 且同主机串行节流链会被一个挂死请求堵死全部后续 AI 调用
const TIMEOUTS = { chat: 90000, embeddings: 60000, transcription: 180000, 'list models': 15000 };

// 自动重试：429 最多 5 次（3s 起指数退避 + 抖动，免费通道拥挤是常态）；5xx 最多 3 次；尊重 Retry-After
async function fetchWithRetry(url, options, what, retries = 3) {
  const { log } = require('./log');
  const host = (url.split('/')[2] || '?').toLowerCase();
  const t0 = Date.now();
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUTS[what] || 90000) });
    } catch (e) {
      // 超时不重试（已等足量时间），直接抛给灾备链切换下一个 provider
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        log('llm', `${what} timeout`, { host, ms: Date.now() - t0, attempt });
        throw new Error(`${what} timeout：${(TIMEOUTS[what] || 90000) / 1000}s 无响应`);
      }
      log('llm', `${what} network error`, { host, error: String(e.message || e).slice(0, 200) });
      throw e;
    }
    if (res.ok) {
      log('llm', `${what} ok`, { host, ms: Date.now() - t0, attempt });
      return res;
    }
    const is429 = res.status === 429;
    const maxAttempts = is429 ? 5 : retries;
    if ((is429 || res.status >= 500) && attempt < maxAttempts) {
      const ra = parseInt(res.headers.get('retry-after') || '', 10);
      const backoff = is429 ? 3000 * 2 ** attempt + Math.floor(Math.random() * 1500) : 2000 * 2 ** attempt;
      const waitMs = Number.isFinite(ra) ? Math.min(ra * 1000, 30000) : Math.min(backoff, 30000);
      log('llm', `${what} HTTP ${res.status}, retrying`, { host, attempt, waitMs });
      await sleep(waitMs);
      continue;
    }
    log('llm', `${what} HTTP ${res.status}, giving up`, { host, ms: Date.now() - t0, attempt });
    await raise(res, what); // 不可重试或重试耗尽
  }
}

// 同主机请求串行化 + 最小间隔：免费端点（如 Pollinations 单 IP 队列上限 1）背靠背连发必 429
const hostChains = new Map();
function hostGap(host) {
  return host.includes('pollinations') ? 3000 : 300; // 匿名免费通道队列极小，间隔放宽
}
function throttled(provider, fn) {
  const host = ((provider.baseUrl || '').split('/')[2] || 'local').toLowerCase();
  const prev = hostChains.get(host) || Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    const result = await fn();
    await sleep(hostGap(host)); // 给服务端释放队列槽位的时间
    return result;
  });
  hostChains.set(host, run);
  return run;
}

function aggregateSseChatCompletion(payload) {
  const text = String(payload || '').trim();
  if (!text) throw new Error('WorkBuddy returned an empty streaming response.');
  const events = text.split(/\r?\n/).map((line) => line.replace(/^data:\s*/, '').trim()).filter((line) => line && line !== '[DONE]');
  const final = { choices: [{ message: { role: 'assistant', content: '', tool_calls: [] }, finish_reason: 'stop' }], usage: {} };
  const calls = new Map();
  let parsed = false;
  for (const event of events) {
    let chunk;
    try { chunk = JSON.parse(event); } catch { continue; }
    parsed = true;
    if (chunk.error) throw new Error(String(chunk.error.message || chunk.error));
    if (chunk.usage) final.usage = chunk.usage;
    for (const choice of Array.isArray(chunk.choices) ? chunk.choices : []) {
      const message = choice.message || choice.delta || {};
      if (typeof message.content === 'string') final.choices[0].message.content += message.content;
      for (const [position, item] of (Array.isArray(message.tool_calls) ? message.tool_calls : []).entries()) {
        const index = Number.isInteger(item.index) ? item.index : position;
        const call = calls.get(index) || { id: item.id || `call_${index + 1}`, type: 'function', function: { name: '', arguments: '' } };
        if (item.id) call.id = item.id;
        if (item.function?.name) call.function.name += item.function.name;
        if (item.function?.arguments) call.function.arguments += item.function.arguments;
        calls.set(index, call);
      }
      if (choice.finish_reason) final.choices[0].finish_reason = choice.finish_reason;
    }
  }
  if (!parsed) throw new Error('WorkBuddy returned an invalid streaming response.');
  final.choices[0].message.tool_calls = [...calls.values()];
  return final;
}

async function chatCompletion(provider, messages, options = {}) {
  if (provider?.protocol === 'trae') return require('./trae').chatCompletion(provider, messages, options);
  provider = await require('./providerOAuth').resolveProviderRecord(provider);
  if (adapters.protocolOf(provider) === adapters.PROTOCOLS.OPENAI_COMPATIBLE && provider.responseMode !== 'manual') {
    return throttled(provider, () => compatibleChatCompletion(provider, messages, options));
  }
  const body = adapters.buildChatRequest(provider, messages, options);
  if (provider.streamResponse === true) body.stream = true;
  const res = await throttled(provider, () =>
    fetchWithRetry(
      adapters.endpointFor(provider, 'chat'),
      {
        method: 'POST',
        headers: adapters.requestHeaders(provider, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      },
      'chat'
    )
  );
  const data = provider.streamResponse === true ? aggregateSseChatCompletion(await res.text()) : await res.json();
  const completion = adapters.parseChatResponse(provider, data);
  if (!completion.text && !completion.toolCalls.length) throw new Error('chat 返回缺少文本或工具调用');
  return {
    ...completion,
    provider: {
      name: provider.name || provider.baseUrl,
      model: provider.model,
      protocol: adapters.protocolOf(provider),
    },
  };
}

function compatibleModules() {
  compatibleSdkPromise ||= Promise.all([import('ai'), import('@ai-sdk/openai-compatible')]);
  return compatibleSdkPromise;
}

function compatibleMessages(messages) {
  const output = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      output.push({ role: 'user', content: String(message.content || '') });
      continue;
    }
    if (message.role === 'assistant') {
      if (!Array.isArray(message.toolCalls) || !message.toolCalls.length) {
        output.push({ role: 'assistant', content: String(message.content || '') });
        continue;
      }
      const content = [];
      if (message.content) content.push({ type: 'text', text: String(message.content) });
      for (const call of message.toolCalls) {
        content.push({ type: 'tool-call', toolCallId: call.id, toolName: call.name, input: call.arguments || {} });
      }
      output.push({ role: 'assistant', content });
      continue;
    }
    output.push({
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: message.toolCallId,
        toolName: message.name || 'tool',
        output: { type: 'text', value: String(message.content || '') },
      }],
    });
  }
  return output;
}

function compatibleKeys(provider) {
  const keys = Array.isArray(provider.apiKeys)
    ? provider.apiKeys.map((key) => String(key).trim()).filter(Boolean)
    : String(provider.apiKey || '').split(/\r?\n/).map((key) => key.trim()).filter(Boolean);
  return keys.length ? keys : [''];
}

async function compatibleChatCompletion(provider, messages, options = {}) {
  const [{ generateText, jsonSchema, tool }, { createOpenAICompatible }] = await compatibleModules();
  const keys = compatibleKeys(provider);
  const cursorKey = provider.id || provider.name || provider.baseUrl;
  const start = compatibleKeyCursors.get(cursorKey) || 0;
  compatibleKeyCursors.set(cursorKey, (start + 1) % keys.length);
  const candidates = [...keys.slice(start), ...keys.slice(0, start)];
  let failure;
  for (const apiKey of candidates) {
    try {
      const customAuth = provider.authHeader && String(provider.authHeader).toLowerCase() !== 'authorization';
      const customHeaders = adapters.requestHeaders({ ...provider, apiKey, apiKeys: [] });
      const requestUrl = adapters.endpointFor(provider, 'chat');
      const sdk = createOpenAICompatible({
        name: String(provider.name || 'epilogue-compatible').replace(/[^a-z0-9_-]/gi, '-').toLowerCase(),
        baseURL: String(provider.baseUrl || '').replace(/\/+$/, ''),
        ...(apiKey && !customAuth ? { apiKey } : {}),
        headers: customHeaders,
        fetch: async (input, init = {}) => {
          const headers = new Headers(init.headers);
          for (const [key, value] of Object.entries(customHeaders)) headers.set(key, value);
          if (apiKey && provider.authHeader) headers.set(provider.authHeader, `${provider.authPrefix ?? 'Bearer '}${apiKey}`);
          let body = init.body;
          if (typeof body === 'string' && body.trim() && provider.body) {
            body = JSON.stringify(adapters.mergeBody(JSON.parse(body), provider.body));
          }
          const incoming = String(input);
          const defaultUrl = adapters.joinEndpointUrl(provider.baseUrl, '/chat/completions');
          return fetch(incoming === defaultUrl ? requestUrl : input, { ...init, headers, body });
        },
      });
      const definitions = Object.fromEntries((options.tools || []).map((definition) => [definition.name, tool({
        description: definition.description,
        inputSchema: jsonSchema(definition.parameters || { type: 'object', properties: {} }),
      })]));
      const system = messages.filter((message) => message.role === 'system').map((message) => String(message.content || '')).filter(Boolean).join('\n\n');
      const result = await generateText({
        model: sdk.languageModel(provider.model),
        ...(system ? { system } : {}),
        messages: compatibleMessages(messages),
        ...(Object.keys(definitions).length ? { tools: definitions } : {}),
        ...(options.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
        ...(Number.isFinite(options.temperature) ? { temperature: options.temperature } : {}),
        ...(options.signal ? { abortSignal: options.signal } : {}),
        maxRetries: 0,
      });
      const inputTokens = Number(result.usage?.inputTokens || 0);
      const outputTokens = Number(result.usage?.outputTokens || 0);
      const toolCalls = (result.toolCalls || []).map((call, index) => ({
        id: String(call.toolCallId || call.id || `call_${index + 1}`),
        name: String(call.toolName || call.name || ''),
        arguments: call.input && typeof call.input === 'object' ? call.input : {},
      })).filter((call) => call.name);
      return {
        text: result.text || '',
        toolCalls,
        finishReason: result.finishReason || (toolCalls.length ? 'tool_calls' : 'stop'),
        usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
        provider: { name: provider.name || provider.baseUrl, model: provider.model, protocol: adapters.protocolOf(provider) },
      };
    } catch (error) {
      failure = error;
      if (options.signal?.aborted) break;
    }
  }
  throw failure || new Error('Compatible provider request failed');
}

async function chat(provider, messages, options = {}) {
  const completion = await chatCompletion(provider, messages, options);
  return completion.text;
}

// 从模型输出中提取 JSON（容忍 ```json 围栏与前后杂文）
function parseJsonLoose(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`无法从模型输出解析 JSON: ${text.slice(0, 200)}`);
  return JSON.parse(candidate.slice(start, end + 1));
}

async function chatJson(provider, messages, opts = {}) {
  // response_format 并非所有 OpenAI-compatible 服务都支持，失败时退回普通模式。
  // 但超时/429 是基础设施错误而非格式不支持 —— 回退只会对同一挂起/拥挤服务商白等双倍时间，直接上抛让灾备链切换。
  let text;
  try {
    text = await chat(provider, messages, { ...opts, json: true });
  } catch (e) {
    if (/timeout|HTTP 429/.test(e.message || '')) throw e;
    text = await chat(provider, messages, { ...opts, json: false });
  }
  return parseJsonLoose(text);
}

function embeddingsConfigured(providers) {
  const list = Array.isArray(providers) ? providers : [providers];
  return list.some((p) => p?.type === 'local' || (usable(p) && p.apiKey && !(p.baseUrl || '').includes('openrouter.ai')));
}

async function embed(provider, texts) {
  const res = await throttled(provider, () =>
    fetchWithRetry(
      apiUrl(provider, '/embeddings'),
      {
        method: 'POST',
        headers: headers(provider, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ model: provider.model, input: texts }),
      },
      'embeddings'
    )
  );
  const data = await res.json();
  return data.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

async function transcribe(provider, filePath) {
  const form = new FormData();
  const buf = fs.readFileSync(filePath);
  form.append('file', new Blob([buf]), path.basename(filePath));
  form.append('model', provider.model);
  const res = await throttled(provider, () =>
    fetchWithRetry(apiUrl(provider, '/audio/transcriptions'), { method: 'POST', headers: headers(provider), body: form }, 'transcription')
  );
  const data = await res.json();
  return data.text || '';
}

async function listModels(provider) {
  provider = await require('./providerOAuth').resolveProviderRecord(provider);
  if (Array.isArray(provider.models) && provider.models.length) return provider.models;
  const res = await fetchWithRetry(
    adapters.endpointFor(provider, 'models'),
    { headers: adapters.requestHeaders(provider) },
    'list models',
    1
  );
  const data = await res.json();
  return adapters.parseModelsResponse(data);
}

// 连通性测试：单次请求、短超时、不重试不节流（一次定生死，且不排同主机节流队列）
const TEST_TIMEOUT = 15000;
async function testProvider(type, provider) {
  provider = await require('./providerOAuth').resolveProviderRecord(provider);
  const t0 = Date.now();
  const post = async (endpoint, body, check) => {
    let res;
    try {
      res = await fetch(apiUrl(provider, endpoint), {
        method: 'POST',
        headers: headers(provider, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TEST_TIMEOUT),
      });
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new Error(`test timeout：${TEST_TIMEOUT / 1000}s 无响应`);
      throw e;
    }
    if (!res.ok) await raise(res, 'test');
    const data = await res.json();
    if (!check(data)) throw new Error('返回格式异常（非 OpenAI-compatible 响应）');
  };
  if (type === 'chat') {
    const testBody = adapters.buildChatRequest(provider, [{ role: 'user', content: 'Reply with exactly: OK' }], { maxTokens: 8, temperature: 0 });
    if (provider.streamResponse === true) testBody.stream = true;
    let res;
    try {
      res = await fetch(adapters.endpointFor(provider, 'chat'), {
        method: 'POST',
        headers: adapters.requestHeaders(provider, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(testBody),
        signal: AbortSignal.timeout(TEST_TIMEOUT),
      });
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new Error(`test timeout：${TEST_TIMEOUT / 1000}s 无响应`);
      throw e;
    }
    if (!res.ok) await raise(res, 'test');
    const completion = adapters.parseChatResponse(provider, provider.streamResponse === true ? aggregateSseChatCompletion(await res.text()) : await res.json());
    if (!completion.text && !completion.toolCalls.length) throw new Error('返回格式异常（模型协议响应为空）');
  } else if (type === 'embeddings') {
    await post('/embeddings', { model: provider.model, input: ['ping'] }, (d) => Array.isArray(d.data?.[0]?.embedding));
  } else {
    throw new Error('该类型不支持快速测试');
  }
  return { ok: true, ms: Date.now() - t0 };
}

// 数组灾备版入口
const chatF = (providers, messages, opts) => withFailover(providers, (p) => chat(p, messages, opts));
const chatCompletionF = (providers, messages, opts) => withFailover(providers, (p) => chatCompletion(p, messages, opts));
const chatJsonF = (providers, messages, opts) => withFailover(providers, (p) => chatJson(p, messages, opts));
const embedF = (providers, texts) =>
  withFailover(
    (Array.isArray(providers) ? providers : [providers]).filter(
      (p) => p.type === 'local' || (p.apiKey && !(p.baseUrl || '').includes('openrouter.ai'))
    ),
    (p) => {
      if (p.type === 'local') {
        const localModels = require('./localModels'); // 懒加载：本机 BGE，离线免费
        return localModels.embed(texts, p.model);
      }
      return embed(p, texts);
    }
  );
const transcribeF = (providers, filePath) => withFailover(providers, (p) => transcribe(p, filePath));

module.exports = {
  chat, chatCompletion, chatJson, embed, transcribe, listModels,
  chatF, chatCompletionF, chatJsonF, embedF, transcribeF,
  usable, routeAllowed, withFailover, routeCandidates, errorForRouter, embeddingsConfigured, parseJsonLoose, localOnlyFilter, testProvider,
  TIMEOUTS, adapters, aggregateSseChatCompletion, // 导出供测试覆盖
};
