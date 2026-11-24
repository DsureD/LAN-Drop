import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('frontend controls reference existing unique DOM IDs', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  for (const match of app.matchAll(/element\('([^']+)'\)/g)) assert.ok(ids.includes(match[1]), match[1]);
  for (const match of html.matchAll(/data-close="([^"]+)"/g)) assert.ok(ids.includes(match[1]), match[1]);
  assert.ok(html.includes('lang="zh-CN"'));
  assert.ok(!html.includes('https://'));
  assert.ok(html.indexOf('/config.js') < html.indexOf('/boot.js'));
  assert.ok(html.indexOf('/config.js') < html.indexOf('/app.js'));
  assert.ok(app.includes('getMemoryLimit(window.LAN_DROP_CONFIG)'));
  assert.ok(app.includes('new TransferHistory(memoryLimit)'));
  assert.ok(!html.includes('256 MB'));
  assert.ok(html.includes('id="connection-diagnostics" class="connection-diagnostics" hidden'));
  assert.ok(html.indexOf('class="workspace"') < html.indexOf('class="about-strip"'));
  assert.ok(!html.includes('class="hero"'));
});
