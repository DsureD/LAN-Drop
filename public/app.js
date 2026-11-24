import { getMemoryLimit, formatBytes, deviceCode } from './protocol.js?v=memory-config-1';
import { TransferEngine } from './transfer.js?v=memory-config-1';
import { installDialogs } from './dialogs.js?v=security-1';
import { TransferHistory } from './history.js?v=security-1';

function diagnose(updates) {
  window.LanDropDiagnostics?.report(updates);
}

diagnose({ frontend: '正在初始化' });

installDialogs(document);

const element = id => document.getElementById(id);
const finishedStatuses = new Set(['completed', 'failed', 'cancelled', 'rejected']);
const statusLabels = { connecting: '正在建立直连', waiting: '等待接收确认', running: '传输中', completed: '已完成', failed: '未完成', cancelled: '已取消', rejected: '已拒绝' };
const memoryLimit = getMemoryLimit(window.LAN_DROP_CONFIG);
const history = new TransferHistory(memoryLimit);
element('memory-receive-limit').textContent = `普通接收的总容量预算为 ${formatBytes(memoryLimit)}，包含本次接收与历史记录中保留的文件；手机建议更小。直接保存到文件夹不受此预算限制。请保持双方网页在前台，避免锁屏。`;
const peerStates = new Map();
let peers = [];
let socket;
let authenticated = false;
let mode = null;
let roomCode = null;
let selectedPeer = null;
let pendingOffer = null;
let reconnectDelay = 1000;
let reconnectTimer;
let password = '';
let desiredRoom = new URLSearchParams(location.hash.slice(1)).get('room');
if (desiredRoom === 'LAN') desiredRoom = null;

