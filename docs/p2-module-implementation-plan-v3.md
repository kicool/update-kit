# P2 实施方案 v3：从 Demo 到可复用模块

> 取代：`docs/p2-module-implementation-plan-v2.md`（v2，保留作历史对照）
> 状态：🟡 P2.0 进行中（D1-D3 已完成）
> 适用场景（设计前提，所有决策都以此为准）：
> **内部团队使用 · 通过 git 发布 · Electron 不打包 · 成员在代码仓库内直接 `npm start` 运行 · remote 可信**

---

## 0. 决策汇总（已确认）

| # | 决策点 | 最终选择 | 理由 |
|---|---|---|---|
| 1 | D2 修复方式 | 始终检查 aheadBehind | 防止丢失未推送 commit；成本很低 |
| 2 | 兼容代码保留 | 立即删除 | 单人使用，旧壳无法启动只要能解决就行 |
| 3 | preload 方式 | 构建期生成 | 避免运行时生成弄脏工作区 |
| 4 | 契约分层 | 三层（kit/项目/本机） | kit 默认值可独立演进 |
| 5 | bridgeApi 结构化 | `{name, type, channel}` | 可生成 preload；类型明确 |
| 6 | sandbox | 保持 false | 后续独立改 |
| 7 | restartMode 默认 | prompt | 避免 npm start 场景脱离终端 |
| 8 | P2.0 先修缺陷 | 先修 | 避免带入 host 层 |
| 9 | subtree prefix | 保持 src/update-kit/ | 路径不变；updateUnits 不用改 |
| 10 | 测试策略 | 拆分（kit + 应用） | 职责清晰；kit 可独立测试 |

---

## 1. P2.0 已完成的修改

### 1.1 D1：npm ci 移到 pull 之后 ✅

**问题**：`checkUpdate()` 里先 `runNpmCi()`，再 `updater.pull()`，装的是旧 lockfile 的依赖。

**修改**：`src/application/main.js`

```javascript
// 修改前
const needNpmCi = plan.units.some((u) => u.action === 'npm-ci-then-relaunch');
if (needNpmCi && POLICY.constraints && POLICY.constraints.autoNpmCi) {
  const r = await runNpmCi();  // ← 在 pull 之前
  // ...
}
await updater.pull({ remote: CONFIG.remote, branch: CONFIG.branch, cwd: appRoot });

// 修改后
const needNpmCi = plan.units.some((u) => u.action === 'npm-ci-then-relaunch');
await updater.pull({ remote: CONFIG.remote, branch: CONFIG.branch, cwd: appRoot });
// npm ci 必须在 pull 之后执行，否则装的是旧 lockfile 的依赖
if (needNpmCi && POLICY.constraints && POLICY.constraints.autoNpmCi) {
  const r = await runNpmCi();  // ← 在 pull 之后
  // ...
}
```

### 1.2 D2/D4：aheadBehind 检查 ✅

**问题**：本地已提交未推送的 commit 会被 `reset --hard` 静默丢弃。

**修改**：
- `src/application/updater.js`：新增 `aheadBehind()` 函数
- `src/application/main.js`：pull 之前检查 aheadBehind

```javascript
// updater.js 新增
async function aheadBehind({ remote, branch, cwd }) {
  const out = await runGit(['rev-list', '--left-right', '--count', `HEAD...${remote}/${branch}`], cwd)
    .catch(() => null);
  if (!out) return { ahead: 0, behind: 0, error: 'git rev-list 执行失败' };
  const [ahead, behind] = out.split('\t').map(Number);
  return { ahead, behind };
}

// main.js 新增（在 isDirty 检查之后、pull 之前）
const { ahead, behind } = await updater.aheadBehind({ remote: CONFIG.remote, branch: CONFIG.branch, cwd: appRoot });
if (ahead > 0) {
  console.log(`[main] 本地领先 ${ahead} 个 commit，拒绝自动拉取（避免丢失未推送的提交）`);
  return {
    ok: true, updated: false, behind: true, version, offline: false, mode,
    blocked: 'ahead', aheadCount: ahead, behindCount: behind,
  };
}
```

### 1.3 D3：require 移到文件顶部 ✅

**问题**：`runNpmCi()` 里 `require('child_process')` 是延迟 require，pull 后再触发会加载磁盘上的新代码。

