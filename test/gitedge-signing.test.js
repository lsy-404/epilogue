'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const sha256 = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const repositoryId = '13814fa3-8580-4b5a-803e-a6b1206007ed';
const requestId = 'ae650e0d-c9ac-4ee5-a339-885b966dcb50';

function sourceEnvironment() {
  return {
    GITEDGE_ORIGIN: 'https://gitedge.voidcarve.com',
    GITEDGE_RUNNER_REPOSITORY_ID: repositoryId,
    GITEDGE_SIGNING_TOKEN: 'test-token',
    GITHUB_REPOSITORY_ID: '123456',
    GITHUB_REPOSITORY: 'owner/epilogue',
    GITHUB_RUN_ID: '987654',
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_TOKEN: 'github-token',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.githubusercontent.com/id?x=y',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-request-token',
    INPUT_ARTIFACT_ID: '4567',
    INPUT_ARTIFACT_NAME: 'epilogue-windows-x64-source',
    INPUT_PROFILE: 'epilogue-windows-x64',
    INPUT_PLATFORM: 'windows',
    INPUT_VERSION: '0.5.4',
  };
}

test('GitEdge submission binds the full GitHub artifact ZIP and exact OIDC audience', async () => {
  const artifact = Buffer.from('github artifact archive');
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.pathname.endsWith('/actions/artifacts/4567')) return Response.json({
      expired: false,
      name: 'epilogue-windows-x64-source',
      size_in_bytes: artifact.length,
      workflow_run: { id: 987654, head_sha: 'a'.repeat(40) },
    });
    if (url.pathname.endsWith('/actions/artifacts/4567/zip')) return new Response(null, {
      status: 302,
      headers: { location: 'https://productionresultssa1.blob.core.windows.net/result' },
    });
    if (url.hostname === 'productionresultssa1.blob.core.windows.net') return new Response(artifact);
    if (url.hostname === 'token.actions.githubusercontent.com') return Response.json({ value: 'signed-oidc' });
    if (url.pathname === '/api/actions/signing/requests') return Response.json({ data: { request: {
      id: requestId,
      profile: 'epilogue-windows-x64',
      platform: 'windows',
      sourceDigest: sha256(artifact),
      sourceSize: artifact.length,
    } } });
    throw new Error(`Unexpected request ${url}`);
  };
  const { submitSigningRequest } = await import('../scripts/gitedge-signing.mjs');
  const result = await submitSigningRequest({ env: sourceEnvironment(), fetchImpl });

  assert.deepEqual(result, {
    request_id: requestId,
    input_digest: sha256(artifact),
    input_size: artifact.length,
    profile: 'epilogue-windows-x64',
    platform: 'windows',
  });
  const submission = JSON.parse(calls.at(-1).init.body);
  assert.equal(submission.sourceDigest, sha256(artifact));
  assert.equal(submission.sourceSize, artifact.length);
  assert.equal(calls.at(-1).url.searchParams.get('repositoryId'), repositoryId);
  assert.equal(calls.at(-1).init.headers['idempotency-key'], 'epilogue-epilogue-windows-x64-987654');
  assert.equal(calls.at(-1).init.headers['x-run-identity'], 'signed-oidc');
  assert.equal(new URL(calls.find(call => call.url.hostname === 'token.actions.githubusercontent.com').url).searchParams.get('audience'), 'https://gitedge.voidcarve.com');
});

