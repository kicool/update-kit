# P2 实施方案（修订版 v2）：把现有实现迁移为可复用模块

> 取代：`docs/p2-module-implementation-plan.md`（v1，保留作历史对照）
> 状态：⬜ 未实施
> 适用场景（设计前提，所有决策都以此为准）：
> **内部团队使用 · 通过 git 发布 · Electron 不打包 · 成员在代码仓库内直接 `npm start` 运行 · remote 可信**

---

## 0. 相对 v1 的变更摘要

v1 是按"空白项目"写的；本版改为**审计现有实现 → 先修缺陷 → 再迁移**。主要变化：

| # | 变化 | 原因 |
|---|---|---|
| 1 | 新增 P2.0「先修现有缺陷」阶段 | 审计发现 `npm ci` 顺序错误、本地已提交未推送的 commit 会被丢弃等问题，提取时会原样带进 host 层 |
| 2 | 契约分三层：项目契约 / kit 默认值 / 本机覆盖 | v1 模板缺 `updatePolicy`，过不了现有 `core/contract.validate()` |
| 3 | 项目契约放项目根 `update-kit.contract.json` | 契约归项目所有，不能进 subtree 目录 |
| 4 | `bridgeApi` 结构化为 `{name, type, channel}` | 字符串名单无法区分 invoke / send / on，生成不了 preload |
| 5 | preload 改为**构建期生成并提交**，不在运行时生成 | 运行时写仓库会被 `reset --hard` 覆盖，或让 `isDirty` 永久为真 |
| 6 | host 层按职责拆成 5 个文件，用 `getWindow()` 注入窗口 | 避免 God Module 平移；修复 v1 示例里 `init` 时窗口为 `null` 的问题 |
| 7 | 更新流程拆成 `check()` / `apply()`，由 policy 编排 | 保留 `apply=auto` 的"检查即应用"语义，同时让边界清楚 |
| 8 | 补"运行中更新"规则，包括 `npm start` 场景下的重启方式 | `app.relaunch()` 会让新进程脱离终端 |
| 9 | 测试拆成 kit 自带测试和应用测试 | 现有 `core-selftest` / `policy-matrix` 引用了应用层文件 |
| 10 | 本仓库保持 subtree prefix 为 `src/update-kit/` | 避免 `updateUnits` 路径和 require 路径大面积改动 |

对评审意见的逐条采纳情况见附录 A。

---

## 1. 现状基线（审计结果，2026-09-30）

### 1.1 文件与职责

| 文件 | 行为 | 迁移去向 |
|---|---|---|
| `src/application/main.js`（~400 行） | 契约自检、环境抬头、分类、检查/拉取、npm ci、调度、状态持久化、IPC、窗口 | 拆到 `host/` 5 个文件，应用侧只留窗口创建 |
| `src/application/preload.js` | `handlers` + 运行时双向校验，`require('./registry')` | 由生成器产出，见第 6 节 |
| `src/application/registry.json` | 契约唯一事实源（`contractVersion` 1.1.0，8 个 updateUnits，updatePolicy） | → 项目根 `update-kit.contract.json` + kit 默认值 |
| `src/application/registry.js` | 合并 registry.json + config.json，解析路径，迁移旧字段 `autoPull` | → `update-kit/core/contract-loader.js`（纯 node） |
| `src/application/config.json`（gitignore） | 本机覆盖：repoPath / branch / updatePolicy | → 项目根 `update-kit.local.json`（gitignore） |
| `src/application/updater.js` | git 封装，已是纯 node | → `update-kit/core/engine.js` |
| `src/update-kit/core/classifier.js` | 4 类（none/hot/restart/reinstall），最长匹配，未登记按 restart，契约版本比较 | 原地保留 |
| `src/update-kit/core/policy.js` | 时机判定：interval/dailyAt、jitter、免打扰、退避 | 原地保留 |
| `src/update-kit/core/contract.js` | 结构自检、覆盖率、bridgeApi 双向一致（正则读 preload） | 原地保留，扩展 bridgeApi 检查 |

### 1.2 已具备、v1 未引用的能力（本版直接沿用，不重新设计）

