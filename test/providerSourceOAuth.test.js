'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const catalog = require('../src/main/providerCatalog');
const oauth = require('../src/main/providerOAuth');

test('Provider Source catalog exposes supported OpenCode entries and disables unbundled SDKs', () => {
  const providers = catalog.parseCatalog({
    compatible: {
      name: 'Compatible Cloud', npm: '@ai-sdk/openai-compatible', api: 'https://example.test/v1', env: ['EXAMPLE_API_KEY'],
      models: { alpha: { name: 'Alpha' }, beta: {} },
    },
    anthropic: {
      name: 'Anthropic', npm: '@ai-sdk/anthropic', api: 'https://api.anthropic.com/v1', env: ['ANTHROPIC_API_KEY'],
      models: { claude: {} },
    },
    future: { name: 'Future', npm: '@future/ai-provider', api: 'https://future.test/v1', models: { next: {} } },
  });
  assert.deepEqual(providers.map((provider) => [provider.id, provider.available]), [
    ['anthropic', true], ['compatible', true], ['future', false],
  ]);
  assert.equal(providers.find((provider) => provider.id === 'anthropic').protocol, 'anthropic-messages');

  const preset = catalog.providerSettingsFromSource(providers.find((provider) => provider.id === 'compatible'), 'source-test');
  assert.equal(preset.protocol, 'openai-compatible');
  assert.equal(preset.baseUrl, 'https://example.test/v1');
  assert.equal(preset.model, 'alpha');
  assert.deepEqual(preset.source.env, ['EXAMPLE_API_KEY']);
});

test('OAuth presets create official Claude and Codex provider records', async () => {
  const claude = await oauth.oauthProviderSettings('anthropic');
  assert.equal(claude.protocol, 'anthropic-messages');
  assert.equal(claude.authHeader, 'Authorization');
  assert.equal(claude.headers['anthropic-beta'], 'oauth-2025-04-20');

  const codex = await oauth.oauthProviderSettings('openai-codex');
  assert.equal(codex.protocol, 'openai-responses');
  assert.equal(codex.baseUrl, 'https://chatgpt.com/backend-api/codex');
  assert.equal(codex.body.store, false);

  const workbuddy = await oauth.oauthProviderSettings('workbuddy');
  assert.equal(workbuddy.protocol, 'openai-completions');
  assert.equal(workbuddy.streamResponse, true);
  assert.equal(workbuddy.requestPath, '/chat/completions');
  assert.equal(workbuddy.headers['x-product'], 'SaaS');
});

test('WorkBuddy native models remain an explicit bounded capability list', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/modelAuth.js'), 'utf8');
  assert.match(source, /WORKBUDDY_RUNTIME_MODELS/);
  assert.match(source, /WORKBUDDY_CATALOG_PROVIDERS/);
  assert.match(source, /WORKBUDDY_RUNTIME_MODELS\.has\(id\)/);
});

test('WorkBuddy browser login polls for a renewable account credential', async () => {
  const requests = [];
  let poll = 0;
  const credential = await oauth.authorizeInBrowser('workbuddy', {
    signal: new AbortController().signal,
    openExternal: async (url) => assert.equal(url, 'https://copilot.tencent.com/login?state=state-1&platform=workbuddy'),
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), headers: Object.fromEntries(new Headers(options.headers).entries()) });
      if (String(url).includes('/auth/state')) return new Response(JSON.stringify({ code: 0, data: { state: 'state-1', authUrl: 'https://copilot.tencent.com/login?state=state-1&platform=workbuddy' } }));
      if (String(url).includes('/auth/token')) {
        poll += 1;
        return new Response(JSON.stringify({ code: 0, data: { accessToken: 'access', refreshToken: 'refresh', expiresIn: 3600, domain: 'tenant' } }));
      }
      return new Response(JSON.stringify({ code: 0, data: { uid: 'user-1', nickname: 'Rosmontis', enterpriseId: 'team-1' } }));
    },
  });
  assert.equal(credential.access, 'access');
  assert.equal(credential.refresh, 'refresh');
  assert.equal(credential.accountId, 'user-1');
  assert.equal(credential.enterpriseId, 'team-1');
  assert.equal(requests[0].headers.origin, 'https://www.codebuddy.cn');
});

test('WorkBuddy token refresh keeps account routing metadata', async () => {
  let captured;
  const refreshed = await oauth.refreshWorkBuddy({
    access: 'old-access', refresh: 'old-refresh', expires: 1, domain: 'tenant', enterpriseId: 'team-1', userId: 'user-1',
  }, async (_url, options) => {
    captured = Object.fromEntries(new Headers(options.headers).entries());
    return new Response(JSON.stringify({ code: 0, data: { accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 3600 } }));
  });
  assert.equal(refreshed.access, 'new-access');
  assert.equal(refreshed.userId, 'user-1');
  assert.equal(captured['x-refresh-token'], 'old-refresh');
  assert.equal(captured['x-enterprise-id'], 'team-1');
});

test('OAuth credential store encrypts tokens and returns only redacted account metadata', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'epilogue-oauth-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from([...Buffer.from(value)].map((byte) => byte ^ 0x5a)),
    decryptString: (value) => Buffer.from([...value].map((byte) => byte ^ 0x5a)).toString('utf8'),
  };
  const store = new oauth.OAuthCredentialStore({
    app: { getPath: () => temp }, safeStorage, shell: { openExternal() {} }, now: () => 1000,
  });
  const saved = store.upsert('openai-codex', {
    access: 'access-secret', refresh: 'refresh-secret', expires: 1000 + 3_600_000, accountId: 'account-1',
  });
  assert.equal(saved.id, 'oauth:openai-codex:account-1');
  const disk = fs.readFileSync(path.join(temp, 'oauth-accounts.json'), 'utf8');
  assert.doesNotMatch(disk, /access-secret|refresh-secret/);
  const accounts = store.list('openai-codex');
  assert.equal(accounts.length, 1);
  assert.equal('encrypted' in accounts[0], false);
  assert.equal('access' in accounts[0], false);
  assert.equal((await store.credentialFor('openai-codex')).access, 'access-secret');
  assert.equal(store.remove('openai-codex', saved.id), true);
  assert.deepEqual(store.list('openai-codex'), []);
});

test('Codex OAuth JWT account id is extracted without exposing the token', () => {
  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: 'workspace-42' },
  })).toString('base64url');
  assert.equal(oauth.tokenAccountId(`header.${payload}.signature`), 'workspace-42');
  assert.equal(oauth.tokenAccountId('malformed'), undefined);
});
