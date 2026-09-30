// core/contract.js — 契约自检（纯 node，零 electron 依赖 → 可进 CI / pre-commit）
//
// 三个检查：
//   1. 结构自检        schema 合法性、路径存在、单元无冲突、appEntry 在 rendererDir 内、hot 单元必须在 rendererDir 内
//   2. 覆盖率         枚举全部 tracked 文件，列出未被任何 updateUnit 覆盖者（白名单的前提是「都登记了」）
//   3. bridgeApi 双向一致  注册表声明 vs preload.js 实际实现（用正则解析源码，不 require，因为 preload 首行 require('electron')）
'use strict';
const fs = require('fs');
const path = require('path');
const classifier = require('./classifier');

/** 1) 结构自检 */
function validate(contract, { appRoot, shellDir }) {
  const errors = [];
  const warn = [];
  const units = contract.updateUnits || [];

  errors.push(...classifier.validateUnits(units));

  // 两种入参都支持：原始 registry.json（paths.rendererDir）或已解析的 registry.js 导出（顶层 rendererDir）
  const paths = contract.paths || {};
  const rendererDir = String(paths.rendererDir || contract.rendererDir || '').replace(/\/$/, '');
  const appEntry = String(paths.appEntry || contract.appEntry || '');
  if (!rendererDir) errors.push('paths.rendererDir 缺失');
  if (!appEntry) errors.push('paths.appEntry 缺失');
  if (rendererDir && appEntry && !appEntry.startsWith(rendererDir + '/')) {
    errors.push(`appEntry(${appEntry}) 必须位于 rendererDir(${rendererDir}) 内`);
  }

  // hot 单元必须完全落在 rendererDir 内：否则「改了就热更」会把不该热更的东西热更掉
  for (const u of units) {
    if (u.class !== 'hot') continue;
    for (const p of u.paths || []) {
      const ok = p.endsWith('/') ? p.replace(/\/$/, '') === rendererDir || p.startsWith(rendererDir + '/')
        : p.startsWith(rendererDir + '/');
      if (!ok) {
        errors.push(`hot 单元 ${u.name} 的路径 ${p} 不在 rendererDir(${rendererDir}) 内 —— hot 意味着 reload 即可接管，出圈即失效`);
      }
    }
  }

  if (appRoot) {
    for (const u of units) {
      for (const p of u.paths || []) {
        if (p.endsWith('/')) continue;               // 目录前缀：仓库里可能还没建
        if ((u.unreachableByGit) ) continue;          // git 到不了的（node_modules）不检查存在性
        if (!fs.existsSync(path.join(appRoot, p))) {
          warn.push(`单元 ${u.name} 的路径 ${p} 在加载树里不存在（可能已改名/已删除）`);
        }
      }
    }
  }

  const pol = contract.updatePolicy || {};
  if (!['off', 'check', 'checkAndApply'].includes(pol.onStartup)) {
    errors.push(`updatePolicy.onStartup="${pol.onStartup}" 非法，应为 off/check/checkAndApply`);
  }
  const mode = (pol.schedule || {}).mode;
  if (!['off', 'interval', 'dailyAt'].includes(mode)) {
    errors.push(`updatePolicy.schedule.mode="${mode}" 非法，应为 off/interval/dailyAt`);
  }
  if (mode === 'dailyAt' && !/^\d{1,2}:\d{2}$/.test((pol.schedule || {}).dailyAt || '')) {
    errors.push('updatePolicy.schedule.dailyAt 必须是 "HH:MM"');
  }
  if (!['auto', 'notify'].includes(pol.apply)) {
    errors.push(`updatePolicy.apply="${pol.apply}" 非法，应为 auto/notify`);
  }

  // —— 以下三条是「不崩、但静默失效/伤远程」的配置，必须拦在写配置的人面前 ——
  const sch = pol.schedule || {};
  if (sch.mode === 'interval') {
    const iv = Number(sch.intervalMinutes);
    if (!Number.isFinite(iv) || iv <= 0) {
      errors.push(`updatePolicy.schedule.intervalMinutes=${JSON.stringify(sch.intervalMinutes)} 非法：应为正数（非法值会被回落成 60 分钟，与你写的意图不符）`);
    } else if (iv < 5) {
      errors.push(`updatePolicy.schedule.intervalMinutes=${iv} 过小：低于 5 分钟会让客户端高频 git fetch，等于自己打自己的远程`);
    }
  }
  const jitter = Number(sch.jitterMinutes);
  if (sch.jitterMinutes !== undefined && (!Number.isFinite(jitter) || jitter < 0)) {
    errors.push(`updatePolicy.schedule.jitterMinutes=${JSON.stringify(sch.jitterMinutes)} 非法：应为 ≥0 的数字（抖动的意义是打散，不能为负）`);
  }
  const mr = pol.constraints && pol.constraints.maxRetries;
  if (mr !== undefined && (!Number.isInteger(mr) || mr < 0)) {
    errors.push(`updatePolicy.constraints.maxRetries=${JSON.stringify(mr)} 非法：应为 ≥0 的整数（0＝失败一次即放弃，不是「不限」）`);
  }
  const q = pol.quietHours || {};
  if ((q.from && !q.to) || (!q.from && q.to)) {
    errors.push('updatePolicy.quietHours 只写了 from 或只写了 to：免打扰会静默失效（判定要求两者齐全）');
  }
  if (q.from && q.to && q.from === q.to) {
    warn.push(`updatePolicy.quietHours 起止相同（${q.from}→${q.to}）：区间为空，免打扰永不生效；想全天免打扰请写 00:00→23:59`);
  }
  if ((q.from && !/^\d{1,2}:\d{2}$/.test(q.from)) || (q.to && !/^\d{1,2}:\d{2}$/.test(q.to))) {
    errors.push(`updatePolicy.quietHours 时间格式应为 "HH:MM"（from=${q.from} to=${q.to}）`);
  }

  if (!contract.contractVersion) warn.push('未声明 contractVersion，跨版本兼容性判定会退化为「总是兼容」');

  return { errors, warn };
}

