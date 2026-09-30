// core/classifier.js — 更新单元白名单分类器
//
// 红线：纯 node，零 electron 依赖、零业务依赖 —— 这样它才能被 CI / pre-commit / 单测直接跑。
// 输入只有「变更文件列表 + 白名单 + 契约版本」，输出「这次更新属于哪一档能力」。
//
// 为什么不用路径前缀启发式（旧的 onlyRendererChanges）：
//   它回答的是「文件在哪个目录」，而真正要回答的是「新旧两份代码会不会同时存在于运行态」。
//   前者是后者的代理指标，会误报（改 docs 弹重启，已实证）也会漏。答案应该写在契约里，不该猜。
'use strict';

// 四档能力。severity 单调递增，一次更新的最终类别 = 变更集里最高的那一档。
const SEVERITY = { none: 0, hot: 1, restart: 2, reinstall: 3 };
const CLASSES = Object.keys(SEVERITY);

const maxClass = (a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a);

// 类别 → 默认动作（契约里可显式指定 action 覆盖）
const DEFAULT_ACTION = {
  none: 'none',
  hot: 'reload',
  restart: 'relaunch',
  reinstall: 'prompt-reinstall',
};

/**
 * 单个文件归属哪个单元。
 * 匹配规则（见设计文档 4.3）：
 *   1. 路径以 '/' 结尾 = 目录前缀匹配；否则 = 精确文件匹配。
 *   2. 最长模式优先：精细单元覆盖粗单元。
 *      （精确文件模式的长度天然 >= 目录前缀长度，所以统一按「命中的模式串长度」比较即可。）
 */
function matchUnit(file, units) {
  let best = null;
  let bestLen = -1;
  for (const unit of units) {
    for (const pattern of unit.paths || []) {
      const isDir = pattern.endsWith('/');
      const hit = isDir ? file.startsWith(pattern) : file === pattern;
      if (hit && pattern.length > bestLen) {
        best = unit;
        bestLen = pattern.length;
      }
    }
  }
  return best;
}

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}

/**
 * 契约兼容性判定（回答「壳还能不能自举」）。
 *   - 主版本不同        → 'incompatible'：运行中的壳读不懂新契约 → 只能重装
 *   - 新契约低于最低支持 → 'incompatible'：降级太远，同样无法自举
 *   - 次版本不同        → 'restart'：bridgeApi 面变了，旧 preload 可能缺新方法（保守）
 *   - 其余              → 'compatible'
 */
function compareContract(runningVersion, targetVersion, minSupported) {
  const run = parseSemver(runningVersion);
  const tgt = parseSemver(targetVersion);
  if (!run || !tgt) return 'unknown';
  if (tgt.major !== run.major) return 'incompatible';
  const min = parseSemver(minSupported);
  if (min && (tgt.major < min.major ||
    (tgt.major === min.major && (tgt.minor < min.minor ||
      (tgt.minor === min.minor && tgt.patch < min.patch))))) return 'incompatible';
  if (tgt.minor !== run.minor) return 'restart';
  return 'compatible';
}

/**
 * 主入口：变更集 → 更新能力分类。
 *
 * @param {string[]} files          变更文件列表（相对仓库根，posix 风格）
 * @param {object}   opts
 * @param {Array}    opts.units             白名单 updateUnits
 * @param {boolean}  opts.contractChanged   bridgeApi 名单是否变化（变了则 hot 不成立）
 * @param {string}   opts.runningContract   运行中壳的契约版本
 * @param {string}   opts.targetContract    目标（拉过来之后）契约版本
 * @param {string}   opts.minSupported      最低支持契约版本
 * @returns {{klass, severity, action, units, unknown, warnings, reasons, files}}
 */
