// main-host.js — 主进程编排
//
// 职责：
//   1. init — 初始化（加载契约、契约自检、采集环境抬头、注册 IPC、采集环境信息）
//   2. check — 检测更新（不修改工作区）
//   3. apply — 应用更新（拉取 + 失败回滚）
//   4. attach — 绑定窗口（按契约 bridgeApi 的通道下发 status / config）
//   5. startScheduler — 启动调度器
//
// 红线：electron 通过参数注入，不直接 require('electron')；
//      通道名一律从契约 bridgeApi 反查，禁止硬编码（契约固化）。
'use strict';
const path = require('node:path');
const { createStateStore } = require('./state-store');
const { createLocalConfig } = require('./local-config');
const { createScheduler } = require('./scheduler');
const { registerIpcBridge } = require('./ipc-bridge');
const engine = require('../core/engine');
const classifier = require('../core/classifier');
const contract = require('../core/contract');
const upolicy = require('../core/policy');

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

  // 契约自检：路径配置错了要在【窗口打开前】报清楚，而不是白屏或静默失效
  {
    const missing = [];
    const check = (label, p) => { if (!require('node:fs').existsSync(p)) missing.push(`${label}: ${p}`); };
    check('appEntry', path.join(projectRoot, loader.appEntry));
    check('rendererDir', path.join(projectRoot, loader.rendererDir));
    check('preload', loader.preloadPath);
    if (missing.length) {
      throw new Error('契约校验失败，以下路径不存在：\n  ' + missing.join('\n  '));
    }
    const errs = contract.validate(loader, { appRoot: projectRoot, shellDir: loader.shellDir }).errors;
    if (errs.length) {
      throw new Error('契约自检未通过：\n  ' + errs.join('\n  '));
    }
    logger.log?.('[contract]\n  ' + loader.describe());
  }

  // 推送通道从契约反查：bridgeApi 里 type='on' 的条目是「主进程推送、渲染层监听」
  const channelOf = (name) => {
    const api = loader.bridgeApi.find((a) => a.name === name);
    return api && api.channel;
  };
  const statusChannel = channelOf('onStatus');
  const configChannel = channelOf('onConfig');
  if (!statusChannel || !configChannel) {
    throw new Error('[main-host] 契约 bridgeApi 缺少 onStatus/onConfig（推送通道无法确定）');
  }

  const stateStore = createStateStore(app.getPath('userData'));
  const localConfig = createLocalConfig(projectRoot);

  let state = { lastCheckAt: 0, failures: 0, nextAt: null, ...stateStore.load() };
  let lastStatus = null;
  let envInfo = null;

  // 采集「环境抬头」：让界面自证加载的是哪棵树、根在哪、入口相对根是什么。
  async function collectEnv() {
    const git = async (args) => {
      const r = await engine.runGit(args, { cwd: projectRoot });
      return r.ok ? r.stdout : null;
    };
    const [head, ref] = await Promise.all([
      git(['rev-parse', '--short', 'HEAD']),
      git(['rev-parse', '--abbrev-ref', 'HEAD']),
    ]);
    // preload 相对项目根的路径：出现 ../ 说明它来自运行中的壳（树外），抬头要显式标出来
    const preloadRel = path.relative(projectRoot, loader.preloadPath).replace(/\\/g, '/');
    const preloadOutside = preloadRel.startsWith('..');
    return {
      tree: loader.treeLabel || path.basename(projectRoot),
      root: projectRoot,
      entry: loader.appEntry,
      preload: preloadOutside ? preloadRel + '（树外 · 改动需重启生效）' : preloadRel,
      branch: loader.branch,
      head: head || 'unknown',
      ref: !ref ? 'unknown' : (ref === 'HEAD' ? 'detached' : ref),
      contractVersion: loader.contractVersion,
    };
  }

  envInfo = await collectEnv();

  // 统一下发运行环境 + 时机策略 + 调度状态；reload / pull / 改策略之后都要再发一次
  function buildConfig() {
    return {
      skipUpdate: loader.skipUpdate, // 验收档：true 时界面要把开关置灰并说明
      env: envInfo,
      policy: loader.updatePolicy,
      schedule: { nextAt: state.nextAt || null, lastCheckAt: state.lastCheckAt, failures: state.failures || 0 },
      units: loader.updateUnits, // 白名单只读下发，供界面展示「每类路径属于哪种更新能力」
    };
  }

  function sendToWindow(channel, payload) {
    const win = getWindow && getWindow();
    if (win && win.webContents && channel) win.webContents.send(channel, payload);
  }
  function sendConfig() { sendToWindow(configChannel, buildConfig()); }

  // 检测更新（不修改工作区）。
  // 返回的 status 形状 = 渲染层契约：ok/updated/behind/offline/skipped/dirty/version/klass/needsRestart/plan
  async function check(mode = 'manual') {
    const versionR = await engine.getVersion({ cwd: projectRoot });
    const version = versionR.version;

    // 验收模式（skipUpdate）：完全不访问远程，只报本地当前版本
    if (loader.skipUpdate) {
      return { ok: true, updated: false, behind: false, offline: false, skipped: true, version, mode };
    }

    const f = await engine.fetch(loader.remote, { cwd: projectRoot });
    if (!f.ok) {
      return { ok: false, offline: true, error: f.error, version, mode };
    }

    const cmp = await engine.compare({ remote: loader.remote, branch: loader.branch, cwd: projectRoot });
    if (!cmp.ok || cmp.offline) {
      return { ok: false, offline: true, version, mode, error: cmp.error };
    }
    if (!cmp.behind) {
      return { ok: true, updated: false, behind: false, offline: false, version, mode };
    }

    // —— 本地落后远程：先过硬保护，再分类（diff 依赖 pull 之前的 local..remote） ——

    // 硬保护 1：pull（reset --hard）会抹掉未提交的 tracked 改动，有改动就拒绝并显式回报
    const dirty = await engine.isDirty({ cwd: projectRoot });
    if (dirty.dirty) {
      logger.log?.(`[main-host] 检测到 ${dirty.count} 个未提交改动，拒绝自动拉取：\n  ${dirty.files.join('\n  ')}`);
      return {
        ok: true, updated: false, behind: true, version, offline: false, mode,
        dirty: true, dirtyCount: dirty.count, dirtyFiles: dirty.files,
      };
    }

    // 硬保护 2：本地领先远程（未推送 commit），reset --hard 会丢弃它们
    const ab = await engine.aheadBehind({ remote: loader.remote, branch: loader.branch, cwd: projectRoot });
    if (ab.ok && ab.ahead > 0) {
      logger.log?.(`[main-host] 本地领先 ${ab.ahead} 个 commit，拒绝自动拉取（避免丢失未推送的提交）`);
      return {
        ok: true, updated: false, behind: true, version, offline: false, mode,
        blocked: 'ahead', aheadCount: ab.ahead, behindCount: ab.behind,
      };
    }

    const df = await engine.diffFiles(cmp.local, cmp.remote, { cwd: projectRoot });
    const plan = classifier.classify(df.ok ? df.files : [], {
      units: loader.updateUnits,
      runningContract: loader.contractVersion,
      targetContract: loader.contractVersion,
      minSupported: loader.contractMinSupported,
    });
    if (df.ok && plan.warnings.length) plan.warnings.forEach((w) => logger.warn?.('[main-host][warn] ' + w));

    return {
      ok: true, updated: false, behind: true, version, offline: false, mode,
      klass: plan.klass, needsRestart: plan.needsRestart, plan,
    };
  }

  // 应用更新（拉取 + 失败回滚）。返回的 status 与 check() 同一形状，updated=true 表示已拉取。
  // pre：调用方若刚跑过 check() 可把结果传入，避免二次 fetch。
  async function apply(mode = 'manual', pre = null) {
    pre = pre || await check(mode);
    // 无可拉取 / 离线 / 硬保护拦截（dirty、ahead）→ 原样把 check 的结论带回去
    if (!pre.ok || !pre.behind || pre.dirty || pre.blocked) return pre;

    const prev = await engine.localRef(loader.branch, { cwd: projectRoot });
    const pulled = await engine.pull({ remote: loader.remote, branch: loader.branch, cwd: projectRoot });
    if (!pulled.ok) {
      if (prev.ok) await engine.runGit(['reset', '--hard', prev.ref], { cwd: projectRoot });
      return { ok: false, updated: false, behind: true, version: pre.version, mode, error: pulled.error };
    }

    envInfo = await collectEnv(); // pull 后 HEAD 变了，抬头要跟着更新
    const newVersion = await engine.getVersion({ cwd: projectRoot });
    sendConfig();

    const status = {
      ok: true, updated: true, behind: false, offline: false, mode,
      version: newVersion.version, prevVersion: pre.version,
      files: pre.plan ? pre.plan.files : [],
      plan: pre.plan,
      klass: pre.klass,
      needsRestart: pre.needsRestart,
    };

    // 恢复到旧语义：apply=auto 时 hot 类更新拉完直接 reload 渲染层（无重启热更）
    if (status.klass === 'hot' && loader.updatePolicy.apply !== 'notify') {
      const win = getWindow && getWindow();
      if (win && win.webContents) win.webContents.reload();
    }

    return status;
  }

  // 检测 + （按策略）自动拉取。startup=checkAndApply / 定时检测 / apply=auto 的手动检查都走这里：
  // shouldApply 为真（apply=auto 且非 dirty）时检查即拉取，通知用户「有更新」之前先把它拉下来。
  async function checkAndMaybeApply(mode = 'manual') {
    const s = await check(mode);
    if (s.behind && !s.dirty && !s.blocked && upolicy.shouldApply(loader.updatePolicy, s.plan || {})) {
      return await apply(mode, s);
    }
    return s;
  }

  // 注册 IPC（通道名全部来自契约 bridgeApi，由 ipc-bridge 校验双向一致）
  registerIpcBridge(ipcMain, loader.bridgeApi, {
    checkUpdate: async () => {
      // apply=auto 时「检查更新」= 检查并拉取（与 startup=checkAndApply / 定时检测同一语义）；
      // apply=notify 时只检测，由用户点「更新」触发 applyUpdate
      const s = await checkAndMaybeApply('manual');
      lastStatus = s;
      return s;
    },
    applyUpdate: async () => {
      const s = await apply('manual');
      lastStatus = s;
      return s;
    },
    relaunch: () => { app.relaunch(); app.quit(); },
    setUpdatePolicy: (_event, patch) => {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return { ok: false, error: 'patch 必须是对象' };
      }
      localConfig.mergePolicy(patch); // 本机覆盖落盘（只累积用户改过的键）
      // 生效策略 = 旧生效值 ⊕ patch。deepMerge 可结合，结果与「三层重新合并」一致
      const effective = upolicy.mergePolicy(loader.updatePolicy, patch);
      // 就地替换内容（不换引用）：调度器拿着的是同一个 policy 对象
      for (const k of Object.keys(loader.updatePolicy)) delete loader.updatePolicy[k];
      Object.assign(loader.updatePolicy, effective);
      logger.log?.(`[main-host] 更新策略已更新: ${JSON.stringify(patch)}`);
      if (schedulerRef) schedulerRef.reschedule(); // 间隔/免打扰等变了，立即按新策略重排
      sendConfig();
      return { ok: true, policy: loader.updatePolicy };
    },
  });

  // 绑定窗口
  function attach(win) {
    win.webContents.on('did-finish-load', async () => {
      // env/policy/units 已在手里，先下发，不必等远程检测（否则断网时抬头也跟着「初始化…」）
      sendConfig();
      // 再推一个本地已知的 interim 状态：版本号/功能标记立即填上，状态显示「检测中」。
      // 远程 fetch 有最长 30s 的超时窗口（断网），没有这一步这段时间界面全是「…」。
      const v = await engine.getVersion({ cwd: projectRoot });
      sendToWindow(statusChannel, { ok: true, checking: true, version: v.version, mode: 'startup' });
      try {
        // 启动或热更 reload 后复用 lastStatus，避免二次 fetch 造成「初始化…」空窗
        // onStartup=checkAndApply 时启动检测直接拉取（apply=auto 前提下）
        const auto = upolicy.startupMode(loader.updatePolicy) === 'checkAndApply';
        const status = lastStatus || (auto ? await checkAndMaybeApply('startup') : await check('startup'));
        lastStatus = status;
        sendToWindow(statusChannel, status);
        sendConfig(); // schedule.lastCheckAt 可能已刷新，顺带再发一次
      } catch (e) {
        logger.error?.('[main-host] 启动状态检查失败:', e);
        sendToWindow(statusChannel, { ok: false, offline: true, error: String(e) });
      }
    });
  }

  // 启动调度器
  let schedulerRef = null;
  function startScheduler() {
    const scheduler = createScheduler({
      policy: loader.updatePolicy,
      state,
      run: async () => {
        const now = Date.now();
        const result = await checkAndMaybeApply('scheduled');
        lastStatus = result;
        state.lastCheckAt = now;
        state.failures = result.ok ? 0 : (state.failures || 0) + 1;
        stateStore.save(state);
        sendToWindow(statusChannel, result);
        sendConfig();
      },
      onChange: (s) => { Object.assign(state, s); },
    });
    scheduler.start();
    schedulerRef = scheduler;
    return scheduler;
  }

  return {
    check,
    apply,
    checkAndMaybeApply,
    attach,
    startScheduler,
    preloadPath: loader.preloadPath,
    appEntryPath: path.join(projectRoot, loader.appEntry),
    getState: () => ({ state, lastStatus, envInfo }),
  };
}

module.exports = { init };
