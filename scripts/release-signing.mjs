import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadSigningOutput, getSigningRequest, GitEdgeSigningError, submitSigningRequest } from './gitedge-signing.mjs';

const LANES = Object.freeze({
  'macos-arm64': { profile: 'epilogue-macos-arm64', artifactName: 'epilogue-macos-arm64-source', platform: 'macos', architecture: 'arm64' },
  'windows-x64': { profile: 'epilogue-windows-x64', artifactName: 'epilogue-windows-x64-source', platform: 'windows', architecture: 'x64' },
  'windows-arm64': { profile: 'epilogue-windows-arm64', artifactName: 'epilogue-windows-arm64-source', platform: 'windows', architecture: 'arm64' },
});
const BUNDLE_ID = 'com.electron.epilogue';
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MARKER = '.epilogue-signing-source';

class ReleaseError extends Error {
  constructor(code, transient = false) { super(code); this.code = code; this.transient = transient; }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
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

function validateInputs({ platform, architecture, version, sourceSha, runId, runAttempt }) {
  const lane = `${platform}-${architecture}`;
  const config = LANES[lane];
  if (!config || !VERSION.test(version ?? '') || !SHA.test(sourceSha ?? '') || !/^\d+$/.test(runId ?? '')
    || !Number.isSafeInteger(Number(runId)) || runAttempt !== '1') throw new ReleaseError('INVALID_SIGNING_INPUT');
  return { lane, ...config, version, sourceSha, runId: String(Number(runId)) };
}

async function createPayload(config, temp) {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const app = path.join(packageRoot, 'dist', `Epilogue-${config.platform === 'macos' ? 'darwin' : 'win32'}-${config.architecture}`);
  if (!(await lstat(app).catch(() => null))?.isDirectory()) throw new ReleaseError('PACKAGED_APP_MISSING');
  const stage = path.join(temp, 'source');
  await mkdir(stage, { mode: 0o700 });
  await writeFile(path.join(stage, 'source.json'), `${JSON.stringify({ source_sha: config.sourceSha, version: config.version, bundle_id: BUNDLE_ID, architecture: config.architecture })}\n`, { mode: 0o600, flag: 'wx' });
  if (config.platform === 'macos') {
    const appBundle = path.join(app, 'Epilogue.app');
    if (!(await lstat(appBundle).catch(() => null))?.isDirectory()) throw new ReleaseError('MACOS_APP_MISSING');
    const unsigned = path.join(stage, 'unsigned.tar.gz');
    run('tar', ['-czf', unsigned, '-C', app, 'Epilogue.app']);
    const templateRoot = path.join(temp, 'template-root');
    await mkdir(templateRoot, { mode: 0o700 });
    await cp(appBundle, path.join(templateRoot, 'Epilogue.app'), { recursive: true, verbatimSymlinks: true });
    await run('ln', ['-s', '/Applications', path.join(templateRoot, 'Applications')]);
    const template = path.join(stage, 'template.dmg');
    run('hdiutil', ['create', '-volname', 'Epilogue', '-srcfolder', templateRoot, '-ov', '-format', 'UDZO', template]);
  } else {
    await mkdir(path.join(stage, 'app'), { mode: 0o700 });
    await cp(app, path.join(stage, 'app'), { recursive: true, verbatimSymlinks: true });
    await copyFile(path.join(packageRoot, 'build', 'icon.ico'), path.join(stage, 'app', 'resources', 'installer.ico'));
  }
}

async function prepareSource() {
  const config = validateInputs({
    platform: process.env.INPUT_PLATFORM, architecture: process.env.INPUT_ARCHITECTURE,
    version: process.env.INPUT_VERSION, sourceSha: process.env.INPUT_SOURCE_SHA,
    runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  });
  const tempRoot = required('RUNNER_TEMP', process.env.RUNNER_TEMP);
  const temp = await mkdtemp(path.join(tempRoot, `epilogue-${config.lane}-`));
  await chmod(temp, 0o700);
  try {
    await createPayload(config, temp);
    await writeFile(path.join(temp, MARKER), `${config.runId}\n${config.lane}\n`, { mode: 0o600, flag: 'wx' });
    if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `source_dir=${path.join(temp, 'source')}\nwork_dir=${temp}\n`, { flag: 'a' });
  } finally {
    if (!process.env.GITHUB_OUTPUT) await rm(temp, { recursive: true, force: true });
  }
}

