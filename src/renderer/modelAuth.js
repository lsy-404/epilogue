import { registerModelAuthElement } from '../../node_modules/@model-auth/vue/dist/model-auth-element.js';

registerModelAuthElement();
const dialog = document.querySelector('model-auth-dialog');
const openButton = document.querySelector('#modelAuthOpen');
let activeOperation = null;

async function refresh() {
  const state = await window.epologue.modelAuthState();
  Object.assign(dialog, { providers: state.providers, model: state.model, catalogStatus: state.catalogStatus, theme: 'system' });
}
function actionFor(event) {
  const detail = Array.isArray(event.detail) ? event.detail : [event.detail];
  if (event.type === 'authorize-oauth') return { type: event.type, providerId: detail[0], ...(detail[1] ? { credentialId: detail[1] } : {}) };
  if (event.type === 'add-api-key' || event.type === 'update-credential' || event.type === 'update-provider' || event.type === 'select-model' || event.type === 'update-provider-strategy') return { type: event.type, payload: detail[0] };
  if (event.type === 'remove-credential') return { type: event.type, ...detail[0] };
  return { type: event.type };
}
async function perform(event) {
  const operationId = crypto.randomUUID();
  activeOperation = operationId;
  dialog.busy = true;
  try { await window.epologue.modelAuthExecute(actionFor(event), operationId); await refresh(); }
  catch { dialog.error = 'Operation could not be completed. Check the provider configuration and try again.'; }
  finally { if (activeOperation === operationId) activeOperation = null; dialog.busy = false; }
}
async function open() { dialog.open = true; dialog.error = null; await refresh(); }
window.openModelAuth = open;
openButton?.addEventListener('click', open);
dialog.addEventListener('close', () => {
  if (activeOperation) void window.epologue.modelAuthCancel(activeOperation);
  dialog.open = false;
});
for (const type of ['authorize-oauth', 'add-api-key', 'remove-credential', 'update-credential', 'update-provider', 'select-model', 'update-provider-strategy', 'refresh-catalog']) dialog.addEventListener(type, perform);
dialog.addEventListener('reconnect-oauth', (event) => perform(new CustomEvent('authorize-oauth', { detail: event.detail })));
dialog.addEventListener('remove-oauth', (event) => {
  const [providerId, credentialId] = Array.isArray(event.detail) ? event.detail : [];
  perform(new CustomEvent('remove-credential', { detail: [{ providerId, credentialId, authMethod: 'oauth' }] }));
});
dialog.addEventListener('remove-api-key', (event) => {
  const [providerId, credentialId] = Array.isArray(event.detail) ? event.detail : [];
  perform(new CustomEvent('remove-credential', { detail: [{ providerId, credentialId, authMethod: 'api-key' }] }));
});