**修改**：`src/application/main.js`

```javascript
// 修改前
function runNpmCi() {
  const { execFile } = require('child_process');  // ← 延迟 require
  // ...
}

// 修改后（文件顶部）
const { execFile } = require('child_process');

function runNpmCi() {
  // require 已移到顶部
  // ...
}
```

### 1.4 验证

```bash
npm run core-test  # 61 通过 / 0 失败 ✅
```

---

## 2. 目标结构

### 2.1 kit 独立仓库

```
update-kit/                         ← 独立 git 仓库，通过 subtree 引入
├── package.json                    ← 仅作元数据与 kit 测试入口；不发 npm
├── README.md                       ← 接入文档
├── defaults.json                   ← kit 默认值（updatePolicy 等）
├── contract.template.json          ← 项目契约模板
├── core/                           ← 纯 node，禁止 require('electron')
│   ├── index.js
│   ├── classifier.js               ← 现有
│   ├── policy.js                   ← 现有
│   ├── contract.js                 ← 现有 + bridgeApi 结构化检查
│   ├── contract-loader.js          ← 由 registry.js 迁入：三层合并 + 路径解析
│   └── engine.js                   ← 由 updater.js 迁入 + aheadBehind
├── host/                           ← electron 适配，electron 通过参数注入
│   ├── main-host.js                ← 编排：init / check / apply / attach / startScheduler
│   ├── scheduler.js                ← 定时器、nextAt、失败退避
│   ├── state-store.js              ← userData/update-state.json 读写
│   ├── local-config.js             ← update-kit.local.json 读写
│   └── ipc-bridge.js               ← 按 bridgeApi 注册 ipcMain.handle / on
├── tools/
│   ├── gen-preload.js              ← 构建期生成 preload.js
│   └── check-boundaries.js         ← core 无 electron、函数体内无 require
└── test/
    ├── run-all.js                  ← 编排下列测试
    ├── core.test.js                ← 纯 core 断言
    ├── policy-matrix.test.js       ← 策略穷举
    ├── host.test.js                ← mock electron 测试 host 编排
    └── git-integration.test.js     ← 临时 git 仓库：dirty / ahead / diverged / 失败恢复
```

### 2.2 接入后的项目结构（以本仓库为例）

```
electron-updater/
├── package.json
├── update-kit.contract.json        ← 项目契约（进 git，改动需评审）
├── update-kit.local.json           ← 本机覆盖（gitignore）
├── .gitignore                      ← 需包含 update-kit.local.json
└── src/
    ├── update-kit/                 ← subtree（本仓库保持现有 prefix）
    ├── application/
    │   ├── main.js                 ← 只创建窗口 + 调用 init
    │   ├── preload.js              ← gen-preload 生成，提交进 git
    │   └── renderer/               ← hot 单元
    └── tools/                      ← 应用侧测试
```

---

## 3. 契约：三层结构

### 3.1 分层

| 层 | 文件 | 进 git | 谁改 | 内容 |
|---|---|---|---|---|
| kit 默认值 | `<kit>/defaults.json` | kit 仓库 | kit 维护者 | `updatePolicy` 全量默认值 |
| 项目契约 | `update-kit.contract.json`（项目根） | 是 | 项目维护者，需评审 | 版本、remote/branch、paths、updateUnits、bridgeApi，可选 updatePolicy 覆盖 |
| 本机覆盖 | `update-kit.local.json`（项目根） | 否 | 成员本人 / 界面设置 | repoPath、branch、treeLabel、skipUpdate、updatePolicy |

**合并顺序**：`defaults.json` → 项目契约 → 本机覆盖（`updatePolicy` 深合并）

**`updateUnits` 与 `bridgeApi` 不允许本机覆盖**（沿用现有规则）

### 3.2 项目契约模板（`contract.template.json`）

