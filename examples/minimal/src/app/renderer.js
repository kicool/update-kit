// renderer.js — 渲染层逻辑
'use strict';

const statusEl = document.getElementById('status');

function setStatus(msg) {
  statusEl.textContent = '状态：' + msg;
}

// 监听状态更新
api.onStatus((s) => {
  if (s.ok) {
    setStatus(s.updated ? '已更新' : '已是最新');
  } else if (s.offline) {
    setStatus('离线');
  } else if (s.blocked) {
    setStatus('被阻止：' + s.blocked);
  } else {
    setStatus('错误：' + (s.error || '未知'));
  }
});

// 监听配置更新
api.onConfig((c) => {
  console.log('配置更新:', c);
});

// 初始检查
api.checkUpdate().then((s) => {
  if (s.ok) {
    setStatus(s.updated ? '已更新' : '已是最新');
  } else {
    setStatus('错误：' + (s.error || '未知'));
  }
});
