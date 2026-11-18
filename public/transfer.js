import { CHUNK_SIZE, MAX_FILES, MEMORY_LIMIT, safeFilename, validateOffer } from './protocol.js?v=security-1';

const WINDOW_SIZE = 256 * 1024;
const BUFFER_LIMIT = 512 * 1024;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function makeId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

export class TransferEngine {
  constructor({ signal, onTransfer, onOffer, onPeerState, onError, memoryAvailable }) {
    Object.assign(this, { signal, onTransfer, onOffer, onPeerState, onError, memoryAvailable });
    this.links = new Map();
    this.peers = new Set();
    this.active = null;
    this.id = null;
    this.iceServers = [];
  }

  configure(id, iceServers) {
    this.closeAll('信令服务重新连接，请重新发送文件。');
    this.id = id;
    this.iceServers = iceServers;
  }

  setPeers(peers) {
    this.peers = new Set(peers.map(peer => peer.id));
    for (const peerId of this.links.keys()) {
      if (!this.peers.has(peerId)) this.closePeer(peerId, '对方已离开房间，传输已停止。');
    }
  }

  ensure(peerId) {
    if (typeof RTCPeerConnection !== 'function') throw new Error('当前页面无法使用 WebRTC。请检查 HTTPS 和浏览器设置；设备发现不代表能传输文件。');
    if (!this.id || !this.peers.has(peerId)) throw new Error('设备不在线，请重新选择。');
    if (this.links.has(peerId)) return this.links.get(peerId);
    const connection = new RTCPeerConnection({ iceServers: this.iceServers });
    const link = { peerId, connection, channel: null, open: deferred(), candidates: [], signalTail: Promise.resolve(), dataTail: Promise.resolve(), queuedBytes: 0, queuedMessages: 0, closed: false };
    this.links.set(peerId, link);
    this.onPeerState(peerId, 'connecting');
    link.connectTimer = setTimeout(() => this.closePeer(peerId, '无法直连：请检查访客网络隔离、防火墙，或配置 STUN/TURN。'), 25000);
    connection.onicecandidate = event => {
      if (!link.closed) this.signal(peerId, { kind: 'candidate', candidate: event.candidate?.toJSON() || null });
    };
    connection.onconnectionstatechange = () => {
      if (link.closed) return;
      if (connection.connectionState === 'failed' || connection.connectionState === 'closed') this.closePeer(peerId, '设备连接中断，请重新发送。');
      if (connection.connectionState === 'disconnected') {
        if (!link.disconnectTimer) link.disconnectTimer = setTimeout(() => this.closePeer(peerId, '设备连接超时，请重新发送。'), 12000);
      } else { clearTimeout(link.disconnectTimer); link.disconnectTimer = null; }
    };
    connection.ondatachannel = event => {
      if (link.channel) { event.channel.close(); return; }
      this.bindChannel(link, event.channel);
    };
    if (this.id < peerId) {
      this.bindChannel(link, connection.createDataChannel('lan-drop', { ordered: true }));
      this.createOffer(link).catch(error => this.closePeer(peerId, error.message));
    } else this.signal(peerId, { kind: 'connect' });
    return link;
  }

  async createOffer(link) {
    await link.connection.setLocalDescription(await link.connection.createOffer());
    if (!link.closed) this.signal(link.peerId, { kind: 'description', description: link.connection.localDescription.toJSON() });
  }

  handleSignal(peerId, signal) {
    if (!this.peers.has(peerId)) return;
    let link;
    try { link = this.ensure(peerId); } catch (error) { this.onError(error.message); return; }
    link.signalTail = link.signalTail.then(async () => {
      if (link.closed || signal.kind === 'connect') return;
      if (signal.kind === 'description') {
        if ((signal.description.type === 'offer') !== (this.id > peerId)) throw new Error('连接协商顺序错误，请重试。');
        await link.connection.setRemoteDescription(signal.description);
        for (const candidate of link.candidates) await link.connection.addIceCandidate(candidate);
        link.candidates = [];
        if (signal.description.type === 'offer') {
          await link.connection.setLocalDescription(await link.connection.createAnswer());
          this.signal(peerId, { kind: 'description', description: link.connection.localDescription.toJSON() });
        }
      } else if (signal.kind === 'candidate' && signal.candidate) {
        if (link.connection.remoteDescription) await link.connection.addIceCandidate(signal.candidate);
        else {
          if (link.candidates.length >= 64) throw new Error('网络候选地址过多。');
          link.candidates.push(signal.candidate);
        }
      }
    }).catch(error => { if (!link.closed) this.closePeer(peerId, `连接失败：${error.message}`); });
  }

