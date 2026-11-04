'use strict';
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');

const PRO_API = 1;
const PACKAGE_ID = 'epilogue-pro';
const LICENSE_PREFIX = 'EPRO1.';
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 64;
const MANIFEST_NAME = 'manifest.json';
const SIGNATURE_NAME = 'manifest.sig';

const B64URL = /^[A-Za-z0-9_-]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.]{1,32})?$/;
const FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const KID = /^[A-Za-z0-9._-]{1,64}$/;

class ProError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ProError';
    this.code = code;
  }
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function decodeB64url(value, code) {
  if (typeof value !== 'string' || !B64URL.test(value)) throw new ProError(code);
  return Buffer.from(value, 'base64url');
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function parseJson(buffer, code) {
  try {
    const value = JSON.parse(buffer.toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    /* fall through */
  }
  throw new ProError(code);
}

function compileKeys(table) {
  const keys = new Map();
  for (const [kid, pem] of Object.entries(table || {})) keys.set(kid, crypto.createPublicKey(pem));
  return keys;
}

// A fixed key table per verifier: production uses src/main/proKeys.js, tests inject their own.
function createVerifier({ extensionKeys = {}, licenseKeys = {} } = {}) {
  const extKeys = compileKeys(extensionKeys);
  const licKeys = compileKeys(licenseKeys);

  function verifyLicense(text, { now = new Date() } = {}) {
    if (typeof text !== 'string') throw new ProError('license_format');
    const parts = text.trim().split('.');
    if (parts.length !== 3 || `${parts[0]}.` !== LICENSE_PREFIX) throw new ProError('license_format');
    const [, payloadB64, sigB64] = parts;
    const payloadBytes = decodeB64url(payloadB64, 'license_format');
    const sig = decodeB64url(sigB64, 'license_format');
    const payload = parseJson(payloadBytes, 'license_format');
    if (typeof payload.kid !== 'string' || !KID.test(payload.kid) || !licKeys.has(payload.kid)) {
      throw new ProError('license_kid');
    }
    const signed = Buffer.from(`${LICENSE_PREFIX}${payloadB64}`, 'utf8');
    if (!crypto.verify(null, signed, licKeys.get(payload.kid), sig)) throw new ProError('license_signature');
    if (payload.v !== 1) throw new ProError('license_version');
    if (payload.sku !== 'pro') throw new ProError('license_sku');
    if (typeof payload.lid !== 'string' || !/^[0-9a-f]{32}$/.test(payload.lid)) throw new ProError('license_format');
    if (payload.name != null && (typeof payload.name !== 'string' || payload.name.length > 128)) {
      throw new ProError('license_format');
    }
    if (!isIsoDate(payload.iat) || !isIsoDate(payload.upd)) throw new ProError('license_dates');
    if (payload.exp != null) {
      if (!isIsoDate(payload.exp)) throw new ProError('license_dates');
      if (now.toISOString().slice(0, 10) > payload.exp) throw new ProError('license_expired');
    }
    return Object.freeze({
      v: 1,
      kid: payload.kid,
      lid: payload.lid,
      sku: 'pro',
      name: payload.name ?? '',
      iat: payload.iat,
      upd: payload.upd,
      exp: payload.exp ?? null,
    });
  }

  // getFile(name) returns the Buffer for a manifest-listed file; shared by the zip and extracted-directory sources.
  function verifyBundle(manifestBytes, sigBytes, getFile) {
    const sigDoc = parseJson(sigBytes, 'sig_format');
    if (typeof sigDoc.kid !== 'string' || !KID.test(sigDoc.kid) || !extKeys.has(sigDoc.kid)) {
      throw new ProError('package_kid');
    }
    const sig = decodeB64url(sigDoc.sig, 'sig_format');
    if (!crypto.verify(null, manifestBytes, extKeys.get(sigDoc.kid), sig)) throw new ProError('package_signature');

    const manifest = parseJson(manifestBytes, 'manifest_format');
    if (manifest.format !== 1 || manifest.id !== PACKAGE_ID) throw new ProError('manifest_format');
    if (typeof manifest.version !== 'string' || !VERSION.test(manifest.version)) throw new ProError('manifest_format');
    if (!Number.isInteger(manifest.api)) throw new ProError('manifest_format');
    if (!isIsoDate(manifest.featureDate)) throw new ProError('manifest_format');
    if (typeof manifest.platform !== 'string' || typeof manifest.arch !== 'string') throw new ProError('manifest_format');
    const { entries, files } = manifest;
    if (!entries || typeof entries !== 'object' || !files || typeof files !== 'object') {
      throw new ProError('manifest_format');
    }
    const names = Object.keys(files);
    if (!names.length || names.length > MAX_ENTRIES) throw new ProError('manifest_format');
    for (const name of names) {
      const meta = files[name];
      if (!FILE_NAME.test(name) || name === MANIFEST_NAME || name === SIGNATURE_NAME) throw new ProError('manifest_format');
      if (!meta || typeof meta.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(meta.sha256)) throw new ProError('manifest_format');
      if (!Number.isInteger(meta.size) || meta.size < 0 || meta.size > MAX_FILE_BYTES) throw new ProError('package_size');
    }
    for (const key of ['main', 'renderer']) {
      if (typeof entries[key] !== 'string' || !Object.hasOwn(files, entries[key])) throw new ProError('manifest_format');
    }

    const contents = new Map();
    let total = 0;
    for (const name of names) {
      const data = getFile(name);
      if (!Buffer.isBuffer(data)) throw new ProError('package_file_missing');
      total += data.length;
      if (data.length !== files[name].size || total > MAX_TOTAL_BYTES) throw new ProError('package_size');
      if (sha256Hex(data) !== files[name].sha256) throw new ProError('package_hash');
      contents.set(name, data);
    }
    return { manifest, files: contents };
  }

  function readZip(zipBuffer) {
    let zipEntries;
    try {
      zipEntries = new AdmZip(zipBuffer).getEntries();
    } catch {
      throw new ProError('package_zip');
    }
    if (zipEntries.length > MAX_ENTRIES + 2) throw new ProError('package_zip');
    const raw = new Map();
    let declared = 0;
    for (const entry of zipEntries) {
      const name = entry.entryName;
      if (name.startsWith('/') || name.includes('\\') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) {
        throw new ProError('package_path');
      }
      const mode = (entry.header.attr >>> 16) & 0o170000;
      if (entry.isDirectory || mode === 0o120000 || raw.has(name) || name.includes('/')) throw new ProError('package_path');
      declared += entry.header.size;
      if (entry.header.size > MAX_FILE_BYTES || declared > MAX_TOTAL_BYTES) throw new ProError('package_size');
      raw.set(name, entry);
    }
    const manifestEntry = raw.get(MANIFEST_NAME);
    const sigEntry = raw.get(SIGNATURE_NAME);
    if (!manifestEntry || !sigEntry) throw new ProError('package_file_missing');
    const manifestBytes = manifestEntry.getData();
    const sigBytes = sigEntry.getData();
    if (manifestBytes.length > 1 << 20 || sigBytes.length > 1 << 16) throw new ProError('package_size');
    const result = verifyBundle(manifestBytes, sigBytes, (name) => raw.get(name)?.getData());
    for (const name of raw.keys()) {
      if (name !== MANIFEST_NAME && name !== SIGNATURE_NAME && !Object.hasOwn(result.manifest.files, name)) {
        throw new ProError('package_unlisted');
      }
    }
    return { ...result, manifestBytes, sigBytes };
  }

  function checkCompatibility(manifest, license, { platform = process.platform, arch = process.arch } = {}) {
    if (manifest.api !== PRO_API) throw new ProError('package_api');
    if (manifest.platform !== platform || manifest.arch !== arch) throw new ProError('package_platform');
    if (manifest.featureDate > license.upd) throw new ProError('package_feature_date');
  }

  return { verifyLicense, verifyBundle, readZip, checkCompatibility };
}

let productionVerifier = null;
function getProductionVerifier() {
  productionVerifier ??= createVerifier(require('./proKeys'));
  return productionVerifier;
}

module.exports = {
  PRO_API,
  MANIFEST_NAME,
  SIGNATURE_NAME,
  ProError,
  createVerifier,
  getProductionVerifier,
  isIsoDate,
};
