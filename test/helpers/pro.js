'use strict';
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');

function makeKeyPair(kid) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { kid, privateKey, publicB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}

function makeKeys() {
  const extension = makeKeyPair('ext-test');
  const license = makeKeyPair('lic-test');
  return {
    extension,
    license,
    verifierKeys: {
      extensionKeys: { [extension.kid]: extension.publicB64 },
      licenseKeys: { [license.kid]: license.publicB64 },
    },
  };
}

const b64u = (buffer) => Buffer.from(buffer).toString('base64url');

function signLicense(key, fields = {}) {
  const payload = {
    v: 1,
    kid: key.kid,
    lid: crypto.randomBytes(16).toString('hex'),
    sku: 'pro',
    name: 'Test User',
    iat: '2026-12-01',
    upd: '2027-12-01',
    exp: null,
    ...fields,
  };
  const payloadB64 = b64u(JSON.stringify(payload));
  const sig = crypto.sign(null, Buffer.from(`EPRO1.${payloadB64}`), key.privateKey);
  return `EPRO1.${payloadB64}.${b64u(sig)}`;
}

function buildParts(key, { version = '1.0.0', featureDate = '2026-12-01', api = 1, files, manifest = {}, kid } = {}) {
  const content = files || {
    'main.cjs': Buffer.from('exports.activate = (api) => api.ipc.handle("ping", () => "pong");'),
    'renderer.js': Buffer.from('window.__proTest = true;'),
  };
  const meta = {};
  for (const [name, data] of Object.entries(content)) {
    meta[name] = { sha256: crypto.createHash('sha256').update(data).digest('hex'), size: data.length };
  }
  const manifestBytes = Buffer.from(
    JSON.stringify({
      format: 1,
      id: 'epilogue-pro',
      version,
      api,
      featureDate,
      platform: process.platform,
      arch: process.arch,
      entries: { main: 'main.cjs', renderer: 'renderer.js' },
      files: meta,
      ...manifest,
    })
  );
  const sig = crypto.sign(null, manifestBytes, key.privateKey);
  const sigBytes = Buffer.from(JSON.stringify({ kid: kid || key.kid, sig: b64u(sig) }));
  return { manifestBytes, sigBytes, files: { ...content } };
}

function zipParts({ manifestBytes, sigBytes, files }, extra = () => {}) {
  const zip = new AdmZip();
  zip.addFile('manifest.json', manifestBytes);
  zip.addFile('manifest.sig', sigBytes);
  for (const [name, data] of Object.entries(files)) zip.addFile(name, data);
  extra(zip);
  return zip.toBuffer();
}

function buildPackage(key, options, extra) {
  return zipParts(buildParts(key, options), extra);
}

module.exports = { makeKeys, signLicense, buildParts, zipParts, buildPackage, b64u };
