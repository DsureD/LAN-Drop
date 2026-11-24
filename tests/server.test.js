import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const websocketModule = await import('ws').catch(() => null);

async function until(predicate, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for server message');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function allocatePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

test('real HTTP and WebSocket service serves assets, isolates rooms and rejects foreign origins', { skip: !websocketModule }, async context => {
  const port = await allocatePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), MODE: 'room', DEBUG: '', MEMORY_LIMIT_MB: '', ACCESS_PASSWORD: '', ALLOW_PASSWORDLESS_LAN: 'false', TRUSTED_PROXIES: '', ALLOWED_ORIGINS: '', ICE_SERVERS: '[]', MAX_CLIENTS: '256', MAX_CONNECTIONS_PER_IP: '16', MAX_ROOM_PEERS: '32', ROOM_IDLE_MINUTES: '30' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  context.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });
  let output = '';
  let errors = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { errors += data; });
  child.on('error', error => { errors += error.message; });
  await until(() => output.includes('LAN Drop listening') || errors);
  assert.equal(errors, '');

  const health = await fetch(`${base}/health`);
  assert.deepEqual(await health.json(), { status: 'ok' });
  const config = await fetch(`${base}/config.js?v=security-1`);
  assert.equal(config.headers.get('cache-control'), 'no-store');
  assert.match(config.headers.get('content-type'), /javascript/);
  assert.equal(await config.text(), 'window.LAN_DROP_CONFIG = {"debug":false,"memoryLimitBytes":536870912};');
  const configHead = await fetch(`${base}/config.js`, { method: 'HEAD' });
  assert.equal(configHead.status, 200);
  assert.equal(await configHead.text(), '');
  const page = await fetch(base);
  assert.ok((await page.text()).includes('文件，'));
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.ok(page.headers.get('content-security-policy').includes(`connect-src 'self' ws://127.0.0.1:${port} wss://127.0.0.1:${port};`));
  const publicHostPolicy = await new Promise((resolve, reject) => {
    http.get(base, { headers: { Host: 'lan.newsi.tech' } }, response => {
      resolve(response.headers['content-security-policy']);
      response.resume();
    }).on('error', reject);
  });
  assert.ok(publicHostPolicy.includes('wss://lan.newsi.tech'));
  for (const resource of ['/styles.css?v=security-1', '/boot.js?v=security-1', '/app.js?v=security-1', '/dialogs.js?v=security-1', '/history.js?v=security-1', '/transfer.js', '/protocol.js', '/favicon.svg', '/vendor/qrcode.js']) assert.equal((await fetch(base + resource)).status, 200, resource);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 403);
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
  assert.equal((await fetch(base, { method: 'HEAD' })).status, 200);

  const WebSocket = websocketModule.default;
  function connect() {
    const connection = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: base });
    const messages = [];
    connection.on('message', data => messages.push(JSON.parse(data)));
    connection.on('error', () => {});
    context.after(() => connection.terminate());
    return { connection, messages, send(message) { connection.send(JSON.stringify(message)); } };
  }
  const first = connect();
  const second = connect();
  await until(() => first.messages.some(message => message.type === 'ready') && second.messages.some(message => message.type === 'ready'));
  first.send({ type: 'hello', name: '电脑' });
  second.send({ type: 'hello', name: '手机', device: 'phone' });
  await until(() => first.messages.some(message => message.type === 'welcome') && second.messages.some(message => message.type === 'welcome'));
  const firstId = first.messages.find(message => message.type === 'welcome').id;
  const secondId = second.messages.find(message => message.type === 'welcome').id;
  first.send({ type: 'signal', to: secondId, signal: { kind: 'connect' } });
  await until(() => first.messages.some(message => message.code === 'peer-missing'));
  first.send({ type: 'create-room' });
  await until(() => first.messages.some(message => message.type === 'room-state'));
  const code = first.messages.find(message => message.type === 'room-state').code;
  second.send({ type: 'join-room', code });
  await until(() => first.messages.some(message => message.type === 'room-state' && message.peers.length === 1));
  first.send({ type: 'signal', to: secondId, signal: { kind: 'connect' } });
  await until(() => second.messages.some(message => message.type === 'signal'));
  assert.equal(second.messages.find(message => message.type === 'signal').from, firstId);

  const rejection = await new Promise((resolve, reject) => {
    const foreign = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'https://attacker.invalid' });
    foreign.on('unexpected-response', (request, response) => { resolve(response.statusCode); response.resume(); foreign.terminate(); });
    foreign.on('open', () => { foreign.terminate(); reject(new Error('Foreign origin accepted')); });
    foreign.on('error', () => {});
  });
  assert.equal(rejection, 403);
});

