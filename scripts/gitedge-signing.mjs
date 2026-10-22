import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_JSON_BYTES = 1_000_000;

export class GitEdgeSigningError extends Error {
  constructor(code, transient = false) {
    super(code);
    this.code = code;
    this.transient = transient;
  }
}

function required(value, code) {
  if (!value) throw new GitEdgeSigningError(code);
  return value;
}

function gatewayOrigin(env) {
  const value = required(env.GITEDGE_ORIGIN, 'GITEDGE_ORIGIN_UNAVAILABLE');
  let url;
  try { url = new URL(value); } catch { throw new GitEdgeSigningError('GITEDGE_ORIGIN_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash)
    throw new GitEdgeSigningError('GITEDGE_ORIGIN_INVALID');
  return url.origin;
}

async function json(response) {
  if (!response.body) throw new GitEdgeSigningError('SIGNING_RESPONSE_INVALID');
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_JSON_BYTES) throw new GitEdgeSigningError('SIGNING_RESPONSE_INVALID');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_JSON_BYTES) throw new GitEdgeSigningError('SIGNING_RESPONSE_INVALID');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
  catch { throw new GitEdgeSigningError('SIGNING_RESPONSE_INVALID'); }
}

function apiError(response) {
  return new GitEdgeSigningError(
    response.status === 401 || response.status === 403
      ? 'GITEDGE_SIGNING_AUTH_FAILED'
      : response.status === 404
        ? 'SIGNING_REQUEST_NOT_FOUND'
        : response.status === 410
          ? 'SIGNED_OUTPUT_UNAVAILABLE'
          : 'GITEDGE_SIGNING_REQUEST_FAILED',
    response.status >= 500 || response.status === 408 || response.status === 429,
  );
}

async function readGitHubJson(fetchImpl, url, token) {
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) { await response.body?.cancel(); throw new GitEdgeSigningError('SOURCE_ARTIFACT_UNAVAILABLE', response.status >= 500 || response.status === 408 || response.status === 429); }
  return json(response);
}

