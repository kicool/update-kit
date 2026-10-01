// scheduler.js — 定时调度器
//
// 职责：
//   1. 按 updatePolicy 排定下次检测时间
//   2. 管理定时器
//   3. 触发检测回调
//
// 红线：纯 node，零 electron 依赖（通过参数注入 setTimeout/clearTimeout）。
'use strict';
const { nextDelayMs } = require('../core/policy');

/**
 * 创建调度器
 * @param {object} opts
 * @param {object} opts.policy — updatePolicy
 * @param {object} opts.state — 运行时状态
 * @param {function} opts.run — 检测回调
 * @param {function} opts.onChange — 状态变化回调
 */
function createScheduler({ policy, state, run, onChange }) {
  let timer = null;
  let nextAt = null;

  function start() {
    stop();
    const now = Date.now();
    const delay = nextDelayMs(policy, now, state);
    nextAt = delay === null ? null : now + delay;
    if (delay !== null) {
      timer = setTimeout(() => {
        run();
        start();
      }, delay);
    }
    if (onChange) onChange({ nextAt, lastCheckAt: state.lastCheckAt });
  }

  function stop() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function reschedule() {
    start();
  }

  return { start, stop, reschedule, get nextAt() { return nextAt; } };
}

module.exports = { createScheduler };
