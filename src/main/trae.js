'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function metadata(credential, id = `oauth:trae:${credential.accountId || crypto.randomUUID()}`) { return { id, label: credential.label || 'TRAE account', accountId: credential.accountId || null, expires: credential.expires, host: credential.host, region: credential.region || null }; }
class TraeCredentialStore {
  constructor({ app, safeStorage, shell, fsImpl = fs, fetchImpl = fetch }) { this.app = app; this.safeStorage = safeStorage; this.shell = shell; this.fs = fsImpl; this.fetch = fetchImpl; }
  filePath() { return path.join(this.app.getPath('userData'), 'trae-oauth-accounts.json'); }
  assertEncryption() { if (!this.safeStorage?.isEncryptionAvailable?.()) throw new Error('System credential encryption is unavailable; TRAE credentials were not saved.'); }
  records() { try { const value = JSON.parse(this.fs.readFileSync(this.filePath(), 'utf8')); return Array.isArray(value.accounts) ? value.accounts.filter((item) => item.id && item.encrypted) : []; } catch { return []; } }
  write(accounts) { this.assertEncryption(); const target = this.filePath(); this.fs.mkdirSync(path.dirname(target), { recursive: true }); const temp = `${target}.tmp`; this.fs.writeFileSync(temp, JSON.stringify({ version: 1, accounts }), 'utf8'); this.fs.renameSync(temp, target); }
  decrypt(record) { this.assertEncryption(); return JSON.parse(this.safeStorage.decryptString(Buffer.from(record.encrypted, 'base64'))); }
  save(credential, id) { this.assertEncryption(); const item = metadata(credential, id); const next = { ...item, encrypted: this.safeStorage.encryptString(JSON.stringify(credential)).toString('base64') }; const records = this.records(); const index = records.findIndex((record) => record.id === item.id); if (index >= 0) records[index] = next; else records.push(next); this.write(records); return metadata(credential, item.id); }
  list() { return this.records().map(({ encrypted, ...item }) => item); }
  remove(id) { const records = this.records(); const next = records.filter((record) => record.id !== id); if (next.length === records.length) return false; this.write(next); return true; }
  async authorize({ signal } = {}) { const api = await import('@model-auth/providers/trae'); const credential = await api.authorizeTrae({ openExternal: (url) => this.shell.openExternal(url), fetchImpl: this.fetch, signal }); return this.save(credential); }
  async credentialFor(id, { signal } = {}) { const record = this.records().find((item) => item.id === id); if (!record) throw new Error('TRAE account was not found.'); let credential = this.decrypt(record); if (Number(credential.expires) <= Date.now() + 60_000) { const api = await import('@model-auth/providers/trae'); credential = await api.refreshTrae(credential, { fetchImpl: this.fetch, signal }); this.save(credential, record.id); } return credential; }
  async status(id, options = {}) { try { const api = await import('@model-auth/providers/trae'); return await api.traeStatus(await this.credentialFor(id, options), { fetchImpl: this.fetch, signal: options.signal }); } catch (error) { return { authenticated: false, detail: 'unauthenticated', error: String(error?.message || error) }; } }
}
let singleton;
function store() { if (!singleton) { const { app, safeStorage, shell } = require('electron'); singleton = new TraeCredentialStore({ app, safeStorage, shell }); } return singleton; }
function promptFor(messages) { if (!Array.isArray(messages) || messages.some((message) => !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string')) throw new Error('TRAE browser OAuth supports text system, user, and assistant messages only; tool history is unsupported.'); return messages; }
async function models(id, options = {}) { const credential = await store().credentialFor(id, options); const api = await import('@model-auth/providers/trae'); return api.listTraeModels(credential, { fetchImpl: store().fetch, signal: options.signal }); }
async function chatCompletion(record, messages, options = {}) { if (options.tools?.length) throw new Error('TRAE browser OAuth currently supports text-only completion; tool definitions are unsupported.'); const textMessages = promptFor(messages); const credential = await store().credentialFor(record.credentialId, options); const api = await import('@model-auth/providers/trae'); const result = await api.completeTrae(credential, { model: record.model, messages: textMessages, fetchImpl: store().fetch, signal: options.signal }); return { text: result.text, reasoning: result.reasoning, finishReason: result.finishReason, usage: result.usage, provider: { name: record.name || 'TRAE', model: record.model, protocol: 'trae' } }; }
module.exports = { TraeCredentialStore, metadata, store, models, chatCompletion, promptFor };
