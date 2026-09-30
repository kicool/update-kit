# P2 实施方案：从 Demo 到可复用模块

> 目标：把 `update-kit/` 从"项目内的一个目录"变成"**可独立分发、可独立升级的 git subtree 模块**"，第三方接入只需填一份契约文件。
>
> 状态：⬜ 未实施

---

## 0. 背景与动机

当前 `update-kit/core/` 已经是纯 node 模块（零 electron 依赖），但存在以下问题：

| 问题 | 现状 | 影响 |
|---|---|---|
| host 层没有物理分离 | `main.js` / `preload.js` 混在 `src/application/` 里 | 第三方接入需要手动拆分 |
| 没有独立包结构 | `update-kit/` 没有 `package.json` | 无法作为独立模块分发 |
| 没有契约模板 | 设计文档提到 `contract.template.json` 但实际不存在 | 第三方不知道该填什么 |
| 没有接入示例 | 只有设计文档中的步骤描述 | 第三方无法快速验证 |
| 没有 subtree 化 | `update-kit/` 只是普通目录 | 无法被第三方通过 `git subtree add` 引入 |

**P2 的核心目标**：让第三方项目通过 `git subtree add` 一条命令引入更新模块，只需填一份契约文件，而不是照着 demo 再开发一遍。

---

## 1. 目标结构

### 1.1 独立仓库 `update-kit/`

```
update-kit/                    ← 独立 git 仓库
├── package.json               ← 声明入口、依赖、peerDependencies
├── README.md                  ← 接入文档
├── core/                      ← 纯 node，零 electron 依赖
│   ├── index.js               ← 统一入口
│   ├── classifier.js          ← 白名单分类器
│   ├── policy.js              ← 时机策略引擎
│   ├── contract.js            ← 契约校验
│   └── engine.js              ← git 封装（从 updater.js 迁入）
├── host/                      ← electron 适配层
│   ├── main-host.js           ← 主进程适配（从 main.js 提取）
│   └── preload-host.js        ← preload 适配（从 preload.js 提取）
├── contract.template.json     ← 第三方照填的模板
└── test/                      ← 模块自带测试
    └── run-all.js
```

### 1.2 第三方项目接入后的结构

```
third-party-project/
├── package.json
├── main.js                    ← 只需两行：require + init
├── contract.json              ← 从 template 复制，填 5 项
├── update-kit/                ← git subtree 引入
│   ├── core/
│   ├── host/
│   └── contract.template.json
└── src/
    └── app/                   ← 业务渲染层（hot 类）
        ├── index.html
        └── renderer.js
```

---

## 2. 接口边界定义

### 2.1 核心原则

```
core/  ← 不 require electron、不读业务代码、只依赖契约文件 + git
host/  ← 只做接线：窗口 / 定时器 / IPC / userData 状态
```

**红线**：`core/` 的任何文件都不能出现 `require('electron')`。这是"能进 CI"的前提。

### 2.2 `core/` 层接口（纯 node）

```javascript
// core/index.js — 统一入口
module.exports = {
  classifier: require('./classifier'),  // 白名单分类器
  policy: require('./policy'),          // 时机策略引擎
  contract: require('./contract'),      // 契约校验
  engine: require('./engine'),          // git 封装
};
```

```javascript
// core/engine.js — git 封装（从 src/application/updater.js 迁入）
module.exports = {
  runGit,        // 执行 git 命令
  resolveAppTree, // 解析加载树
  fetch,         // git fetch
  compare,       // 比对本地与远程
  diffFiles,     // 列出变更文件
  pull,          // 拉取更新
  isDirty,       // 检查未提交改动
  getVersion,    // 获取版本号
};
```

### 2.3 `host/` 层接口（electron 适配）

```javascript
// host/main-host.js — 主进程适配
module.exports = {
  /**
   * 初始化更新模块
   * @param {object} opts
   * @param {string} opts.contractPath — 契约文件路径
   * @param {object} opts.electron — electron 模块引用（注入，不直接 require）
   * @param {object} opts.window — BrowserWindow 实例
   * @param {object} opts.logger — 日志接口 { info, warn, error }
   */
  init(opts) { /* ... */ },

  /**
   * 检查更新
   * @returns {Promise<object>} 更新结果
   */
  checkUpdate() { /* ... */ },

  /**
   * 应用更新
   */
  applyUpdate() { /* ... */ },
};
```

