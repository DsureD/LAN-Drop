import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { RateLimiter } from './limits.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function normalizeCode(value) {
  return typeof value === 'string' ? value.toUpperCase().replace(/[\s-]/g, '') : '';
}

export function cleanName(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 32) : '';
}

export function passwordMatches(actual, expected) {
  if (typeof actual !== 'string' || actual.length > 256) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export class RoomHub {
  constructor({ mode = 'room', password = '', iceServers = [], maxPeers = 32, idleMs = 1800000, limiter = new RateLimiter() } = {}) {
    this.mode = mode;
    this.serverId = randomUUID();
    this.password = password;
    this.iceServers = iceServers;
    this.maxPeers = maxPeers;
    this.idleMs = idleMs;
    this.limiter = limiter;
    this.clients = new Map();
    this.rooms = new Map();
  }

  attach(socket, address = 'unknown') {
    const client = { id: randomUUID(), address, socket, ready: false, room: null, name: '', device: 'desktop', windows: new Map() };
    this.clients.set(client.id, client);
    this.send(client, { type: 'ready', serverId: this.serverId, requiresPassword: Boolean(this.password) });
    return client;
  }

  send(client, message) {
    if (client.socket.readyState === 1) {
      if (client.socket.bufferedAmount > 1024 * 1024) client.socket.close(1013, 'Slow connection');
      else client.socket.send(JSON.stringify(message));
    }
  }

  error(client, message, code = 'invalid') {
    this.send(client, { type: 'error', code, message });
  }

  allow(client, key, limit) {
    const now = Date.now();
    let window = client.windows.get(key);
    if (!window || now - window.start >= 60000) {
      window = { start: now, count: 0 };
      client.windows.set(key, window);
    }
    window.count += 1;
    return window.count <= limit;
  }

  receive(client, data) {
    if (client.socket.readyState !== 1 || !this.clients.has(client.id)) return;
    if (!this.limiter.consume(`message:${client.address}`, 1800)) return client.socket.close(1008, 'Too many messages');
    if (!this.allow(client, 'all', 360)) return this.error(client, '操作太频繁，请稍后再试。', 'rate-limit');
    let message;
    try { message = JSON.parse(data); } catch { return this.error(client, '消息格式错误。'); }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return this.error(client, '消息格式错误。');
    if (message.type === 'hello') {
      if (client.ready) return this.error(client, '设备已经连接。');
      if (this.limiter.blocked(`auth:${client.address}`, 5)) return client.socket.close(1008, 'Authentication cooldown');
      if (!this.allow(client, 'password', 5)) return client.socket.close(1008, 'Too many attempts');
      if (this.password && !passwordMatches(message.password, this.password)) {
        this.limiter.consume(`auth:${client.address}`, 5, 600000);
        return this.error(client, '访问密码不正确。', 'auth');
      }
      client.name = cleanName(message.name) || '未命名设备';
      client.device = ['desktop', 'phone', 'tablet'].includes(message.device) ? message.device : 'desktop';
      client.ready = true;
      this.send(client, { type: 'welcome', id: client.id, serverId: this.serverId, mode: this.mode, iceServers: this.iceServers });
      if (this.mode === 'lan') this.join(client, 'LAN', true);
      return;
    }
    if (!client.ready) return this.error(client, '请先连接服务。', 'auth-required');
    if (message.type === 'rename') {
      client.name = cleanName(message.name) || client.name;
      if (client.room) this.broadcast(client.room);
      return;
    }
    if (message.type === 'create-room' || message.type === 'join-room') {
      if (this.mode === 'lan') return this.error(client, '局域网模式不支持房间操作。');
      if (!this.limiter.consume(`join:${client.address}`, 30)) return this.error(client, '房间操作太频繁，请稍后再试。', 'rate-limit');
      if (!this.allow(client, 'join', 10)) return this.error(client, '房间操作过于频繁，请一分钟后重试。', 'rate-limit');
      if (message.type === 'create-room') {
        this.prune();
        if (this.rooms.size >= 128) return this.error(client, '房间数量已达上限，请稍后再试。');
        if ([...this.rooms.values()].filter(room => room.createdBy === client.address).length >= 8 || !this.limiter.consume(`create:${client.address}`, 5, 600000)) return this.error(client, '当前来源创建的房间过多，请稍后再试。', 'rate-limit');
        let code;
        do { code = Array.from(randomBytes(8), byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join(''); } while (this.rooms.has(code));
        this.join(client, code, true);
      } else {
        const code = normalizeCode(message.code);
        if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) return this.error(client, '请输入正确的 8 位房间码。');
        this.prune();
        if (!this.rooms.has(code)) return this.error(client, '房间不存在或已过期，请确认房间码。');
        this.join(client, code);
      }
      return;
    }
    if (message.type === 'leave-room') {
      this.leave(client);
      if (this.mode === 'lan') this.join(client, 'LAN', true);
      else this.send(client, { type: 'room-state', code: null, peers: [] });
      return;
    }
    if (message.type === 'signal') {
      const target = this.clients.get(message.to);
      if (!target?.ready || !client.room || target.room !== client.room || target.id === client.id) return this.error(client, '目标设备已离开房间。', 'peer-missing');
      const signal = message.signal;
      if (!signal || !['connect', 'description', 'candidate'].includes(signal.kind)) return this.error(client, '无效的连接信息。');
      if (signal.kind === 'description' && (!['offer', 'answer'].includes(signal.description?.type) || typeof signal.description.sdp !== 'string' || signal.description.sdp.length > 48000)) return this.error(client, '无效的连接描述。');
      if (signal.kind === 'candidate' && signal.candidate !== null && (!signal.candidate || typeof signal.candidate.candidate !== 'string' || signal.candidate.candidate.length > 4096)) return this.error(client, '无效的网络候选地址。');
      this.send(target, { type: 'signal', from: client.id, signal });
      return;
    }
    this.error(client, '未知操作。');
  }

  join(client, code, create = false) {
    let room = this.rooms.get(code);
    if (!room && create) {
      room = { code, createdBy: client.address, members: new Set(), emptySince: null };
      this.rooms.set(code, room);
    }
    if (!room) return this.error(client, '房间不存在。');
    if (client.room === code) return this.broadcast(code);
    if (room.members.size >= this.maxPeers) return this.error(client, '房间已满。');
    this.leave(client);
    room.members.add(client.id);
    room.emptySince = null;
    client.room = code;
    this.broadcast(code);
  }

  leave(client) {
    if (!client.room) return;
    const code = client.room;
    const room = this.rooms.get(code);
    room?.members.delete(client.id);
    if (room && !room.members.size) room.emptySince = Date.now();
    client.room = null;
    this.broadcast(code);
  }

  broadcast(code) {
    const room = this.rooms.get(code);
    if (!room) return;
    const members = [...room.members].map(id => this.clients.get(id)).filter(Boolean);
    for (const client of members) {
      this.send(client, { type: 'room-state', code, peers: members.filter(peer => peer.id !== client.id).map(({ id, name, device }) => ({ id, name, device })) });
    }
  }

  detach(client) {
    this.leave(client);
    this.clients.delete(client.id);
  }

  prune(now = Date.now()) {
    for (const [code, room] of this.rooms) {
      if (code !== 'LAN' && room.emptySince !== null && now - room.emptySince >= this.idleMs) this.rooms.delete(code);
    }
  }
}
