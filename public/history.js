export class TransferHistory extends Map {
  constructor(limit, urls = URL) {
    super();
    this.limit = limit;
    this.urls = urls;
    this.downloads = new Map();
  }

  set(key, record) {
    if (!key || key !== record.key) throw new Error('Invalid local transfer key');
    for (const [index, cached] of this.downloads.get(key) || []) {
      if (cached.blob !== record.downloads?.[index]?.blob) {
        this.urls.revokeObjectURL(cached.url);
        this.downloads.get(key).delete(index);
      }
    }
    return super.set(key, record);
  }

  downloadUrl(key, index) {
    const blob = this.get(key)?.downloads?.[index]?.blob;
    if (!blob) throw new Error('Download no longer exists');
    let files = this.downloads.get(key);
    if (!files) {
      files = new Map();
      this.downloads.set(key, files);
    }
    let cached = files.get(index);
    if (cached?.blob !== blob) {
      if (cached) this.urls.revokeObjectURL(cached.url);
      cached = { blob, url: this.urls.createObjectURL(blob) };
      files.set(index, cached);
    }
    return cached.url;
  }

  remaining() {
    let used = 0;
    for (const record of this.values()) {
      for (const download of record.downloads || []) used += download.blob?.size || 0;
    }
    return Math.max(0, this.limit - used);
  }

  delete(key) {
    for (const cached of this.downloads.get(key)?.values() || []) this.urls.revokeObjectURL(cached.url);
    this.downloads.delete(key);
    return super.delete(key);
  }

  clear() {
    for (const key of this.keys()) this.delete(key);
  }
}
