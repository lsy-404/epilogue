'use strict';
// stdio relay: MCP clients run this under ELECTRON_RUN_AS_NODE=1; stdout carries protocol bytes only.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HANDSHAKE_TIMEOUT_MS = 5000;
const CONNECT_BUDGET_MS = 15000;
const RETRY_DELAY_MS = 250;
const NOT_RUNNING = 'Epilogue Pro 未激活或本地服务未启动 / Epilogue Pro is not active or its local service is not running';

function parseArgs(argv) {
  const out = { service: null, client: 'unknown', launch: true };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--service') out.service = argv[++i] ?? null;
    else if (argv[i] === '--client') out.client = argv[++i] ?? out.client;
    else if (argv[i] === '--no-launch') out.launch = false;
  }
  return out;
}

// service.json lives at <userData>/pro/, so the launched app must use that same userData directory.
function launchCommand({ execPath = process.execPath, dir = __dirname, service } = {}) {
  const packaged = dir.split(/[\\/]/).includes('app.asar');
  const appRoot = path.resolve(dir, '..', '..');
  const flags = ['--hidden', '--epilogue-service'];
  if (service) flags.push(`--user-data-dir=${path.dirname(path.dirname(path.resolve(service)))}`);
  return { command: execPath, args: packaged ? flags : [appRoot, ...flags] };
}

function launchApp(service) {
  const { command, args } = launchCommand({ service });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(command, args, { detached: true, stdio: 'ignore', env, windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

function readService(file) {
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (info?.v === 1 && typeof info.endpoint === 'string' && typeof info.token === 'string') return info;
  } catch {}
  return null;
}

// Resolves { socket, rest } once the server accepted the handshake, or null on any failure.
function connectOnce(info, client) {
  return new Promise((resolve) => {
    const socket = net.connect(info.endpoint);
    let buf = Buffer.alloc(0);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('data', onData);
      if (!value) socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), HANDSHAKE_TIMEOUT_MS);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return;
      let reply = null;
      try { reply = JSON.parse(buf.subarray(0, nl).toString('utf8')); } catch {}
      finish(reply?.ok === true ? { socket, rest: buf.subarray(nl + 1) } : null);
    };
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(null));
    socket.on('data', onData);
    socket.on('connect', () => socket.write(`${JSON.stringify({ epilogue: 1, token: info.token, client })}\n`));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect({ service, client, launch }) {
  const attempt = async () => {
    const info = readService(service);
    return info ? connectOnce(info, client) : null;
  };
  let conn = await attempt();
  if (conn || !launch) return conn;
  launchApp(service);
  const deadline = Date.now() + CONNECT_BUDGET_MS;
  while (!conn && Date.now() < deadline) {
    await sleep(RETRY_DELAY_MS);
    conn = await attempt();
  }
  return conn;
}

function exitAfterFlush(code) {
  process.stdout.write('', () => process.exit(code));
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (!opts.service) {
    process.stderr.write('usage: integrationBridge.js --service <service.json> [--client <name>] [--no-launch]\n');
    process.exit(2);
  }

  const pending = [];
  let socket = null;
  let stdinEnded = false;
  let probe = Buffer.alloc(0);
  process.stdin.on('data', (chunk) => {
    if (socket) socket.write(chunk);
    else {
      pending.push(chunk);
      probe = Buffer.concat([probe, chunk]);
    }
  });
  process.stdin.on('end', () => {
    stdinEnded = true;
    if (socket) {
      socket.end();
      setTimeout(() => process.exit(0), 2000).unref();
    }
  });
  process.stdin.on('error', () => {});
  process.stdout.on('error', () => process.exit(0));

  const conn = await connect(opts);
  if (!conn) {
    process.stderr.write(`${NOT_RUNNING}\n`);
    // Answer the client's first request so it fails fast instead of timing out.
    while (probe.indexOf(0x0a) < 0 && !stdinEnded) await sleep(20);
    const nl = probe.indexOf(0x0a);
    let id;
    try { id = JSON.parse(probe.subarray(0, nl < 0 ? probe.length : nl).toString('utf8')).id; } catch {}
    if (id !== undefined && id !== null) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: NOT_RUNNING } })}\n`);
    }
    return exitAfterFlush(1);
  }

  socket = conn.socket;
  socket.on('error', () => {});
  socket.on('close', () => exitAfterFlush(0));
  if (conn.rest.length) process.stdout.write(conn.rest);
  socket.pipe(process.stdout, { end: false });
  for (const chunk of pending.splice(0)) socket.write(chunk);
  if (stdinEnded) {
    socket.end();
    setTimeout(() => process.exit(0), 2000).unref();
  }
}

if (require.main === module) main();

module.exports = { parseArgs, launchCommand, readService, connectOnce, NOT_RUNNING };
