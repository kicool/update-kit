# update-kit

Git-pull based auto-update module for Electron.

## 适用场景

**内部团队使用 · 通过 git 发布 · Electron 不打包 · 成员在代码仓库内直接 `npm start` 运行 · remote 可信**

## 接入步骤

### 1. 引入模块

```bash
git subtree add --prefix=update-kit git@github.com:kicool/update-kit.git main --squash
```

### 2. 填写契约

```bash
cp update-kit/contract.template.json update-kit.contract.json
# 编辑 contract.json，填写以下字段：
# - remote / branch
# - paths.appEntry / paths.rendererDir
# - updateUnits
# - bridgeApi
```

### 3. 生成 preload

```bash
npm run gen-preload
npm run inject-preload
```

### 4. 主进程接入

```javascript
// main.js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const updateKit = require('./update-kit/host/main-host');

let win = null;

app.whenReady().then(async () => {
  const kit = await updateKit.init({
    projectRoot: path.resolve(__dirname, '..'),
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

### 5. 验证

```bash
npm run contract-check  # 要求覆盖率 100%
npm run kit-test        # 运行 kit 测试
```

## 升级模块

```bash
git subtree pull --prefix=update-kit git@github.com:kicool/update-kit.git main --squash
```

### 示例接入步骤

1. **安装依赖**：
   ```bash
   cd examples/minimal
   npm install
   ```

2. **生成 preload**：
   ```bash
   npm run gen-preload
   npm run inject-preload
   ```

3. **运行**：
   ```bash
   npm start
   ```

## 分类决策树

```
这个路径改动后，不重启就能生效吗？
  能，且只影响 renderer            → hot（必须位于 rendererDir 内）
  不能，但 git 能拉到               → restart
  git 拉不到（node_modules 等）     → reinstall（标 unreachableByGit）
  与运行态无关（文档、脚本）         → none
  拿不准                           → restart（宁可多重启，也不要错误热更）
```

## 更新状态机

| 状态 | 规则 |
|---|---|
| checking | 应用可正常使用 |
| applying | 界面显示"更新中"，禁用 check/apply 按钮 |
| applied（hot） | reload 会重新执行磁盘上的新 preload |
| pending-restart | 禁止 host 主动 reload；界面常驻"需要重启"提示 |
| needs-reinstall | 同 pending-restart，另外给出终端命令提示 |

## 重启方式

| restartMode | 行为 |
|---|---|
| `prompt`（默认） | 界面提示"请关闭应用，并在终端重新运行 `npm start`" |
| `relaunch` | 保持现有 `app.relaunch()` 行为 |

## 目录结构

```
update-kit/
├── core/                  ← 纯 node，零 electron 依赖
│   ├── classifier.js      ← 白名单分类器
│   ├── policy.js          ← 时机策略引擎
│   ├── contract.js        ← 契约校验
│   ├── contract-loader.js ← 三层合并 + 路径解析
│   └── engine.js          ← git 封装
├── host/                  ← electron 适配层
│   ├── main-host.js       ← 编排：init / check / apply
│   ├── scheduler.js       ← 定时调度器
│   ├── state-store.js     ← userData 状态读写
│   ├── local-config.js    ← 本机覆盖配置读写
│   └── ipc-bridge.js      ← IPC 通道注册
├── tools/                 ← kit 工具
│   ├── gen-preload.js     ← 构建期生成 preload-handlers.js
│   └── inject-preload.js  ← 自动注入 preload.js 的 handler 引用
├── test/                  ← kit 测试
│   ├── core.test.js       ← 纯 core 断言
│   ├── host.test.js       ← mock electron 测试
│   ├── engine.test.js     ← engine 返回形状契约（本地裸仓库，零网络）
│   ├── git-integration.test.js ← 临时 git 仓库集成测试
│   └── run-all.js         ← 编排所有测试
├── defaults.json          ← kit 默认值
└──  contract.template.json ← 项目契约模板
```

## 设计原则

1. **core/ 可复用**：纯 node，不 require electron，接口稳定
2. **host/ 不可复用**：依赖 electron + 项目特定逻辑
3. **契约驱动**：第三方只需填一份契约文件
4. **git subtree 分发**：守住 C1（可更新物在 git 内）

## 模块间契约

engine 返回形状、IPC 通道反查、主进程→渲染层载荷形状、状态推送时序等约定，
见 [host/README.md](host/README.md#模块间契约改动前必读)。改动任一约定必须同步改测试。

## 参考文档

- [更新策略与模块化设计](docs/update-policy-and-module-design.md)
- [P2 实施方案 v3](docs/p2-module-implementation-plan-v3.md)
