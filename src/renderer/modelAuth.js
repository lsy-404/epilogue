import { registerModelAuthElement, registerModelConnectionPanelElement } from '../../node_modules/@model-auth/vue/dist/model-auth-element.js';

registerModelAuthElement();
registerModelConnectionPanelElement();
const dialog = document.querySelector('model-auth-dialog');
const panel = document.querySelector('model-connection-panel');
let activeOperation = null;
let dialogEpoch = 0;

async function refresh() {
  const state = await window.epologue.modelAuthState();
  Object.assign(dialog, { providers: state.providers, model: state.model, catalogStatus: state.catalogStatus, theme: 'system' });
  Object.assign(panel, { providers: state.providers, model: state.model, busy: false, error: null, styled: true, theme: 'system' });
}
function actionFor(event) {
  const detail = Array.isArray(event.detail) ? event.detail : [event.detail];
  if (event.type === 'authorize-oauth') return { type: event.type, providerId: detail[0], ...(detail[1] ? { credentialId: detail[1] } : {}) };
  if (event.type === 'add-api-key' || event.type === 'update-credential' || event.type === 'update-provider' || event.type === 'select-model' || event.type === 'update-provider-strategy') return { type: event.type, payload: detail[0] };
  if (event.type === 'remove-credential') return { type: event.type, ...detail[0] };
  return { type: event.type };
}
async function perform(event) {
  if (dialog.busy) return;
  const operationId = crypto.randomUUID();
  const operationEpoch = dialogEpoch;
  activeOperation = operationId;
  dialog.busy = true;
  dialog.error = null;
  try {
    await window.epologue.modelAuthExecute(actionFor(event), operationId);
    await refresh();
    if (event.type === 'select-model' && activeOperation === operationId && operationEpoch === dialogEpoch && dialog.open) {
      activeOperation = null;
      dialog.open = false;
    }
  }
  catch { dialog.error = 'Operation could not be completed. Check the provider configuration and try again.'; }
  finally { if (activeOperation === operationId) activeOperation = null; dialog.busy = false; }
}
async function open(initialConnection = null) {
  dialogEpoch += 1;
  dialog.initialConnection = initialConnection;
  dialog.open = true;
  if (dialog.busy) return;
  dialog.busy = true;
  dialog.error = null;
  try { await refresh(); }
  catch { dialog.error = 'Could not load model connections. Close this dialog and try again.'; }
  finally { dialog.busy = false; }
}
window.openModelAuth = open;
dialog.addEventListener('close', () => {
  dialogEpoch += 1;
  if (activeOperation) void window.epologue.modelAuthCancel(activeOperation);
  dialog.open = false;
  void refresh().catch(() => {});
});
panel?.addEventListener('manage', (event) => {
  const [connection] = event.detail;
  if (connection?.providerId) void open(connection);
});
panel?.addEventListener('add', () => { void open(); });
panel?.addEventListener('refresh', () => {
  void refresh().catch(() => { panel.error = 'Could not load model connections. Try again.'; });
});
void refresh().catch(() => { if (panel) panel.error = 'Could not load model connections. Try again.'; });
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