```javascript
// host/preload-host.js — preload 适配
module.exports = {
  /**
   * 生成 preload 脚本内容
   * @param {string[]} bridgeApi — API 名单
   * @returns {string} preload 脚本源码
   */
  generatePreload(bridgeApi) { /* ... */ },
};
```

### 2.4 依赖注入原则

| 依赖 | 注入方式 | 理由 |
|---|---|---|
| electron 模块 | `opts.electron` 注入 | 避免 `core/` 间接依赖 electron |
| 日志接口 | `opts.logger` 注入 | 让宿主应用自定义日志 |
| 契约文件路径 | `opts.contractPath` | 不同项目路径不同 |
| 窗口实例 | `opts.window` 注入 | 便于测试和 mock |

---

## 3. 契约文件设计

### 3.1 `contract.template.json`

```json
{
  "_说明": "复制为 contract.json 后填写以下字段",

  "remote": "origin",
  "branch": "release",

  "paths": {
    "appEntry": "src/app/index.html",
    "rendererDir": "src/app"
  },

  "updateUnits": [
    {
      "name": "renderer",
      "class": "hot",
      "paths": ["src/app/"],
      "action": "reload"
    },
    {
      "name": "shell",
      "class": "restart",
      "paths": ["update-kit/"],
      "action": "relaunch"
    }
  ],

  "bridgeApi": [
    "checkUpdate",
    "applyUpdate",
    "relaunch",
    "onStatus",
    "onConfig"
  ]
}
```

### 3.2 字段说明

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `remote` | 是 | string | git remote 名称 |
| `branch` | 是 | string | 跟踪的分支 |
| `paths.appEntry` | 是 | string | 入口 HTML 相对路径 |
| `paths.rendererDir` | 是 | string | 渲染层目录相对路径 |
| `updateUnits` | 是 | array | 更新单元白名单 |
| `bridgeApi` | 是 | array | 桥接 API 名单 |

### 3.3 第三方只需填什么

五到六项：`remote` / `branch` / `paths` 两项 / `updateUnits` / `bridgeApi`。

其余（时机策略、分类器、git 引擎、契约校验）全部走默认值。

---

## 4. 代码提取方案

### 4.1 从 `main.js` 提取到 `host/main-host.js`

| 提取内容 | 目标位置 | 说明 |
|---|---|---|
| `verifyContract()` | `host/main-host.js` | 契约校验 |
| `checkUpdate()` | `host/main-host.js` | 检测 + 拉取 + 分类 |
| `applyIfPossible()` | `host/main-host.js` | 应用更新 |
| `scheduleNext()` | `host/main-host.js` | 定时调度 |
| `runScheduledCheck()` | `host/main-host.js` | 定时检测 |
| `collectEnv()` | `host/main-host.js` | 环境信息采集 |
| `runNpmCi()` | `host/main-host.js` | npm ci 执行 |
| `classifyPending()` | `host/main-host.js` | 更新前分类 |

### 4.2 从 `preload.js` 提取到 `host/preload-host.js`

| 提取内容 | 目标位置 | 说明 |
|---|---|---|
| `handlers` 对象 | `host/preload-host.js` | bridgeApi 实现 |
| 双向校验逻辑 | `host/preload-host.js` | 声明 vs 实现校验 |

### 4.3 从 `updater.js` 提取到 `core/engine.js`

| 提取内容 | 目标位置 | 说明 |
|---|---|---|
| 全部函数 | `core/engine.js` | git 封装（已经是纯 node） |

---

## 5. `package.json` 设计

```json
{
  "name": "@your-org/update-kit",
  "version": "1.0.0",
  "description": "Git-pull based auto-update module for Electron",
  "main": "core/index.js",
  "scripts": {
    "test": "node test/run-all.js"
  },
  "peerDependencies": {
    "electron": ">=20.0.0"
  },
  "engines": {
    "node": ">=18.0.0"
  },
  "files": [
    "core/",
    "host/",
    "contract.template.json"
  ]
}
```

---

## 6. 第三方接入示例

### 6.1 目录结构

```
examples/minimal/
├── package.json
├── main.js                  ← 最小接入示例
├── preload.js               ← 由 host/preload-host.js 生成
├── contract.json            ← 填好的契约
└── src/
    └── app/
        ├── index.html
        └── renderer.js
```

### 6.2 `main.js`

