'use strict';

const crypto = require('crypto');
const path = require('path');
const { app } = require('electron');

function sessionHome(id) {
  if (!/^[a-zA-Z0-9_-]{1,96}$/.test(String(id))) throw new Error('Invalid TRAE session id.');
  return path.join(app.getPath('userData'), 'trae-enterprise', String(id));
}

async function providerFor(session) {
  const { TraeProvider } = await import('@model-auth/providers/trae');
  return new TraeProvider({ session: { homeDir: session.homeDir, ...(session.label ? { label: session.label } : {}), ...(session.host ? { host: session.host } : {}) } });
}

function unavailable(error) {
  return { available: false, authenticated: false, error: String(error?.message || error || 'Trae enterprise CLI is unavailable.') };
}

async function status(session, signal) {
  try { return await (await providerFor(session)).status(signal); } catch (error) { return unavailable(error); }
}

async function login(session, signal) {
  const provider = await providerFor(session);
  await provider.login(signal);
  const result = await provider.status(signal);
  if (!result.available || !result.authenticated) throw new Error('Trae enterprise CLI did not report an authenticated session.');
  return result;
}

async function logout(session, signal) {
  const provider = await providerFor(session);
  if (typeof provider.logout !== 'function') throw new Error('Trae enterprise CLI logout is not available in this adapter release.');
  await provider.logout(signal);
}

function promptFor(messages) {
  return messages.map((message) => `${message.role.toUpperCase()}: ${typeof message.content === 'string' ? message.content : JSON.stringify(message.content || '')}`).join('\n\n');
}

async function chatCompletion(record, messages, options = {}) {
  const provider = await providerFor({ homeDir: record.traeHome, label: record.name, host: record.traeHost });
  const result = await provider.execute({ prompt: promptFor(messages), ...(record.model ? { model: record.model } : {}), ...(record.traeCwd ? { cwd: record.traeCwd } : {}), signal: options.signal });
  if (typeof result?.assistantText !== 'string' || !result.assistantText.trim()) throw new Error('Trae enterprise CLI returned no structured assistant message.');
  return { text: result.assistantText, toolCalls: [], finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, provider: { name: record.name || 'Trae Enterprise CLI', model: record.model || null, protocol: 'trae-cli' } };
}

function newSession() { const id = crypto.randomUUID(); return { id, homeDir: sessionHome(id) }; }

module.exports = { sessionHome, newSession, status, login, logout, chatCompletion };