```json
{
  "contractVersion": "1.2.0",
  "contractMinSupported": "1.0.0",
  "remote": "origin",
  "branch": "release",
  "paths": {
    "repoPath": ".",
    "preload": "src/app/preload.js",
    "appEntry": "src/app/renderer/index.html",
    "rendererDir": "src/app/renderer"
  },
  "bridgeApi": [
    { "name": "checkUpdate",     "type": "invoke", "channel": "update-kit:check" },
    { "name": "applyUpdate",     "type": "invoke", "channel": "update-kit:apply" },
    { "name": "relaunch",        "type": "send",   "channel": "update-kit:relaunch" },
    { "name": "onStatus",        "type": "on",     "channel": "update-kit:status" },
    { "name": "onConfig",        "type": "on",     "channel": "update-kit:config" },
    { "name": "setUpdatePolicy", "type": "invoke", "channel": "update-kit:set-policy" }
  ],
  "updateUnits": [
    { "name": "renderer", "class": "hot",       "paths": ["src/app/renderer/"], "action": "reload" },
    { "name": "shell",    "class": "restart",   "paths": ["src/app/main.js", "src/app/preload.js", "update-kit/", "update-kit.contract.json"], "action": "relaunch" },
    { "name": "deps",     "class": "restart",   "paths": ["package.json", "package-lock.json"], "action": "npm-ci-then-relaunch", "fallback": "reinstall" },
    { "name": "runtime",  "class": "reinstall", "paths": ["node_modules/"], "action": "prompt-reinstall", "unreachableByGit": true },
    { "name": "docs",     "class": "none",      "paths": ["docs/", "README.md"], "action": "none" }
  ]
}
```

### 3.3 契约版本

- 本次迁移定为 **1.1.0 → 1.2.0**（次版本 → restart）
- 主版本跳跃 → reinstall（旧壳无法自举）
- 次版本变化 → restart（bridgeApi 面变了）
- 修订号变化 → 无运行态影响

---

## 4. 接口与更新流程

### 4.1 应用侧接入（生命周期）

```javascript
// src/application/main.js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const updateKit = require('../update-kit/host/main-host');

let win = null;

app.whenReady().then(async () => {
  const kit = await updateKit.init({
    projectRoot: path.resolve(__dirname, '../..'),
    electron: { app, BrowserWindow, ipcMain, dialog },
    getWindow: () => win,
    logger: console,
  });

  win = new BrowserWindow({
    width: 920, height: 760,
    webPreferences: {
      preload: kit.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  kit.attach(win);
  win.loadFile(kit.appEntryPath);
  kit.startScheduler();
});
```

### 4.2 host 各模块接口

| 模块 | 导出 | 依赖 |
|---|---|---|
| `main-host.js` | `init(opts)` → `{ check, apply, attach, startScheduler, preloadPath, appEntryPath, getState }` | 其余 4 个 host 模块 + core |
| `scheduler.js` | `create({ policy, state, run, onChange })` → `{ start, reschedule, stop, nextAt }` | core/policy |
| `state-store.js` | `create(userDataDir)` → `{ load, save, get, patch }` | fs |
| `local-config.js` | `create(projectRoot)` → `{ read, mergePolicy(patch) }` | fs, core/policy |
| `ipc-bridge.js` | `register(ipcMain, bridgeApi, impl)` | — |

### 4.3 check / apply 流程

`check()`：**不修改工作区**

```
1. skipUpdate → 返回本地版本，结束
2. fetch（失败 → offline）
3. compare + aheadBehind
      behind=0            → up-to-date
      ahead>0 且 behind>0 → blocked:diverged
      ahead>0             → blocked:ahead
4. isDirty（仅 tracked）→ 若 dirty：blocked:dirty
5. diffFiles + 读取目标契约 → classify → plan
6. 返回 { state: 'available' | 'blocked:*', plan, version }
```

`apply()`：只有 `check()` 结果为 `available` 时才执行

```
1. 重新执行 check() 的 3–5
2. plan.klass === 'reinstall' → 不拉取，提示重装
3. 记录 prevHead
4. pull（fetch + reset --hard remote/branch）
      失败 → reset --hard prevHead，返回可读错误
5. 若含 deps 单元且 autoNpmCi=true → npm ci（在 pull 之后）
      失败 → 不回滚 git，状态升级为 needs-reinstall
6. 按 klass 生效：
      none    → applied
      hot     → 若 apply=auto：reload 窗口
      restart → 状态 pending-restart
```

### 4.4 运行中更新规则

