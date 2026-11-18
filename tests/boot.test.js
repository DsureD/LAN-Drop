import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/boot.js', import.meta.url), 'utf8');

function fixture({ rtc = true, debug = true } = {}) {
  const elements = new Map(['diagnostics-output', 'startup-warning', 'connection-diagnostics'].map(id => [id, { hidden: true, textContent: '', open: false }]));
  const documentEvents = new Map();
  const windowEvents = new Map();
  const timers = [];
  const window = {
    ...(debug === null ? {} : { LAN_DROP_CONFIG: { debug } }),
    WebSocket() {},
    ...(rtc ? { RTCPeerConnection() {} } : {}),
    isSecureContext: false,
    addEventListener: (event, handler) => windowEvents.set(event, handler)
  };
  const document = {
    getElementById: id => elements.get(id),
    addEventListener: (event, handler) => documentEvents.set(event, handler)
  };
  vm.runInNewContext(source, { window, document, location: { origin: 'http://drop.local', pathname: '/', search: '?password=never-display', hash: '#room=hidden' }, navigator: { userAgent: 'iPhone OS 15_1' }, setTimeout: handler => timers.push(handler) });
  documentEvents.get('DOMContentLoaded')?.();
  return { elements, window, windowEvents, timers, report: window.LanDropDiagnostics?.report };
}

test('diagnostics boot independently of the module and report missing RTC without sensitive URL parameters', () => {
  const fixtureData = fixture({ rtc: false });
  const text = fixtureData.elements.get('diagnostics-output').textContent;
  assert.match(text, /security-1/);
  assert.match(text, /WebRTC 接口：不可用/);
  assert.match(text, /主脚本尚未启动/);
  assert.ok(!text.includes('never-display'));
  assert.ok(!text.includes('#room='));
});

test('diagnostics remain disabled without an explicit boolean debug setting', () => {
  for (const debug of [false, null, 'true']) {
    const fixtureData = fixture({ debug });
    assert.equal(fixtureData.window.LanDropDiagnostics, undefined);
    assert.equal(fixtureData.elements.get('connection-diagnostics').hidden, true);
    assert.equal(fixtureData.elements.get('diagnostics-output').textContent, '');
    assert.equal(fixtureData.windowEvents.size, 0);
    assert.equal(fixtureData.timers.length, 0);
  }
});

test('a module that never initializes produces a visible startup warning', () => {
  const fixtureData = fixture();
  fixtureData.timers[0]();
  assert.equal(fixtureData.elements.get('startup-warning').hidden, false);
  assert.match(fixtureData.elements.get('startup-warning').textContent, /前端尚未正常启动/);
  assert.equal(fixtureData.elements.get('connection-diagnostics').open, true);
});

test('reported connection timeout clears when the service finally responds', () => {
  const fixtureData = fixture();
  fixtureData.report({ frontend: '已启动', socket: '正在连接' });
  fixtureData.timers[0]();
  assert.match(fixtureData.elements.get('startup-warning').textContent, /信令连接尚未建立/);
  fixtureData.report({ socket: '已收到服务消息', mode: 'lan', server: 'instance-123', room: 'LAN', peers: 1 });
  assert.equal(fixtureData.elements.get('startup-warning').hidden, true);
  assert.match(fixtureData.elements.get('diagnostics-output').textContent, /服务模式：lan/);
  assert.match(fixtureData.elements.get('diagnostics-output').textContent, /服务实例：instance-123/);
});

test('resource failures and script exceptions appear in the diagnostic panel', () => {
  const fixtureData = fixture();
  fixtureData.windowEvents.get('error')({ target: { tagName: 'SCRIPT', getAttribute: () => '/app.js?v=ios15-2' } });
  fixtureData.windowEvents.get('error')({ message: 'showModal is not a function' });
  fixtureData.report({ frontend: '已启动' });
  assert.match(fixtureData.elements.get('diagnostics-output').textContent, /脚本加载失败/);
  assert.match(fixtureData.elements.get('diagnostics-output').textContent, /showModal is not a function/);
  assert.equal(fixtureData.elements.get('startup-warning').hidden, false);
});
