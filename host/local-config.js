// local-config.js — 本机覆盖配置读写（update-kit.local.json）
//
// 职责：
//   1. 读取/写入 update-kit.local.json
//   2. 合并 updatePolicy 片段
//
// 红线：纯 node，零 electron 依赖。
'use strict';
const fs = require('fs');
const path = require('path');

/**
 * 创建本机配置管理
 * @param {string} projectRoot — 项目根目录
 */
function createLocalConfig(projectRoot) {
  const configFile = path.join(projectRoot, 'update-kit.local.json');

  function read() {
    try {
      return JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch {
      return {};
    }
  }

  function write(config) {
    try {
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    } catch (e) {
      console.error('[local-config] 写入配置失败:', e.message);
    }
  }

  function mergePolicy(patch) {
    const config = read();
    config.updatePolicy = deepMerge(config.updatePolicy || {}, patch);
    write(config);
    return config.updatePolicy;
  }

  function deepMerge(base, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
    const out = { ...base };
    for (const [k, v] of Object.entries(patch)) {
      const nested = v && typeof v === 'object' && !Array.isArray(v) &&
        out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]);
      out[k] = nested ? deepMerge(out[k], v) : v;
    }
    return out;
  }

  return { read, write, mergePolicy };
}

module.exports = { createLocalConfig };
