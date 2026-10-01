# host/ — electron 适配层

## 定位

`host/` 是 **electron 适配层**，负责把 `core/` 的纯 node 能力接入 electron 环境。

## 契约含义

| 层 | 职责 | 依赖 |
|---|---|---|
| `core/` | 纯 node，零 electron 依赖 | 只依赖契约文件 + git |
| `host/` | electron 适配，只做接线 | 依赖 core + electron（注入） |

**边界**：`core/` 可复用，`host/` 属于宿主应用。

## 文件说明

| 文件 | 职责 |
|---|---|
| `main-host.js` | 编排：init / check / apply / attach / startScheduler |
| `scheduler.js` | 定时器、nextAt、失败退避 |
| `state-store.js` | userData/update-state.json 读写 |
| `local-config.js` | update-kit.local.json 读写 |
| `ipc-bridge.js` | 按 bridgeApi 注册 ipcMain.handle / on |

## 设计原则

1. **electron 通过参数注入**：`host/` 不直接 `require('electron')`
2. **职责单一**：每个文件只做一件事
3. **可测试**：通过 mock electron 测试

## 与 core 的关系

```
core/  ← 可复用，不 require electron，可进 CI
host/  ← 不可复用，require electron（注入），属于宿主
```

## 模块间契约（改动前必读）

kit 拆分后各层只靠以下三个约定耦合。**改动任一约定必须同步改测试**（`test/engine.test.js`、`tools/main-smoke.js`）。

### 1. engine 返回形状：结果对象、绝不抛异常

`core/engine.js` 所有函数**不抛异常**，统一返回 `{ ok, ... }`；调用方按 `ok` 分支，禁止用 try/catch 当控制流。

| 函数 | 返回形状 | 备注 |
|---|---|---|
| `runGit(args, {cwd, timeoutMs})` | `{ok, stdout, error?}` | stdout 只剥行尾换行，**不 trim 行首**（porcelain 行首空格是状态位） |
| `fetch(remote, {cwd})` | `{ok, error?}` | `ok=false` 一律按离线处理；connect 15s / 硬超时 30s |
| `compare({remote, branch, cwd})` | `{ok, behind, offline, local, remote, error?}` | `offline=true` 表示远程分支不存在/不可达 |
| `aheadBehind(...)` | `{ok, ahead, behind}` | ahead/behind 永远是数字 |
| `isDirty({cwd})` | `{ok, dirty, count, files}` | 只看 tracked（`--untracked-files=no`）；`files` 是纯路径数组 |
| `diffFiles(local, remote, {cwd})` | `{ok, files}` | 两点 diff，`files` 可直接喂 `classifier.classify()` |
| `getVersion({cwd})` | `{ok, version}` | `version` 是**字符串**（`git describe --tags --always`），可直接显示 |
| `localRef(branch, {cwd})` | `{ok, ref}` | `ref` 可直接喂 `runGit(['reset','--hard', ref])` |
| `pull({remote, branch, cwd})` | `{ok, error?}` | fetch + `reset --hard origin/branch`；调用前必须先过 isDirty/aheadBehind |

### 2. IPC 通道从 bridgeApi 反查，禁止硬编码

通道名唯一来源是契约的 `bridgeApi`（`type:'on'` 的条目 = 主进程推送、渲染层监听）：

```js
const channelOf = (name) => loader.bridgeApi.find((a) => a.name === name)?.channel;
```

host 不得出现 `'update:status'` 之类的字面量。bridgeApi 双向一致性由 `core/contract.js` 的 `checkBridgeApi` 把关。

### 3. 主进程 → 渲染层的两个载荷形状

**status（`onStatus` 通道）** —— 渲染层按此渲染状态面板：

```js
// 检测中（本地已知，远程结果未到）
{ ok:true, checking:true, version:string }
// 离线 / 已是最新 / 有更新（未拉） / 硬保护拦截 / 已拉取
{ ok, offline?, version, mode }
{ ok:true, updated:false, behind:false, version }
{ ok:true, updated:false, behind:true, version, klass, needsRestart, plan }
{ ..., dirty:true, dirtyCount, dirtyFiles } | { ..., blocked:'ahead', aheadCount, behindCount }
{ ok:true, updated:true, version, prevVersion, klass, needsRestart, plan, files }
```

**「检查即拉取」的语义**（渲染层据此判断弹窗时机）：`apply=auto` 时，
启动（onStartup=checkAndApply）、定时检测、手动 `checkUpdate` 走的都是
`checkAndMaybeApply()`——先 check，`shouldApply` 通过就直接拉取并返回
`updated:true`；只有 `updated:true` 且 `needsRestart` 时才允许弹「重启生效」。
`apply=notify` 时 check 只检测不拉取，由 `applyUpdate` 触发拉取。
**check 返回 `updated:false` 时弹重启 = 契约违规**（重启前后代码一模一样）。

**config（`onConfig` 通道）** —— 渲染层按此渲染抬头与策略面板：

```js
{ skipUpdate:boolean, env:{tree,root,entry,preload,branch,head,ref,contractVersion},
  policy:updatePolicy, schedule:{nextAt,lastCheckAt,failures}, units:updateUnits }
```

### 4. 状态推送时序

`attach()` 在 `did-finish-load` 里**先**推 config + interim status（`checking:true`，本地 `getVersion` 立即可得），**再**做远程检测推正式 status。禁止把远程 fetch 排在第一次状态推送之前——断网时 fetch 最长挂 30s，界面不能白等。

### 5. 本机覆盖文件

用户改策略写 `update-kit.local.json`（项目根，须 gitignore），**不写仓库内的 config.json**——避免被 `reset --hard` 抹掉、也不让 dirty check 误判。
