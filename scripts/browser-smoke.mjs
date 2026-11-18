import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

async function until(predicate, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Browser smoke test timed out');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function availablePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function findBrowser() {
  const candidates = [process.env.BROWSER_PATH, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].filter(Boolean);
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch {}
  }
  throw new Error('Set BROWSER_PATH to an existing Chromium/Chrome/Edge executable.');
}

class DevTools {
  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    this.errors = [];
    socket.on('message', data => {
      const message = JSON.parse(data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      }
      if (message.method === 'Runtime.exceptionThrown') this.errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    });
  }

  send(method, params = {}, sessionId, timeout = 30000) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`DevTools timeout: ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async evaluate(session, expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
}

const browserPath = await findBrowser();
const legacyLan = process.argv.includes('--lan-legacy-dialog');
const lanMode = legacyLan || process.argv.includes('--lan');
const noWebRTC = process.argv.includes('--no-webrtc');
const debugEnabled = process.argv.includes('--debug');
const smokePassword = process.argv.includes('--no-password') ? '' : 'lan-drop-smoke-only';
if (noWebRTC && !lanMode) throw new Error('--no-webrtc requires --lan or --lan-legacy-dialog');
const port = await availablePort();
const profile = await mkdtemp(path.join(os.tmpdir(), 'lan-drop-smoke-'));
const downloads = path.join(profile, 'downloads');
const base = `http://127.0.0.1:${port}`;
const artifacts = path.resolve('.artifacts', `${lanMode ? 'lan' : 'room'}-${debugEnabled ? 'debug' : 'normal'}${noWebRTC ? '-no-rtc' : ''}${legacyLan ? '-legacy' : ''}`);
await mkdir(artifacts, { recursive: true });
await mkdir(downloads, { recursive: true });
let browser;
let devtools;
const service = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), MODE: lanMode ? 'lan' : 'room', DEBUG: String(debugEnabled), ACCESS_PASSWORD: smokePassword, ALLOW_PASSWORDLESS_LAN: String(!smokePassword), TRUSTED_PROXIES: '', MAX_CONNECTIONS_PER_IP: '16', ICE_SERVERS: '[]', ALLOWED_ORIGINS: '' },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
});

