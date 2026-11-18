(function () {
  'use strict';

  if (!window.LAN_DROP_CONFIG || window.LAN_DROP_CONFIG.debug !== true) return;

  var facts = {
    version: 'security-1',
    frontend: '主脚本尚未启动',
    status: '正在加载页面',
    socket: '尚未连接',
    mode: '尚未收到服务配置',
    room: '尚未加入',
    server: '尚未收到服务标识',
    peers: 0
  };
  var errors = [];
  var issue = '';
  var issueKind = '';

  function render() {
    var output = document.getElementById('diagnostics-output');
    var warning = document.getElementById('startup-warning');
    var panel = document.getElementById('connection-diagnostics');
    if (!output || !warning || !panel) return;
    panel.hidden = false;
    output.textContent = [
      '页面版本：' + facts.version,
      '访问地址：' + location.origin + location.pathname,
      '安全上下文：' + (window.isSecureContext ? '是（HTTPS 或本地安全地址）' : '否'),
      'WebSocket 接口：' + (typeof window.WebSocket === 'function' ? '支持' : '不支持'),
      'WebRTC 接口：' + (typeof window.RTCPeerConnection === 'function' ? '支持' : '不可用'),
      '原生弹窗接口：' + (window.HTMLDialogElement && typeof window.HTMLDialogElement.prototype.showModal === 'function' ? '支持' : '使用兼容弹窗'),
      '前端脚本：' + facts.frontend,
      '连接状态：' + facts.status,
      'WebSocket：' + facts.socket,
      '服务模式：' + facts.mode,
      '服务实例：' + facts.server,
      '当前房间：' + facts.room,
      '其他设备：' + facts.peers,
      '浏览器：' + navigator.userAgent,
      '错误：' + (errors.length ? errors.join('\n') : '暂无')
    ].join('\n');
    warning.hidden = !issue;
    warning.textContent = issue;
    if (issue) panel.open = true;
  }

  window.LanDropDiagnostics = {
    report: function (updates) {
      Object.keys(updates).forEach(function (key) { facts[key] = updates[key]; });
      if (!errors.length && (updates.frontend === '已启动' || (issueKind === 'connection' && updates.socket === '已收到服务消息'))) {
        issue = '';
        issueKind = '';
      }
      render();
    }
  };

  window.addEventListener('error', function (event) {
    if (event.target && event.target.tagName === 'SCRIPT') {
      errors.push('脚本加载失败：' + (event.target.getAttribute('src') || '未知脚本'));
    } else if (event.message) {
      errors.push(String(event.message).slice(0, 240));
    } else return;
    errors = errors.slice(-5);
    issue = '页面脚本发生错误，请展开连接诊断并截图。检查是否完整上传前端文件，勿仅凭页面能打开判断信令已连接。';
    issueKind = 'script';
    render();
  }, true);

  document.addEventListener('DOMContentLoaded', function () {
    render();
    setTimeout(function () {
      if (facts.frontend === '主脚本尚未启动' || facts.frontend === '正在初始化') {
        issue = '前端尚未正常启动。可能是脚本加载、缓存或浏览器兼容性问题，请截图下方连接诊断。';
        issueKind = 'script';
      } else if (facts.socket === '尚未连接' || facts.socket === '正在连接') {
        issue = '信令连接尚未建立。请核对手机访问的协议、域名和端口，并检查 /ws 的反向代理。';
        issueKind = 'connection';
      }
      render();
    }, 8000);
  });
}());