  bindChannel(link, channel) {
    link.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = BUFFER_LIMIT / 2;
    channel.onopen = () => {
      clearTimeout(link.connectTimer);
      this.onPeerState(link.peerId, 'connected');
      link.open.resolve(link);
    };
    channel.onclose = () => { if (!link.closed) this.closePeer(link.peerId, '对方断开连接，未完成的文件需要重新发送。'); };
    channel.onerror = () => { if (!link.closed) this.closePeer(link.peerId, '传输通道发生错误，请重新发送。'); };
    channel.onmessage = event => {
      if (link.closed) return;
      const bytes = typeof event.data === 'string' ? event.data.length * 2 : event.data.byteLength;
      link.queuedBytes = (link.queuedBytes || 0) + bytes;
      link.queuedMessages = (link.queuedMessages || 0) + 1;
      if (!Number.isFinite(bytes) || link.queuedBytes > 1024 * 1024 || link.queuedMessages > 128) {
        this.closePeer(link.peerId, '对方发送过快，已停止传输以保护接收设备。');
        return;
      }
      link.dataTail = link.dataTail.then(() => {
        if (!link.closed) return this.handleData(link, event.data);
      }).catch(error => { if (!link.closed) this.closePeer(link.peerId, `传输失败：${error.message}`); }).finally(() => {
        link.queuedBytes -= bytes;
        link.queuedMessages -= 1;
      });
    };
  }

  sendControl(link, message) {
    if (link.closed || link.channel?.readyState !== 'open') throw new Error('传输通道已断开。');
    link.channel.send(JSON.stringify(message));
  }

  update(record, force = false) {
    const now = performance.now();
    if (!force && now - (record.lastUpdate || 0) < 100) return;
    record.lastUpdate = now;
    record.speed = record.started ? record.transferred / Math.max((now - record.started) / 1000, 0.1) : 0;
    this.onTransfer({ ...record, files: record.files.map(file => ({ name: file.name, size: file.size })), sourceFiles: undefined, chunks: undefined, writer: undefined, directory: undefined, timer: undefined, fileAck: undefined });
  }

  touch(record, duration = 60000) {
    clearTimeout(record.timer);
    record.timer = setTimeout(() => {
      if (this.active === record) this.closePeer(record.peerId, record.status === 'waiting' ? '对方未确认接收，请重新发送。' : '传输长时间没有响应，请保持两台设备网页在前台。');
    }, duration);
  }

  async sendFiles(peerId, files) {
    if (this.active) throw new Error('请等待当前传输完成，或先取消。');
    if (!files.length || files.length > MAX_FILES) throw new Error(`一次请选择 1–${MAX_FILES} 个文件。`);
    const metadata = files.map(file => ({ name: safeFilename(file.name), size: file.size, mime: file.type }));
    const offer = validateOffer({ type: 'offer', id: makeId(), files: metadata });
    const record = { ...offer, key: makeId(), peerId, direction: 'send', status: 'connecting', transferred: 0, acknowledged: 0, sourceFiles: files, downloads: [] };
    this.active = record;
    this.update(record, true);
    try {
      const link = this.ensure(peerId);
      await link.open.promise;
      if (this.active !== record) return;
      record.status = 'waiting';
      this.update(record, true);
      this.touch(record, 120000);
      this.sendControl(link, { type: 'offer', id: record.id, files: metadata });
    } catch (error) { if (this.active === record) this.finish(record, 'failed', error.message); }
  }

  async accept(id, directory = null, key = null) {
    const record = this.active;
    if (!record || record.id !== id || (key && record.key !== key) || record.direction !== 'receive' || record.status !== 'waiting') return;
    if (!directory && record.total > Math.min(MEMORY_LIMIT, this.memoryAvailable())) throw new Error('内存接收空间不足，请保存到文件夹，或清空已接收记录。');
    record.directory = directory;
    record.status = 'running';
    record.started = performance.now();
    record.nextIndex = 0;
    record.currentIndex = null;
    record.lastAck = 0;
    this.update(record, true);
    this.touch(record);
    this.sendControl(this.links.get(record.peerId), { type: 'accept', id });
  }

  decline(id, key = null) {
    const record = this.active;
    if (!record || record.id !== id || (key && record.key !== key)) return;
    try { this.sendControl(this.links.get(record.peerId), { type: 'reject', id }); } catch {}
    this.finish(record, 'rejected', '已拒绝接收。');
  }

