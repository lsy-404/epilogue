'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { launchCommand, parseArgs, NOT_RUNNING } = require('../src/main/integrationBridge');

const BRIDGE = path.join(__dirname, '..', 'src', 'main', 'integrationBridge.js');
const TOKEN = 'tok-123';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epi-bridge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function endpointFor(dir) {
  return process.platform === 'win32' ? `\\\\.\\pipe\\epi-bridge-${path.basename(dir)}` : path.join(dir, 's.sock');
}

// Fake server: speaks the handshake (optionally delayed), then echoes uppercase and records what the client sent.
async function startServer(t, dir, { handshakeDelay = 0 } = {}) {
  const endpoint = endpointFor(dir);
  const state = { hello: null, received: '', sockets: [] };
  const server = net.createServer((socket) => {
    state.sockets.push(socket);
    let buf = '';
    let shaken = false;
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (!shaken) {
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        state.hello = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (state.hello.token !== TOKEN) {
          socket.end('{"ok":false,"error":"unauthorized"}\n');
          return;
        }
        shaken = true;
        setTimeout(() => socket.write('{"ok":true}\n'), handshakeDelay);
      }
      if (buf) {
        state.received += buf;
        const reply = buf.toUpperCase();
        setTimeout(() => socket.write(reply), handshakeDelay);
        buf = '';
      }
    });
  });
  await new Promise((resolve) => server.listen(endpoint, resolve));
  t.after(() => {
    for (const s of state.sockets) s.destroy();
    server.close();
  });
  const service = path.join(dir, 'service.json');
  fs.writeFileSync(service, JSON.stringify({ v: 1, endpoint, token: TOKEN, pid: process.pid, version: 'test' }));
  return { state, service };
}

function runBridge(args) {
  const child = spawn(process.execPath, [BRIDGE, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (c) => { out.stdout += c; });
  child.stderr.on('data', (c) => { out.stderr += c; });
  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  return { child, out, exited };
}

async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    assert.ok(Date.now() < end, 'timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('relay handshakes with the client name then forwards bytes both ways', async (t) => {
  const dir = tmpDir(t);
  const { state, service } = await startServer(t, dir);
  const { child, out, exited } = runBridge(['--service', service, '--client', 'tester', '--no-launch']);
  child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  await until(() => out.stdout.includes('"PING"'));
  assert.deepEqual(state.hello, { epilogue: 1, token: TOKEN, client: 'tester' });
  assert.equal(out.stdout, '{"JSONRPC":"2.0","ID":1,"METHOD":"PING"}\n');
  child.stdin.write('partial');
  child.stdin.write(' line\n');
  await until(() => out.stdout.includes('PARTIAL LINE'));
  assert.equal(state.received, '{"jsonrpc":"2.0","id":1,"method":"ping"}\npartial line\n');
  child.stdin.end();
  assert.equal(await exited, 0);
});

test('bytes written before the handshake finishes are forwarded afterwards', async (t) => {
  const dir = tmpDir(t);
  const { state, service } = await startServer(t, dir, { handshakeDelay: 300 });
  const { child, out, exited } = runBridge(['--service', service, '--no-launch']);
  child.stdin.write('early\n');
  await until(() => out.stdout.includes('EARLY'));
  assert.equal(state.received, 'early\n');
  assert.equal(out.stdout, 'EARLY\n');
  child.stdin.end();
  await exited;
});

test('a bad token ends in the JSON-RPC error for the first request and exit code 1', async (t) => {
  const dir = tmpDir(t);
  const { service } = await startServer(t, dir);
  const info = JSON.parse(fs.readFileSync(service, 'utf8'));
  fs.writeFileSync(service, JSON.stringify({ ...info, token: 'wrong' }));
  const { child, out, exited } = runBridge(['--service', service, '--no-launch']);
  child.stdin.write('{"jsonrpc":"2.0","id":7,"method":"initialize"}\n');
  assert.equal(await exited, 1);
  assert.deepEqual(JSON.parse(out.stdout), { jsonrpc: '2.0', id: 7, error: { code: -32000, message: NOT_RUNNING } });
});

test('a missing service file with --no-launch replies with the error and nothing else on stdout', async (t) => {
  const dir = tmpDir(t);
  const { child, out, exited } = runBridge(['--service', path.join(dir, 'absent.json'), '--no-launch']);
  child.stdin.write('{"jsonrpc":"2.0","id":"a","method":"initialize"}\n');
  assert.equal(await exited, 1);
  assert.equal(out.stdout, `${JSON.stringify({ jsonrpc: '2.0', id: 'a', error: { code: -32000, message: NOT_RUNNING } })}\n`);
  assert.match(out.stderr, /Epilogue Pro/);
});

test('without an installed Pro package the relay fails at once instead of launching the app', async (t) => {
  const dir = tmpDir(t);
  const started = Date.now();
  const { child, out, exited } = runBridge(['--service', path.join(dir, 'pro', 'service.json')]);
  child.stdin.write('{"jsonrpc":"2.0","id":7,"method":"initialize"}\n');
  assert.equal(await exited, 1);
  assert.ok(Date.now() - started < 5000);
  assert.equal(out.stdout, `${JSON.stringify({ jsonrpc: '2.0', id: 7, error: { code: -32000, message: NOT_RUNNING } })}\n`);
});

test('a notification as the first message gets no reply', async (t) => {
  const dir = tmpDir(t);
  const { child, out, exited } = runBridge(['--service', path.join(dir, 'absent.json'), '--no-launch']);
  child.stdin.end('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  assert.equal(await exited, 1);
  assert.equal(out.stdout, '');
});

test('the relay exits when the server closes the connection mid-stream', async (t) => {
  const dir = tmpDir(t);
  const { state, service } = await startServer(t, dir);
  const { child, out, exited } = runBridge(['--service', service, '--no-launch']);
  child.stdin.write('hello\n');
  await until(() => out.stdout.includes('HELLO'));
  state.sockets[0].destroy();
  assert.equal(await exited, 0);
});

test('launch arguments differ between packaged and development layouts', () => {
  const dev = launchCommand({ execPath: '/x/electron', dir: path.join('/repo', 'src', 'main') });
  assert.deepEqual(dev, { command: '/x/electron', args: [path.resolve('/repo'), '--hidden', '--epilogue-service'] });
  const packaged = launchCommand({ execPath: '/x/Epilogue', dir: '/x/resources/app.asar/src/main' });
  assert.deepEqual(packaged, { command: '/x/Epilogue', args: ['--hidden', '--epilogue-service'] });
  const windows = launchCommand({ execPath: 'C:\\x\\Epilogue.exe', dir: 'C:\\x\\resources\\app.asar\\src\\main' });
  assert.deepEqual(windows.args, ['--hidden', '--epilogue-service']);
  const withService = launchCommand({ execPath: '/x/Epilogue', dir: '/x/resources/app.asar/src/main', service: path.join('/data', 'Epilogue', 'pro', 'service.json') });
  assert.deepEqual(withService.args, ['--hidden', '--epilogue-service', `--user-data-dir=${path.resolve('/data', 'Epilogue')}`]);
  assert.deepEqual(parseArgs(['--service', 'a.json', '--client', 'c', '--no-launch']), { service: 'a.json', client: 'c', launch: false });
});