test('GitEdge submission rejects a GitHub artifact size that differs from the downloaded ZIP', async () => {
  const fetchImpl = async input => {
    const url = new URL(input);
    if (url.pathname.endsWith('/actions/artifacts/4567')) return Response.json({
      expired: false,
      name: 'epilogue-windows-x64-source',
      size_in_bytes: 99,
      workflow_run: { id: 987654, head_sha: 'a'.repeat(40) },
    });
    if (url.pathname.endsWith('/actions/artifacts/4567/zip')) return new Response(null, {
      status: 302,
      headers: { location: 'https://productionresultssa1.blob.core.windows.net/result' },
    });
    if (url.hostname === 'productionresultssa1.blob.core.windows.net') return new Response('short');
    throw new Error(`Unexpected request ${url}`);
  };
  const { submitSigningRequest, GitEdgeSigningError } = await import('../scripts/gitedge-signing.mjs');
  await assert.rejects(submitSigningRequest({ env: sourceEnvironment(), fetchImpl }), error =>
    error instanceof GitEdgeSigningError && error.code === 'SOURCE_ARTIFACT_SIZE_MISMATCH');
});

test('GitEdge status reads the native data envelope and rejects a mismatched request', async () => {
  const request = {
    id: requestId,
    profile: 'epilogue-macos-arm64',
    platform: 'macos',
    state: 'succeeded',
    sourceDigest: sha256(Buffer.from('source')),
    sourceSize: 6,
    outputDigest: sha256(Buffer.from('output')),
    outputSize: 6,
  };
  const env = {
    GITEDGE_ORIGIN: 'https://gitedge.voidcarve.com',
    GITEDGE_RUNNER_REPOSITORY_ID: repositoryId,
    GITEDGE_SIGNING_TOKEN: 'test-token',
  };
  const { getSigningRequest, GitEdgeSigningError } = await import('../scripts/gitedge-signing.mjs');
  const fetchImpl = async input => {
    assert.equal(new URL(input).searchParams.get('repositoryId'), repositoryId);
    return Response.json({ data: request });
  };
  assert.deepEqual(await getSigningRequest({ env, requestId, fetchImpl }), request);
  await assert.rejects(getSigningRequest({ env, requestId, fetchImpl: async () => Response.json({ data: { ...request, id: 'wrong' } }) }), error =>
    error instanceof GitEdgeSigningError && error.code === 'SIGNING_RESPONSE_INVALID');
});

test('GitEdge output download requires matching digest headers and body bytes', async () => {
  const payload = Buffer.from('signed output zip bytes');
  const request = {
    id: requestId,
    state: 'succeeded',
    outputDigest: sha256(payload),
    outputSize: payload.length,
  };
  const env = {
    GITEDGE_ORIGIN: 'https://gitedge.voidcarve.com',
    GITEDGE_RUNNER_REPOSITORY_ID: repositoryId,
    GITEDGE_SIGNING_TOKEN: 'test-token',
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'epilogue-gitedge-'));
  const destination = path.join(dir, 'output.zip');
  try {
    const { downloadSigningOutput, GitEdgeSigningError } = await import('../scripts/gitedge-signing.mjs');
    const fetchImpl = async () => new Response(payload, { headers: {
      'X-Signing-Digest': sha256(payload),
      'Content-Length': String(payload.length),
    } });
    await downloadSigningOutput({ env, request, destination, fetchImpl });
    assert.deepEqual(await fs.readFile(destination), payload);

    await fs.rm(destination);
    await assert.rejects(downloadSigningOutput({ env, request, destination, fetchImpl: async () => new Response(payload, {
      headers: { 'X-Signing-Digest': sha256(Buffer.from('wrong')), 'Content-Length': String(payload.length) },
    }) }), error => error instanceof GitEdgeSigningError && error.code === 'SIGNED_OUTPUT_MISMATCH');
    await assert.rejects(fs.access(destination));
    const altered = Buffer.from(payload);
    altered[0] ^= 1;
    await assert.rejects(downloadSigningOutput({ env, request, destination, fetchImpl: async () => new Response(altered, {
      headers: { 'X-Signing-Digest': request.outputDigest, 'Content-Length': String(request.outputSize) },
    }) }), error => error instanceof GitEdgeSigningError && error.code === 'SIGNED_OUTPUT_MISMATCH');
    await assert.rejects(fs.access(destination));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
