// main-host.js — 主进程编排
//
// 职责：
//   1. init — 初始化（加载契约、读状态、注册 IPC、启动检测）
//   2. check — 检测更新（不修改工作区）
//   3. apply — 应用更新（拉取 + 校验 + 失败回滚）
//   4. attach — 绑定窗口
//   5. startScheduler — 启动调度器
//
// 红线：electron 通过参数注入，不直接 require('electron')。
'use strict';
const path = require('path');
const { createStateStore } = require('./state-store');
const { createLocalConfig } = require('./local-config');
const { createScheduler } = require('./scheduler');
const { registerIpcBridge } = require('./ipc-bridge');

/**
 * 初始化更新模块
 * @param {object} opts
 * @param {string} opts.projectRoot — 项目根目录
 * @param {object} opts.electron — electron 模块引用（注入）
 * @param {function} opts.getWindow — 获取窗口实例
 * @param {object} opts.logger — 日志接口
 */
async function init(opts) {
  const { projectRoot, electron, getWindow, logger } = opts;
  const { app, ipcMain, dialog } = electron;

  const kitDir = path.join(projectRoot, 'src/update-kit');
  const { createContractLoader } = require('../core/contract-loader');
  const loader = createContractLoader({ projectRoot, kitDir, shellDir: path.join(projectRoot, 'src/application') });

  const stateStore = createStateStore(app.getPath('userData'));
  const localConfig = createLocalConfig(projectRoot);

  let state = { lastCheckAt: 0, failures: 0, ...stateStore.load() };
  let lastStatus = null;
  let envInfo = null;

  // 注册 IPC
  registerIpcBridge(ipcMain, loader.bridgeApi, {
    checkUpdate: () => check(),
    applyUpdate: () => apply(),
    relaunch: () => { app.relaunch(); app.quit(); },
  });

  // 检测更新（不修改工作区）
  async function check() {
    const updater = require('../core/engine');
    const classifier = require('../core/classifier');

    try {
      await updater.fetch(loader.remote, { cwd: projectRoot });
    } catch (e) {
      return { ok: false, offline: true, error: String(e.stderr || e.message) };
    }

    const cmp = await updater.compare({ remote: loader.remote, branch: loader.branch, cwd: projectRoot });
    if (cmp.offline) return { ok: false, offline: true };

    const { ahead, behind } = await updater.aheadBehind({ remote: loader.remote, branch: loader.branch, cwd: projectRoot });
    if (ahead > 0) {
      return { ok: false, blocked: 'ahead', aheadCount: ahead, behindCount: behind };
    }

    const dirty = await updater.isDirty({ cwd: projectRoot });
    if (dirty.dirty) {
      return { ok: false, blocked: 'dirty', dirtyCount: dirty.count, dirtyFiles: dirty.files };
    }

    const files = await updater.diffFiles(cmp.local, cmp.remote, { cwd: projectRoot });
    const plan = classifier.classify(files, {
      units: loader.updateUnits,
      runningContract: loader.contractVersion,
      targetContract: loader.contractVersion,
      minSupported: loader.contractMinSupported,
    });

    return { ok: true, state: 'available', plan, version: await updater.getVersion({ cwd: projectRoot }) };
  }

  // 应用更新
  async function apply() {
    const updater = require('../core/engine');
    const result = await check();
    if (!result.ok || result.state !== 'available') return result;

    const prevHead = await updater.localRef(loader.branch, { cwd: projectRoot });

    try {
      await updater.pull({ remote: loader.remote, branch: loader.branch, cwd: projectRoot });
    } catch (e) {
      await updater.runGit(['reset', '--hard', prevHead], projectRoot);
      return { ok: false, error: String(e.stderr || e.message) };
    }

    return { ok: true, applied: true, klass: result.plan.klass };
  }

  // 绑定窗口
  function attach(win) {
    const { BrowserWindow } = electron;
    win.webContents.on('did-finish-load', async () => {
      const status = lastStatus || await check();
      win.webContents.send('update:status', status);
      win.webContents.send('update:config', {
        env: envInfo,
        policy: loader.updatePolicy,
        units: loader.updateUnits,
      });
    });
  }

  // 启动调度器
  function startScheduler() {
    const scheduler = createScheduler({
      policy: loader.updatePolicy,
      state,
      run: async () => {
        const result = await check();
        lastStatus = result;
        state.lastCheckAt = Date.now();
        stateStore.save(state);
      },
      onChange: (s) => { Object.assign(state, s); },
    });
    scheduler.start();
    return scheduler;
  }

  return {
    check,
    apply,
    attach,
    startScheduler,
    preloadPath: loader.preloadPath,
    appEntryPath: path.join(projectRoot, loader.appEntry),
    getState: () => ({ state, lastStatus, envInfo }),
  };
}

module.exports = { init };