- **contractVersion 判定**：`classifier.compareContract()`，主版本不同或低于 minSupported → reinstall；次版本不同 → restart。
- **分类规则**：最长模式优先；多单元取最高级别；同一路径被多个单元声明 → 报错；未登记文件 → restart + 告警。
- **版本号**：`git describe --tags --always`。
- **运行时状态写 userData**（`update-state.json`），绝不写仓库。
- **updateUnits 不允许本机覆盖**（团队契约）。

### 1.3 现有测试

| 命令 | 内容 | 归属（迁移后） |
|---|---|---|
| `npm run contract-check` | 结构自检 + 覆盖率 + bridgeApi 双向一致 | 应用（调用 kit 的 core/contract） |
| `npm run core-test` | classifier / policy / contract 断言（61 条） | 拆分：纯 core 部分进 kit，`registry` / `ui-state` 部分留应用 |
| `npm run matrix-test` | 策略组合穷举 + 界面组合 | 拆分：策略部分进 kit，`ui-state` 部分留应用 |
| `npm run smoke` | stub electron 跑 main.js 接线 | 应用 |
| `npm run selftest` | 真实远程检查 | 应用 |
| `npm run verify` | 脚本化验收 | 应用 |

---

## 2. P2.0：先修的现有缺陷

这些与模块化无关，但提取时会原样带入 host 层，所以**先修、先测、先发版**。

### D1. `npm ci` 在 pull 之前执行（bug）

`checkUpdate()` 里先 `runNpmCi()`，再 `updater.pull()`，装的是**旧** lockfile 的依赖。`autoNpmCi` 默认 false，所以暂时没暴露。

**修法**：npm ci 移到 pull 之后。失败时按 deps 单元的 `fallback: reinstall` 升级为 reinstall 提示（见 5.3，不做 git 回滚）。

### D2. 本地已提交、未推送的 commit 会被静默丢弃（bug）

`pull()` = `fetch` + `reset --hard origin/release`；`isDirty()` 只查未提交的 tracked 改动。成员本地有未推送 commit 时，commit 会从分支上消失，只能从 reflog 找回。

**修法**：`engine` 新增 `aheadBehind({ remote, branch, cwd })`（`git rev-list --left-right --count HEAD...origin/release`）。`ahead > 0` → 拒绝 apply，状态为 `blocked:ahead`。加了这道检查后，`reset --hard` 在效果上等于快进，**无需改成 `--ff-only`**。

### D3. 主进程里的延迟 require

`verifyContract()` 里 `require('../update-kit/core/contract')`、`runNpmCi()` 里 `require('child_process')`。pull 之后再触发，会加载磁盘上的**新**代码，与内存里的旧代码混跑。

**修法**：所有 require 移到文件顶部。在 kit 的检查脚本里加一条规则：`host/` 与 `core/` 文件中，函数体内不得出现 `require(`（grep 检查）。

### D4. 分支分叉时静默处理

本地既领先又落后（分叉）时，当前逻辑只看 `behind`。**修法**：D2 的 `aheadBehind` 同时覆盖此情况，分叉 → `blocked:diverged`，提示先 rebase 或 push。

**P2.0 验收**：现有 5 个测试全绿；新增失败注入用例：① lockfile 变化 + `autoNpmCi=true`，验证 npm ci 在 pull 之后执行；② 本地领先 1 个 commit → 拒绝 apply，commit 仍在；③ 分叉 → 拒绝。

---

## 3. 目标结构

### 3.1 kit 独立仓库