  cancel() {
    const record = this.active;
    if (!record) return;
    try { this.sendControl(this.links.get(record.peerId), { type: 'cancel', id: record.id }); } catch {}
    this.finish(record, 'cancelled', '已取消传输。');
    this.closePeer(record.peerId);
  }

  async waitForCapacity(link, record, bytes) {
    const deadline = performance.now() + 30000;
    while (this.active === record && !link.closed && (link.channel.bufferedAmount > BUFFER_LIMIT || record.transferred - record.acknowledged + bytes > WINDOW_SIZE)) {
      if (performance.now() > deadline) throw new Error('对方接收速度过慢或连接中断，请重试。');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (this.active !== record || link.closed) throw new Error('传输已停止。');
  }

  async pump(link, record) {
    record.status = 'running';
    record.started = performance.now();
    this.update(record, true);
    this.touch(record);
    for (let index = 0; index < record.sourceFiles.length; index += 1) {
      if (this.active !== record) return;
      const file = record.sourceFiles[index];
      record.filename = record.files[index].name;
      this.sendControl(link, { type: 'file-start', id: record.id, index });
      for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
        const bytes = Math.min(CHUNK_SIZE, file.size - offset);
        await this.waitForCapacity(link, record, bytes);
        const chunk = await file.slice(offset, offset + bytes).arrayBuffer();
        if (this.active !== record || link.closed) return;
        link.channel.send(chunk);
        record.transferred += chunk.byteLength;
        this.update(record);
      }
      record.fileAck = deferred();
      record.waitingIndex = index;
      this.sendControl(link, { type: 'file-end', id: record.id, index });
      await record.fileAck.promise;
      record.fileAck = null;
    }
    if (this.active !== record) return;
    record.awaitComplete = true;
    record.note = '文件已发送，等待对方确认…';
    this.update(record, true);
    this.sendControl(link, { type: 'batch-end', id: record.id });
  }

  async createWriter(record, name) {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : '';
    for (let counter = 0; counter < 10000; counter += 1) {
      const candidate = counter ? `${stem} (${counter})${extension}` : name;
      try { await record.directory.getFileHandle(candidate); } catch (error) {
        if (error.name === 'TypeMismatchError') continue;
        if (error.name !== 'NotFoundError') throw error;
        const handle = await record.directory.getFileHandle(candidate, { create: true });
        record.savedName = candidate;
        return handle.createWritable();
      }
    }
    throw new Error('同名文件过多，请选择其他文件夹。');
  }