test('public configuration exposes the debug flag and memory budget, not private settings', { skip: !websocketModule }, async context => {
  const port = await allocatePort();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), MODE: 'room', DEBUG: 'true', MEMORY_LIMIT_MB: '', ACCESS_PASSWORD: 'never-expose-this', ICE_SERVERS: '[]' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  context.after(async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  await until(() => output.includes('LAN Drop listening'));
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/config.js`)).text(), 'window.LAN_DROP_CONFIG = {"debug":true,"memoryLimitBytes":536870912};');
});

test('server publishes configured memory budgets without caching', { skip: !websocketModule }, async context => {
  for (const limit of [128, 1024]) {
    const base = await securityService(context, { MEMORY_LIMIT_MB: String(limit) });
    const config = await fetch(`${base}/config.js`);
    assert.equal(config.headers.get('cache-control'), 'no-store');
    assert.equal(await config.text(), `window.LAN_DROP_CONFIG = ${JSON.stringify({ debug: false, memoryLimitBytes: limit * 1024 * 1024 })};`);
  }
});

test('server rejects invalid or unsafe memory budgets at startup', { skip: !websocketModule }, async () => {
  for (const limit of ['0', '-1', '1.5', 'invalid', 'Infinity', '8589934592']) {
    const child = spawn(process.execPath, ['server/index.js'], {
      cwd: new URL('../', import.meta.url),
      env: { ...process.env, MODE: 'room', DEBUG: 'false', ACCESS_PASSWORD: '', ALLOW_PASSWORDLESS_LAN: 'false', MEMORY_LIMIT_MB: limit },
      stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true
    });
    let errors = '';
    child.stderr.on('data', data => { errors += data; });
    const [code] = await once(child, 'exit');
    assert.equal(code, 1);
    assert.match(errors, /MEMORY_LIMIT_MB must be a positive integer/);
  }
});

async function securityService(context, settings = {}) {
  const port = await allocatePort();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), MODE: 'room', DEBUG: 'false', MEMORY_LIMIT_MB: '', ACCESS_PASSWORD: '', ALLOW_PASSWORDLESS_LAN: 'false', TRUSTED_PROXIES: '', ALLOWED_ORIGINS: '', ICE_SERVERS: '[]', MAX_CLIENTS: '256', MAX_CONNECTIONS_PER_IP: '16', MAX_ROOM_PEERS: '32', ROOM_IDLE_MINUTES: '30', ...settings },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  context.after(async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  });
  let output = '';
  let errors = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { errors += data; });
  child.on('error', error => { errors += error.message; });
  await until(() => output.includes('LAN Drop listening') || child.exitCode !== null);
  assert.ok(output.includes('LAN Drop listening'), errors);
  return `http://127.0.0.1:${port}`;
}

async function securitySocket(context, base, headers = {}) {
  const socket = new websocketModule.default(base.replace('http:', 'ws:') + '/ws', { origin: base, headers });
  context.after(() => socket.terminate());
  socket.messages = [];
  socket.on('message', data => socket.messages.push(JSON.parse(data)));
  socket.on('error', () => {});
  await once(socket, 'open');
  await until(() => socket.messages.some(message => message.type === 'ready'));
  return socket;
}

function rejectedUpgrade(base, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = new websocketModule.default(base.replace('http:', 'ws:') + '/ws', { origin: base, headers });
    socket.on('unexpected-response', (request, response) => { resolve(response.statusCode); response.resume(); socket.terminate(); });
    socket.on('open', () => { socket.terminate(); reject(new Error('Connection unexpectedly accepted')); });
    socket.on('error', () => {});
  });
}

