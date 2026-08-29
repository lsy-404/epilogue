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

test('OAuth presets create official Claude and Codex provider records', () => {
  const claude = oauth.oauthProviderSettings('anthropic');
  assert.equal(claude.protocol, 'anthropic-messages');
  assert.equal(claude.authHeader, 'Authorization');
  assert.equal(claude.headers['anthropic-beta'], 'oauth-2025-04-20');

  const codex = oauth.oauthProviderSettings('openai-codex');
  assert.equal(codex.protocol, 'openai-responses');
  assert.equal(codex.baseUrl, 'https://chatgpt.com/backend-api/codex');
  assert.equal(codex.body.store, false);
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
