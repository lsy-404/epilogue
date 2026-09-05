'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const CONFIGS = Object.freeze({
  anthropic: {
    authorizeUrl: 'https://claude.ai/oauth/authorize',
    tokenUrl: 'https://platform.claude.com/v1/oauth/token',
    clientId: Buffer.from('OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl', 'base64').toString('utf8'),
    redirectUri: 'http://localhost:53692/callback',
    callbackPath: '/callback',
    scope: 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
    extraAuthorize: { code: 'true' },
  },
  'openai-codex': {
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    clientId: Buffer.from('YXBwX0VNb2FtRUVaNzNmMENrWGFYcDdocmFubg==', 'base64').toString('utf8'),
    redirectUri: 'http://localhost:1455/auth/callback',
    callbackPath: '/auth/callback',
    scope: 'openid profile email offline_access',
    extraAuthorize: { id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: 'pi' },
  },
  workbuddy: {
    apiBase: 'https://copilot.tencent.com/v2/plugin',
    chatBase: 'https://copilot.tencent.com/v2',
    origin: 'https://www.codebuddy.cn',
    platform: 'workbuddy',
  },
});

const cursors = new Map();
let singleton = null;

function workBuddyProtocol() { return import('@model-auth/providers/workbuddy'); }

function knownProvider(provider) {
  if (!CONFIGS[provider]) throw new Error('Unknown OAuth provider.');
  return provider;
}

function tokenAccountId(access) {
  try {
    const payload = JSON.parse(Buffer.from(String(access).split('.')[1] || '', 'base64url').toString('utf8'));
    const accountId = payload?.['https://api.openai.com/auth']?.chatgpt_account_id;
    return typeof accountId === 'string' && accountId.trim() ? accountId.trim() : undefined;
  } catch {
    return undefined;
  }
}

function callbackPage(ok) {
  const title = ok ? 'Authorization complete' : 'Authorization failed';
  const body = ok ? 'You can close this window and return to Epilogue.' : 'Return to Epilogue and try again.';
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font:16px system-ui;margin:48px;color:#181818}h1{font-size:24px}</style><h1>${title}</h1><p>${body}</p>`;
}

function workBuddyHeaders(config, extra = {}) {
  return {
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    origin: config.origin,
    referer: `${config.origin}/`,
    'user-agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
    ...extra,
  };
}

function workBuddyPayload(payload, { pending = false } = {}) {
  const code = Number(payload?.code);
  if (code === 0 || code === 200) return payload?.data && typeof payload.data === 'object' ? payload.data : {};
  if (pending && code === 11217) return null;
  throw new Error(`WorkBuddy authorization failed${Number.isFinite(code) ? ` (code ${code})` : ''}: ${String(payload?.msg || payload?.message || 'unexpected response')}`);
}

function secondsToExpiry(value, now = Date.now()) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('WorkBuddy returned an invalid token expiry.');
  return now + seconds * 1000 - 5 * 60_000;
}

function workBuddyCredential(data, now = Date.now()) {
  const access = String(data?.accessToken || data?.access_token || '').trim();
  const refresh = String(data?.refreshToken || data?.refresh_token || '').trim();
  if (!access || !refresh) throw new Error('WorkBuddy returned an incomplete renewable credential.');
  return {
    access,
    refresh,
    expires: secondsToExpiry(data?.expiresIn || data?.expires_in, now),
    ...(typeof data?.domain === 'string' && data.domain.trim() ? { domain: data.domain.trim() } : {}),
  };
}

function sessionFetch(fetchImpl) {
  let cookie = '';
  return async (url, options = {}) => {
    const headers = new Headers(options.headers || {});
    if (cookie) headers.set('cookie', cookie);
    const response = await fetchImpl(url, { ...options, headers });
    const setCookies = typeof response.headers?.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers?.get?.('set-cookie')].filter(Boolean);
    const pairs = setCookies.flatMap((entry) => String(entry).split(/,(?=\s*[^;,\s]+=)/)).map((entry) => entry.split(';', 1)[0]).filter(Boolean);
    if (pairs.length) cookie = pairs.join('; ');
    return response;
  };
}

const delay = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(new Error('Browser authorization was cancelled.'));
  }, { once: true });
});