  async handleData(link, data) {
    if (data instanceof ArrayBuffer) {
      const record = this.active;
      if (!record || record.peerId !== link.peerId || record.direction !== 'receive' || record.status !== 'running' || record.currentIndex === null) throw new Error('收到了未确认的文件内容。');
      const file = record.files[record.currentIndex];
      if (!data.byteLength || data.byteLength > CHUNK_SIZE || record.currentBytes + data.byteLength > file.size) throw new Error('文件分块大小不匹配。');
      if (record.writer) await record.writer.write(data);
      else record.chunks.push(data);
      if (this.active !== record) return;
      record.currentBytes += data.byteLength;
      record.transferred += data.byteLength;
      this.touch(record);
      this.update(record);
      if (record.transferred - record.lastAck >= WINDOW_SIZE / 2 || performance.now() - (record.lastAckAt || 0) >= 100) {
        this.sendControl(link, { type: 'progress', id: record.id, bytes: record.transferred });
        record.lastAck = record.transferred;
        record.lastAckAt = performance.now();
      }
      return;
    }
    if (typeof data !== 'string' || data.length > 65536) throw new Error('无效的传输消息。');
    const message = JSON.parse(data);
    if (!message || typeof message !== 'object') throw new Error('无效的传输消息。');
    if (message.type === 'offer') {
      const offer = validateOffer(message);
      if (this.active) {
        this.sendControl(link, { type: 'reject', id: offer.id, reason: '对方正在处理其他传输，请稍后再试。' });
        return;
      }
      const record = { ...offer, key: makeId(), peerId: link.peerId, direction: 'receive', status: 'waiting', transferred: 0, downloads: [] };
      this.active = record;
      this.update(record, true);
      this.touch(record, 120000);
      this.onOffer({ id: record.id, key: record.key, peerId: record.peerId, files: record.files, total: record.total });
      return;
    }
    const record = this.active;
    if (!record || record.peerId !== link.peerId || message.id !== record.id) return;
    if (message.type === 'reject') {
      this.finish(record, 'rejected', typeof message.reason === 'string' ? message.reason.slice(0, 120) : '对方拒绝了接收请求。');
      return;
    }
    if (message.type === 'cancel') {
      this.finish(record, 'cancelled', '对方取消了传输。');
      this.closePeer(link.peerId);
      return;
    }
    if (message.type === 'accept') {
      if (record.direction !== 'send' || record.status !== 'waiting') throw new Error('接收确认顺序错误。');
      this.pump(link, record).catch(error => { if (this.active === record) this.closePeer(link.peerId, error.message); });
      return;
    }
    if (message.type === 'progress') {
      if (record.direction !== 'send' || !Number.isSafeInteger(message.bytes) || message.bytes < record.acknowledged || message.bytes > record.transferred) throw new Error('接收进度不匹配。');
      record.acknowledged = message.bytes;
      this.touch(record);
      return;
    }
    if (message.type === 'file-ack') {
      if (record.direction !== 'send' || !record.fileAck || message.index !== record.waitingIndex) throw new Error('文件确认顺序错误。');
      record.acknowledged = record.transferred;
      this.touch(record);
      record.fileAck.resolve();
      return;
    }
    if (message.type === 'complete') {
      if (record.direction !== 'send' || !record.awaitComplete) throw new Error('传输完成确认顺序错误。');
      this.finish(record, 'completed', '对方已完整接收。');
      return;
    }
    if (record.direction !== 'receive' || record.status !== 'running') throw new Error('对方尚未确认接收。');
    if (message.type === 'file-start') {
      if (message.index !== record.nextIndex || record.currentIndex !== null || message.index >= record.files.length) throw new Error('文件发送顺序错误。');
      record.currentIndex = message.index;
      record.currentBytes = 0;
      record.chunks = [];
      record.filename = record.files[message.index].name;
      this.touch(record);
      if (record.directory) {
        const writer = await this.createWriter(record, record.filename);
        if (this.active !== record) { await writer.abort(); return; }
        record.writer = writer;
      }
      this.update(record, true);
    } else if (message.type === 'file-end') {
      if (record.currentIndex === null || message.index !== record.currentIndex || record.currentBytes !== record.files[message.index].size) throw new Error('文件未完整接收。');
      const file = record.files[message.index];
      if (record.writer) {
        await record.writer.close();
        record.writer = null;
        if (this.active !== record) return;
        record.downloads.push({ name: record.savedName, saved: true });
      } else record.downloads.push({ name: file.name, blob: new Blob(record.chunks, { type: 'application/octet-stream' }) });
      record.chunks = [];
      record.currentIndex = null;
      record.nextIndex += 1;
      record.lastAck = record.transferred;
      this.sendControl(link, { type: 'file-ack', id: record.id, index: message.index });
      this.touch(record);
      this.update(record, true);
    } else if (message.type === 'batch-end') {
      if (record.currentIndex !== null || record.nextIndex !== record.files.length || record.transferred !== record.total) throw new Error('文件队列未完整接收。');
      this.sendControl(link, { type: 'complete', id: record.id });
      this.finish(record, 'completed', record.directory ? '已保存到你选择的文件夹。' : '接收完成，请点击文件保存。');
    } else throw new Error('未知的传输操作。');
  }

  finish(record, status, note) {
    clearTimeout(record.timer);
    record.fileAck?.reject(new Error(note || status));
    if (record.writer) record.writer.abort().catch(() => {});
    record.writer = null;
    record.chunks = [];
    record.sourceFiles = [];
    record.status = status;
    record.note = note;
    if (this.active === record) this.active = null;
    this.update(record, true);
  }

  closePeer(peerId, reason) {
    const link = this.links.get(peerId);
    if (!link) return;
    link.closed = true;
    clearTimeout(link.connectTimer);
    clearTimeout(link.disconnectTimer);
    link.open.reject(new Error(reason || '连接已关闭。'));
    link.channel?.close();
    link.connection.close();
    this.links.delete(peerId);
    this.onPeerState(peerId, 'offline');
    if (this.active?.peerId === peerId) this.finish(this.active, 'failed', reason || '连接已关闭。');
  }

  closeAll(reason) {
    for (const peerId of [...this.links.keys()]) this.closePeer(peerId, reason);
    if (this.active) this.finish(this.active, 'failed', reason || '连接已关闭。');
    this.peers.clear();
  }
}
