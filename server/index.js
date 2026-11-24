import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { RoomHub } from './rooms.js';
import { contentSecurityPolicy } from './security.js';
import { RateLimiter, clientAddress, normalizeAddress } from './limits.js';

const publicRoot = path.resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const mode = process.env.MODE || 'room';
const accessPassword = process.env.ACCESS_PASSWORD || '';
if (accessPassword.length > 256) throw new Error('ACCESS_PASSWORD must not exceed 256 characters');
const passwordlessLanSetting = (process.env.ALLOW_PASSWORDLESS_LAN || 'false').toLowerCase();
if (!['true', 'false'].includes(passwordlessLanSetting)) throw new Error('ALLOW_PASSWORDLESS_LAN must be true or false');
if (mode === 'lan' && !accessPassword && passwordlessLanSetting !== 'true') throw new Error('LAN mode requires ACCESS_PASSWORD; set ALLOW_PASSWORDLESS_LAN=true only on a trusted, access-restricted network');
const debugSetting = (process.env.DEBUG || 'false').toLowerCase();
if (!['true', 'false'].includes(debugSetting)) throw new Error('DEBUG must be true or false');
const debug = debugSetting === 'true';
const memoryLimitMb = Number(process.env.MEMORY_LIMIT_MB || 512);
const memoryLimitBytes = memoryLimitMb * 1024 * 1024;
if (!Number.isSafeInteger(memoryLimitMb) || memoryLimitMb <= 0 || !Number.isSafeInteger(memoryLimitBytes)) throw new Error('MEMORY_LIMIT_MB must be a positive integer with a safe byte count');
const maxClients = Number(process.env.MAX_CLIENTS || 256);
const maxConnectionsPerIp = Number(process.env.MAX_CONNECTIONS_PER_IP || 16);
const trustedProxies = new Set((process.env.TRUSTED_PROXIES || '').split(',').map(value => value.trim()).filter(Boolean).map(value => {
  const address = normalizeAddress(value);
  if (!address) throw new Error('TRUSTED_PROXIES must contain exact proxy IP addresses');
  return address;
}));
const maxPeers = Number(process.env.MAX_ROOM_PEERS || 32);
const idleMinutes = Number(process.env.ROOM_IDLE_MINUTES || 30);
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(origin => origin.trim()).filter(Boolean);
let iceServers;
try {
  iceServers = JSON.parse(process.env.ICE_SERVERS || '[]');
  if (!Array.isArray(iceServers) || iceServers.some(entry => !entry || typeof entry !== 'object' || !(typeof entry.urls === 'string' || (Array.isArray(entry.urls) && entry.urls.every(url => typeof url === 'string'))))) throw new Error();
} catch { throw new Error('ICE_SERVERS must be a JSON array of RTCIceServer objects'); }
if (!['room', 'lan'].includes(mode)) throw new Error('MODE must be room or lan');
if (![port, maxClients, maxConnectionsPerIp, maxPeers, idleMinutes].every(value => Number.isInteger(value) && value > 0) || port > 65535) throw new Error('Invalid numeric configuration');

const limiter = new RateLimiter();
const connectionCounts = new Map();
const hub = new RoomHub({ mode, password: accessPassword, iceServers, maxPeers, idleMs: idleMinutes * 60000, limiter });
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};

const server = http.createServer(async (request, response) => {
  for (const [name, value] of Object.entries(securityHeaders)) response.setHeader(name, value);
  response.setHeader('Content-Security-Policy', contentSecurityPolicy(request.headers.host));
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    return response.end();
  }
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); } catch {
    response.writeHead(400);
    return response.end('Bad request');
  }
  if (pathname === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return response.end(request.method === 'HEAD' ? undefined : '{"status":"ok"}');
  }
  if (pathname === '/config.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    return response.end(request.method === 'HEAD' ? undefined : `window.LAN_DROP_CONFIG = ${JSON.stringify({ debug, memoryLimitBytes })};`);
  }
  const vendor = pathname === '/vendor/qrcode.js';
  const filename = vendor ? fileURLToPath(new URL('../node_modules/qrcode-generator/qrcode.js', import.meta.url)) : path.resolve(publicRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
  if ((!vendor && !filename.startsWith(publicRoot + path.sep)) || pathname.includes('\0') || pathname.includes('\\')) {
    response.writeHead(403);
    return response.end('Forbidden');
  }
  try {
    const data = await readFile(filename);
    response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Content-Length': data.length });
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
});

const websocket = new WebSocketServer({ noServer: true, maxPayload: 65536, maxFragments: 128, maxBufferedChunks: 128, perMessageDeflate: false });
server.on('upgrade', (request, socket, head) => {
  let validOrigin = false;
  try {
    const origin = new URL(request.headers.origin);
    const expectedOrigin = new URL(`${origin.protocol}//${request.headers.host}`);
    validOrigin = ['http:', 'https:'].includes(origin.protocol) && (allowedOrigins.length ? allowedOrigins.includes(origin.origin) : origin.origin === expectedOrigin.origin);
  } catch { validOrigin = false; }
  if (request.url !== '/ws' || !validOrigin || hub.clients.size >= maxClients) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  const address = clientAddress(request, trustedProxies);
  if (limiter.blocked(`auth:${address}`, 5) || !limiter.consume(`connect:${address}`, 30) || (connectionCounts.get(address) || 0) >= maxConnectionsPerIp) {
    socket.end('HTTP/1.1 429 Too Many Requests\r\nRetry-After: 60\r\nConnection: close\r\n\r\n');
    return;
  }
  connectionCounts.set(address, (connectionCounts.get(address) || 0) + 1);
  socket.once('close', () => {
    const count = (connectionCounts.get(address) || 1) - 1;
    if (count) connectionCounts.set(address, count);
    else connectionCounts.delete(address);
  });
  websocket.handleUpgrade(request, socket, head, connection => websocket.emit('connection', connection, address));
});

websocket.on('connection', (socket, address) => {
  const client = hub.attach(socket, address);
  socket.alive = true;
  const deadline = setTimeout(() => { if (!client.ready) socket.close(1008, 'Authentication timeout'); }, 120000);
  socket.on('pong', () => { socket.alive = true; });
  socket.on('message', (data, binary) => {
    if (binary) return socket.close(1003, 'Text messages only');
    hub.receive(client, data.toString());
  });
  socket.on('close', () => { clearTimeout(deadline); hub.detach(client); });
  socket.on('error', () => socket.terminate());
});

const heartbeat = setInterval(() => {
  hub.prune();
  limiter.prune();
  for (const socket of websocket.clients) {
    if (!socket.alive) socket.terminate();
    else { socket.alive = false; socket.ping(); }
  }
}, 30000);
heartbeat.unref();
server.listen(port, host, () => {
  console.log(`LAN Drop listening on http://${host}:${port} (${mode} mode)`);
  if (mode === 'lan') console.warn('LAN mode exposes the shared lobby to every authorized visitor. Use only on trusted networks.');
  if (mode === 'lan' && !accessPassword) console.warn('Passwordless LAN mode is enabled. Restrict access with a firewall or authenticated reverse proxy.');
});
function shutdown() {
  clearInterval(heartbeat);
  for (const socket of websocket.clients) socket.close(1001, 'Server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