function classify(files, opts = {}) {
  const {
    units = [],
    contractChanged = false,
    runningContract = null,
    targetContract = null,
    minSupported = null,
  } = opts;

  const list = files || [];
  const matched = new Map(); // name -> { unit, files }
  const unknown = [];
  const warnings = [];
  const reasons = [];

  for (const file of list) {
    const unit = matchUnit(file, units);
    if (!unit) {
      unknown.push(file);
      continue;
    }
    if (!matched.has(unit.name)) matched.set(unit.name, { unit, files: [] });
    matched.get(unit.name).files.push(file);
  }

  // 取变更集里 severity 最高的类别
  let klass = 'none';
  for (const { unit, files: fs } of matched.values()) {
    const c = CLASSES.includes(unit.class) ? unit.class : 'restart';
    if (!CLASSES.includes(unit.class)) {
      warnings.push(`单元 ${unit.name} 的 class="${unit.class}" 非法，已按 restart 处理`);
    }
    if (SEVERITY[c] > SEVERITY[klass]) klass = c;
    reasons.push(`${unit.name}(${c}) ← ${fs.length} 个文件：${fs.slice(0, 3).join('、')}${fs.length > 3 ? ' …' : ''}`);
  }

  if (unknown.length) {
    // 未登记不静默：保守按 restart + 吵闹告警。吵闹胜过静默猜错，这是白名单机制的精髓。
    klass = maxClass(klass, 'restart');
    const msg = `${unknown.length} 个文件未登记到任何 updateUnit，按 restart 保守处理：` +
      unknown.slice(0, 5).join('、') + (unknown.length > 5 ? ' …' : '');
    warnings.push(msg);
    reasons.push('unknown → restart（未登记）');
  }

  if (contractChanged) {
    // renderer 单独变只在「桥接契约没变」时才安全；bridgeApi 变了 → 旧 preload 提供不了新方法。
    klass = maxClass(klass, 'restart');
    reasons.push('bridgeApi 名单变化 → hot 不成立，降为 restart（保守）');
  }

  let contract = 'compatible';
  if (runningContract && targetContract) {
    contract = compareContract(runningContract, targetContract, minSupported);
    if (contract === 'incompatible') {
      klass = 'reinstall';
      reasons.push(`契约不兼容：运行中 ${runningContract} ↔ 目标 ${targetContract} → 无法自举，需重装`);
    } else if (contract === 'restart') {
      klass = maxClass(klass, 'restart');
      reasons.push(`契约次版本变化：${runningContract} → ${targetContract} → restart`);
    }
  }

  // 动作：取 severity 最高那个单元声明的 action（契约可覆盖默认动作）
  let action = DEFAULT_ACTION[klass];
  let topSeverity = -1;
  for (const { unit } of matched.values()) {
    const s = SEVERITY[CLASSES.includes(unit.class) ? unit.class : 'restart'];
    if (s > topSeverity) {
      topSeverity = s;
      action = unit.action || DEFAULT_ACTION[unit.class] || action;
    }
  }
  if (klass === 'reinstall') action = 'prompt-reinstall';
  if (unknown.length && klass === 'restart') action = 'relaunch';

  return {
    klass,
    severity: SEVERITY[klass],
    action,
    contract,
    units: [...matched.values()].map(({ unit, files: fs }) => ({
      name: unit.name,
      class: unit.class,
      action: unit.action || DEFAULT_ACTION[unit.class],
      fallback: unit.fallback || null, // restart 类可以有「失败则升级」的兜底（如 deps → reinstall）
      unreachableByGit: !!unit.unreachableByGit,
      files: fs,
    })),
    unknown,
    warnings,
    reasons,
    files: list,
    needsRestart: klass === 'restart' || klass === 'reinstall',
    hot: klass === 'hot',
  };
}

/**
 * 白名单自检：结构 + 路径冲突。冲突必须报错，不能静默取第一个（设计 4.3 第 3 条）。
 */
function validateUnits(units) {
  const errors = [];
  const seen = new Map(); // pattern -> [unitName]
  (units || []).forEach((u, i) => {
    const at = `updateUnits[${i}]${u && u.name ? `(${u.name})` : ''}`;
    if (!u || typeof u !== 'object') { errors.push(`${at}: 不是对象`); return; }
    if (!u.name) errors.push(`${at}: 缺少 name`);
    if (!CLASSES.includes(u.class)) errors.push(`${at}: class="${u.class}" 非法，应为 ${CLASSES.join('/')}`);
    if (!Array.isArray(u.paths) || !u.paths.length) errors.push(`${at}: paths 必须是非空数组`);
    for (const p of u.paths || []) {
      if (typeof p !== 'string' || !p) { errors.push(`${at}: paths 含非法项`); continue; }
      if (p.startsWith('/') || p.includes('..')) errors.push(`${at}: 路径 ${p} 必须是仓库内相对路径`);
      if (!seen.has(p)) seen.set(p, []);
      seen.get(p).push(u.name);
    }
  });
  for (const [pattern, names] of seen) {
    if (names.length > 1) errors.push(`路径冲突：${pattern} 同时被单元 ${names.join(' / ')} 声明`);
  }
  return errors;
}

module.exports = {
  SEVERITY, CLASSES, DEFAULT_ACTION,
  matchUnit, classify, compareContract, validateUnits, parseSemver,
};
