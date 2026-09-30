// core/policy.js — 自动更新的时机判定（纯 node，零 electron 依赖）
//
// pull 模式（不是服务端推送）下，检测节奏完全由客户端自己决定，所以这里要回答四件事：
//   1. 此刻该不该检测？（总开关 / 免打扰 / 退避 / 距上次检测多久了）
//   2. 下次检测是什么时候？（interval 或 dailyAt + 抖动 + 免打扰顺延）
//   3. 检测到了该不该拉取？（apply=auto/notify、dirty 时跳过）
//   4. 开机那一次该做什么？（off / check / checkAndApply）
//
// 所有函数都接受 `now`/`rand` 注入，便于单测（不依赖真实时钟）。
'use strict';

const MINUTE = 60 * 1000;

// 检测间隔的下限：interval 一旦为 0/负数/NaN，排期时刻会落在过去，
// nextDelayMs 又只保证「至少 1 秒」，于是客户端会 ~1 秒一次 fetch 远程（自我 DoS）。
// 契约校验拦写坏的配置，这里再兜运行时（用户经 setUpdatePolicy 也能改）。
const DEFAULT_INTERVAL_MINUTES = 60;
const MIN_INTERVAL_MINUTES = 5;

function intervalMs(sch) {
  const raw = Number(sch && sch.intervalMinutes);
  const v = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_MINUTES;
  return Math.max(MIN_INTERVAL_MINUTES, v) * MINUTE;
}