```
update-kit/                         ← 独立 git 仓库，通过 subtree 引入
├── package.json                    ← 仅作元数据与 kit 测试入口；不发 npm
├── README.md                       ← 接入文档（写明第 0 节的场景前提）
├── defaults.json                   ← kit 默认值（updatePolicy 等）
├── contract.template.json          ← 项目契约模板
├── core/                           ← 纯 node，禁止 require('electron')
│   ├── index.js
│   ├── classifier.js               ← 现有
│   ├── policy.js                   ← 现有
│   ├── contract.js                 ← 现有 + bridgeApi 结构化检查
│   ├── contract-loader.js          ← 由 registry.js 迁入：三层合并 + 路径解析 + 旧字段迁移
│   └── engine.js                   ← 由 updater.js 迁入 + aheadBehind
├── host/                           ← electron 适配，electron 通过参数注入
│   ├── main-host.js                ← 编排：init / check / apply / 状态下发（目标 < 200 行）
│   ├── scheduler.js                ← 定时器、nextAt、失败退避（调用 core/policy）
│   ├── state-store.js              ← userData/update-state.json 读写
│   ├── local-config.js             ← update-kit.local.json 读写（set-update-policy）
│   └── ipc-bridge.js               ← 按 bridgeApi 注册 ipcMain.handle / on
├── tools/
│   ├── gen-preload.js              ← 构建期生成 preload.js
│   └── check-boundaries.js         ← core 无 electron、函数体内无 require
└── test/
    ├── run-all.js                  ← 编排下列测试
    ├── core.test.js                ← 纯 core 断言（从 core-selftest 拆出）
    ├── policy-matrix.test.js       ← 策略穷举（从 policy-matrix 拆出）
    ├── host.test.js                ← mock electron 测试 host 编排
    └── git-integration.test.js     ← 临时 git 仓库：dirty / ahead / diverged / 失败恢复
```

`package.json` 要点：`"private": true`；不写 `peerDependencies`（electron 走注入，host 不直接 require electron）；`engines.node` 与宿主一致（`>=22.12.0`）；不需要 `exports` / `files`（不走 npm）。

### 3.2 接入后的项目结构（以本仓库为例）

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

**prefix 决策**：本仓库保留 `src/update-kit/`，这样 `updateUnits` 里的 `src/update-kit/` 路径和所有 require 路径不变。新项目默认用 `update-kit/`。kit 代码中**不得硬编码自身 prefix**，一律用 `__dirname` 推导。

---

## 4. 契约：三层结构

### 4.1 分层

| 层 | 文件 | 进 git | 谁改 | 内容 |
|---|---|---|---|---|
| kit 默认值 | `<kit>/defaults.json` | kit 仓库 | kit 维护者 | `updatePolicy` 全量默认值 |
| 项目契约 | `update-kit.contract.json`（项目根） | 是 | 项目维护者，需评审 | 版本、remote/branch、paths、updateUnits、bridgeApi，可选 updatePolicy 覆盖 |
| 本机覆盖 | `update-kit.local.json`（项目根） | 否 | 成员本人 / 界面设置 | repoPath、branch、treeLabel、skipUpdate、updatePolicy |

合并顺序：`defaults.json` → 项目契约 → 本机覆盖（`updatePolicy` 深合并）。**`updateUnits` 与 `bridgeApi` 不允许本机覆盖**（沿用现有规则）。`contract.validate()` 在**合并之后**执行，所以项目契约里不写 updatePolicy 也能通过校验。

为什么契约放项目根而不放 subtree 目录：

1. 契约属于项目，不属于 kit；放在 kit 目录里，维护者分不清归属。
2. 维护者在 kit 目录里执行 `git subtree push` 时，会把项目契约推到上游。
3. kit 目录在本仓库属于 shell（restart）单元，契约放在里面，改契约会被当成 restart 处理，而不是走 contractVersion 判定。

### 4.2 项目契约模板（`contract.template.json`）

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

说明：

- `class` 只有四个合法值：`none` / `hot` / `restart` / `reinstall`。**没有 `unknown` 类**：未登记的文件由分类器按 restart 处理并告警；写 `"class": "unknown"` 会被 `validateUnits` 拒绝。
- 契约文件本身登记在 shell 单元里，这是**路径层面**的兜底；bridgeApi 变化和版本跳跃仍由 contractVersion / bridgeApi 比对判定，最终取两者中级别更高的。
- `paths.rendererDir` 是入口目录，用于校验 `appEntry` 在其内、hot 单元不出圈；`updateUnits` 是更新判定白名单。两者用途不同，不算重复。

### 4.3 契约版本

