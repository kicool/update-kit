// ipc-bridge.js — IPC 通道注册
//
// 职责：
//   1. 按 bridgeApi 注册 ipcMain.handle / on
//   2. 校验 impl 缺项或多项 → throw
//
// 红线：纯 node，零 electron 依赖（通过参数注入 ipcMain）。
'use strict';

/**
 * 注册 IPC 通道
 * @param {object} ipcMain — electron ipcMain（注入）
 * @param {Array} bridgeApi — bridgeApi 数组
 * @param {object} impl — 实现对象
 */
function registerIpcBridge(ipcMain, bridgeApi, impl) {
  const registered = new Set();

  for (const api of bridgeApi) {
    const { name, type, channel } = api;

    if (!impl[name]) {
      throw new Error(`[ipc-bridge] 缺少实现: ${name}`);
    }

    if (type === 'invoke') {
      ipcMain.handle(channel, impl[name]);
    } else if (type === 'send') {
      ipcMain.on(channel, impl[name]);
    } else if (type === 'on') {
      // on 类型由 renderer 主动监听，主进程不需要注册
      // 但需要标记为已注册，避免误报"多余实现"
    } else {
      throw new Error(`[ipc-bridge] 未知 type: ${type}`);
    }

    registered.add(name);
  }

  // 检查多余实现
  const extra = Object.keys(impl).filter((k) => !registered.has(k));
  if (extra.length) {
    throw new Error(`[ipc-bridge] 多余实现: ${extra.join(', ')}`);
  }
}

module.exports = { registerIpcBridge };
