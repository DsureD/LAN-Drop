import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomHub, cleanName, normalizeCode, passwordMatches } from '../server/rooms.js';
import { RateLimiter } from '../server/limits.js';

function client(hub, name = '设备', password, address = '127.0.0.1') {
  const socket = { readyState: 1, bufferedAmount: 0, messages: [], send(data) { this.messages.push(JSON.parse(data)); }, close(code) { this.closeCode = code; this.readyState = 3; } };
  const member = hub.attach(socket, address);
  hub.receive(member, JSON.stringify({ type: 'hello', name, password }));
  return member;
}

function receive(hub, member, message) {
  hub.receive(member, JSON.stringify(message));
}

test('public deployment defaults to isolated rooms', () => {
  const hub = new RoomHub();
  const first = client(hub, '电脑');
  const second = client(hub, '手机');
  assert.equal(first.room, null);
  receive(hub, first, { type: 'create-room' });
  assert.match(first.room, /^[A-HJ-NP-Z2-9]{8}$/);
  receive(hub, second, { type: 'join-room', code: first.room.toLowerCase() });
  assert.equal(second.room, first.room);
  assert.deepEqual(first.socket.messages.at(-1).peers, [{ id: second.id, name: '手机', device: 'desktop' }]);
});

test('signals cannot cross rooms or spoof their sender', () => {
  const hub = new RoomHub();
  const first = client(hub);
  const second = client(hub);
  receive(hub, first, { type: 'create-room' });
  receive(hub, second, { type: 'create-room' });
  receive(hub, first, { type: 'signal', to: second.id, signal: { kind: 'connect' } });
  assert.equal(first.socket.messages.at(-1).code, 'peer-missing');
  receive(hub, second, { type: 'join-room', code: first.room });
  receive(hub, first, { type: 'signal', from: 'spoofed', to: second.id, signal: { kind: 'connect' } });
  assert.equal(second.socket.messages.at(-1).from, first.id);
});

test('password is required before room operations', () => {
  const hub = new RoomHub({ password: '秘密' });
  const member = client(hub, '设备', 'wrong');
  assert.equal(member.ready, false);
  assert.equal(member.socket.messages.at(-1).code, 'auth');
  receive(hub, member, { type: 'create-room' });
  assert.equal(member.socket.messages.at(-1).code, 'auth-required');
  receive(hub, member, { type: 'hello', name: '设备', password: '秘密' });
  assert.equal(member.ready, true);
  assert.equal(passwordMatches('秘密', '秘密'), true);
  assert.equal(passwordMatches('abc', '秘密'), false);
});

test('LAN mode autojoins the lobby and rejects hidden room operations', () => {
  const hub = new RoomHub({ mode: 'lan' });
  const member = client(hub);
  assert.equal(member.room, 'LAN');
  receive(hub, member, { type: 'create-room' });
  assert.equal(member.room, 'LAN');
  assert.equal(member.socket.messages.at(-1).type, 'error');
  assert.equal(hub.rooms.size, 1);
  receive(hub, member, { type: 'leave-room' });
  assert.equal(member.room, 'LAN');
});

test('password cooldown survives reconnects and cannot be cleared by a correct attempt', () => {
  const hub = new RoomHub({ password: 'secret' });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const member = client(hub, '攻击者', 'wrong');
    assert.equal(member.ready, false);
    hub.detach(member);
  }
  const blocked = client(hub, '同一来源', 'secret');
  assert.equal(blocked.ready, false);
  assert.equal(blocked.socket.closeCode, 1008);
  const allowed = client(hub, '其他来源', 'secret', '192.0.2.1');
  assert.equal(allowed.ready, true);
});