- 本次迁移（文件改位置、bridgeApi 结构化）定为 **1.1.0 → 1.2.0**（次版本 → restart），**不升主版本**。理由：运行中的旧壳只需完成"拉取 + 提示重启"，不需要读懂新契约。旧壳 `classifyPending` 按旧路径读不到目标契约时会退化为只看路径，而 shell 文件都变了，结果仍是 restart，可以自举。
- 以后如果出现"旧壳连拉取都无法正确完成"的变更，才升主版本（→ reinstall）。
- 过渡期：`contract-loader` 找不到 `update-kit.contract.json` 时，回退读 `src/application/registry.json` 与 `config.json`，并打印一条迁移提示；这段兼容代码保留一个发版周期后删除。

### 4.4 bridgeApi 变化检测（扩展）

`classifyPending` 现在只比对名称列表。结构化之后改为比对 `{name, type, channel}` 三元组的排序序列化结果，任一项变化 → `contractChanged = true` → 不允许 hot。

---

## 5. 接口与更新流程

### 5.1 应用侧接入（生命周期）

```javascript
// src/application/main.js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const updateKit = require('../update-kit/host/main-host'); // subtree 目录，相对路径 require

let win = null;

app.whenReady().then(async () => {
  const kit = await updateKit.init({
    projectRoot: path.resolve(__dirname, '../..'),
    electron: { app, BrowserWindow, ipcMain, dialog },  // 注入，host 不 require electron
    getWindow: () => win,                               // 窗口可能尚未创建或已重建
    logger: console,
  });
  // init 内部：加载并校验契约 → 读状态 → 注册 IPC → 启动检测（按 onStartup）
  // 契约校验失败时 init 会 dialog + app.quit，不会返回

  win = new BrowserWindow({
    width: 920, height: 760,
    webPreferences: {
      preload: kit.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // 见 6.3；生成版 preload 验证通过后可改为 true
    },
  });
  kit.attach(win);           // 绑定 did-finish-load：下发 lastStatus + config
  win.loadFile(kit.appEntryPath);
  kit.startScheduler();
});
```

要点：先 `init`（启动检测在窗口出现前完成，沿用现有"复用 lastStatus、避免初始化空窗"的行为），再创建窗口，再 `attach`。host 内部**只通过 `getWindow()` 取窗口**，不缓存窗口引用。

### 5.2 host 各模块接口

| 模块 | 导出 | 依赖 |
|---|---|---|
| `main-host.js` | `init(opts)` → `{ check, apply, attach, startScheduler, preloadPath, appEntryPath, getState }` | 其余 4 个 host 模块 + core |
| `scheduler.js` | `create({ policy, state, run, onChange })` → `{ start, reschedule, stop, nextAt }` | core/policy |
| `state-store.js` | `create(userDataDir)` → `{ load, save, get, patch }` | fs |
| `local-config.js` | `create(projectRoot)` → `{ read, mergePolicy(patch) }` | fs, core/policy |
| `ipc-bridge.js` | `register(ipcMain, bridgeApi, impl)`：按契约 channel 注册，impl 缺项或多项 → throw | — |

### 5.3 check / apply 流程

`check()`：**不修改工作区**。

```
1. skipUpdate → 返回本地版本，结束
2. fetch（失败 → offline）
3. compare + aheadBehind
     behind=0            → up-to-date
     ahead>0 且 behind>0 → blocked:diverged
     ahead>0             → blocked:ahead
4. isDirty（仅 tracked）→ 若 dirty：blocked:dirty（仍返回 behind 信息）
5. diffFiles + 读取目标契约 → classify → plan
6. 返回 { state: 'available' | 'blocked:*', plan, version }
```

`apply()`：只有 `check()` 结果为 `available` 时才执行。

```
1. 重新执行 check() 的 3–5（防止两次调用之间状态变化）
2. plan.klass === 'reinstall'（契约不兼容）→ 不拉取，状态 needs-reinstall，提示重装
3. 记录 prevHead
4. pull（fetch + reset --hard remote/branch）
     失败 → reset --hard prevHead，状态 error，返回可读错误
5. 若含 deps 单元且 autoNpmCi=true → npm ci（在 pull 之后）
     失败 → 不回滚 git（npm ci 已删 node_modules，回滚代码无法恢复依赖），
            状态升级为 needs-reinstall，提示在终端执行 `npm ci` 后重启
6. 按 klass 生效：
     none    → applied
     hot     → 若 apply=auto：reload 窗口；状态 applied
     restart → 状态 pending-restart（不 reload，见 5.4）
```