async function artifactProof(env, artifactId, fetchImpl) {
  const sourceRepositoryId = required(env.GITHUB_REPOSITORY_ID, 'SOURCE_REPOSITORY_ID_UNAVAILABLE');
  const sourceRunId = required(env.GITHUB_RUN_ID, 'SOURCE_RUN_ID_UNAVAILABLE');
  const sourceCommitOid = required(env.GITHUB_SHA, 'SOURCE_COMMIT_UNAVAILABLE');
  const repository = required(env.GITHUB_REPOSITORY, 'SOURCE_REPOSITORY_UNAVAILABLE');
  const githubToken = required(env.GITHUB_TOKEN, 'SOURCE_GITHUB_TOKEN_UNAVAILABLE');
  if (!/^[1-9]\d*$/.test(artifactId ?? '') || !/^[1-9]\d*$/.test(sourceRunId) || !/^[1-9]\d*$/.test(sourceRepositoryId) || !/^[a-f0-9]{40}$/.test(sourceCommitOid) || !/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new GitEdgeSigningError('SOURCE_ARTIFACT_INVALID');

  const artifactUrl = `https://api.github.com/repos/${repository}/actions/artifacts/${artifactId}`;
  const artifact = await readGitHubJson(fetchImpl, artifactUrl, githubToken);
  if (artifact?.expired !== false || artifact.name !== env.INPUT_ARTIFACT_NAME || artifact.workflow_run?.id !== Number(sourceRunId)
    || artifact.workflow_run?.head_sha !== sourceCommitOid || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1)
    throw new GitEdgeSigningError('SOURCE_ARTIFACT_MISMATCH');

  const archiveResponse = await fetchImpl(`${artifactUrl}/zip`, {
    headers: { authorization: `Bearer ${githubToken}`, accept: 'application/vnd.github+json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  if (archiveResponse.status !== 302) { await archiveResponse.body?.cancel(); throw new GitEdgeSigningError('SOURCE_ARTIFACT_UNAVAILABLE', archiveResponse.status >= 500 || archiveResponse.status === 408 || archiveResponse.status === 429); }
  const location = archiveResponse.headers.get('location');
  await archiveResponse.body?.cancel();
  if (!location) throw new GitEdgeSigningError('SOURCE_ARTIFACT_INVALID');
  let target;
  try { target = new URL(location); } catch { throw new GitEdgeSigningError('SOURCE_ARTIFACT_INVALID'); }
  if (target.protocol !== 'https:' || target.port || target.username || target.password
    || !(/^productionresultssa\d+\.blob\.core\.windows\.net$/.test(target.hostname)
      || target.hostname === 'pipelines.actions.githubusercontent.com' || target.hostname === 'results-receiver.actions.githubusercontent.com'))
    throw new GitEdgeSigningError('SOURCE_ARTIFACT_INVALID');
  const download = await fetchImpl(target, { redirect: 'error', signal: AbortSignal.timeout(600_000) });
  if (!download.ok || !download.body) { await download.body?.cancel(); throw new GitEdgeSigningError('SOURCE_ARTIFACT_UNAVAILABLE', download.status >= 500 || download.status === 408 || download.status === 429); }
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of download.body) {
    size += chunk.byteLength;
    if (size > artifact.size_in_bytes) throw new GitEdgeSigningError('SOURCE_ARTIFACT_SIZE_MISMATCH');
    hash.update(chunk);
  }
  if (size !== artifact.size_in_bytes) throw new GitEdgeSigningError('SOURCE_ARTIFACT_SIZE_MISMATCH');
  return {
    sourceRepositoryId,
    sourceRunId,
    sourceCommitOid,
    sourceArtifactId: String(artifactId),
    sourceDigest: `sha256:${hash.digest('hex')}`,
    sourceSize: size,
  };
}

async function sourceIdentity(env, audience, fetchImpl) {
  const endpoint = required(env.ACTIONS_ID_TOKEN_REQUEST_URL, 'SOURCE_IDENTITY_UNAVAILABLE');
  const requestToken = required(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, 'SOURCE_IDENTITY_UNAVAILABLE');
  let url;
  try { url = new URL(endpoint); } catch { throw new GitEdgeSigningError('SOURCE_IDENTITY_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !url.hostname.endsWith('.actions.githubusercontent.com'))
    throw new GitEdgeSigningError('SOURCE_IDENTITY_INVALID');
  url.searchParams.set('audience', audience);
  const response = await fetchImpl(url, { headers: { authorization: `Bearer ${requestToken}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) { await response.body?.cancel(); throw new GitEdgeSigningError('SOURCE_IDENTITY_UNAVAILABLE', response.status >= 500 || response.status === 408 || response.status === 429); }
  const token = (await json(response))?.value;
  if (typeof token !== 'string' || !token || token.length > 20_000 || /\s/.test(token)) throw new GitEdgeSigningError('SOURCE_IDENTITY_INVALID');
  return token;
}

export async function submitSigningRequest({ env = process.env, fetchImpl = fetch } = {}) {
  const origin = gatewayOrigin(env);
  const repositoryId = required(env.GITEDGE_RUNNER_REPOSITORY_ID, 'GITEDGE_RUNNER_REPOSITORY_ID_UNAVAILABLE');
  const token = required(env.GITEDGE_SIGNING_TOKEN, 'GITEDGE_SIGNING_TOKEN_UNAVAILABLE');
  const profile = required(env.INPUT_PROFILE, 'SIGNING_PROFILE_UNAVAILABLE');
  const platform = required(env.INPUT_PLATFORM, 'SIGNING_PLATFORM_UNAVAILABLE');
  const version = required(env.INPUT_VERSION, 'SIGNING_VERSION_UNAVAILABLE');
  if (!UUID.test(repositoryId) || !/^[a-z][a-z0-9-]{0,63}$/.test(profile) || !['macos', 'windows'].includes(platform) || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version))
    throw new GitEdgeSigningError('SIGNING_INPUT_INVALID');
  const artifactId = required(env.INPUT_ARTIFACT_ID, 'SOURCE_ARTIFACT_ID_UNAVAILABLE');
  const submission = {
    ...await artifactProof(env, artifactId, fetchImpl),
    profile,
    platform,
    version,
  };
  const identity = await sourceIdentity(env, origin, fetchImpl);
  const endpoint = new URL('/api/actions/signing/requests', origin);
  endpoint.searchParams.set('repositoryId', repositoryId);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'content-type': 'application/json',
        'idempotency-key': `epilogue-${profile}-${submission.sourceRunId}`,
        'x-run-identity': identity,
      },
      body: JSON.stringify(submission),
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new GitEdgeSigningError('GITEDGE_SIGNING_REQUEST_FAILED', true);
  }
  if (!response.ok) { await response.body?.cancel(); throw apiError(response); }
  const request = (await json(response))?.data?.request;
  if (!request || !UUID.test(request.id ?? '') || request.profile !== profile || request.platform !== platform
    || request.sourceDigest !== submission.sourceDigest || request.sourceSize !== submission.sourceSize)
    throw new GitEdgeSigningError('SIGNING_RESPONSE_INVALID');
  return { request_id: request.id, input_digest: request.sourceDigest, input_size: request.sourceSize, profile, platform };
}

export async function getSigningRequest({ env = process.env, requestId, fetchImpl = fetch } = {}) {
  const origin = gatewayOrigin(env);
  const repositoryId = required(env.GITEDGE_RUNNER_REPOSITORY_ID, 'GITEDGE_RUNNER_REPOSITORY_ID_UNAVAILABLE');
  const token = required(env.GITEDGE_SIGNING_TOKEN, 'GITEDGE_SIGNING_TOKEN_UNAVAILABLE');
  if (!UUID.test(requestId ?? '')) throw new GitEdgeSigningError('SIGNING_REQUEST_INVALID');
  const endpoint = new URL(`/api/actions/signing/requests/${requestId}`, origin);
  endpoint.searchParams.set('repositoryId', repositoryId);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new GitEdgeSigningError('GITEDGE_SIGNING_STATUS_UNAVAILABLE', true);
  }
  if (!response.ok) { await response.body?.cancel(); throw apiError(response); }
  const request = (await json(response))?.data;
  if (!request || request.id !== requestId || !['accepted', 'awaiting_source', 'queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(request.state)
    || !DIGEST.test(request.sourceDigest ?? '') || !Number.isSafeInteger(request.sourceSize) || request.sourceSize < 1
    || (request.outputDigest !== null && !DIGEST.test(request.outputDigest))
    || (request.outputSize !== null && (!Number.isSafeInteger(request.outputSize) || request.outputSize < 1)))
    throw new GitEdgeSigningError('SIGNING_RESPONSE_INVALID');
  return request;
}

export async function downloadSigningOutput({ env = process.env, request, destination, fetchImpl = fetch } = {}) {
  const origin = gatewayOrigin(env);
  const repositoryId = required(env.GITEDGE_RUNNER_REPOSITORY_ID, 'GITEDGE_RUNNER_REPOSITORY_ID_UNAVAILABLE');
  const token = required(env.GITEDGE_SIGNING_TOKEN, 'GITEDGE_SIGNING_TOKEN_UNAVAILABLE');
  if (!request || request.state !== 'succeeded' || !UUID.test(request.id ?? '') || !DIGEST.test(request.outputDigest ?? '')
    || !Number.isSafeInteger(request.outputSize) || request.outputSize < 1)
    throw new GitEdgeSigningError('SIGNED_OUTPUT_UNAVAILABLE');
  const endpoint = new URL(`/api/actions/signing/requests/${request.id}/download`, origin);
  endpoint.searchParams.set('repositoryId', repositoryId);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/zip' },
      redirect: 'error',
      signal: AbortSignal.timeout(1_800_000),
    });
  } catch {
    throw new GitEdgeSigningError('SIGNED_OUTPUT_UNAVAILABLE', true);
  }
  if (!response.ok || !response.body) { await response.body?.cancel(); throw apiError(response); }
  if (response.headers.get('X-Signing-Digest') !== request.outputDigest
    || response.headers.get('Content-Length') !== String(request.outputSize)) {
    await response.body.cancel();
    throw new GitEdgeSigningError('SIGNED_OUTPUT_MISMATCH');
  }
  const hash = createHash('sha256');
  let size = 0;
  const temporary = `${destination}.${randomUUID()}.partial`;
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > request.outputSize) return callback(new GitEdgeSigningError('SIGNED_OUTPUT_MISMATCH'));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), verifier, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    if (size !== request.outputSize || `sha256:${hash.digest('hex')}` !== request.outputDigest)
      throw new GitEdgeSigningError('SIGNED_OUTPUT_MISMATCH');
    await rename(temporary, destination);
  } catch (error) {
    if (error instanceof GitEdgeSigningError) throw error;
    throw new GitEdgeSigningError('SIGNED_OUTPUT_UNAVAILABLE', true);
  } finally {
    await rm(temporary, { force: true });
  }
  return destination;
}
