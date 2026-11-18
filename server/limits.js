import { isIP } from 'node:net';

export function normalizeAddress(value) {
  if (typeof value !== 'string' || !isIP(value)) return null;
  if (isIP(value) === 4) return value;
  const address = new URL(`http://[${value.split('%')[0]}]/`).hostname.slice(1, -1);
  const mapped = address.match(/^::ffff:([a-f0-9]+):([a-f0-9]+)$/);
  if (!mapped) return address;
  const high = parseInt(mapped[1], 16);
  const low = parseInt(mapped[2], 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

export function clientAddress(request, trustedProxies = new Set()) {
  const remote = normalizeAddress(request.socket.remoteAddress) || 'unknown';
  if (!trustedProxies.has(remote)) return remote;
  return normalizeAddress(request.headers['x-real-ip']) || remote;
}

export class RateLimiter {
  constructor({ now = Date.now, maxEntries = 4096 } = {}) {
    this.now = now;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  blocked(key, limit) {
    const entry = this.entries.get(key);
    if (!entry) return this.entries.size >= this.maxEntries;
    return Boolean(entry && entry.expires > this.now() && entry.count >= limit);
  }

  consume(key, limit, duration = 60000) {
    const now = this.now();
    let entry = this.entries.get(key);
    if (entry && entry.expires <= now) {
      this.entries.delete(key);
      entry = null;
    }
    if (!entry) {
      if (this.entries.size >= this.maxEntries) this.prune(now);
      if (this.entries.size >= this.maxEntries) return false;
      entry = { count: 0, expires: now + duration };
      this.entries.set(key, entry);
    }
    if (entry.count >= limit) return false;
    entry.count += 1;
    return true;
  }

  prune(now = this.now()) {
    for (const [key, entry] of this.entries) {
      if (entry.expires <= now) this.entries.delete(key);
    }
  }
}
