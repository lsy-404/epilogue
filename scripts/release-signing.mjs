import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SIGNING_API = 'https://sign.voidcarve.com/v1/requests';
const PROJECTS = Object.freeze({
  'macos-arm64': { id: 'epilogue-macos-arm64', platform: 'macos', architecture: 'arm64' },
  'windows-x64': { id: 'epilogue-windows-x64', platform: 'windows', architecture: 'x64' },
  'windows-arm64': { id: 'epilogue-windows-arm64', platform: 'windows', architecture: 'arm64' },
});
const BUNDLE_ID = 'com.electron.epilogue';
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_INPUT_BYTES = 1_000_000_000;
const MAX_OUTPUT_BYTES = 2_000_000_000;
const PART_ATTEMPTS = 5;

class ReleaseError extends Error {
  constructor(code, transient = false) { super(code); this.code = code; this.transient = transient; }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const stableJson = value => JSON.stringify(value, (_key, child) => child && typeof child === 'object' && !Array.isArray(child)
  ? Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]])) : child);
const digestFile = async file => {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) { size += chunk.length; hash.update(chunk); }
  return { digest: `sha256:${hash.digest('hex')}`, size };
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000, maxBuffer: 4_000_000, ...options });
  if (result.error || result.status !== 0) throw new ReleaseError('RELEASE_COMMAND_FAILED');
  return result.stdout ?? '';
}

function required(name, value) {
  if (!value) throw new ReleaseError(`${name}_UNAVAILABLE`);
  return value;
}

function validateInputs({ platform, architecture, version, sourceSha, runId, runAttempt, apiKey }) {
  const lane = `${platform}-${architecture}`;
  const project = PROJECTS[lane];
  if (!project || !VERSION.test(version ?? '') || !SHA.test(sourceSha ?? '') || !/^\d+$/.test(runId ?? '')
    || !Number.isSafeInteger(Number(runId)) || runAttempt !== '1') throw new ReleaseError('INVALID_SIGNING_INPUT');
  required('SIGNING_API_KEY', apiKey);
  return { lane, project, version, sourceSha, runId: String(Number(runId)), apiKey };
}

