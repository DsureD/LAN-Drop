import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter, clientAddress, normalizeAddress } from '../server/limits.js';

test('rate limits persist across connections and expire without extending on failed attempts', () => {
  let now = 0;
  const limiter = new RateLimiter({ now: () => now });
  for (let attempt = 0; attempt < 5; attempt += 1) assert.equal(limiter.consume('auth:ip', 5, 600000), true);
  assert.equal(limiter.blocked('auth:ip', 5), true);
  now = 599999;
  assert.equal(limiter.consume('auth:ip', 5, 600000), false);
  now = 600000;
  assert.equal(limiter.blocked('auth:ip', 5), false);
  assert.equal(limiter.consume('auth:ip', 5, 600000), true);
  assert.equal(limiter.consume('auth:another-ip', 5, 600000), true);
});

test('limiter storage is bounded and does not evict active restrictions', () => {
  let now = 0;
  const limiter = new RateLimiter({ now: () => now, maxEntries: 2 });
  assert.equal(limiter.consume('first', 1, 10), true);
  assert.equal(limiter.consume('second', 1, 20), true);
  assert.equal(limiter.consume('third', 1), false);
  assert.equal(limiter.blocked('auth:new-source', 5), true);
  assert.equal(limiter.blocked('first', 1), true);
  now = 10;
  assert.equal(limiter.consume('third', 1), true);
  assert.equal(limiter.entries.size, 2);
  now = 70000;
  limiter.prune();
  assert.equal(limiter.entries.size, 0);
});

test('only an explicitly trusted direct proxy may provide a single real client IP', () => {
  const request = { socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { 'x-real-ip': '192.0.2.1', 'x-forwarded-for': '198.51.100.1' } };
  assert.equal(clientAddress(request), '127.0.0.1');
  assert.equal(clientAddress(request, new Set(['127.0.0.1'])), '192.0.2.1');
  request.headers['x-real-ip'] = '192.0.2.1, 198.51.100.1';
  assert.equal(clientAddress(request, new Set(['127.0.0.1'])), '127.0.0.1');
  delete request.headers['x-real-ip'];
  assert.equal(clientAddress(request, new Set(['127.0.0.1'])), '127.0.0.1');
  request.socket.remoteAddress = '192.0.2.5';
  request.headers['x-real-ip'] = '192.0.2.1';
  assert.equal(clientAddress(request, new Set(['127.0.0.1'])), '192.0.2.5');
});

test('IP address representations are canonical and invalid headers cannot introduce limiter keys', () => {
  assert.equal(normalizeAddress('::ffff:192.0.2.1'), '192.0.2.1');
  assert.equal(normalizeAddress('::ffff:c000:201'), '192.0.2.1');
  assert.equal(normalizeAddress('2001:0DB8:0:0:0:0:0:1'), '2001:db8::1');
  assert.equal(normalizeAddress('fe80::1%12'), 'fe80::1');
  for (const value of [undefined, ['192.0.2.1'], 'attacker', '192.0.2.1:80', '192.0.2.1, 192.0.2.2']) assert.equal(normalizeAddress(value), null);
});