| 状态 | 规则 |
|---|---|
| checking | 应用可正常使用 |
| applying | 界面显示"更新中"，禁用 check/apply 按钮；互斥锁 |
| applied（hot） | reload 会重新执行磁盘上的新 preload |
| pending-restart | **禁止 host 主动 reload**；界面常驻"需要重启"提示 |
| needs-reinstall | 同 pending-restart，另外给出终端命令提示 |

**重启方式**：
- `restartMode: "prompt"`（默认）：界面提示"请关闭应用，并在终端重新运行 `npm start`"
- `restartMode: "relaunch"`：保持现有 `app.relaunch()` 行为

---

## 5. preload：构建期生成

### 5.1 方案

- `update-kit/tools/gen-preload.js` 读取项目契约的 `bridgeApi`，生成 `paths.preload` 指向的文件
- 文件首行写 `// GENERATED by update-kit/tools/gen-preload.js — do not edit`
- 生成内容把 API 表内联进文件，按 type 映射：
  - `invoke → ipcRenderer.invoke(channel, ...args)`
  - `send → ipcRenderer.send(channel, ...args)`
  - `on → ipcRenderer.on(channel, (_e, v) => cb(v))`
- 生成物**提交进 git**，属于 shell 单元

### 5.2 校验

- `contract-check` 在内存里重新生成一次，与磁盘上的文件逐字节比对
- 主进程侧 `ipc-bridge.register` 在启动时校验"契约声明的 channel 全部已注册、没有多余注册"

---

## 6. 测试策略

| 层 | 测试 | 状态 |
|---|---|---|
| kit / core | classifier、policy、contract、contract-loader 三层合并 | 从 `core-selftest` 拆出 + 新增 |
| kit / core | 策略穷举 | 从 `policy-matrix` 拆出 |
| kit / host | mock electron：init 顺序、`getWindow()` 为 null 时不崩、pending-restart 不 reload、apply 互斥 | 新增 |
| kit / 集成 | 临时 git 仓库（bare remote + clone）：dirty / ahead / diverged 拒绝；pull 失败回到 prevHead | 新增 |
| kit / 边界 | `check-boundaries.js`：core 无 `require('electron')`；函数体内无 `require(` | 新增 |
| 应用 | `contract-check`（含 preload 生成物比对）、`smoke`、界面 `ui-state` 组合、`selftest`、`verify` | 保留并调整路径 |

---

## 7. 分发：git subtree

```bash
# 引入（新项目）
git subtree add  --prefix=update-kit <kit 仓库 URL> main --squash

# 升级（必须与 add 时一致地带 --squash）
git subtree pull --prefix=update-kit <kit 仓库 URL> main --squash
```

**接入清单**：

1. 复制 `update-kit/contract.template.json` 到项目根，命名为 `update-kit.contract.json` 并填写
2. `.gitignore` 加入 `update-kit.local.json`
3. 执行 `node update-kit/tools/gen-preload.js`，提交生成的 preload
4. 在主进程按 4.1 接入
5. 运行 `contract-check`，要求覆盖率 100%

---

## 8. 实施阶段与验收

### 验收流程

```
master 分支开发 → 自动化测试通过 → 通知用户验收 → 用户验收通过 → merge 到 release
```

**原则**：
- 每个验收点完成后立即通知用户验收
- 验收通过后再 merge 到 release
- 不要积攒所有任务完成后再验收

### P2.0 修缺陷（✅ 进行中）

| 步骤 | 内容 | 验收 | 状态 |
|---|---|---|---|
| 0.1 | D1：npm ci 移到 pull 之后 | 失败注入用例通过 | ✅ 完成 |
| 0.2 | D2/D4：aheadBehind，ahead/diverged 拒绝 apply | 临时仓库用例通过 | ✅ 完成 |
| 0.3 | D3：require 全部移到文件顶部 | grep 检查通过 | ✅ 完成 |
| 0.4 | master 分支开发验收 | 用户验证 D1-D3 修复 | ⬜ 待验收 |
| 0.5 | merge 到 release + V3 用户目录验收 | 5 个现有测试全绿 | ⬜ 待做 |

### P2.1 契约与 host 拆分（仍在本仓库内）