```javascript
const { app, BrowserWindow } = require('electron');
const path = require('path');
const { init } = require('update-kit/host/main-host');

let win = null;

app.whenReady().then(async () => {
  // 初始化更新模块
  await init({
    contractPath: path.join(__dirname, 'contract.json'),
    electron: { app, BrowserWindow },
    window: win,
    logger: console,
  });

  // 创建窗口
  win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, 'src/app/index.html'));
});
```

### 6.3 `contract.json`

```json
{
  "remote": "origin",
  "branch": "release",
  "paths": {
    "appEntry": "src/app/index.html",
    "rendererDir": "src/app"
  },
  "updateUnits": [
    { "name": "renderer", "class": "hot", "paths": ["src/app/"], "action": "reload" },
    { "name": "shell", "class": "restart", "paths": ["update-kit/"], "action": "relaunch" }
  ],
  "bridgeApi": ["checkUpdate", "applyUpdate", "relaunch", "onStatus", "onConfig"]
}
```

---

## 7. 分发方式：git subtree

### 7.1 为什么选 subtree

| 方式 | 模块能被用户端 git pull 更新吗 | 第三方接入 | 判据 |
|---|---|---|---|
| **git subtree** | **能**（源码在第三方仓库内，随 release 一起 pull） | `git subtree add` 一条命令 | **推荐**：守住 C1 |
| npm 包 | **不能**（在 `node_modules`） | `npm i` 一条命令 | 出局：模块升级变成 reinstall 类 |
| 模板仓库 fork | 能（复制一份） | fork 即可 | 起步最省事，但升级靠手动同步 |
| git submodule | 内容在外仓库，`reset --hard` 不更新子模块 | 需改 pull 参数 | 有坑，不推荐 |

**结论：subtree。** 只有它同时满足 C1（可更新物在 git 内）和低接入成本。

### 7.2 接入步骤（第三方视角）

```bash
# 1. 引入模块
git subtree add --prefix=update-kit <模块仓库URL> main --squash

# 2. 填写契约
cp update-kit/contract.template.json update-kit/contract.json
# 编辑 contract.json，填写 5 项

# 3. 主进程接入（main.js 里两行）
# const { init } = require('./update-kit/host/main-host');
# await init({ contractPath: './update-kit/contract.json', ... });

# 4. 启动
npm start
```

### 7.3 升级模块

```bash
git subtree pull --prefix=update-kit <模块仓库URL> main --squash
```

---

## 8. 实施步骤与验收标准

| 步骤 | 内容 | 验收标准 |
|---|---|---|
| 1 | 建立独立仓库 | `update-kit/` 成为独立 git 仓库，有 `package.json` |
| 2 | 定义接口边界 | `core/` 不 require electron，`host/` 只做接线 |
| 3 | 提取 host 层 | `main.js` 和 `preload.js` 的核心逻辑提取到 `host/` |
| 4 | 创建 package.json | 有 `main` 入口、`peerDependencies` |
| 5 | 创建 contract.template.json | 包含所有必填字段和注释 |
| 6 | 编写示例 | `examples/minimal/` 可运行 |
| 7 | subtree 化 | `electron-updater` 通过 subtree 引入，现有测试全绿 |
| 8 | 编写文档 | `README.md` 包含完整接入步骤 |

---

## 9. 关键设计决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| electron 依赖方式 | 注入（`opts.electron`） | 避免 `core/` 间接依赖 electron |
| 日志接口 | 注入（`opts.logger`） | 让宿主应用自定义日志 |
| 契约文件位置 | `update-kit/contract.json` | 与模块一起分发，一起更新 |
| 配置覆盖 | 保留 `config.json` 机制 | 本机差异不污染契约 |
| 分发方式 | git subtree | 守住 C1（可更新物在 git 内） |
| 模块入口 | `core/index.js` | 统一入口，便于 tree-shaking |

---

## 10. 风险与注意事项

| 风险 | 缓解措施 |
|---|---|
| 提取 host 层时破坏现有功能 | 每提取一个函数，跑一次现有测试 |
| subtree 引入后路径变化导致契约校验失败 | 重新推导 `shellDir` 与 `repoPath` 的相对关系 |
| 第三方项目目录结构差异大 | 契约文件支持自定义路径，不假设固定结构 |
| 模块升级时契约不兼容 | `contractVersion` 机制已就位，主版本跳跃 → reinstall |

---

## 11. 后续工作（P3）

P2 完成后，P3 阶段将实施：

- CI / pre-commit 集成
- `update-plan` 发版预演
- 契约哈希校验
- AST 解析替代正则
- `config.json` schema 校验
