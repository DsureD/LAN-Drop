export const MEMORY_LIMIT = 512 * 1024 * 1024;
export const CHUNK_SIZE = 16 * 1024;
export const MAX_FILES = 100;

export function getMemoryLimit(config) {
  const limit = config?.memoryLimitBytes;
  return Number.isSafeInteger(limit) && limit > 0 ? limit : MEMORY_LIMIT;
}

export function safeFilename(value) {
  const name = String(value || '').normalize('NFC').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069<>:"|?*]/g, '_').slice(0, 180).replace(/[.\s]+$/g, '');
  return !name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name) ? `file-${name || 'unnamed'}` : name;
}

export function deviceCode(id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) return '尚未连接';
  return id.replace(/-/g, '').slice(0, 12).toUpperCase().match(/.{4}/g).join('-');
}

export function validateOffer(message) {
  if (!message || message.type !== 'offer' || typeof message.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(message.id) || !Array.isArray(message.files) || message.files.length < 1 || message.files.length > MAX_FILES) throw new Error('无效的文件请求。');
  let total = 0;
  const files = message.files.map(file => {
    if (!file || typeof file.name !== 'string' || file.name.length > 512 || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error('无效的文件信息。');
    total += file.size;
    if (!Number.isSafeInteger(total)) throw new Error('文件总大小超出支持范围。');
    const mime = typeof file.mime === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(file.mime) ? file.mime : 'application/octet-stream';
    return { name: safeFilename(file.name), size: file.size, mime };
  });
  return { id: message.id, files, total };
}

export function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '0 B';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = value / 1024;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`;
}