async function submitSource() {
  const config = validateInputs({
    platform: process.env.INPUT_PLATFORM, architecture: process.env.INPUT_ARCHITECTURE,
    version: process.env.INPUT_VERSION, sourceSha: process.env.INPUT_SOURCE_SHA,
    runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  });
  const tempRoot = path.resolve(required('RUNNER_TEMP', process.env.RUNNER_TEMP));
  const workDir = path.resolve(required('INPUT_WORK_DIR', process.env.INPUT_WORK_DIR));
  if (path.dirname(workDir) !== tempRoot || !path.basename(workDir).startsWith(`epilogue-${config.lane}-${config.runId}-`)) throw new ReleaseError('SOURCE_CONTEXT_INVALID');
  const marker = await readFile(path.join(workDir, MARKER), 'utf8').catch(() => '');
  if (marker !== `${config.runId}\n${config.lane}\n`) throw new ReleaseError('SOURCE_CONTEXT_INVALID');
  const sourceDir = path.join(workDir, 'source');
  const names = (await readdir(sourceDir)).sort();
  const expectedNames = config.platform === 'macos' ? ['source.json', 'template.dmg', 'unsigned.tar.gz'] : ['app', 'source.json'];
  if (names.join('\n') !== expectedNames.join('\n')) throw new ReleaseError('SOURCE_CONTEXT_INVALID');
  let metadata;
  try { metadata = JSON.parse(await readFile(path.join(sourceDir, 'source.json'), 'utf8')); }
  catch { throw new ReleaseError('SOURCE_CONTEXT_INVALID'); }
  if (metadata.source_sha !== config.sourceSha || metadata.version !== config.version
    || metadata.bundle_id !== BUNDLE_ID || metadata.architecture !== config.architecture) throw new ReleaseError('SOURCE_CONTEXT_INVALID');
  const artifactId = required('INPUT_ARTIFACT_ID', process.env.INPUT_ARTIFACT_ID);
  try {
    const result = await submitSigningRequest({
      env: {
        ...process.env,
        INPUT_ARTIFACT_NAME: config.artifactName,
        INPUT_PROFILE: config.profile,
        INPUT_PLATFORM: config.platform,
        INPUT_VERSION: config.version,
        INPUT_ARTIFACT_ID: artifactId,
      },
    });
    const requestFile = path.join(required('INPUT_CONTEXT_DIR', process.env.INPUT_CONTEXT_DIR), `request-${config.profile}.json`);
    await mkdir(path.dirname(requestFile), { recursive: true });
    await writeFile(requestFile, `${JSON.stringify({ profile: config.profile, request_id: result.request_id,
      input_digest: result.input_digest, input_size: result.input_size, version: config.version,
      source_sha: config.sourceSha, platform: config.platform, architecture: config.architecture })}\n`, { mode: 0o600, flag: 'wx' });
    if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT,
      `request_id=${result.request_id}\ninput_digest=${result.input_digest}\ninput_size=${result.input_size}\nprofile=${config.profile}\n`, { flag: 'a' });
  } catch (error) {
    if (error instanceof GitEdgeSigningError) throw new ReleaseError(error.code, error.transient);
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function githubJson(url, token) {
  const response = await fetch(url, { redirect: 'error', headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) { await response.body?.cancel(); throw new ReleaseError('GITHUB_API_FAILED'); }
  return response.json();
}

function parseReport(report, request) {
  if (!report || report.request_id !== request.request_id || !DIGEST.test(report.input_digest ?? '') || (request.platform === 'windows' && report.input_digest !== request.input_digest)
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

async function downloadAndVerify(request, outDir) {
  const signingEnv = process.env;
  let status;
  try { status = await getSigningRequest({ env: signingEnv, requestId: request.request_id }); }
  catch (error) {
    if (error instanceof GitEdgeSigningError) throw new ReleaseError(error.code, error.transient);
    throw new ReleaseError('SIGNING_STATUS_UNAVAILABLE', true);
  }
  if (status.id !== request.request_id || status.profile !== request.profile || status.platform !== request.platform
    || status.sourceDigest !== request.input_digest || status.sourceSize !== request.input_size) throw new ReleaseError('SIGNING_REQUEST_MISMATCH');
  if (status.state !== 'succeeded') return { done: false, failed: status.state === 'failed' || status.state === 'cancelled', error: status.state };
  const archive = path.join(outDir, `${request.profile}.zip`);
  try { await downloadSigningOutput({ env: signingEnv, request: status, destination: archive }); }
  catch (error) {
    if (error instanceof GitEdgeSigningError) throw new ReleaseError(error.code, error.transient);
    throw new ReleaseError('SIGNED_OUTPUT_UNAVAILABLE', true);
  }
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
  const reported = new Map(report.files.map(file => [file.path, file]));
  const outputMap = request.platform === 'macos'
    ? [['product.dmg', `Epilogue-v${request.version}-darwin-${request.architecture}.dmg`]]
    : [['product.exe', `Epilogue-v${request.version}-win32-${request.architecture}-Setup.exe`], [report.files.find(file => /-full\.nupkg$/.test(file.path)).path, report.files.find(file => /-full\.nupkg$/.test(file.path)).path], ['RELEASES', `Epilogue-v${request.version}-win32-${request.architecture}-RELEASES`]];
  for (const [entry, filename] of outputMap) await extractEntry(archive, entry, path.join(outDir, filename), reported.get(entry));
  const verification = `Epilogue-v${request.version}-${request.profile}-verification.json`;
  await writeFile(path.join(outDir, verification), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rm(archive, { force: true });
  return { done: true };
}

async function publish() {
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
  for (const [lane, config] of Object.entries(LANES)) {
    const file = path.join(requestDir, `request-${config.profile}.json`);
    let request;
    try { request = JSON.parse(await readFile(file, 'utf8')); } catch { throw new ReleaseError('SOURCE_CONTEXT_INVALID'); }
    if (request.profile !== config.profile || request.platform !== config.platform || request.architecture !== config.architecture
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
        const result = await downloadAndVerify(request, outDir);
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
    if (command === 'prepare') await prepareSource();
    else if (command === 'submit') await submitSource();
    else if (command === 'publish') await publish();
    else throw new ReleaseError('INVALID_COMMAND');
  } catch (error) {
    process.stderr.write(`${error instanceof ReleaseError ? error.code : 'RELEASE_FAILED'}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
