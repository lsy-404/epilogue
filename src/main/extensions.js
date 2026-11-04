'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const hooks = require('./hooks');
const { restrictedRequire } = require('../shared/restrictedRequire');
const { PRO_API, MANIFEST_NAME, SIGNATURE_NAME, VERSION, ProError, toProError, getProductionVerifier } = require('./proVerify');

const PRO_SCHEME = 'epilogue-pro';
const IPC_NAME = /^[a-z][a-z0-9:-]{0,63}$/;
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const MAX_LICENSE_BYTES = 4096;

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

function removeDirQuiet(dir) {
  try {
    removeDir(dir);
  } catch {
    /* leftovers are pruned on the next install */
  }
}

const RETRYABLE_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 5;

// Antivirus and indexers briefly hold directories open on Windows, so renames get a short bounded retry.
function renameRetry(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (attempt >= RENAME_ATTEMPTS || !RETRYABLE_RENAME.has(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * attempt);
    }
  }
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
  core = {},
  chmod = fs.chmodSync,
}) {
  const proDir = path.join(userData, 'pro');
  const extDir = path.join(proDir, 'ext');
  const licenseFile = path.join(proDir, 'license.epl');
  const currentFile = path.join(proDir, 'current.json');
  const newBus = () => createEventBus((event, error) => log('pro', 'event listener failed', { event, message: String(error?.message || error) }));

  let loaded = null; // { version, renderer: Buffer }, set only after activate() resolves
  let activation = null; // { bus, channels } of the extension currently activating or active
  let loadError = null;
  let dirty = false;

  const events = Object.freeze({
    emit: (event, payload) => activation?.bus.emit(event, payload),
  });

  function readCurrentPointer() {
    try {
      const doc = JSON.parse(fs.readFileSync(currentFile, 'utf8'));
      if (typeof doc.version !== 'string' || !VERSION.test(doc.version)) return null;
      return { version: doc.version, previous: typeof doc.previous === 'string' && VERSION.test(doc.previous) ? doc.previous : null };
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
    try {
      fs.mkdirSync(proDir, { recursive: true });
      writeFileAtomic(licenseFile, trimmed);
    } catch (error) {
      throw toProError(error);
    }
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
      if (platform !== 'win32') for (const name of manifest.executables ?? []) chmod(path.join(staging, name), 0o755);
      let replaced = null;
      if (fs.existsSync(target)) {
        replaced = `${target}.old-${crypto.randomBytes(6).toString('hex')}`;
        renameRetry(target, replaced);
      }
      try {
        renameRetry(staging, target);
      } catch (error) {
        if (replaced) {
          try {
            renameRetry(replaced, target);
          } catch {
            /* the old copy stays under its .old name */
          }
        }
        throw error;
      }
      if (replaced) removeDirQuiet(replaced);
    } catch (error) {
      throw toProError(error);
    } finally {
      removeDirQuiet(staging);
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
    let data;
    try {
      if (fs.statSync(file).size > MAX_PACKAGE_BYTES) throw new ProError('package_size');
      data = fs.readFileSync(file);
    } catch (error) {
      throw toProError(error);
    }
    return installPackage(data);
  }

  function pruneExtDir() {
    const pointer = readCurrentPointer();
    const keep = new Set([pointer?.version, pointer?.previous].filter(Boolean));
    for (const name of fs.readdirSync(extDir)) {
      if (!keep.has(name)) removeDirQuiet(path.join(extDir, name));
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

  function buildApi(license, { bus, channels }, packageDir) {
    const unavailable = () => {
      throw new Error('This core hook is not available');
    };
    const modelHost = core.modelHost ?? {};
    return Object.freeze({
      PRO_API,
      version: coreVersion,
      license,
      paths: Object.freeze({ userData, proDir, extDir, packageDir }),
      log: (scope, msg, data) => log(`pro/${String(scope)}`, String(msg), data),
      settings: Object.freeze({
        get: () => structuredClone(settings.get()),
        patch: (patch) => structuredClone(settings.patch(patch)),
      }),
      events: Object.freeze({ on: bus.on, off: bus.off, emit: bus.emit }),
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
      modelHost: Object.freeze({
        call(op, ...args) {
          if (typeof op !== 'string' || !op || op.startsWith('__')) throw new Error('Invalid model host op');
          return (modelHost.call ?? unavailable)(op, ...args);
        },
        pid: () => modelHost.pid?.() ?? null,
      }),
      extractors: Object.freeze({ register: hooks.registerExtractor }),
      vectorSpaces: Object.freeze({ register: hooks.registerVectorSpace }),
      providers: Object.freeze({ setStrategy: hooks.setStrategy }),
      lifecycle: Object.freeze({
        stopHost: () => core.lifecycle?.stopHost() ?? false,
        dropStore: () => core.lifecycle?.dropStore() ?? false,
      }),
      scheduler: Object.freeze({
        setIntervalFilter: hooks.setIntervalFilter,
        rearm: () => core.scheduler?.rearm(),
      }),
      power: Object.freeze({ onBattery: () => core.power?.onBattery() ?? false }),
    });
  }

  async function load() {
    deactivate();
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
      const renderer = files.get(manifest.entries.renderer);
      const current = { bus: newBus(), channels: [] };
      activation = current;
      hooks.attach(current.bus.emit);
      try {
        if (manifest.entries.host) {
          core.modelHost?.setModule({
            source: files.get(manifest.entries.host).toString('utf8'),
            filename: path.join(dir, manifest.entries.host),
            packageDir: dir,
          });
        }
        await mod.exports.activate(buildApi(license, current, dir));
      } catch (error) {
        if (activation === current) deactivate();
        throw error;
      }
      if (activation !== current) throw new ProError('activate_failed');
      loaded = { version: manifest.version, renderer };
      dirty = false;
      log('pro', 'extension active', { version: manifest.version });
    } catch (error) {
      loaded = null;
      loadError = typeof error?.code === 'string' && /^[a-z_]+$/.test(error.code) ? error.code : 'activate_failed';
      log('pro', 'extension failed to load', { code: loadError, message: String(error?.message || error).slice(0, 200) });
    }
    return status();
  }

  function deactivate() {
    const current = activation;
    activation = null;
    loaded = null;
    if (!current) return;
    current.bus.emit('pro:deactivate');
    for (const channel of current.channels) ipcRemove(channel);
    hooks.reset();
    core.modelHost?.setModule(null);
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

// Maps the runtime modules onto the hook surface the extension manager exposes; tests pass fakes instead.
function createCore({ localModels, ipc, scheduler, onBattery }) {
  return {
    modelHost: { setModule: localModels.setHostModule, call: localModels.hostCall, pid: localModels.hostPid },
    lifecycle: { stopHost: localModels.stopHostIfIdle, dropStore: ipc.dropStore },
    scheduler: { rearm: scheduler.rearm },
    power: { onBattery },
  };
}

let manager = null;
function getManager() {
  if (manager) return manager;
  const { app, ipcMain, powerMonitor } = require('electron');
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
    core: createCore({
      localModels: require('./localModels'),
      ipc,
      scheduler: require('./scheduler'),
      onBattery: () => powerMonitor.isOnBatteryPower(),
    }),
  });
  return manager;
}

module.exports = {
  PRO_API,
  PRO_SCHEME,
  IPC_NAME,
  createExtensionManager,
  createCore,
  getManager,
  ProError,
};