test('room creation and join limits survive reconnects without exhausting global slots', () => {
  const hub = new RoomHub();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const member = client(hub);
    receive(hub, member, { type: 'create-room' });
    hub.detach(member);
  }
  assert.equal(hub.rooms.size, 5);
  const legitimate = client(hub, '其他来源', undefined, '192.0.2.1');
  receive(hub, legitimate, { type: 'create-room' });
  assert.ok(legitimate.room);
  assert.equal(hub.rooms.size, 6);
});

test('a source cannot hoard more than eight unexpired rooms after creation windows reset', () => {
  let now = 0;
  const limiter = new RateLimiter({ now: () => now });
  const hub = new RoomHub({ limiter });
  for (let round = 0; round < 3; round += 1) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const member = client(hub);
      receive(hub, member, { type: 'create-room' });
      hub.detach(member);
    }
    now += 600001;
  }
  assert.equal(hub.rooms.size, 8);
});

test('device names remove direction overrides and passwords have a bounded length', () => {
  assert.equal(cleanName('手机\u202E\u2066'), '手机');
  assert.equal(passwordMatches('a'.repeat(257), 'a'.repeat(257)), false);
});

test('limiter capacity exhaustion cannot bypass authentication restrictions', () => {
  const limiter = new RateLimiter({ maxEntries: 1 });
  const hub = new RoomHub({ password: 'secret', limiter });
  const member = client(hub, '设备', 'secret');
  assert.equal(member.ready, false);
  assert.equal(member.socket.closeCode, 1008);
});

test('full rooms do not evict a visitor from their existing room', () => {
  const hub = new RoomHub({ maxPeers: 1 });
  const first = client(hub);
  const second = client(hub);
  receive(hub, first, { type: 'create-room' });
  receive(hub, second, { type: 'create-room' });
  const previousRoom = second.room;
  receive(hub, second, { type: 'join-room', code: first.room });
  assert.equal(second.room, previousRoom);
  assert.equal(second.socket.messages.at(-1).type, 'error');
});

test('empty rooms expire but occupied rooms do not', () => {
  const hub = new RoomHub({ idleMs: 100 });
  const member = client(hub);
  receive(hub, member, { type: 'create-room' });
  const code = member.room;
  hub.prune(Date.now() + 1000);
  assert.equal(hub.rooms.has(code), true);
  hub.detach(member);
  hub.prune(Date.now() + 1000);
  assert.equal(hub.rooms.has(code), false);
});

test('join attempts are rate limited', () => {
  const hub = new RoomHub();
  const member = client(hub);
  for (let attempt = 0; attempt < 11; attempt += 1) receive(hub, member, { type: 'join-room', code: 'ABCDEFGH' });
  assert.equal(member.socket.messages.at(-1).code, 'rate-limit');
});

test('malformed JSON and invalid ICE descriptions are rejected', () => {
  const hub = new RoomHub({ mode: 'lan' });
  const first = client(hub);
  const second = client(hub);
  hub.receive(first, '{');
  assert.equal(first.socket.messages.at(-1).type, 'error');
  receive(hub, first, { type: 'signal', to: second.id, signal: { kind: 'description', description: { type: 'offer', sdp: 123 } } });
  assert.equal(first.socket.messages.at(-1).type, 'error');
  assert.equal(second.socket.messages.at(-1).type, 'room-state');
});

test('device names and room codes are normalized', () => {
  assert.equal(cleanName('  手机\n\u0000  '), '手机');
  assert.equal(cleanName('a'.repeat(100)).length, 32);
  assert.equal(normalizeCode('abcd-2345'), 'ABCD2345');
});

test('service identity is shared by clients but differs across independent instances', () => {
  const hub = new RoomHub({ mode: 'lan' });
  const first = client(hub);
  const second = client(hub);
  assert.equal(first.socket.messages[0].serverId, hub.serverId);
  assert.equal(second.socket.messages[0].serverId, hub.serverId);
  assert.equal(first.socket.messages.find(message => message.type === 'welcome').serverId, hub.serverId);
  assert.notEqual(new RoomHub().serverId, hub.serverId);
});
