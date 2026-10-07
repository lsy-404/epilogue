'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

if (!process.versions.electron) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'epilogue-package-smoke-'));
  try {
    const environment = { ...process.env, EPILOGUE_PACKAGE_FIXTURE: fixture };
    delete environment.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], {
      env: environment, windowsHide: true, encoding: 'utf8', timeout: 40000,
    });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
  return;
}

const { app, BrowserWindow, session } = require('electron');
const fixture = process.env.EPILOGUE_PACKAGE_FIXTURE;
if (!fixture) throw new Error('Run this smoke test with Node.js.');
app.setPath('userData', fixture);
const timeout = setTimeout(() => app.exit(1), 35000);

app.whenReady().then(async () => {
  const archive = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist', `Epilogue-${process.platform}-${process.arch}`, 'resources', 'app.asar'));
  const packaged = createRequire(path.join(archive, 'package.json'));
  for (const entry of ['core', 'providers', 'vue']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(archive, 'node_modules', '@model-auth', entry, 'package.json'), 'utf8'));
    assert.equal(manifest.name, `@model-auth/${entry}`);
  }
  for (const [name, entry] of [['core', '.'], ['providers', './usage']]) {
    const packageRoot = path.join(archive, 'node_modules', '@model-auth', name);
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    await import(pathToFileURL(path.join(packageRoot, manifest.exports[entry].import)).href);
  }
  const transformersRoot = path.join(archive, 'node_modules', '@huggingface', 'transformers');
  const transformers = JSON.parse(fs.readFileSync(path.join(transformersRoot, 'package.json'), 'utf8'));
  await import(pathToFileURL(path.join(transformersRoot, transformers.exports.node.import.default)).href);
  const tensor = new (packaged('onnxruntime-node').Tensor)('float32', new Float32Array([1]), [1]);
  assert.equal(tensor.size, 1);
  const png = await packaged('sharp')({ create: { width: 2, height: 2, channels: 3, background: 'white' } }).png().toBuffer();
  assert.equal(png[1], 0x50);
  const ffmpegVersion = execFileSync(packaged('ffmpeg-static'), ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.match(ffmpegVersion, /ffmpeg version/);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
  const settings = packaged('./src/main/settings');
  settings.set({ tosAccepted: true, cleanup: { autoScan: false, folders: [] } });
  const ipc = packaged('./src/main/ipc');
  const window = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(archive, 'src', 'preload.js'), contextIsolation: true, sandbox: true,
  } });
  ipc.register(() => window);
  await window.loadFile(path.join(archive, 'src', 'renderer', 'index.html'));
  assert.equal(await window.webContents.executeJavaScript(`typeof window.epologue.getSettings`), 'function');
  assert.equal(await window.webContents.executeJavaScript(`Boolean(document.querySelector('#prefQuickSearchShortcut'))`), true);
  for (const file of ['src/main/quickSearch.js', 'src/quickSearchPreload.js', 'src/renderer/quick-search.html', 'src/renderer/quick-search.js', 'src/renderer/quick-search.css']) {
    assert.ok(fs.readFileSync(path.join(archive, file)).length > 0);
  }
  window.destroy();
  clearTimeout(timeout);
  console.log(JSON.stringify({ packagedRuntime: 'passed', native: ['onnx', 'sharp', 'ffmpeg'], auth: 'passed', renderer: 'passed', quickSearchAssets: 'passed' }));
  app.exit(0);
}).catch((error) => {
  console.error(error);
  clearTimeout(timeout);
  app.exit(1);
});
