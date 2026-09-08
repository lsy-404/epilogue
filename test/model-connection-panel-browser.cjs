const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const output = path.resolve(__dirname, '.output', 'model-connection-panel-browser.log');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, 'startup\n');
const progress = (step) => fs.appendFileSync(output, `${step}\n`);

app.whenReady().then(async () => {
  progress('ready');
  const window = new BrowserWindow({ show: false, webPreferences: {
    preload: path.resolve(__dirname, 'model-connection-panel-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false,
  }, backgroundThrottling: false });
  try {
    progress('window-created');
    await window.loadFile(path.resolve(__dirname, 'model-connection-panel-browser.html'));
    progress('fixture-loaded');
    const result = await window.webContents.executeJavaScript(`new Promise(resolve => setTimeout(() => {
      try {
        const panel = document.querySelector('model-connection-panel');
        const dialog = document.querySelector('model-auth-dialog');
        const cards = panel.shadowRoot.querySelectorAll('[data-part="connection-card"]').length;
        const panelText = panel.shadowRoot.textContent;
        const manage = panel.shadowRoot.querySelector('[data-part="view-connection"]');
        if (!manage) return resolve({ cards, panelText });
        manage.click();
        setTimeout(() => resolve({ cards, panelText, account: panel.shadowRoot.textContent.includes('Fixture account'), detail: Boolean(dialog.shadowRoot.querySelector('[data-part="connection-info"]')) }), 0);
      } catch (error) { resolve({ error: String(error) }); }
    }, 100))`);
    progress('fixture-evaluated');
    progress(`result:${JSON.stringify(result)}`);
    if (result.cards !== 1 || !result.account || !result.detail) throw new Error('Model connection panel fixture did not retain or manage the saved connection.');
    console.log('model connection panel browser fixture passed');
  } catch (error) {
    progress(`failed:${error.message}`);
    console.error(error);
    process.exitCode = 1;
  } finally {
    window.destroy();
    app.quit();
  }
});
app.on('web-contents-created', (_event, contents) => contents.on('did-fail-load', (_event, code, detail) => progress(`load-failed:${code}:${detail}`)));