policy 编排：`apply=auto` → 启动 / 定时 / 手动检查都执行 `check()` 后接 `apply()`；`apply=notify` → 只执行 `check()`，由界面"更新"按钮触发 `apply()`。对外行为与现有一致。

**不提供强制覆盖选项**：dirty / ahead / diverged 一律拒绝，提示用户先 commit/stash、push 或 rebase。不提供 `--force` 式的 `reset --hard`，避免丢失成员的工作。

### 5.4 运行中更新规则

| 状态 | 规则 |
|---|---|
| checking | 应用可正常使用 |
| applying | 界面显示"更新中"，禁用 check/apply 按钮；主进程拒绝并发的 check/apply（互斥锁） |
| applied（hot） | reload 会重新执行磁盘上的新 preload；由 4.4 保证 bridgeApi 未变才允许 hot |
| pending-restart | **禁止 host 主动 reload**（否则新 renderer + 新 preload 会配旧主进程）；界面常驻"需要重启"提示；定时器暂停，重启前不再拉取 |
| needs-reinstall | 同 pending-restart，另外给出终端命令提示 |

**重启方式（`npm start` 场景）**：`app.relaunch()` 之后 `npm start` 进程会退出，新进程脱离终端，看不到日志，Ctrl+C 也停不掉它。所以：

- 新增项目契约字段 `restartMode`：`"prompt"`（默认）| `"relaunch"`。
- `prompt`：界面提示"请关闭应用，并在终端重新运行 `npm start`"，按钮执行 `app.quit()`。
- `relaunch`：保持现有 `app.relaunch()` 行为，适合不从终端启动的成员。
- host 可以用 `process.env.npm_lifecycle_event === 'start'` 识别是否由 npm 启动，据此在界面文案中提示；但**不自动切换模式**，以契约为准。

---

## 6. preload：构建期生成

### 6.1 方案

- `update-kit/tools/gen-preload.js` 读取项目契约的 `bridgeApi`，生成 `paths.preload` 指向的文件。文件首行写 `// GENERATED by update-kit/tools/gen-preload.js — do not edit`。
- 生成内容把 API 表**内联**进文件，按 type 映射：`invoke → ipcRenderer.invoke(channel, ...args)`，`send → ipcRenderer.send(channel, ...args)`，`on → ipcRenderer.on(channel, (_e, v) => cb(v))`。文件里只 `require('electron')`。
- 生成物**提交进 git**，属于 shell 单元。
- 新增 npm 脚本 `gen-preload`；修改 bridgeApi 后必须重新生成。

### 6.2 校验（替代现有正则解析 handlers）

- `contract-check` 在内存里重新生成一次，与磁盘上的文件逐字节比对；不一致 → 失败，提示"契约已改但未重新生成 preload"。
- 主进程侧 `ipc-bridge.register` 在启动时校验"契约声明的 channel 全部已注册、没有多余注册"。
- 这样声明与实现的双向一致性由"生成物一致 + 主进程注册一致"共同保证，比现在的正则解析更严格。

### 6.3 sandbox

生成版 preload 不再 require 本地文件，理论上可以开启 `sandbox: true`。但 `smoke` 用 stub 顶掉了 electron，无法验证这一点，因此：P2 保持 `sandbox: false` 不变；在 V1 人眼验收中单独验证 `sandbox: true` 下 `window.api` 可用，通过后再作为独立改动切换。

---

## 7. 测试策略

| 层 | 测试 | 状态 |
|---|---|---|
| kit / core | classifier、policy、contract、contract-loader 三层合并、旧字段迁移 | 从 `core-selftest` 拆出 + 新增 |
| kit / core | 策略穷举 | 从 `policy-matrix` 拆出 |
| kit / host | mock electron：init 顺序、`getWindow()` 为 null 时不崩、pending-restart 不 reload、apply 互斥 | 新增 |
| kit / 集成 | 临时 git 仓库（bare remote + clone）：dirty / ahead / diverged 拒绝；pull 失败回到 prevHead；npm ci 在 pull 后执行（stub npm） | 新增 |
| kit / 边界 | `check-boundaries.js`：core 无 `require('electron')`；函数体内无 `require(` | 新增 |
| 应用 | `contract-check`（含 preload 生成物比对）、`smoke`、界面 `ui-state` 组合、`selftest`、`verify` | 保留并调整路径 |

