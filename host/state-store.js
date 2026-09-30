// state-store.js — 运行时状态持久化（userData/update-state.json）
//
// 职责：
//   1. 读取/写入 update-state.json
//   2. 状态包括：lastCheckAt、failures、lastResult
//
// 红线：纯 node，零 electron 依赖（通过参数注入 userDataDir）。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

/**
 * 创建状态存储
 * @param {string} userDataDir — userData 目录
 */
function createStateStore(userDataDir) {
  const stateFile = () => path.join(userDataDir, 'update-state.json');

  function load() {
    try {
      return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    } catch {
      return {};
    }
  }

  function save(state) {
    try {
      fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
      fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2));
    } catch (e) {
      console.error('[state-store] 保存状态失败:', e.message);
    }
  }

  function get(key) {
    return load()[key];
  }

  function patch(key, value) {
    const state = load();
    state[key] = value;
    save(state);
  }

  return { load, save, get, patch };
}

module.exports = { createStateStore };
