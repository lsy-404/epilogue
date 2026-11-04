'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { builtinModules } = require('node:module');
const { PRO_API, MANIFEST_NAME, SIGNATURE_NAME, ProError, getProductionVerifier } = require('./proVerify');

const PRO_SCHEME = 'epilogue-pro';
const IPC_NAME = /^[a-z][a-z0-9:-]{0,63}$/;
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const MAX_LICENSE_BYTES = 4096;

const BUILTINS = new Set(builtinModules);
function restrictedRequire(id) {
  if (typeof id === 'string' && (id.startsWith('node:') || BUILTINS.has(id))) return require(id);
  throw new Error(`require of '${id}' is not allowed in extensions`);
}

function createEventBus(onError) {
  const listeners = new Map();
  return {
    on(event, fn) {
      if (typeof fn !== 'function') return;
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
    },
    off(event, fn) {
      listeners.get(event)?.delete(fn);
    },
    emit(event, payload) {
      for (const fn of [...(listeners.get(event) || [])]) {
        try {
          fn(payload);
        } catch (error) {
          onError?.(event, error);
        }
      }
    },
  };
}

function writeFileAtomic(file, data) {
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function createExtensionManager({
  verifier,
  userData,
  coreVersion,
  platform = process.platform,
  arch = process.arch,
  settings,
  log = () => {},
  ipcHandle,
  ipcRemove = () => {},
  now = () => new Date(),
}) {
  const proDir = path.join(userData, 'pro');
  const extDir = path.join(proDir, 'ext');
  const licenseFile = path.join(proDir, 'license.epl');
  const currentFile = path.join(proDir, 'current.json');
  const events = createEventBus((event, error) => log('pro', 'event listener failed', { event, message: String(error?.message || error) }));

  let loaded = null; // { version, licenseId, renderer: Buffer }
  let loadError = null;
  let registeredChannels = [];
  let dirty = false;

  function readCurrentPointer() {
    try {
      const doc = JSON.parse(fs.readFileSync(currentFile, 'utf8'));
      if (typeof doc.version !== 'string') return null;
      return { version: doc.version, previous: typeof doc.previous === 'string' ? doc.previous : null };
    } catch {
      return null;
    }
  }

  function writePointer(version, previous) {
    fs.mkdirSync(proDir, { recursive: true });
    writeFileAtomic(currentFile, JSON.stringify({ version, previous: previous ?? null }));
  }

  function readLicenseText() {
    try {
      return fs.readFileSync(licenseFile, 'utf8');
    } catch {
      return null;
    }
  }

  function currentLicense() {
    const text = readLicenseText();
    if (text == null) return { payload: null, error: null };
    try {
      return { payload: verifier.verifyLicense(text, { now: now() }), error: null };
    } catch (error) {
      return { payload: null, error: error.code || 'license_format' };
    }
  }

  function readInstalled(version) {
    const dir = path.join(extDir, version);
    const bundle = verifier.verifyBundle(
      fs.readFileSync(path.join(dir, MANIFEST_NAME)),
      fs.readFileSync(path.join(dir, SIGNATURE_NAME)),
      (name) => fs.readFileSync(path.join(dir, name))
    );
    if (bundle.manifest.version !== version) throw new ProError('manifest_format');
    return { ...bundle, dir };
  }

  function previewLicense(text) {
    const payload = verifier.verifyLicense(String(text ?? ''), { now: now() });
    return publicLicense(payload);
  }

  function publicLicense(payload) {
    return { name: payload.name, sku: payload.sku, iat: payload.iat, upd: payload.upd, exp: payload.exp };
  }

  function importLicense(text) {
    const trimmed = String(text ?? '').trim();
    if (Buffer.byteLength(trimmed) > MAX_LICENSE_BYTES) throw new ProError('license_format');
    const payload = verifier.verifyLicense(trimmed, { now: now() });
    fs.mkdirSync(proDir, { recursive: true });
    writeFileAtomic(licenseFile, trimmed);
    dirty = true;
    log('pro', 'license imported', { upd: payload.upd });
    return status();
  }

  function removeLicense() {
    fs.rmSync(licenseFile, { force: true });
    dirty = true;
    return status();
  }

  function installPackage(zipBuffer) {
    const { payload: license } = currentLicense();
    if (!license) throw new ProError('license_required');
    const { manifest, files, manifestBytes, sigBytes } = verifier.readZip(zipBuffer);
    verifier.checkCompatibility(manifest, license, { platform, arch });

    const { version } = manifest;
    fs.mkdirSync(extDir, { recursive: true });
    const staging = path.join(extDir, `${version}.staging-${crypto.randomBytes(6).toString('hex')}`);
    const target = path.join(extDir, version);
    try {
      fs.mkdirSync(staging);
      fs.writeFileSync(path.join(staging, MANIFEST_NAME), manifestBytes);
      fs.writeFileSync(path.join(staging, SIGNATURE_NAME), sigBytes);
      for (const [name, data] of files) fs.writeFileSync(path.join(staging, name), data);
      let replaced = null;
      if (fs.existsSync(target)) {
        replaced = `${target}.old-${crypto.randomBytes(6).toString('hex')}`;
        fs.renameSync(target, replaced);
      }
      fs.renameSync(staging, target);
      if (replaced) removeDir(replaced);
    } finally {
      removeDir(staging);
    }

    const pointer = readCurrentPointer();
    const previous = [pointer?.version, pointer?.previous].find((v) => v && v !== version) ?? null;
    writePointer(version, previous);
    pruneExtDir();
    dirty = true;
    log('pro', 'package installed', { version, featureDate: manifest.featureDate });
    return status();
  }

  function installPackageFile(file) {
    const size = fs.statSync(file).size;
    if (size > MAX_PACKAGE_BYTES) throw new ProError('package_size');
    return installPackage(fs.readFileSync(file));
  }

  function pruneExtDir() {
    const pointer = readCurrentPointer();
    const keep = new Set([pointer?.version, pointer?.previous].filter(Boolean));
    for (const name of fs.readdirSync(extDir)) {
      if (!keep.has(name)) removeDir(path.join(extDir, name));
    }
  }

  function rollback() {
    const pointer = readCurrentPointer();
    if (!pointer?.previous) throw new ProError('no_previous');
    readInstalled(pointer.previous);
    writePointer(pointer.previous, pointer.version);
    dirty = true;
    return status();
  }

  function removePackage() {
    fs.rmSync(currentFile, { force: true });
    removeDir(extDir);
    dirty = true;
    return status();
  }

  function packageInfo(license) {
    const pointer = readCurrentPointer();
    if (!pointer) return { package: null, previousVersion: null, packageError: null };
    try {
      const { manifest } = readInstalled(pointer.version);
      return {
        package: {
          version: manifest.version,
          featureDate: manifest.featureDate,
          api: manifest.api,
          platform: manifest.platform,
          arch: manifest.arch,
          covered: license ? manifest.featureDate <= license.upd : null,
        },
        previousVersion: pointer.previous,
        packageError: null,
      };
    } catch (error) {
      return { package: null, previousVersion: pointer.previous, packageError: error.code || 'package_hash' };
    }
  }

  function status() {
    const { payload, error } = currentLicense();
    const info = packageInfo(payload);
    return {
      active: Boolean(loaded),
      loadedVersion: loaded?.version ?? null,
      loadError,
      restartRequired: dirty,
      coreApi: PRO_API,
      license: payload ? { valid: true, ...publicLicense(payload) } : { valid: false, installed: readLicenseText() != null, error },
      ...info,
    };
  }

  function buildApi(license) {
    const channels = [];
    registeredChannels = channels;
    return Object.freeze({
      PRO_API,
      version: coreVersion,
      license,
      paths: Object.freeze({ userData, proDir, extDir }),
      log: (scope, msg, data) => log(`pro/${String(scope)}`, String(msg), data),
      settings: Object.freeze({
        get: () => structuredClone(settings.get()),
        patch: (patch) => structuredClone(settings.patch(patch)),
      }),
      events: Object.freeze({ on: events.on, off: events.off, emit: events.emit }),
      ipc: Object.freeze({
        handle(name, fn) {
          if (typeof name !== 'string' || !IPC_NAME.test(name) || typeof fn !== 'function') {
            throw new Error('Invalid extension IPC registration');
          }
          const channel = `pro:${name}`;
          ipcHandle(channel, (_event, ...args) => fn(...args));
          channels.push(channel);
        },
      }),
    });
  }

  async function load() {
    loaded = null;
    loadError = null;
    const { payload: license, error: licenseError } = currentLicense();
    if (!license) {
      loadError = licenseError;
      return status();
    }
    const pointer = readCurrentPointer();
    if (!pointer) return status();
    try {
      const { manifest, files, dir } = readInstalled(pointer.version);
      verifier.checkCompatibility(manifest, license, { platform, arch });
      const source = files.get(manifest.entries.main).toString('utf8');
      const filename = path.join(dir, manifest.entries.main);
      const fn = vm.compileFunction(source, ['exports', 'require', 'module'], { filename });
      const mod = { exports: {} };
      fn.call(mod.exports, mod.exports, restrictedRequire, mod);
      if (typeof mod.exports.activate !== 'function') throw new ProError('activate_missing');
      loaded = { version: manifest.version, renderer: files.get(manifest.entries.renderer) };
      try {
        await mod.exports.activate(buildApi(license));
      } catch (error) {
        deactivate();
        throw error;
      }
      dirty = false;
      log('pro', 'extension active', { version: manifest.version });
    } catch (error) {
      loaded = null;
      loadError = error.code || 'activate_failed';
      log('pro', 'extension failed to load', { code: loadError, message: String(error?.message || error).slice(0, 200) });
    }
    return status();
  }

  function deactivate() {
    if (loaded) events.emit('pro:deactivate');
    for (const channel of registeredChannels) ipcRemove(channel);
    registeredChannels = [];
    loaded = null;
  }

  function rendererSource() {
    return loaded?.renderer ?? null;
  }

  function handleProtocol(request) {
    const source = rendererSource();
    const url = new URL(request.url);
    if (!source || url.hostname !== 'ext' || url.pathname !== '/renderer.js') return new Response(null, { status: 404 });
    return new Response(source, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } });
  }

  return {
    events,
    status,
    previewLicense,
    importLicense,
    removeLicense,
    installPackage,
    installPackageFile,
    rollback,
    removePackage,
    load,
    deactivate,
    rendererSource,
    handleProtocol,
  };
}

let manager = null;
function getManager() {
  if (manager) return manager;
  const { app, ipcMain } = require('electron');
  const settings = require('./settings');
  const { log } = require('./log');
  const ipc = require('./ipc');
  manager = createExtensionManager({
    verifier: getProductionVerifier(),
    userData: app.getPath('userData'),
    coreVersion: app.getVersion(),
    settings: {
      get: settings.get,
      patch: (patch) => ipc.applySettingsPatch(patch),
    },
    log,
    ipcHandle: ipc.handleTrusted,
    ipcRemove: (channel) => ipcMain.removeHandler(channel),
  });
  return manager;
}

module.exports = {
  PRO_API,
  PRO_SCHEME,
  IPC_NAME,
  createExtensionManager,
  getManager,
  ProError,
};