`update-kit/test/run-all.js` 串行执行 kit 测试；应用侧 `npm test` 先执行 `node src/update-kit/test/run-all.js`，再执行应用测试。CI 与 pre-commit 接入放在 P3（与 v1 一致）。

---

## 8. 分发：git subtree

```bash
# 引入（新项目）
git subtree add  --prefix=update-kit <kit 仓库 URL> main --squash
# 升级（必须与 add 时一致地带 --squash）
git subtree pull --prefix=update-kit <kit 仓库 URL> main --squash
```

接入清单（写进 README）：

1. 复制 `update-kit/contract.template.json` 到项目根，命名为 `update-kit.contract.json` 并填写。
2. `.gitignore` 加入 `update-kit.local.json`。
3. 执行 `node update-kit/tools/gen-preload.js`，提交生成的 preload。
4. 在主进程按 5.1 接入。
5. 运行 `contract-check`，要求覆盖率 100%。

kit 维护规则：kit 改动先在 kit 仓库提交，再 `subtree pull` 进项目；**禁止**在项目里直接改 subtree 目录后 `subtree push`，除非改动只涉及 kit 文件。

本仓库的 subtree 化方式：先把 `src/update-kit/` 用 `git subtree split --prefix=src/update-kit` 拆成独立仓库历史，推到新仓库；之后本仓库以同一 prefix 通过 `subtree pull` 升级。

---

## 9. 实施阶段与验收

### P2.0 修缺陷（不动结构）

| 步骤 | 内容 | 验收 |
|---|---|---|
| 0.1 | D1：npm ci 移到 pull 之后 | 失败注入用例通过 |
| 0.2 | D2 / D4：`aheadBehind`，ahead / diverged 拒绝 apply | 临时仓库用例通过，本地 commit 保留 |
| 0.3 | D3：require 全部移到文件顶部 | grep 检查通过 |
| 0.4 | 发版（按 `todo.md` 流程）+ V3 用户目录验收 | 5 个现有测试全绿 |

### P2.1 契约与 host 拆分（仍在本仓库内）

| 步骤 | 内容 | 验收 |
|---|---|---|
| 1.1 | 新增 `defaults.json`、`contract-loader.js`（三层合并 + 兼容旧路径），`registry.js` 改为转调 | `core-test` 全绿；旧 config.json 仍生效 |
| 1.2 | 契约迁到项目根，bridgeApi 结构化，contractVersion → 1.2.0；4.4 扩展比对 | `contract-check` 全绿 |
| 1.3 | `gen-preload` + 生成物比对；替换手写 preload | `contract-check` / `smoke` 全绿；V1 人眼验收 `window.api` 可用 |
| 1.4 | 拆出 state-store / local-config / scheduler / ipc-bridge，每拆一个跑一次 `smoke` | 每步全绿 |
| 1.5 | main-host 编排 + check/apply 拆分 + 5.4 状态机 + `restartMode` | `main-host.js` < 200 行；host mock 测试通过 |
| 1.6 | `src/application/main.js` 改为按 5.1 接入 | `smoke` 全绿；V1 验收 |

### P2.2 独立化

| 步骤 | 内容 | 验收 |
|---|---|---|
| 2.1 | 测试拆分到 `update-kit/test/`，新增集成测试和边界检查 | `node src/update-kit/test/run-all.js` 全绿，不依赖 `src/application` |
| 2.2 | `subtree split` 建立 kit 仓库，本仓库改为 subtree 引入 | 所有测试全绿；`subtree pull` 空更新成功 |
| 2.3 | `examples/minimal/`（放在 kit 仓库内，含 `update-kit` 相对引用） | 在临时目录按 README 接入并 `npm start` 成功 |
| 2.4 | README：场景前提、接入清单、分类决策树、状态机、重启方式 | 另一名成员仅按文档完成接入 |
| 2.5 | 删除 4.3 的旧路径兼容代码（下一个发版周期） | — |

分类决策树（写进 README）：