function parseHHMM(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  const h = +m[1];
  const mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

function minutesOfDay(ts) {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes();
}

// 免打扰时段（from > to 表示跨午夜）
function inQuietHours(policy, ts) {
  const q = policy && policy.quietHours;
  if (!q || !q.from || !q.to) return false;
  const from = parseHHMM(q.from);
  const to = parseHHMM(q.to);
  if (from === null || to === null) return false;
  const cur = minutesOfDay(ts);
  return from <= to ? (cur >= from && cur < to) : (cur >= from || cur < to);
}

// 免打扰结束的下一个时刻（用于把落在免打扰里的检测顺延出去）
function quietEndAfter(policy, ts) {
  const to = parseHHMM(policy.quietHours.to);
  const d = new Date(ts);
  d.setHours(Math.floor(to / 60), to % 60, 0, 0);
  if (d.getTime() <= ts) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function nextDailyAt(hhmm, now) {
  const t = parseHHMM(hhmm);
  if (t === null) return now + 60 * MINUTE;
  const d = new Date(now);
  d.setHours(Math.floor(t / 60), t % 60, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// 抖动：在定点时间上加 ±jitterMinutes 的随机偏移。
// 没有它，几百个客户端会在同一秒 fetch 同一个 git 服务（惊群）。
function jitterMs(jitterMinutes, rand = Math.random) {
  const j = (jitterMinutes || 0) * MINUTE;
  if (!j) return 0;
  return Math.floor(rand() * j * 2) - j;
}

/**
 * 下一次检测的「绝对时刻」（未做下限截断）。
 * 这是判定的真值：shouldCheck 必须拿它跟 now 比。
 * 别用 nextCheckAt 去判定 —— 那个值被 clamp 成「至少 1 秒后」，逾期时会把时刻推向未来，
 * 结果「早就该检测了」被判成「还没到」。
 */
function nextScheduledAt(policy, now, state = {}, rand = Math.random) {
  if (!policy || !policy.enabled) return null;
  const sch = policy.schedule || {};
  if (sch.mode === 'off') return null;

  const c = policy.constraints || {};
  const failures = state.failures || 0;
  const maxRetries = c.maxRetries == null ? 3 : c.maxRetries;
  // maxRetries=0 表示「一次都不重试」= 第一次失败就放弃，不是「还没失败就放弃」；
  // 所以必须 failures>0 才判放弃，否则 0 次失败 ≥ 0 会让客户端永远不检测。
  if (failures > 0 && failures >= maxRetries) return null; // 本轮放弃：等下次启动或用户手动

  // 连续失败 → 指数退避，别在断网时限流死循环
  if (failures > 0) {
    const backs = c.backoffMinutes && c.backoffMinutes.length ? c.backoffMinutes : [5, 15, 60];
    const idx = Math.min(failures - 1, backs.length - 1);
    return (state.lastCheckAt || now) + backs[idx] * MINUTE;
  }

  let at;
  if (sch.mode === 'dailyAt') {
    at = nextDailyAt(sch.dailyAt, now);
  } else {
    at = (state.lastCheckAt || now) + intervalMs(sch);
  }
  at += jitterMs(sch.jitterMinutes, rand);
  if (inQuietHours(policy, at)) at = quietEndAfter(policy, at); // 落在免打扰里就顺延
  return at;
}

/** 距离下次检测的等待毫秒数（给 setTimeout 用，至少 1 秒）；不安排则返回 null */
function nextDelayMs(policy, now, state = {}, rand = Math.random) {
  const at = nextScheduledAt(policy, now, state, rand);
  return at === null ? null : Math.max(1000, at - now);
}

function nextCheckAt(policy, now, state = {}, rand = Math.random) {
  const d = nextDelayMs(policy, now, state, rand);
  return d === null ? null : now + d;
}

/**
 * 此刻该不该（自动）检测。
 * @returns {{check:boolean, reason:string, nextAt:number|null}}
 */
function shouldCheck(policy, now, state = {}, rand = Math.random) {
  if (!policy || !policy.enabled) return { check: false, reason: '自动更新已关闭（enabled=false）', nextAt: null };
  const sch = policy.schedule || {};
  if (sch.mode === 'off') return { check: false, reason: '定时检测关闭（schedule.mode=off）', nextAt: null };

  const failures = state.failures || 0;
  const maxRetries = (policy.constraints || {}).maxRetries == null ? 3 : (policy.constraints.maxRetries);
  // 同上：0 次失败不能算「已达上限」，否则 maxRetries=0 会静默禁用全部自动检测
  if (failures > 0 && failures >= maxRetries) {
    return { check: false, reason: `连续失败 ${failures} 次，已达 maxRetries=${maxRetries}，本轮放弃`, nextAt: null };
  }
  if (inQuietHours(policy, now)) {
    return { check: false, reason: '免打扰时段内，不自动检测', nextAt: quietEndAfter(policy, now) };
  }
  const at = nextScheduledAt(policy, now, state, rand);
  if (at === null) return { check: false, reason: '策略未安排下一次检测', nextAt: null };
  // 判定用 at（真值）；回报给界面的 nextAt 才是截断后的（定时器不能排到过去）
  return { check: now >= at, reason: now >= at ? '已到检测时间' : '未到检测时间', nextAt: Math.max(now + 1000, at) };
}

/** 开机那一次的行为：off / check / checkAndApply */
function startupMode(policy) {
  if (!policy || !policy.enabled) return 'off';
  return policy.onStartup || 'off';
}

/**
 * 检测到了更新，该不该自动拉取并应用？
 * @param {object} policy
 * @param {object} plan  { klass, dirty }
 */
function shouldApply(policy, plan = {}) {
  if (!policy || !policy.enabled) return false;
  if (policy.apply === 'notify') return false; // 只提示，把打断权交还用户
  const c = policy.constraints || {};
  if (c.skipWhenDirty !== false && plan.dirty) return false; // 自动更新无人值守，dirty 优先
  return true;
}

/** 检测失败后的退避时长（ms） */
function backoffMs(policy, failures) {
  const c = (policy && policy.constraints) || {};
  const backs = c.backoffMinutes && c.backoffMinutes.length ? c.backoffMinutes : [5, 15, 60];
  const n = Math.max(1, failures || 1);
  return backs[Math.min(n - 1, backs.length - 1)] * MINUTE;
}

/** 深合并：用户可能只改 enabled，不能把 schedule / quietHours 抹掉 */
function mergePolicy(base, patch) {
  if (!patch || typeof patch !== 'object') return { ...base };
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const nested = v && typeof v === 'object' && !Array.isArray(v) &&
      out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]);
    out[k] = nested ? mergePolicy(out[k], v) : v;
  }
  return out;
}

module.exports = {
  MINUTE, parseHHMM, minutesOfDay,
  inQuietHours, quietEndAfter, nextDailyAt, jitterMs,
  nextScheduledAt, nextDelayMs, nextCheckAt, shouldCheck, startupMode, shouldApply, backoffMs,
  mergePolicy, intervalMs, MIN_INTERVAL_MINUTES, DEFAULT_INTERVAL_MINUTES,
};
