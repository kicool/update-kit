// contract-loader.js — 契约加载器：三层合并 + 路径解析
//
// 三层结构：
//   defaults.json（kit 默认值）→ 项目契约（update-kit.contract.json）→ 本机覆盖（update-kit.local.json）
//
// 职责：
//   1. 读取三层配置
//   2. 深合并（updatePolicy 允许深合并，其他字段覆盖）
//   3. 路径解析（相对路径 → 绝对路径）
//   4. 旧字段迁移（autoPull → updatePolicy.apply）
//
// 红线：纯 node，零 electron 依赖，可进 CI。
'use strict';
const fs = require('fs');
const path = require('path');

/**
 * 创建契约加载器
 * @param {object} opts
 * @param {string} opts.projectRoot — 项目根目录
 * @param {string} opts.kitDir — kit 目录（默认 src/update-kit）
 * @param {string} opts.shellDir — 壳层目录（默认 src/application）
 */
function createContractLoader({ projectRoot, kitDir, shellDir }) {
  const defaultsFile = path.join(kitDir, 'defaults.json');
  const contractFile = path.join(projectRoot, 'update-kit.contract.json');
  const localFile = path.join(projectRoot, 'update-kit.local.json');

  function readJson(file, required) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      if (required) throw new Error(`[contract-loader] 读取契约失败: ${file}（${e.message}）`);
      return null;
    }
  }

  // 读取三层配置
  const defaults = readJson(defaultsFile, true);
  const contract = readJson(contractFile) || {};
  const local = readJson(localFile) || {};

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

  // 合并三层：defaults → contract → local
  const merged = deepMerge(deepMerge(defaults, contract), local);

  function pick(key, fallback) {
    return merged[key] !== undefined ? merged[key] : fallback;
  }

  // 旧字段迁移：autoPull → updatePolicy.apply
  function legacyApplyFrom(localOverride) {
    if (!localOverride || localOverride.autoPull !== false) return null;
    if (localOverride.updatePolicy && localOverride.updatePolicy.apply !== undefined) return null;
    return 'notify';
  }

  function resolvePolicy() {
    const policy = merged.updatePolicy || {};
    const legacy = legacyApplyFrom(local);
    if (!legacy) return policy;
    console.log('[contract-loader] 迁移旧字段：autoPull=false 已映射为 updatePolicy.apply=notify');
    return { ...policy, apply: legacy };
  }

  const paths = merged.paths || {};
  const repoPath = path.resolve(projectRoot, pick('repoPath', paths.repoPath || '.'));

  const norm = (p) => p.replace(/\\/g, '/').replace(/\/$/, '');
  const rendererDir = norm(paths.rendererDir || '');
  const appEntry = norm(paths.appEntry || '');

  if (!appEntry.startsWith(rendererDir + '/')) {
    throw new Error(`[contract-loader] 契约冲突：appEntry(${appEntry}) 必须位于 rendererDir(${rendererDir}) 内`);
  }

  const updatePolicy = resolvePolicy();

  return {
    // 运行期开关
    remote: pick('remote', 'origin'),
    branch: pick('branch', 'release'),
    useWorktree: pick('useWorktree', false),
    treeLabel: pick('treeLabel', ''),
    skipUpdate: pick('skipUpdate', false),
    autoRestart: pick('autoRestart', false),

    // 根目录
    shellDir,
    repoPath,
    projectRoot,

    // 壳侧路径（paths.preload 相对于项目根）
    preloadPath: path.resolve(projectRoot, paths.preload || 'src/application/preload.js'),

    // 代码树相对路径
    appEntry,
    rendererDir,
    rendererPrefix: rendererDir + '/',
    rendererEntry: norm(paths.rendererEntry || ''),

    // 桥接契约
    bridgeApi: merged.bridgeApi || [],

    // 契约版本
    contractVersion: merged.contractVersion || '0.0.0',
    contractMinSupported: merged.contractMinSupported || '0.0.0',

    // 更新单元白名单
    updateUnits: merged.updateUnits || [],

    // 时机策略
    updatePolicy,

    describe() {
      return [
        `remote=${this.remote} branch=${this.branch} skipUpdate=${this.skipUpdate}`,
        `treeLabel=${this.treeLabel || '(未设置)'}`,
        `repoPath=${this.repoPath}`,
        `appEntry=${this.appEntry}`,
        `rendererPrefix=${this.rendererPrefix}`,
        `preload=${this.preloadPath}`,
        `bridgeApi=[${this.bridgeApi.map((a) => a.name || a).join(', ')}]`,
        `contractVersion=${this.contractVersion} (minSupported=${this.contractMinSupported})`,
        `updateUnits=[${this.updateUnits.map((u) => u.name + ':' + u.class).join(', ')}]`,
        `updatePolicy=enabled:${this.updatePolicy.enabled} onStartup:${this.updatePolicy.onStartup}` +
          ` schedule:${(this.updatePolicy.schedule || {}).mode}` +
          ` apply:${this.updatePolicy.apply}`,
      ].join('\n  ');
    },
  };
}

// 导出供测试：旧字段迁移规则必须可断言
function legacyApplyFrom(localOverride) {
  if (!localOverride || localOverride.autoPull !== false) return null;
  if (localOverride.updatePolicy && localOverride.updatePolicy.apply !== undefined) return null;
  return 'notify';
}

module.exports = { createContractLoader, legacyApplyFrom };