```
这个路径改动后，不重启就能生效吗？
  能，且只影响 renderer            → hot（必须位于 rendererDir 内）
  不能，但 git 能拉到               → restart
  git 拉不到（node_modules 等）     → reinstall（标 unreachableByGit）
  与运行态无关（文档、脚本）         → none
  拿不准                           → restart（宁可多重启，也不要错误热更）
```

---

## 10. 风险

| 风险 | 缓解 |
|---|---|
| 拆分 host 时破坏现有行为 | 每拆一个模块跑一次 `smoke` + `core-test`；P2.1 期间不改对外 IPC 行为 |
| 旧壳拉到新契约结构后出错 | 旧壳读不到目标契约时退化为只看路径 → restart；1.2 发版前用用户模拟目录实测一次 1.1 → 1.2 升级 |
| 忘记重新生成 preload | `contract-check` 生成物比对失败，阻断 |
| pending-restart 期间用户手动 Ctrl+R | 无法完全阻止；界面常驻提示；bridgeApi 未变时新 preload 与旧主进程仍兼容，变了则调用会失败并提示重启 |
| 成员长期停留在 blocked:ahead | 界面持续显示原因和建议命令；不自动处理 |
| subtree prefix 在不同项目不一致 | kit 内部全部用 `__dirname` 推导，不硬编码 prefix |

---

## 11. 不在 P2 范围（P3）

- CI / pre-commit 接入
- `update-plan` 发版预演
- commit 签名、契约哈希校验（可信 remote 场景下非必须）
- AST 解析替代正则（preload 改为生成后，正则解析仅剩少量用途）
- `update-kit.local.json` schema 校验
- `npx update-kit init` 脚手架、扫描 renderer 生成 bridgeApi 建议名单
- 默认开启 `sandbox: true`（视 6.3 验收结果）

---

## 附录 A：对评审意见（修订版）的采纳情况

| 条目 | 处理 | 说明 |
|---|---|---|
| B1 契约命名与 schema | 采纳（调整） | 字段名本就一致，不需要映射表；改为第 4 节的三层结构 |
| B2 host 职责再划分 | 采纳 | 5.2 |
| B3 preload 保留模板注入 | 改为构建期生成 | 第 6 节；运行时生成会弄脏或覆盖工作区 |
| B4 require 路径 | 采纳 | 相对路径 require，不走 node_modules |
| B5 init 时窗口为 null | 采纳 | `getWindow()` + `attach()` |
| B6 bridgeApi 结构化 | 采纳 | 4.2 / 4.4 |
| G1 失败恢复 | 部分采纳 | 白名单越界、不兼容在 pull **前**判定；npm ci 失败不做 git 回滚（无法恢复 node_modules），改为 reinstall 提示 |
| G2 checkUpdate 不 pull | 调整 | 拆成 check / apply，`apply=auto` 语义保留 |
| G3 契约放项目根 | 采纳（理由修正） | 见 4.1 |
| G4 contractVersion 未定义 | 不成立 | 已实现（`compareContract`）；本版补进模板并定义 1.2.0 |
| G5 运行中更新 | 采纳并补充 | 5.4；补充 `npm start` 下 relaunch 脱离终端的问题 |
| G6 本地未推送改动 | 采纳，严重性上调 | 当前代码会静默丢弃 commit（D2） |
| m1 五类含 unknown | 不采纳 | 只有 4 类，unknown 是分类结果 |
| m5 开 sandbox | 延后 | 6.3 |
| m6 getVersion | 已定义 | git describe |
| m7 包管理器可配置 | 延后 | 团队统一 npm；`autoNpmCi` 默认关闭 |
| m8 peerDependencies | 采纳 | 删除 |
| m9 `--squash` 一致 | 采纳 | 第 8 节 |
| m10 exports | 不采纳 | 不走 npm，相对路径 require |
| m11 config 机制 | 采纳 | `update-kit.local.json` |
| m12 分类器策略 | 已定义 | 1.2 节 |
| 测试策略 | 采纳（更正） | 现有是 5 个脚本 + `verify.sh` |
| 第七节 脚手架 / 扫描工具 | 延后到 P3 | 内部团队规模下收益低 |