try {
  let serviceLog = '';
  service.stdout.on('data', data => { serviceLog += data; });
  service.stderr.on('data', data => { serviceLog += data; });
  await until(() => serviceLog.includes('LAN Drop listening'), 10000);
  browser = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let browserLog = '';
  browser.stderr.on('data', data => { browserLog += data; });
  await until(() => /DevTools listening on (ws:\/\/\S+)/.test(browserLog), 15000);
  const endpoint = browserLog.match(/DevTools listening on (ws:\/\/\S+)/)[1];
  const socket = new WebSocket(endpoint);
  await once(socket, 'open');
  devtools = new DevTools(socket);
  await devtools.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });

  async function page(width, height, mobile) {
    const { targetId } = await devtools.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await devtools.send('Target.attachToTarget', { targetId, flatten: true });
    await devtools.send('Runtime.enable', {}, sessionId);
    await devtools.send('Page.enable', {}, sessionId);
    if (legacyLan && mobile) {
      await devtools.send('Page.addScriptToEvaluateOnNewDocument', { source: 'delete HTMLDialogElement.prototype.showModal; delete HTMLDialogElement.prototype.close;' }, sessionId);
    }
    if (noWebRTC && mobile) await devtools.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.RTCPeerConnection = undefined;' }, sessionId);
    await devtools.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }, sessionId);
    if (mobile) await devtools.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', platform: 'Linux armv8l' }, sessionId);
    await devtools.send('Page.navigate', { url: `${base}${lanMode ? '#room=ABCDEFGH' : ''}` }, sessionId);
    if (smokePassword) {
    await until(() => devtools.evaluate(sessionId, 'document.getElementById("password-dialog")?.open === true'));
    const prompt = await devtools.evaluate(sessionId, '(() => { const dialog = document.getElementById("password-dialog"); const rect = dialog.getBoundingClientRect(); return { visible: rect.width > 0 && rect.height > 0 && getComputedStyle(dialog).display !== "none", fallback: dialog.classList.contains("modal-fallback-dialog"), focus: document.activeElement.id, status: document.getElementById("connection-label").textContent }; })()');
    assert.equal(prompt.visible, true);
    assert.equal(prompt.fallback, legacyLan && mobile);
    assert.equal(prompt.status, '等待访问密码');
    if (legacyLan && mobile) {
      assert.equal(prompt.focus, 'password-input');
      await devtools.evaluate(sessionId, 'document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))');
      assert.ok(await devtools.evaluate(sessionId, 'document.getElementById("password-dialog").open'));
      const screenshot = await devtools.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      await writeFile(path.join(artifacts, 'legacy-password.png'), Buffer.from(screenshot.data, 'base64'));
    }
    await devtools.evaluate(sessionId, 'document.getElementById("password-input").value = "wrong"; document.getElementById("password-form").requestSubmit()');
    await until(() => devtools.evaluate(sessionId, 'document.getElementById("password-description").textContent.includes("不正确")'));
    assert.ok(await devtools.evaluate(sessionId, 'document.getElementById("password-dialog").open'));
    await devtools.evaluate(sessionId, `document.getElementById("password-input").value = ${JSON.stringify(smokePassword)}; document.getElementById("password-form").requestSubmit()`);
    }
    await until(() => devtools.evaluate(sessionId, 'document.querySelector("#connection-status")?.dataset.state === "online"'));
    assert.equal(await devtools.evaluate(sessionId, 'document.getElementById("password-dialog").open'), false);
    return sessionId;
  }

  const desktop = await page(1440, 1100, false);
  const mobile = await page(390, 844, true);
  if (lanMode) {
    await until(() => devtools.evaluate(desktop, 'document.getElementById("mode-label").textContent.includes("局域网模式")'));
    await until(() => devtools.evaluate(mobile, 'document.getElementById("mode-label").textContent.includes("局域网模式")'));
    assert.ok(await devtools.evaluate(mobile, 'parseFloat(getComputedStyle(document.getElementById("connection-status")).fontSize) > 0'));
    for (const session of [desktop, mobile]) {
      assert.ok(await devtools.evaluate(session, 'document.getElementById("room-panel").hidden && document.getElementById("room-active").hidden && document.getElementById("room-code").textContent === "" && !document.querySelector("#qr-code svg")'));
      assert.ok(await devtools.evaluate(session, 'location.hash === ""'));
    }
  } else {
    await devtools.evaluate(desktop, 'document.getElementById("create-room").click()');
    await until(() => devtools.evaluate(desktop, '!!document.querySelector("#qr-code svg")'));
    const roomCode = await devtools.evaluate(desktop, 'document.getElementById("room-code").textContent.replace(/\\s/g, "")');
    await devtools.evaluate(mobile, `document.getElementById("room-input").value = ${JSON.stringify(roomCode)}; document.getElementById("join-form").requestSubmit()`);
  }
  await until(() => devtools.evaluate(desktop, 'document.querySelectorAll(".peer-card").length === 1'));
  await until(() => devtools.evaluate(mobile, 'document.querySelectorAll(".peer-card").length === 1'));
  const desktopCode = await devtools.evaluate(desktop, 'document.getElementById("self-code").textContent');
  const mobileCode = await devtools.evaluate(mobile, 'document.getElementById("self-code").textContent');
  assert.match(desktopCode, /^设备码 [A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/);
  assert.notEqual(desktopCode, mobileCode);
  assert.equal(await devtools.evaluate(desktop, 'document.querySelector(".peer-card .device-code").textContent'), mobileCode);
  assert.equal(await devtools.evaluate(mobile, 'document.querySelector(".peer-card .device-code").textContent'), desktopCode);

  if (debugEnabled) {
  const desktopServer = await devtools.evaluate(desktop, 'document.getElementById("diagnostics-output").textContent.match(/服务实例：([^\\n]+)/)[1]');
  const mobileServer = await devtools.evaluate(mobile, 'document.getElementById("diagnostics-output").textContent.match(/服务实例：([^\\n]+)/)[1]');
  assert.equal(desktopServer, mobileServer);
  assert.ok(await devtools.evaluate(mobile, 'document.getElementById("diagnostics-output").textContent.includes("前端脚本：已启动")'));
  assert.equal(await devtools.evaluate(mobile, 'document.getElementById("connection-diagnostics").hidden'), false);
  } else {
    for (const session of [desktop, mobile]) {
      assert.ok(await devtools.evaluate(session, 'document.getElementById("connection-diagnostics").hidden && typeof window.LanDropDiagnostics === "undefined"'));
      assert.equal(await devtools.evaluate(session, 'document.getElementById("startup-warning").hidden'), true);
    }
  }
  if (noWebRTC) {
    if (debugEnabled) assert.ok(await devtools.evaluate(mobile, 'document.getElementById("diagnostics-output").textContent.includes("WebRTC 接口：不可用")'));
    assert.ok(await devtools.evaluate(mobile, 'document.getElementById("environment-warning").textContent.includes("仍可连接信令并发现设备")'));
    assert.ok(await devtools.evaluate(mobile, 'document.getElementById("room-empty").hidden'));
  }

  async function verifyTransfer() {
  const text = 'LAN Drop 浏览器直传测试。\n'.repeat(16000);
  async function chooseFile(session, content, filename) {
    await devtools.evaluate(session, `(() => { document.querySelector(".peer-card").click(); const selection = new DataTransfer(); selection.items.add(new File([${JSON.stringify(content)}], ${JSON.stringify(filename)}, { type: "text/plain" })); const input = document.getElementById("file-input"); input.files = selection.files; input.dispatchEvent(new Event("change")); })()`);
  }
  await chooseFile(desktop, text, 'LAN-Drop-test.txt');
  await until(() => devtools.evaluate(mobile, 'document.getElementById("receive-dialog").open'));
  assert.ok(await devtools.evaluate(mobile, `document.getElementById("receive-description").textContent.includes(${JSON.stringify(desktopCode)})`));
  await devtools.evaluate(mobile, 'document.getElementById("accept-memory").click()');
  await until(() => devtools.evaluate(desktop, '!!document.querySelector(".transfer-card[data-status=completed]")'));
  await until(() => devtools.evaluate(mobile, '!!document.querySelector(".download-link")'));
  await devtools.evaluate(mobile, 'document.querySelector(".download-link").click()');
  const downloadedFile = path.join(downloads, 'LAN-Drop-test.txt');
  await until(async () => { try { await access(downloadedFile); return true; } catch { return false; } });
  const saved = await readFile(downloadedFile, 'utf8');
  assert.equal(saved, text);

  await chooseFile(mobile, '拒绝接收测试', 'reject.txt');
  await until(() => devtools.evaluate(desktop, 'document.getElementById("receive-dialog").open'));
  await devtools.evaluate(desktop, 'document.getElementById("reject-transfer").click()');
  await until(() => devtools.evaluate(mobile, '!!document.querySelector(".transfer-card[data-status=rejected]")'));

  await chooseFile(desktop, '取消测试', 'cancel.txt');
  await until(() => devtools.evaluate(mobile, 'document.getElementById("receive-dialog").open'));
  await devtools.evaluate(desktop, 'document.querySelector(".transfer-card[data-status=waiting] .icon-button").click()');
  await until(() => devtools.evaluate(mobile, '!document.getElementById("receive-dialog").open'));
  }
  if (!noWebRTC) await verifyTransfer();

  for (const [session, filename] of [[desktop, 'desktop.png'], [mobile, 'mobile.png']]) {
    await devtools.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, session);
    await devtools.send('Page.bringToFront', {}, session);
    await devtools.evaluate(session, 'document.getElementById("toast-region").replaceChildren()');
    await new Promise(resolve => setTimeout(resolve, 1000));
    const dimensions = await devtools.evaluate(session, '({ content: document.documentElement.scrollWidth, viewport: innerWidth })');
    assert.ok(dimensions.content <= dimensions.viewport, `Horizontal overflow in ${filename}`);
    const layout = await devtools.evaluate(session, '(() => { const card = document.querySelector(".peer-card").getBoundingClientRect(); const stage = document.querySelector(".device-stage").getBoundingClientRect(); return { center: card.x + card.width / 2, stageCenter: stage.x + stage.width / 2, top: card.top, viewport: innerHeight }; })()');
    assert.ok(Math.abs(layout.center - layout.stageCenter) < 2, 'Devices should be centered');
    assert.ok(layout.top < layout.viewport, 'Devices should appear in the first viewport');
    const { cssContentSize } = await devtools.send('Page.getLayoutMetrics', {}, session);
    const screenshot = await devtools.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 } }, session);
    await writeFile(path.join(artifacts, filename), Buffer.from(screenshot.data, 'base64'));
  }
  await devtools.evaluate(mobile, 'document.getElementById("theme-button").click()');
  assert.ok(await devtools.evaluate(mobile, '!!document.documentElement.dataset.theme'));
  assert.deepEqual(devtools.errors, []);
  console.log(`PASS (${lanMode ? 'LAN' : 'room'} / DEBUG=${debugEnabled}): centered device UI, room controls, ${smokePassword ? 'password authentication' : 'no password'}, ${noWebRTC ? 'discovery without WebRTC' : 'real file transfer, rejection, cancellation'}, mobile overflow, no JavaScript exceptions.`);
  console.log(`Screenshots: ${artifacts}`);
} finally {
  if (devtools) {
    await devtools.send('Browser.close', {}, undefined, 2000).catch(() => {});
    devtools.socket.close();
    for (const pending of devtools.pending.values()) clearTimeout(pending.timer);
  }
  if (browser?.exitCode === null) {
    const exited = once(browser, 'exit');
    browser.kill();
    await exited;
  }
  if (service.exitCode === null) {
    const exited = once(service, 'exit');
    service.kill();
    await exited;
  }
  const resolvedProfile = path.resolve(profile);
  if (!resolvedProfile.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolvedProfile).startsWith('lan-drop-smoke-')) throw new Error('Unsafe temporary profile path');
  await rm(resolvedProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