async function apiJson(fetchImpl, url, method, apiKey, body, headers = {}, timeout = 30_000) {
  let response;
  try {
    response = await fetchImpl(url, {
      method, redirect: 'error', signal: AbortSignal.timeout(timeout),
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  } catch { throw new ReleaseError('SIGNING_API_UNAVAILABLE', true); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ReleaseError(`SIGNING_API_${response.status}`, response.status === 408 || response.status === 429 || response.status >= 500);
  }
  let data;
  try { data = await response.json(); } catch { throw new ReleaseError('SIGNING_RESPONSE_INVALID'); }
  return data;
}

async function runIdentity(env = process.env, fetchImpl = fetch) {
  const credential = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !credential) throw new ReleaseError('RUN_IDENTITY_UNAVAILABLE');
  let url;
  try {
    url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error();
    url.searchParams.set('audience', new URL(SIGNING_API).origin);
  } catch { throw new ReleaseError('RUN_IDENTITY_UNAVAILABLE'); }
  let response;
  try {
    response = await fetchImpl(url.href, { redirect: 'error', headers: { authorization: `Bearer ${credential}`, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  } catch { throw new ReleaseError('RUN_IDENTITY_FAILED', true); }
  if (!response.ok) { await response.body?.cancel(); throw new ReleaseError('RUN_IDENTITY_FAILED', response.status === 408 || response.status === 429 || response.status >= 500); }
  let body;
  try { body = await response.json(); } catch { throw new ReleaseError('RUN_IDENTITY_FAILED'); }
  if (typeof body.value !== 'string' || body.value.length < 1 || body.value.length > 4096 || /[\r\n]/.test(body.value)) throw new ReleaseError('RUN_IDENTITY_FAILED');
  return { 'x-run-identity': body.value };
}

async function retry(call) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await call(); }
    catch (error) {
      if (!(error instanceof ReleaseError) || !error.transient || attempt >= PART_ATTEMPTS) throw error;
      await sleep(2000 * 2 ** (attempt - 1));
    }
  }
}

async function createPayload(config, temp) {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const app = path.join(packageRoot, 'dist', `Epilogue-${config.project.platform === 'macos' ? 'darwin' : 'win32'}-${config.project.architecture}`);
  if (!(await lstat(app).catch(() => null))?.isDirectory()) throw new ReleaseError('PACKAGED_APP_MISSING');
  const source = path.join(temp, 'source.json');
  await writeFile(source, `${JSON.stringify({ source_sha: config.sourceSha, version: config.version, bundle_id: BUNDLE_ID, architecture: config.project.architecture })}\n`, { mode: 0o600, flag: 'wx' });
  const archive = path.join(temp, 'input.zip');
  if (config.project.platform === 'macos') {
    const appBundle = path.join(app, 'Epilogue.app');
    if (!(await lstat(appBundle).catch(() => null))?.isDirectory()) throw new ReleaseError('MACOS_APP_MISSING');
    const unsigned = path.join(temp, 'unsigned.tar.gz');
    run('tar', ['-czf', unsigned, '-C', app, 'Epilogue.app']);
    const templateRoot = path.join(temp, 'template-root');
    await mkdir(templateRoot, { mode: 0o700 });
    await cp(appBundle, path.join(templateRoot, 'Epilogue.app'), { recursive: true, verbatimSymlinks: true });
    await run('ln', ['-s', '/Applications', path.join(templateRoot, 'Applications')]);
    const template = path.join(temp, 'template.dmg');
    run('hdiutil', ['create', '-volname', 'Epilogue', '-srcfolder', templateRoot, '-ov', '-format', 'UDZO', template]);
    run('zip', ['-X', '-0', archive, 'unsigned.tar.gz', 'template.dmg', 'source.json'], { cwd: temp });
  } else {
    const staging = path.join(temp, 'windows-input');
    await mkdir(path.join(staging, 'app'), { recursive: true, mode: 0o700 });
    await cp(app, path.join(staging, 'app'), { recursive: true, verbatimSymlinks: true });
    await copyFile(path.join(packageRoot,'build','icon.ico'),path.join(staging,'app','resources','installer.ico'));
    await copyFile(source, path.join(staging, 'source.json'));
    const powershell = [
      'Add-Type -AssemblyName System.IO.Compression.FileSystem;',
      '[IO.Compression.ZipFile]::CreateFromDirectory($env:INPUT_ROOT, $env:INPUT_ZIP, [IO.Compression.CompressionLevel]::NoCompression, $false)',
    ].join(' ');
    run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', powershell], {
      env: { ...process.env, INPUT_ROOT: staging, INPUT_ZIP: archive },
    });
  }
  const input = await digestFile(archive);
  if (input.size < 1 || input.size > MAX_INPUT_BYTES) throw new ReleaseError('SIGNING_INPUT_SIZE_INVALID');
  return { archive, input };
}

async function requestPlan(fetchImpl, base, apiKey, identityHeaders, input) {
  const plan = await retry(async () => apiJson(fetchImpl, `${base}/source`, 'POST', apiKey, {}, await identityHeaders()));
  if (!Number.isSafeInteger(plan.part_size) || plan.part_size < 5 * 1024 * 1024 || plan.part_size > 64 * 1024 * 1024
    || plan.part_count !== Math.ceil(input.size / plan.part_size) || !Array.isArray(plan.received_parts)) throw new ReleaseError('SIGNING_UPLOAD_PLAN_INVALID');
  return plan;
}

async function putPart(fetchImpl, url, apiKey, identity, file, start, length) {
  const response = await fetchImpl(url, {
    method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(300_000),
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/octet-stream', 'content-length': String(length), ...identity },
    body: createReadStream(file, { start, end: start + length - 1 }), duplex: 'half',
  });
  await response.body?.cancel();
  return response.status;
}