async function workBuddyRequest(fetchImpl, url, options, signal, pending = false) {
  const response = await fetchImpl(url, { ...options, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
  if (!response.ok) throw new Error(`WorkBuddy request failed (${response.status}).`);
  return workBuddyPayload(await response.json(), { pending });
}

async function authorizeWorkBuddy({ fetchImpl = fetch, openExternal, signal = AbortSignal.timeout(10 * 60_000), sleep = delay } = {}) {
  const protocol = await workBuddyProtocol();
  return protocol.authorizeWorkBuddy({ openExternal, fetchImpl, signal });
}

async function refreshWorkBuddy(credential, fetchImpl = fetch) {
  const protocol = await workBuddyProtocol();
  return protocol.refreshWorkBuddy(credential, { fetchImpl });
}

async function startCallbackServer(config, state, signal, httpImpl = http) {
  if (signal.aborted) throw new Error('Browser authorization was cancelled.');
  const port = Number(new URL(config.redirectUri).port);
  return new Promise((resolve, reject) => {
    let listening = false;
    let settled = false;
    let resolveCode;
    let rejectCode;
    const codePromise = new Promise((resolveWait, rejectWait) => { resolveCode = resolveWait; rejectCode = rejectWait; });
    const server = httpImpl.createServer((request, response) => {
      const url = new URL(request.url || '/', config.redirectUri);
      if (url.pathname !== config.callbackPath) return response.writeHead(404).end();
      const code = url.searchParams.get('code');
      const accepted = Boolean(code && url.searchParams.get('state') === state && !url.searchParams.get('error'));
      response.writeHead(accepted ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' }).end(callbackPage(accepted));
      if (settled) return;
      settled = true;
      cleanup();
      if (accepted) resolveCode(code);
      else rejectCode(new Error('Browser authorization callback was rejected.'));
    });
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      if (listening && server.listening) server.close();
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectCode(new Error('Browser authorization was cancelled.'));
    };
    server.once('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (listening) rejectCode(error);
      else reject(error);
    });
    signal.addEventListener('abort', onAbort, { once: true });
    server.listen(port, '127.0.0.1', () => {
      listening = true;
      resolve({ waitForCode: () => codePromise, close: cleanup });
    });
  });
}

async function tokenRequest(provider, form, fetchImpl = fetch, signal = AbortSignal.timeout(30_000)) {
  if (provider === 'workbuddy') return refreshWorkBuddy(form, fetchImpl);
  const config = CONFIGS[knownProvider(provider)];
  const openAI = config.tokenUrl.includes('openai.com');
  const response = await fetchImpl(config.tokenUrl, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': openAI ? 'application/x-www-form-urlencoded' : 'application/json' },
    body: openAI ? new URLSearchParams(form) : JSON.stringify(form),
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  if (!response.ok) throw new Error(`OAuth token exchange failed (${response.status}).`);
  const payload = await response.json();
  const access = typeof payload.access_token === 'string' ? payload.access_token.trim() : '';
  const refresh = typeof payload.refresh_token === 'string' ? payload.refresh_token.trim() : String(form.refresh_token || '').trim();
  const expiresIn = Number(payload.expires_in);
  if (!access || !refresh || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('OAuth token exchange returned an incomplete renewable credential.');
  }
  const accountId = tokenAccountId(access);
  return { access, refresh, expires: Date.now() + expiresIn * 1000 - 5 * 60_000, ...(accountId ? { accountId } : {}) };
}

async function authorizeInBrowser(provider, { fetchImpl = fetch, openExternal, signal = AbortSignal.timeout(10 * 60_000), httpImpl = http, sleep } = {}) {
  if (provider === 'workbuddy') return authorizeWorkBuddy({ fetchImpl, openExternal, signal, ...(sleep ? { sleep } : {}) });
  const config = CONFIGS[knownProvider(provider)];
  if (typeof openExternal !== 'function') throw new Error('OAuth browser opener is unavailable.');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(24).toString('base64url');
  const params = new URLSearchParams({
    response_type: 'code', client_id: config.clientId, redirect_uri: config.redirectUri, scope: config.scope,
    code_challenge: challenge, code_challenge_method: 'S256', state, ...config.extraAuthorize,
  });
  const callback = await startCallbackServer(config, state, signal, httpImpl);
  try {
    await openExternal(`${config.authorizeUrl}?${params}`);
    const code = await callback.waitForCode();
    const form = { grant_type: 'authorization_code', client_id: config.clientId, code, code_verifier: verifier, redirect_uri: config.redirectUri };
    if (provider === 'anthropic') form.state = state;
    return await tokenRequest(provider, form, fetchImpl, signal);
  } finally {
    callback.close();
  }
}

class OAuthCredentialStore {
  constructor({ app, safeStorage, shell, fsImpl = fs, fetchImpl = fetch, now = () => Date.now() }) {
    this.app = app;
    this.safeStorage = safeStorage;
    this.shell = shell;
    this.fs = fsImpl;
    this.fetch = fetchImpl;
    this.now = now;
  }

  filePath() { return path.join(this.app.getPath('userData'), 'oauth-accounts.json'); }

  assertEncryption() {
    if (!this.safeStorage?.isEncryptionAvailable?.()) throw new Error('System credential encryption is unavailable; OAuth tokens were not saved.');
  }

  readRecords() {
    try {
      const parsed = JSON.parse(this.fs.readFileSync(this.filePath(), 'utf8'));
      return Array.isArray(parsed.accounts) ? parsed.accounts.filter((account) => CONFIGS[account.provider] && account.id && account.encrypted) : [];
    } catch {
      return [];
    }
  }

  writeRecords(accounts) {
    this.assertEncryption();
    const target = this.filePath();
    this.fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.tmp`;
    this.fs.writeFileSync(temp, JSON.stringify({ version: 1, accounts }, null, 2), 'utf8');
    this.fs.renameSync(temp, target);
  }

  encryptCredential(credential) {
    this.assertEncryption();
    return this.safeStorage.encryptString(JSON.stringify(credential)).toString('base64');
  }

  decryptCredential(record) {
    this.assertEncryption();
    return JSON.parse(this.safeStorage.decryptString(Buffer.from(record.encrypted, 'base64')));
  }

  list(provider) {
    const records = this.readRecords().filter((record) => !provider || record.provider === provider);
    return records.map(({ encrypted, ...record }) => ({ ...record, connected: true }));
  }

  upsert(provider, credential) {
    knownProvider(provider);
    if (provider === 'workbuddy' && !credential.label) credential = { ...credential, label: 'WorkBuddy account' };
    const records = this.readRecords();
    const accountKey = credential.accountId || crypto.randomUUID();
    const id = `oauth:${provider}:${accountKey}`;
    const next = {
      id,
      provider,
      accountId: credential.accountId || accountKey,
      label: credential.label || 'Official account',
      expires: credential.expires,
      createdAt: this.now(),
      encrypted: this.encryptCredential({ ...credential, accountId: credential.accountId || accountKey }),
    };
    const index = records.findIndex((record) => record.id === id);
    if (index >= 0) records[index] = next;
    else records.push(next);
    this.writeRecords(records);
    return { ...next, encrypted: undefined };
  }

  remove(provider, id) {
    knownProvider(provider);
    const records = this.readRecords();
    const next = records.filter((record) => !(record.provider === provider && record.id === id));
    if (next.length === records.length) return false;
    this.writeRecords(next);
    return true;
  }

  async authorize(provider, { signal } = {}) {
    const credential = await authorizeInBrowser(provider, {
      fetchImpl: this.fetch,
      openExternal: (url) => this.shell.openExternal(url),
      signal,
    });
    return this.upsert(provider, credential);
  }

  async refresh(provider, record, credential) {
    const config = CONFIGS[provider];
    const next = provider === 'workbuddy'
      ? await refreshWorkBuddy(credential, this.fetch)
      : await tokenRequest(provider, { grant_type: 'refresh_token', client_id: config.clientId, refresh_token: credential.refresh }, this.fetch);
    const records = this.readRecords();
    const index = records.findIndex((item) => item.id === record.id);
    if (index < 0) throw new Error('OAuth account was removed while refreshing.');
    const updated = {
      ...records[index], accountId: next.accountId || record.accountId, expires: next.expires,
      encrypted: this.encryptCredential({ ...next, accountId: next.accountId || record.accountId }),
    };
    records[index] = updated;
    this.writeRecords(records);
    return this.decryptCredential(updated);
  }

  async credentialFor(provider, accountId) {
    knownProvider(provider);
    const records = this.readRecords().filter((record) => record.provider === provider);
    if (!records.length) throw new Error('No OAuth account is connected for this provider.');
    let record = accountId ? records.find((candidate) => candidate.id === accountId || candidate.accountId === accountId) : undefined;
    if (!record) {
      const cursor = cursors.get(provider) || 0;
      record = records[cursor % records.length];
      cursors.set(provider, (cursor + 1) % records.length);
    }
    let credential = this.decryptCredential(record);
    if (Number(credential.expires) <= this.now() + 60_000) credential = await this.refresh(provider, record, credential);
    return credential;
  }
}

function defaultStore() {
  if (!singleton) {
    const { app, safeStorage, shell } = require('electron');
    singleton = new OAuthCredentialStore({ app, safeStorage, shell });
  }
  return singleton;
}

async function oauthProviderSettings(provider) {
  knownProvider(provider);
  if (provider === 'anthropic') {
    return {
      id: 'oauth-anthropic', name: 'Claude Official OAuth', enabled: true, authType: 'oauth', oauthProvider: provider,
      protocol: 'anthropic-messages', baseUrl: 'https://api.anthropic.com/v1', requestPath: '/messages', modelsPath: '/models',
      authHeader: 'Authorization', authPrefix: 'Bearer ', headers: { 'anthropic-beta': 'oauth-2025-04-20' }, model: 'claude-sonnet-4-6',
    };
  }
  if (provider === 'workbuddy') {
    const { WORKBUDDY_ENDPOINTS } = await workBuddyProtocol();
    return {
      id: 'oauth-workbuddy', name: 'WorkBuddy OAuth', enabled: true, authType: 'oauth', oauthProvider: provider,
      protocol: 'openai-completions', baseUrl: WORKBUDDY_ENDPOINTS.chatBase, requestPath: '/chat/completions',
      authHeader: 'Authorization', authPrefix: 'Bearer ', streamResponse: true, model: 'glm-5.2',
      headers: { 'x-product': 'SaaS' },
      models: ['glm-5.2', 'glm-5.1', 'glm-5v-turbo', 'kimi-k2.7', 'minimax-m3-pay', 'hy3', 'deepseek-v4-pro', 'deepseek-v4-flash'],
    };
  }
  return {
    id: 'oauth-openai-codex', name: 'ChatGPT Codex OAuth', enabled: true, authType: 'oauth', oauthProvider: provider,
    protocol: 'openai-responses', baseUrl: 'https://chatgpt.com/backend-api/codex', requestPath: '/responses', modelsPath: '/models',
    authHeader: 'Authorization', authPrefix: 'Bearer ', headers: { originator: 'pi' }, body: { store: false }, omitTemperature: true, model: 'gpt-5.4',
  };
}

async function resolveProviderRecord(provider) {
  if (!provider?.oauthProvider) return provider;
  const credential = await defaultStore().credentialFor(provider.oauthProvider, provider.oauthAccountId);
  const headers = { ...(provider.headers || {}) };
  if (provider.oauthProvider === 'openai-codex' && credential.accountId) headers['ChatGPT-Account-ID'] = credential.accountId;
  if (provider.oauthProvider === 'workbuddy') {
    Object.assign(headers, (await workBuddyProtocol()).workBuddyHeaders(credential));
  }
  return { ...provider, apiKey: credential.access, apiKeys: [], keyless: true, headers };
}

module.exports = {
  CONFIGS,
  OAuthCredentialStore,
  tokenAccountId,
  tokenRequest,
  startCallbackServer,
  authorizeInBrowser,
  authorizeWorkBuddy,
  refreshWorkBuddy,
  workBuddyCredential,
  oauthProviderSettings,
  resolveProviderRecord,
  listAccounts: (provider) => defaultStore().list(provider),
  authorize: (provider, options) => defaultStore().authorize(provider, options),
  removeAccount: (provider, id) => defaultStore().remove(provider, id),
};