/** 2) 覆盖率：列出未被任何单元覆盖的 tracked 文件 */
function coverage(trackedFiles, units) {
  const uncovered = [];
  for (const f of trackedFiles) {
    if (!classifier.matchUnit(f, units)) uncovered.push(f);
  }
  return uncovered;
}

/**
 * 3) bridgeApi 双向一致：解析 preload.js 源码里的 handlers 键名，与注册表比对。
 * 不 require 它 —— preload 首行 require('electron')，node 直接跑会炸，
 * 而这个检查必须能在 CI 里跑，所以只能用正则/AST 读源码。
 *
 * 支持两种格式：
 *   - 字符串数组：["checkUpdate", "applyUpdate"]
 *   - 对象数组：[{name: "checkUpdate", type: "invoke", channel: "update-kit:check"}]
 *
 * 支持两种 preload 结构：
 *   - 直接包含 handlers：const handlers = { ... };
 *   - 引用生成的 handlers：const handlers = require('./preload-handlers');
 */
function checkBridgeApi(preloadSource, declaredApi, preloadPath) {
  let handlersSource = preloadSource;

  // 检查是否引用生成的 handlers
  const requireMatch = preloadSource.match(/require\(['"]\.\/preload-handlers['"]\)/);
  if (requireMatch && preloadPath) {
    const handlersPath = require('path').join(require('path').dirname(preloadPath), 'preload-handlers.js');
    try {
      handlersSource = require('fs').readFileSync(handlersPath, 'utf8');
    } catch (e) {
      return { errors: [`找不到 preload-handlers.js: ${handlersPath}`] };
    }
  }

  const start = handlersSource.indexOf('const handlers');
  if (start < 0) return { errors: ['preload.js 里找不到 `const handlers = {` 声明块'] };

  // 从 `const handlers` 起，取到第一个顶格 `};` 为止
  const rest = handlersSource.slice(start);
  const end = rest.search(/\n\};/);
  const block = end < 0 ? rest : rest.slice(0, end + 2);
  if (end < 0) return { errors: ['preload.js 的 handlers 块没有找到结束的 `};`'] };

  const implemented = new Set();
  for (const m of block.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*:/gm)) implemented.add(m[1]);

  // 支持字符串数组和对象数组两种格式
  const declared = new Set(
    (declaredApi || []).map((api) => typeof api === 'string' ? api : api.name)
  );
  const unimplemented = [...declared].filter((k) => !implemented.has(k));
  const undeclared = [...implemented].filter((k) => !declared.has(k));

  const errors = [];
  if (unimplemented.length) errors.push(`注册表声明但 preload 未实现: ${unimplemented.join(', ')}`);
  if (undeclared.length) errors.push(`preload 已实现但未登记到 registry.json: ${undeclared.join(', ')}`);
  return { errors, implemented: [...implemented], declared: [...declared] };
}

module.exports = { validate, coverage, checkBridgeApi };