async function uploadInput(fetchImpl, base, apiKey, identityHeaders, file, input) {
  let plan = await requestPlan(fetchImpl, base, apiKey, identityHeaders, input);
  for (let part = 1; part <= plan.part_count; part += 1) {
    if (plan.received_parts.includes(part)) continue;
    const start = (part - 1) * plan.part_size;
    const length = Math.min(plan.part_size, input.size - start);
    for (let attempt = 1; ; attempt += 1) {
      let status = 0;
      const identity = await retry(identityHeaders);
      try { status = await putPart(fetchImpl, `${base}/source/parts/${part}`, apiKey, identity, file, start, length); } catch { status = 0; }
      if (status === 200) break;
      if (status !== 0 && status !== 408 && status !== 429 && status < 500 || attempt >= PART_ATTEMPTS) throw new ReleaseError('SOURCE_UPLOAD_FAILED');
      await sleep(2000 * 2 ** (attempt - 1));
      plan = await requestPlan(fetchImpl, base, apiKey, identityHeaders, input);
      if (plan.received_parts.includes(part)) break;
    }
  }
}

async function submitSource() {
  const config = validateInputs({
    platform: process.env.INPUT_PLATFORM, architecture: process.env.INPUT_ARCHITECTURE,
    version: process.env.INPUT_VERSION, sourceSha: process.env.INPUT_SOURCE_SHA,
    runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    apiKey: process.env.SIGNING_API_KEY,
  });
  const tempRoot = required('RUNNER_TEMP', process.env.RUNNER_TEMP);
  const temp = await mkdtemp(path.join(tempRoot, `epilogue-${config.lane}-`));
  await chmod(temp, 0o700);
  try {
    const { archive, input } = await createPayload(config, temp);
    const identityHeaders = () => runIdentity(process.env, fetch);
    const created = await retry(async () => apiJson(fetch, SIGNING_API, 'POST', config.apiKey, {
      project_id: config.project.id, platform: config.project.platform, run_id: Number(config.runId), run_attempt: 1,
      input_digest: input.digest, input_size: input.size, version: config.version, source_sha: config.sourceSha, execution_visibility: 'public',
    }, { 'idempotency-key': `epilogue-${config.project.id}-${config.runId}-1`, ...await identityHeaders() }));
    if (typeof created.request_id !== 'string' || !UUID.test(created.request_id) || created.project_id !== config.project.id
      || created.platform !== config.project.platform || created.source_run_id !== Number(config.runId)
      || created.input_digest !== input.digest || created.source_sha !== config.sourceSha || created.version !== config.version) throw new ReleaseError('SIGNING_REQUEST_MISMATCH');
    if (created.state === 'awaiting_upload') {
      const base = `${SIGNING_API}/${created.request_id}`;
      await uploadInput(fetch, base, config.apiKey, identityHeaders, archive, input);
      const completed = await retry(async () => apiJson(fetch, `${base}/source/complete`, 'POST', config.apiKey, {}, await identityHeaders(), 300_000));
      if (completed.state !== 'accepted_waiting_source') throw new ReleaseError('SIGNING_SOURCE_REJECTED');
    } else if (created.state !== 'accepted_waiting_source') throw new ReleaseError('SIGNING_SOURCE_REJECTED');
    const requestFile = path.join(required('INPUT_CONTEXT_DIR', process.env.INPUT_CONTEXT_DIR), `request-${config.project.id}.json`);
    await mkdir(path.dirname(requestFile), { recursive: true });
    await writeFile(requestFile, `${JSON.stringify({ project_id: config.project.id, request_id: created.request_id, input_digest: input.digest, input_size: input.size, version: config.version, source_sha: config.sourceSha, platform: config.project.platform, architecture: config.project.architecture })}\n`, { mode: 0o600, flag: 'wx' });
    if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `request_id=${created.request_id}\ninput_digest=${input.digest}\n`, { flag: 'a' });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function githubJson(url, token) {
  const response = await fetch(url, { redirect: 'error', headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) { await response.body?.cancel(); throw new ReleaseError('GITHUB_API_FAILED'); }
  return response.json();
}

async function streamToFile(response, file, maxBytes) {
  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length;
    if (size > maxBytes) return callback(new ReleaseError('SIGNED_ARCHIVE_TOO_LARGE'));
    hash.update(chunk);
    callback(null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
  return { size, digest: `sha256:${hash.digest('hex')}` };
}

function parseReport(report, request) {
  if (!report || report.request_id !== request.request_id || report.input_digest !== request.input_digest
    || report.version !== request.version || report.bundle_id !== BUNDLE_ID || report.architecture !== request.architecture
    || !SHA.test(report.recipe_sha ?? '') || !DIGEST.test(report.policy_digest ?? '') || !Array.isArray(report.files)) throw new ReleaseError('SIGNING_REPORT_MISMATCH');
  if (request.platform === 'macos') {
    if (report.stage !== 'dmg_finalize' || report.notarization_status !== 'Accepted' || report.codesign_verified !== true
      || report.timestamp_verified !== true || report.gatekeeper_verified !== true || report.staple_verified !== true
      || report.team_id !== '76DMUAK6J5' || report.files.length !== 1 || report.files[0].path !== 'product.dmg') throw new ReleaseError('MACOS_SIGNING_REPORT_INVALID');
  } else if (report.stage !== 'windows_sign' || report.subject !== 'CN=VOIDCARVE LABS, O=VOIDCARVE LABS, L=Mississauga, S=Ontario, C=CA'
    || report.authenticode_verified !== true || report.timestamp_verified !== true || report.nested_signatures_verified !== true
    || report.files.length !== 3 || !['product.exe', 'RELEASES'].every(name => report.files.some(file => file.path === name))
    || report.files.filter(file => /^[A-Za-z0-9][A-Za-z0-9_.-]*-full\.nupkg$/.test(file.path)).length !== 1) {
    throw new ReleaseError('WINDOWS_SIGNING_REPORT_INVALID');
  }
  for (const file of report.files) if (!Number.isSafeInteger(file.size) || file.size < 1 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new ReleaseError('SIGNING_REPORT_INVALID');
  return report;
}

async function extractEntry(archive, name, destination, expected) {
  const out = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  const child = spawn('unzip', ['-p', archive, name], { stdio: ['ignore', 'pipe', 'ignore'] });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length;
    if (size > expected.size) return callback(new ReleaseError('SIGNED_FILE_SIZE_MISMATCH'));
    hash.update(chunk);
    callback(null, chunk);
  } });
  try { await pipeline(child.stdout, meter, out); }
  catch { child.kill(); await closed; throw new ReleaseError('SIGNED_FILE_EXTRACT_FAILED'); }
  if ((await closed).code !== 0 || size !== expected.size || hash.digest('hex') !== expected.sha256) throw new ReleaseError('SIGNED_FILE_DIGEST_MISMATCH');
}

async function downloadAndVerify(request, apiKey, outDir) {
  let status;
  try {
    const response = await fetch(`${SIGNING_API}/${request.request_id}`, { headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new ReleaseError('SIGNING_STATUS_UNAVAILABLE', response.status >= 500 || response.status === 408 || response.status === 429);
    status = await response.json();
  } catch (error) {
    if (error instanceof ReleaseError) throw error;
    throw new ReleaseError('SIGNING_STATUS_UNAVAILABLE', true);
  }
  if (status.request_id !== request.request_id || status.project_id !== request.project_id || status.platform !== request.platform
    || status.source_run_id !== Number(process.env.INPUT_BUILD_RUN_ID) || status.source_sha !== request.source_sha
    || status.version !== request.version || status.input_digest !== request.input_digest) throw new ReleaseError('SIGNING_REQUEST_MISMATCH');
  if (status.state !== 'succeeded') return { done: false, failed: status.state === 'failed' || status.state === 'cancelled', error: status.error };
  const expectedArchive = status.output;
  if (!expectedArchive || !DIGEST.test(expectedArchive.archive_digest ?? '') || !Number.isSafeInteger(expectedArchive.archive_size)) throw new ReleaseError('SIGNING_OUTPUT_INVALID');
  const response = await fetch(`${SIGNING_API}/${request.request_id}/download`, { headers: { authorization: `Bearer ${apiKey}`, accept: 'application/octet-stream' }, redirect: 'error', signal: AbortSignal.timeout(300_000) });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new ReleaseError(response.status === 410 ? 'SIGNED_OUTPUT_EXPIRED' : 'SIGNED_OUTPUT_UNAVAILABLE', response.status === 409 || response.status >= 500 || response.status === 408 || response.status === 429); }
  const archiveHeader = response.headers.get('x-signing-archive-digest');
  const archive = path.join(outDir, `${request.project_id}.zip`);
  const actual = await streamToFile(response, archive, MAX_OUTPUT_BYTES);
  if (archiveHeader !== expectedArchive.archive_digest || actual.digest !== expectedArchive.archive_digest || actual.size !== expectedArchive.archive_size) throw new ReleaseError('SIGNED_ARCHIVE_MISMATCH');
  const entries = run('unzip', ['-Z1', archive]).trim().split(/\r?\n/).filter(Boolean);
  if (new Set(entries).size !== entries.length || entries.some(name => name.includes('/') || name.includes('\\')) || !entries.includes('verification.json')) throw new ReleaseError('SIGNED_ARCHIVE_CONTENT_INVALID');
  const allowed = request.platform === 'macos' ? new Set(['product.dmg', 'verification.json']) : new Set(['product.exe', 'product.nupkg', 'RELEASES', 'verification.json']);
  if (request.platform === 'windows') {
    const nupkgNames = entries.filter(name => /^[A-Za-z0-9][A-Za-z0-9_.-]*-full\.nupkg$/.test(name));
    allowed.add(nupkgNames[0]);
    if (nupkgNames.length !== 1) throw new ReleaseError('SIGNED_ARCHIVE_CONTENT_INVALID');
    allowed.delete('product.nupkg');
  }
  if (entries.some(name => !allowed.has(name))) throw new ReleaseError('SIGNED_ARCHIVE_CONTENT_INVALID');
  const report = parseReport(JSON.parse(run('unzip', ['-p', archive, 'verification.json'], { maxBuffer: 2_000_000 })), request);
  if (stableJson(report) !== stableJson(expectedArchive.report)) throw new ReleaseError('SIGNING_REPORT_MISMATCH');
  const reported = new Map(report.files.map(file => [file.path, file]));
  const outputMap = request.platform === 'macos'
    ? [['product.dmg', `Epilogue-v${request.version}-darwin-${request.architecture}.dmg`]]
    : [['product.exe', `Epilogue-v${request.version}-win32-${request.architecture}-Setup.exe`], [report.files.find(file => /-full\.nupkg$/.test(file.path)).path, report.files.find(file => /-full\.nupkg$/.test(file.path)).path], ['RELEASES', `Epilogue-v${request.version}-win32-${request.architecture}-RELEASES`]];
  for (const [entry, filename] of outputMap) await extractEntry(archive, entry, path.join(outDir, filename), reported.get(entry));
  const verification = `Epilogue-v${request.version}-${request.project_id}-verification.json`;
  await writeFile(path.join(outDir, verification), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rm(archive, { force: true });
  return { done: true };
}

async function publish() {
  const apiKey = required('SIGNING_API_KEY', process.env.SIGNING_API_KEY);
  const buildRunId = process.env.INPUT_BUILD_RUN_ID;
  const repository = required('GITHUB_REPOSITORY', process.env.GITHUB_REPOSITORY);
  const token = required('GITHUB_TOKEN', process.env.GITHUB_TOKEN);
  if (!/^\d+$/.test(buildRunId ?? '') || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new ReleaseError('INVALID_BUILD_RUN');
  const run = await githubJson(`https://api.github.com/repos/${repository}/actions/runs/${buildRunId}`, token);
  if (String(run.id) !== String(buildRunId) || run.path?.split('@')[0] !== '.github/workflows/release.yml' || run.event !== 'push'
    || run.status !== 'completed' || run.conclusion !== 'success' || run.run_attempt !== 1
    || !/^v\d+\.\d+\.\d+$/.test(run.head_branch ?? '') || !SHA.test(run.head_sha ?? '')) throw new ReleaseError('SOURCE_RUN_NOT_ALLOWED');
  const requestDir = path.resolve(required('INPUT_CONTEXT_DIR', process.env.INPUT_CONTEXT_DIR));
  const outDir = path.resolve(required('INPUT_OUTPUT_DIR', process.env.INPUT_OUTPUT_DIR));
  await mkdir(outDir, { recursive: true });
  const requests = [];
  for (const [lane, project] of Object.entries(PROJECTS)) {
    const file = path.join(requestDir, `request-${project.id}.json`);
    let request;
    try { request = JSON.parse(await readFile(file, 'utf8')); } catch { throw new ReleaseError('SOURCE_CONTEXT_INVALID'); }
    if (request.project_id !== project.id || request.platform !== project.platform || request.architecture !== project.architecture
      || request.version !== run.head_branch.slice(1) || request.source_sha !== run.head_sha || !UUID.test(request.request_id ?? '')
      || !DIGEST.test(request.input_digest ?? '') || !Number.isSafeInteger(request.input_size) || request.input_size < 1) throw new ReleaseError('SOURCE_CONTEXT_INVALID');
    requests.push({ lane, ...request });
  }
  const deadline = Date.now() + 5 * 60 * 1000;
  const pending = new Set(requests.map(request => request.request_id));
  while (pending.size && Date.now() < deadline) {
    for (const request of requests) {
      if (!pending.has(request.request_id)) continue;
      try {
        const result = await downloadAndVerify(request, apiKey, outDir);
        if (result.failed) throw new ReleaseError(`SIGNING_${String(result.error || 'FAILED').toUpperCase()}`);
        if (result.done) pending.delete(request.request_id);
      } catch (error) {
        if (!(error instanceof ReleaseError) || !error.transient) throw error;
      }
    }
    if (pending.size) await sleep(5_000);
  }
  if (pending.size) throw new ReleaseError('SIGNING_TIMEOUT');
  const linuxFiles = (await readdir(requestDir)).filter(name => /^Epilogue-v\d+\.\d+\.\d+-linux-(?:x64|arm64)\.deb$/.test(name));
  if (linuxFiles.length !== 2) throw new ReleaseError('LINUX_RELEASE_ASSETS_MISSING');
  for (const name of linuxFiles) await copyFile(path.join(requestDir, name), path.join(outDir, name));
  const assets = await readdir(outDir);
  const shaAssets = assets.filter(name => name.endsWith('.dmg') || name.endsWith('.exe') || name.endsWith('.nupkg') || name.endsWith('.deb') || name.endsWith('-RELEASES'));
  if (!shaAssets.length) throw new ReleaseError('RELEASE_ASSETS_MISSING');
  for (const name of shaAssets) {
    const { digest } = await digestFile(path.join(outDir, name));
    await writeFile(`${path.join(outDir, name)}.sha256`, `${digest.slice(7)} *${name}\n`, { mode: 0o600, flag: 'wx' });
  }
  if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `release_tag=${run.head_branch}\n`, { flag: 'a' });
}

async function main() {
  try {
    const command = process.argv[2];
    if (command === 'source') await submitSource();
    else if (command === 'publish') await publish();
    else throw new ReleaseError('INVALID_COMMAND');
  } catch (error) {
    process.stderr.write(`${error instanceof ReleaseError ? error.code : 'RELEASE_FAILED'}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