function readSetting(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function saveSetting(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

function detectDevice() {
  const agent = navigator.userAgent;
  if (/iPad|Tablet/i.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1)) return 'tablet';
  return /Mobi|Android|iPhone/i.test(agent) ? 'phone' : 'desktop';
}

const device = detectDevice();
const defaultName = device === 'phone' ? (/iPhone/.test(navigator.userAgent) ? '我的 iPhone' : '我的手机') : device === 'tablet' ? '我的平板' : /Mac/.test(navigator.platform) ? '我的 Mac' : '我的电脑';
let name = readSetting('lan-drop-name') || defaultName;
document.documentElement.dataset.theme = readSetting('lan-drop-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
element('self-name').textContent = name;
element('self-device-icon').setAttribute('href', `#icon-${device}`);

function icon(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#icon-${kind}`);
  svg.append(use);
  return svg;
}

function node(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

function toast(message) {
  const item = node('div', 'toast', message);
  element('toast-region').append(item);
  setTimeout(() => item.remove(), 5000);
  while (element('toast-region').children.length > 3) element('toast-region').firstChild.remove();
}

function setConnection(state, label) {
  if (!authenticated) element('self-code').textContent = '尚未连接';
  element('connection-status').dataset.state = state;
  element('connection-label').textContent = label;
  document.querySelector('.live-indicator').hidden = !authenticated;
  element('create-room').disabled = !authenticated;
  element('join-form').querySelector('button').disabled = !authenticated;
  renderRoom();
  diagnose({ status: label });
}

function send(message) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function memoryAvailable() {
  return history.remaining();
}

const engine = new TransferEngine({
  signal: (peerId, signal) => send({ type: 'signal', to: peerId, signal }),
  onTransfer: record => {
    const previous = history.get(record.key);
    record.peerName = previous?.peerName || peers.find(peer => peer.id === record.peerId)?.name || '另一台设备';
    history.set(record.key, record);
    if (pendingOffer?.key === record.key && record.status !== 'waiting') {
      pendingOffer = null;
      element('receive-dialog').close();
    }
    if (finishedStatuses.has(record.status) && previous?.status !== record.status) {
      toast(record.status === 'completed' ? `与 ${record.peerName} 的传输已完成。` : record.note || statusLabels[record.status]);
    }
    if (history.size > 30) {
      for (const [id, item] of history) {
        if (history.size <= 30) break;
        if (finishedStatuses.has(item.status) && !item.downloads?.some(download => download.blob)) removeRecord(id);
      }
    }
    renderTransfers();
  },
  onOffer: showOffer,
  onPeerState: (peerId, state) => { peerStates.set(peerId, state); renderPeers(); },
  onError: toast,
  memoryAvailable,
  memoryLimit
});

function connect() {
  clearTimeout(reconnectTimer);
  authenticated = false;
  setConnection('connecting', '正在连接');
  diagnose({ socket: '正在连接', mode: '尚未收到服务配置', room: '尚未加入', server: '尚未收到服务标识', peers: 0 });
  try {
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
  } catch (error) {
    diagnose({ socket: `创建失败：${error.message}` });
    setConnection('offline', '浏览器无法建立信令连接');
    return;
  }
  const currentSocket = socket;
  socket.onopen = () => { if (currentSocket === socket) diagnose({ socket: '握手成功，等待服务消息' }); };
  socket.onmessage = event => {
    if (currentSocket !== socket) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'ready') {
      diagnose({ socket: '已收到服务消息', server: message.serverId || '旧版后端未提供标识' });
      if (message.requiresPassword && !password) {
        setConnection('connecting', '等待访问密码');
        element('password-description').textContent = '请输入管理员设置的访问密码。';
        if (!element('password-dialog').open) element('password-dialog').showModal();
      } else send({ type: 'hello', name, device, password });
    } else if (message.type === 'welcome') {
      authenticated = true;
      mode = message.mode;
      diagnose({ mode, server: message.serverId || '旧版后端未提供标识' });
      reconnectDelay = 1000;
      engine.configure(message.id, message.iceServers);
      element('self-code').textContent = `设备码 ${deviceCode(message.id)}`;
      element('password-dialog').close();
      setConnection('online', '信令已连接');
      if (mode === 'room' && desiredRoom) send({ type: 'join-room', code: desiredRoom });
      else desiredRoom = null;
      renderRoom();
    } else if (message.type === 'room-state') {
      if (roomCode !== message.code) engine.closeAll('已切换房间，未完成的文件需要重新发送。');
      roomCode = message.code;
      desiredRoom = roomCode && roomCode !== 'LAN' ? roomCode : null;
      peers = message.peers;
      diagnose({ room: roomCode || '尚未加入', peers: peers.length });
      engine.setPeers(peers);
      for (const peerId of peerStates.keys()) if (!peers.some(peer => peer.id === peerId)) peerStates.delete(peerId);
      window.history.replaceState(null, '', `${location.pathname}${location.search}${desiredRoom ? `#room=${desiredRoom}` : ''}`);
      renderRoom();
      renderPeers();
    } else if (message.type === 'signal') engine.handleSignal(message.from, message.signal);
    else if (message.type === 'error') {
      if (message.code === 'auth' || message.code === 'auth-required') {
        password = '';
        setConnection('connecting', '等待访问密码');
        element('password-description').textContent = message.message;
        if (!element('password-dialog').open) element('password-dialog').showModal();
      } else toast(message.message);
    }
  };
  socket.onclose = event => {
    if (currentSocket !== socket) return;
    authenticated = false;
    engine.closeAll('信令连接已断开，请等待重连后重新发送。');
    roomCode = null;
    peers = [];
    diagnose({ socket: `已断开（代码 ${event.code}），自动重连`, room: '尚未加入', peers: 0 });
    renderRoom();
    renderPeers();
    setConnection('offline', '连接断开 · 自动重连');
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  };
  socket.onerror = () => {
    if (currentSocket !== socket) return;
    diagnose({ socket: '连接出错，请检查 /ws 代理、HTTPS 证书或访问来源限制' });
    setConnection('offline', '暂时无法连接');
  };
}

function inviteLink() {
  return `${location.origin}${location.pathname}${roomCode !== 'LAN' ? `#room=${roomCode}` : ''}`;
}

function renderRoom() {
  const privateRoom = authenticated && mode === 'room' && Boolean(roomCode);
  element('room-panel').hidden = !authenticated || mode !== 'room';
  element('room-empty').hidden = !authenticated || mode !== 'room' || Boolean(roomCode);
  element('room-active').hidden = !privateRoom;
  element('room-connection-hint').hidden = authenticated && (Boolean(roomCode) || mode === 'room');
  element('room-connection-hint').textContent = authenticated ? '正在发现设备…' : element('connection-label').textContent;
  const label = !authenticated ? '等待连接' : mode === 'lan' ? '局域网模式 · 自动发现' : privateRoom ? '房间模式 · 已加入' : '房间模式 · 等待加入';
  element('mode-label').replaceChildren(node('span', ''), document.createTextNode(label));
  element('device-description').textContent = !authenticated ? '正在连接服务，连接成功后显示可用设备。' : mode === 'lan' ? '在另一台设备打开同一网址，即可在这里选择并发送。' : privateRoom ? '同一房间的设备会显示在这里，点击即可发送文件。' : '先在下方创建或加入房间，再选择接收设备。';
  element('mode-note').textContent = mode === 'lan' ? '只向可信设备发送文件。大厅显示所有有权访问本站的设备，不按 Wi-Fi 筛选。' : '服务器只负责连接协商，不保存你的文件。';
  element('room-code').textContent = privateRoom ? `${roomCode.slice(0, 4)} ${roomCode.slice(4)}` : '';
  const container = element('qr-code');
  container.replaceChildren();
  if (!privateRoom) return;
  element('room-kind').textContent = '当前临时房间';
  element('room-note').textContent = '扫码或发送邀请链接，让另一台设备加入。';
  try {
    if (typeof globalThis.qrcode !== 'function') throw new Error();
    const code = globalThis.qrcode(0, 'M');
    code.addData(inviteLink());
    code.make();
    container.innerHTML = code.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
    container.firstChild.setAttribute('role', 'img');
    container.firstChild.setAttribute('aria-label', '房间邀请二维码');
  } catch { container.append(node('span', 'muted', '请使用邀请链接或房间码加入')); }
}

function renderPeers() {
  element('peer-count').textContent = peers.length;
  element('devices-empty').hidden = peers.length > 0;
  element('empty-title').textContent = authenticated ? mode === 'lan' ? '等待另一台设备上线' : roomCode ? '等待房间里的另一台设备' : '先连接另一台设备' : '正在连接…';
  element('empty-description').textContent = !authenticated ? '请保持网页打开，连接后自动更新设备列表。' : mode === 'lan' ? '在手机、电脑或平板打开同一网址，无需房间码。' : roomCode ? '让另一台设备扫码或输入下方房间码加入。' : '在下方创建房间，或输入另一台设备的房间码。';
  const container = element('peers');
  container.replaceChildren();
  for (const peer of peers) {
    const card = node('button', 'peer-card');
    card.type = 'button';
    card.setAttribute('aria-label', `向 ${peer.name} 发送文件`);
    card.append(node('span', 'peer-device-icon'));
    card.lastChild.append(icon(peer.device));
    card.append(node('strong', 'peer-name', peer.name));
    const code = node('span', 'device-code', `设备码 ${deviceCode(peer.id)}`);
    code.title = '发送前与对方页面的这台设备码核对；昵称不能证明身份';
    card.append(code);
    const state = peerStates.get(peer.id);
    card.append(node('span', 'peer-subtitle', state === 'connected' ? '已直连 · 点击发送' : state === 'connecting' ? '正在建立直连…' : '在线 · 点击发送文件'));
    const arrow = node('span', 'peer-arrow');
    arrow.append(icon('arrow'));
    card.append(arrow);
    card.onclick = () => {
      if (engine.active) return toast('请先完成或取消当前传输。');
      selectedPeer = peer.id;
      element('file-input').click();
    };
    card.ondragover = event => { event.preventDefault(); card.classList.add('drag-over'); };
    card.ondragleave = () => card.classList.remove('drag-over');
    card.ondrop = event => {
      event.preventDefault();
      event.stopPropagation();
      card.classList.remove('drag-over');
      const items = [...(event.dataTransfer.items || [])];
      if (items.some(item => item.webkitGetAsEntry?.()?.isDirectory)) return toast('第一版不支持文件夹，请先打包成压缩文件。');
      startSend(peer.id, [...event.dataTransfer.files]);
    };
    container.append(card);
  }
}

async function startSend(peerId, files) {
  if (!authenticated) return toast('信令服务尚未连接，请稍后再试。');
  try { await engine.sendFiles(peerId, files); } catch (error) { toast(error.message); }
}

function removeRecord(id) {
  history.delete(id);
}

function renderTransfers() {
  const container = element('transfers');
  const focusedKey = document.activeElement?.dataset.focusKey;
  container.replaceChildren();
  if (!history.size) {
    const empty = node('div', 'transfer-empty');
    empty.append(icon('file'), node('span', '', '选择一台设备，开始第一次分享。'));
    container.append(empty);
    return;
  }
  for (const record of [...history.values()].reverse()) {
    const item = node('article', 'transfer-card');
    item.dataset.status = record.status;
    const heading = node('div', 'transfer-heading');
    const badge = node('span', 'transfer-icon');
    badge.append(icon(record.status === 'completed' ? 'check' : record.direction === 'send' ? 'upload' : 'download'));
    const detail = node('div', 'transfer-detail');
    detail.append(node('strong', '', record.files.length === 1 ? record.files[0].name : `${record.files[0].name} 等 ${record.files.length} 个文件`));
    detail.append(node('span', 'muted', `${record.direction === 'send' ? '发送至' : '来自'} ${record.peerName} · ${formatBytes(record.total)}`));
    heading.append(badge, detail, node('span', 'transfer-status', statusLabels[record.status]));
    if (!finishedStatuses.has(record.status)) {
      const cancel = node('button', 'icon-button');
      cancel.setAttribute('aria-label', '取消当前传输');
        cancel.dataset.focusKey = `cancel-${record.key}`;
      cancel.append(icon('close'));
      cancel.onclick = () => engine.cancel();
      heading.append(cancel);
    }
    item.append(heading);
    if (record.status === 'running' || record.status === 'connecting' || record.status === 'waiting') {
      const progress = node('progress', 'transfer-progress');
      progress.max = record.total || 1;
      progress.value = record.transferred;
      progress.setAttribute('aria-label', '文件传输进度');
      const stats = node('div', 'transfer-stats');
      stats.append(node('span', '', record.filename || record.note || statusLabels[record.status]), node('span', '', `${formatBytes(record.transferred)} / ${formatBytes(record.total)}${record.speed ? ` · ${formatBytes(record.speed)}/s` : ''}`));
      item.append(progress, stats);
    } else if (record.note) item.append(node('p', 'transfer-note', record.note));
    if (record.downloads?.length) {
      const downloads = node('div', 'download-list');
      record.downloads.forEach((download, index) => {
        if (download.saved) { downloads.append(node('span', 'saved-file', `✓ ${download.name}`)); return; }
        const key = `${record.key}:${index}`;
        const link = node('a', 'download-link', download.name);
        link.href = history.downloadUrl(record.key, index);
        link.download = download.name;
        link.dataset.focusKey = `download-${key}`;
        link.prepend(icon('download'));
        downloads.append(link);
      });
      item.append(downloads);
    }
    container.append(item);
  }
  if (focusedKey) container.querySelector(`[data-focus-key="${CSS.escape(focusedKey)}"]`)?.focus({ preventScroll: true });
}

function showOffer(offer) {
  pendingOffer = offer;
  const peerName = peers.find(peer => peer.id === offer.peerId)?.name || '另一台设备';
  element('receive-description').textContent = `${peerName}（设备码 ${deviceCode(offer.peerId)}）想发送 ${offer.files.length} 个文件，共 ${formatBytes(offer.total)}。请与发送设备页面核对。`;
  element('receive-files').replaceChildren(...offer.files.map(file => {
    const item = node('li', '');
    item.append(node('span', '', file.name), node('span', 'muted', formatBytes(file.size)));
    return item;
  }));
  const available = memoryAvailable();
  const diskSupported = window.isSecureContext && typeof window.showDirectoryPicker === 'function';
  element('accept-memory').disabled = offer.total > available;
  element('accept-memory').textContent = offer.total > available ? '超出内存接收上限' : '接收文件';
  element('accept-disk').hidden = !diskSupported;
  element('receive-limit').textContent = `普通接收总预算：${formatBytes(memoryLimit)}，可用空间：${formatBytes(available)}。${offer.total > available ? (diskSupported ? '请直接保存到文件夹。' : '请先保存并清空旧记录，或让对方拆分文件；大文件可使用支持文件夹写入的桌面 Chrome/Edge。') : '普通接收完成后，请在传输记录中点击文件保存。手机建议使用较小文件。'}`;
  element('receive-dialog').showModal();
}

async function acceptOffer(toDisk) {
  if (!pendingOffer) return;
  const id = pendingOffer.id;
  const key = pendingOffer.key;
  const button = element(toDisk ? 'accept-disk' : 'accept-memory');
  button.disabled = true;
  try {
    const directory = toDisk ? await window.showDirectoryPicker({ mode: 'readwrite' }) : null;
    if (pendingOffer?.key !== key) return;
    await engine.accept(id, directory, key);
  } catch (error) {
    if (error.name !== 'AbortError') {
      element('receive-limit').textContent = error.message;
      toast(error.message);
    }
  }
  finally { button.disabled = false; }
}

element('file-input').onchange = () => {
  const files = [...element('file-input').files];
  element('file-input').value = '';
  if (files.length && selectedPeer) startSend(selectedPeer, files);
};
element('create-room').onclick = () => {
  if (mode !== 'room') return;
  if (engine.active && !confirm('创建新房间会停止当前传输，是否继续？')) return;
  send({ type: 'create-room' });
};
element('join-form').onsubmit = event => {
  event.preventDefault();
  if (mode !== 'room') return;
  if (!authenticated) return toast('请等待信令服务连接。');
  if (engine.active && !confirm('切换房间会停止当前传输，是否继续？')) return;
  send({ type: 'join-room', code: element('room-input').value });
};
element('leave-room').onclick = () => {
  if (engine.active && !confirm('离开房间会停止当前传输，是否继续？')) return;
  send({ type: 'leave-room' });
};
element('copy-invite').onclick = async () => {
  try { await navigator.clipboard.writeText(inviteLink()); toast('邀请链接已复制，发给另一台设备即可。'); }
  catch {
    element('invite-link').value = inviteLink();
    element('invite-dialog').showModal();
    element('invite-link').select();
  }
};
element('theme-button').onclick = () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  saveSetting('lan-drop-theme', theme);
};
element('help-button').onclick = () => element('help-dialog').showModal();
element('rename-button').onclick = () => { element('name-input').value = name; element('rename-dialog').showModal(); };
element('rename-form').onsubmit = event => {
  event.preventDefault();
  const nextName = element('name-input').value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32);
  if (!nextName) return;
  name = nextName;
  saveSetting('lan-drop-name', name);
  element('self-name').textContent = name;
  if (authenticated) send({ type: 'rename', name });
  element('rename-dialog').close();
};
element('password-form').onsubmit = event => {
  event.preventDefault();
  password = element('password-input').value;
  if (!send({ type: 'hello', name, device, password })) toast('服务正在重连，请稍后再试。');
};
element('password-dialog').addEventListener('cancel', event => event.preventDefault());
element('reject-transfer').onclick = () => { if (pendingOffer) engine.decline(pendingOffer.id, pendingOffer.key); };
element('accept-memory').onclick = () => acceptOffer(false);
element('accept-disk').onclick = () => acceptOffer(true);
element('receive-dialog').addEventListener('cancel', event => { event.preventDefault(); if (pendingOffer) engine.decline(pendingOffer.id, pendingOffer.key); });
element('clear-history').onclick = () => {
  if ([...history.values()].some(record => finishedStatuses.has(record.status) && record.downloads?.some(download => download.blob)) && !confirm('清空后，未保存的接收文件将无法再下载。确定清空？')) return;
  for (const [id, record] of history) if (finishedStatuses.has(record.status)) removeRecord(id);
  renderTransfers();
};
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => element(button.dataset.close).close()));
document.addEventListener('dragover', event => { if ([...event.dataTransfer.types].includes('Files')) event.preventDefault(); });
document.addEventListener('drop', event => {
  if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); toast('请将文件拖到目标设备卡片上。'); }
});
window.addEventListener('beforeunload', event => {
  if (engine.active) { event.preventDefault(); event.returnValue = ''; }
});

const warnings = [];
if (!window.isSecureContext) warnings.push('当前使用 HTTP。建议配置 HTTPS，以启用安全剪贴板和文件夹写入；基础传输仍取决于浏览器支持。');
if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) warnings.push('另一台设备不能访问你的 localhost。请使用服务器局域网 IP 或域名打开本页后再分享邀请。');
if (!window.RTCPeerConnection) warnings.push('当前页面的 WebRTC 接口不可用，仍可连接信令并发现设备，但无法传文件。请优先检查 HTTPS 和浏览器设置，或升级浏览器。');
if (warnings.length) { element('environment-warning').hidden = false; element('environment-warning').textContent = warnings.join(' '); }
renderPeers();
diagnose({ frontend: '已启动' });
connect();
