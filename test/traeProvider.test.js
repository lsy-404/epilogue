'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const trae = require('../src/main/trae');
function fixtureStore() {
  const files = new Map();
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => Buffer.from(value).toString() };
  const fs = { readFileSync: (file) => { if (!files.has(file)) throw new Error('missing'); return files.get(file); }, writeFileSync: (file, value) => files.set(file, value), renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); }, mkdirSync: () => {} };
  return { store: new trae.TraeCredentialStore({ app: { getPath: () => '/profile' }, safeStorage, shell: { openExternal: async () => {} }, fsImpl: fs }), files };
}
test('TRAE stores the full browser credential encrypted while exposing sanitized metadata', () => {
  const { store, files } = fixtureStore();
  const account = store.save({ access: 'access-secret', refresh: 'refresh-secret', expires: Date.now() + 3600000, host: 'https://www.trae.ai', device: { privateKeyPem: 'private-secret' }, accountId: 'person' });
  assert.deepEqual(Object.keys(account).sort(), ['accountId', 'expires', 'host', 'id', 'label', 'region']);
  assert.doesNotMatch(files.get('/profile/trae-oauth-accounts.json'), /access-secret|refresh-secret|private-secret/);
  assert.equal(store.remove(account.id), true);
});
test('TRAE refuses tool definitions and tool history rather than dropping them', async () => {
  await assert.rejects(() => trae.chatCompletion({ credentialId: 'x', model: 'm' }, [{ role: 'tool', content: 'result' }]), /tool history/);
  await assert.rejects(() => trae.chatCompletion({ credentialId: 'x', model: 'm' }, [{ role: 'user', content: 'hello' }], { tools: [{ name: 'read' }] }), /text-only/);
});
