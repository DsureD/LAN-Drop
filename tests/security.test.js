import test from 'node:test';
import assert from 'node:assert/strict';
import { contentSecurityPolicy } from '../server/security.js';

test('CSP explicitly allows same-host WebSocket schemes for older Safari', () => {
  const policy = contentSecurityPolicy('lan.newsi.tech');
  assert.ok(policy.includes("connect-src 'self' ws://lan.newsi.tech wss://lan.newsi.tech;"));
  assert.ok(policy.includes("script-src 'self';"));
  assert.ok(policy.includes("frame-ancestors 'none';"));
  assert.ok(!policy.includes(' wss:;'));
  assert.ok(!policy.includes(' *'));
});

test('WebSocket sources preserve nonstandard ports and IPv6 addresses', () => {
  assert.ok(contentSecurityPolicy('127.0.0.1:31118').includes('ws://127.0.0.1:31118 wss://127.0.0.1:31118'));
  assert.ok(contentSecurityPolicy('[::1]:31118').includes('ws://[::1]:31118 wss://[::1]:31118'));
  assert.ok(contentSecurityPolicy('DROP.EXAMPLE.COM:443').includes('ws://drop.example.com:443 wss://drop.example.com'));
});

test('malformed Host values cannot inject CSP directives or third-party sources', () => {
  for (const host of [undefined, '', 'host; script-src *', 'host wss://attacker.invalid', 'host\r\nInjected: true', 'user@host', 'host/path', 'host:99999', 'host?query', 'host#hash', '[bad-ipv6]']) {
    const policy = contentSecurityPolicy(host);
    assert.ok(policy.includes("connect-src 'self';"), String(host));
    assert.ok(!policy.includes('attacker'));
  }
});