| 步骤 | 内容 | 验收 | 状态 |
|---|---|---|---|
| 1.1 | 新增 `defaults.json`、`contract-loader.js`（三层合并） | `core-test` 全绿 + 用户验收 | ⬜ 待做 |
| 1.2 | 契约迁到项目根，bridgeApi 结构化，contractVersion → 1.2.0 | `contract-check` 全绿 + 用户验收 | ⬜ 待做 |
| 1.3 | `gen-preload` + 生成物比对；替换手写 preload | `contract-check` / `smoke` 全绿 + 用户验收 | ⬜ 待做 |
| 1.4 | 拆出 state-store / local-config / scheduler / ipc-bridge | 每步全绿 + 用户验收 | ⬜ 待做 |
| 1.5 | main-host 编排 + check/apply 拆分 + 4.4 状态机 + restartMode | `main-host.js` < 200 行 + 用户验收 | ⬜ 待做 |
| 1.6 | `src/application/main.js` 改为按 4.1 接入 | `smoke` 全绿 + 用户验收 | ⬜ 待做 |

### P2.2 独立化

| 步骤 | 内容 | 验收 | 状态 |
|---|---|---|---|
| 2.1 | 测试拆分到 `update-kit/test/`，新增集成测试和边界检查 | `run-all.js` 全绿 + 用户验收 | ⬜ 待做 |
| 2.2 | `subtree split` 建立 kit 仓库，本仓库改为 subtree 引入 | 所有测试全绿 + 用户验收 | ⬜ 待做 |
| 2.3 | `examples/minimal/` | 用户按 README 接入并 `npm start` 成功 | ⬜ 待做 |
| 2.4 | README + 分类决策树 + 状态机 + 重启方式 | 用户审查文档 | ⬜ 待做 |

---

## 9. 风险

| 风险 | 缓解 |
|---|---|
| 拆分 host 时破坏现有行为 | 每拆一个模块跑一次 `smoke` + `core-test` |
| 旧壳拉到新契约结构后出错 | 退化为只看路径 → restart |
| 忘记重新生成 preload | `contract-check` 生成物比对失败，阻断 |
| pending-restart 期间用户手动 Ctrl+R | 界面常驻提示；bridgeApi 未变时新 preload 与旧主进程仍兼容 |

---

## 10. 不在 P2 范围（P3）

- CI / pre-commit 接入
- `update-plan` 发版预演
- commit 签名、契约哈希校验
- AST 解析替代正则
- `update-kit.local.json` schema 校验
- `npx update-kit init` 脚手架
- 默认开启 `sandbox: true`

---

## 11. 分类决策树（写进 README）

```
这个路径改动后，不重启就能生效吗？
  能，且只影响 renderer            → hot（必须位于 rendererDir 内）
  不能，但 git 能拉到               → restart
  git 拉不到（node_modules 等）     → reinstall（标 unreachableByGit）
  与运行态无关（文档、脚本）         → none
  拿不准                           → restart（宁可多重启，也不要错误热更）
```

---

## 12. 投入产出分析（复杂度视角）

### 投入：带来的复杂度

| 维度 | 当前（demo） | P2 后（模块） | 变化 |
|---|---|---|---|
| 文件数 | ~15 | ~25 | +10 |
| 接口数 | ~10 | ~23 | +13 |
| 测试脚本 | 5 | 10 | +5 |
| 概念数 | ~5 | ~12 | +7 |
| 代码行数 | ~1500 | ~2000 | +500 |
| 可复用性 | 低（复制粘贴） | 高（subtree 引入） | 质变 |
| 接入成本 | 高（重新实现） | 低（填契约） | 质变 |

### 产出：带来的价值

| 价值 | 说明 |
|---|---|
| 可复用模块 | 第三方接入成本从"重新实现"降到"填契约文件" |
| 修复现有缺陷 | D1-D4 四个 bug 得到修复 |
| 明确运行中更新 | 状态机 + 重启方式 |
| 统一契约 schema | 三层结构 + bridgeApi 结构化 |

### 代价：不做的后果

| 代价 | 说明 |
|---|---|
| 每个新项目重新实现 | 重复造轮子，维护多份代码 |
| 现有缺陷继续存在 | D1-D4 四个 bug 继续影响用户 |
| 运行中更新状态缺失 | 可能导致白屏/崩溃 |
| 成员本地改动丢失 | D2 的 bug 会静默丢弃 commit |