test('per-source connection limits reject forged forwarding headers and release closed slots', { skip: !websocketModule }, async context => {
  const base = await securityService(context, { MAX_CONNECTIONS_PER_IP: '2' });
  const first = await securitySocket(context, base);
  await securitySocket(context, base);
  assert.equal(await rejectedUpgrade(base, { 'X-Real-IP': '192.0.2.1', 'X-Forwarded-For': '192.0.2.1' }), 429);
  const closed = once(first, 'close');
  first.close();
  await closed;
  await securitySocket(context, base);
});

test('authentication failure cooldown persists across real WebSocket reconnects', { skip: !websocketModule }, async context => {
  const base = await securityService(context, { ACCESS_PASSWORD: 'test-secret' });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const socket = await securitySocket(context, base);
    socket.send(JSON.stringify({ type: 'hello', password: 'wrong' }));
    await until(() => socket.messages.some(message => message.code === 'auth'));
    const closed = once(socket, 'close');
    socket.close();
    await closed;
  }
  assert.equal(await rejectedUpgrade(base, { 'X-Real-IP': '192.0.2.2' }), 429);
});

test('connection attempt budgets persist after sockets are closed', { skip: !websocketModule }, async context => {
  const base = await securityService(context);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const socket = await securitySocket(context, base);
    const closed = once(socket, 'close');
    socket.close();
    await closed;
  }
  assert.equal(await rejectedUpgrade(base), 429);
});

test('a trusted proxy uses overwritten real client IPs for separate connection budgets', { skip: !websocketModule }, async context => {
  const base = await securityService(context, { TRUSTED_PROXIES: '127.0.0.1,::1', MAX_CONNECTIONS_PER_IP: '1' });
  await securitySocket(context, base, { 'X-Real-IP': '192.0.2.1' });
  await securitySocket(context, base, { 'X-Real-IP': '192.0.2.2' });
  assert.equal(await rejectedUpgrade(base, { 'X-Real-IP': '::ffff:c000:201' }), 429);
});

test('tiny fragmented WebSocket messages are rejected before authentication', { skip: !websocketModule }, async context => {
  const base = await securityService(context, { ACCESS_PASSWORD: 'test-secret' });
  const socket = await securitySocket(context, base);
  const closed = once(socket, 'close');
  for (let fragment = 0; fragment < 130; fragment += 1) socket.send(Buffer.from('x'), { fin: false });
  const [code] = await closed;
  assert.equal(code, 1008);
  assert.deepEqual(await (await fetch(base + '/health')).json(), { status: 'ok' });
});

test('passwordless LAN requires an explicit opt-in', { skip: !websocketModule }, async context => {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, MODE: 'lan', ACCESS_PASSWORD: '', ALLOW_PASSWORDLESS_LAN: 'false' },
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true
  });
  let errors = '';
  child.stderr.on('data', data => { errors += data; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
  assert.match(errors, /LAN mode requires ACCESS_PASSWORD/);
  const base = await securityService(context, { MODE: 'lan', ALLOW_PASSWORDLESS_LAN: 'true' });
  const socket = await securitySocket(context, base);
  socket.send(JSON.stringify({ type: 'hello', name: 'test' }));
  await until(() => socket.messages.some(message => message.type === 'room-state'));
  assert.equal(socket.messages.find(message => message.type === 'room-state').code, 'LAN');
});
