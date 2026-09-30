# 更新策略与模块化的设计方案（契约加固第二阶段）

> 目标：把「git-pull 更新」从本项目的一个 demo 做法，收敛成一份**契约驱动的公共机制**和
> **可独立交付的模块**，第三方接进去只填一份契约文件，而不是照着 demo 再开发一遍。
>
> **状态（2026-09-30）**：**P0 + P1 已实施**（第 9 节标 ✅，含实测结果）。
> P2（模块拆分 / subtree）与 P3（CI / pre-commit）仍是设计，未实施。

---

## 0. 一句话结论

把 `registry.json` 从「路径登记表」升级成「**更新单元白名单 `updateUnits` + 时机策略 `updatePolicy` + 契约指纹 `contractVersion`**」三件套：

- **范围**用白名单表达，每条路径显式标注更新类别（`hot` / `restart` / `reinstall` / `none`），
  未登记路径判 `unknown` 并告警——而不是像现在这样「越出 renderer 前缀就算需重启」；
- **时机**用 `updatePolicy` 表达，自动更新是可配置开关（总开关 / 开机行为 / 检测频率与时间 / 免打扰 / 失败退避），
  界面可改、写本机 `config.json`；
- **能力差别**由白名单的 `class` 字段直接体现，三类更新能力各有判据和兜底动作。

---

## 1. 需求（要解决的五件事）

| # | 需求 | 现状 | 缺口 |
|---|---|---|---|
| R1 | **白名单**：所有路径进注册表，显式标注更新类别 | 只有 `rendererDir` 一个前缀，其余靠「非此即需重启」反推 | 判据是代理指标，会误报也会漏 |
| R2 | **时机可配**：手动之外，自动更新作为开关 | 只有 `autoPull` 布尔 + 启动时一次检测 | 无法关、无法定频率/时间、无退避 |
| R3 | **界面可控**：界面有「是否启用自动更新」开关 | 无开关，改配置要手改 JSON | 用户（和验收者）无法运行时控制 |
| R4 | **能力分层可见**：热更 / 需重启 / 需重装三类差别体现在白名单 | 只有「热更 / 需重启」两档，第三层没定义 | 「哪些文件必须重装」无判据 |
| R5 | **模块化**：成为第三方可直接用的独立模块 | 壳与业务混在 `src/application/` | 第三方接入只能复制粘贴再改 |

---

## 2. 约束（不可违背的前提）

| # | 约束 | 来源 / 证据 |
|---|---|---|
| C1 | **可更新物必须在 git 里**。`node_modules/` 被 gitignore，pull 到不了 | Electron 307MB 实测在 `node_modules/electron/dist` |
| C2 | **加载树 = 仓库自己**（1 份化已落地），renderer / preload / registry 同源同 pull | 抬头实测 `preload = src/application/preload.js`（树内） |
| C3 | **pull 是 `reset --hard`**，会抹 tracked 改动 → 自动更新必须过 dirty check | `updater.js` 的 `isDirty()` |
| C4 | **preload 需 `sandbox: false`** 才能 `require('./registry')`，否则静默挂掉 | 截图实测：`window.api 不可用` |
| C5 | **运行时状态不能写在仓库里**（会被 reset 影响或触发 dirty） | 1 份化的直接推论 |
| C6 | **契约变更 = 结构性变更**：改 `bridgeApi` 名单就会跨版本不兼容 | `preload.js` 的双向校验闸门 |

---

## 3. 推导：三层更新能力的判据

### 3.1 判据一句话

> **能不能在不中断进程的前提下，让新代码完整地接管运行态？**
> 能 → `hot`；需要重启进程才能接管 → `restart`；git 拉不到、或拉到了也换不进运行中的进程 → `reinstall`。

判据的关键不在「文件在哪」，而在「**新旧两份代码会不会同时存在于运行态**」。
这也是为什么路径前缀是个坏判据——它只回答了前者。

### 3.2 「必须重装」那一层到底是什么（回答你的疑问）

判据：**git 拉不到，或拉到了也换不进正在运行的进程里。** 具体清单：

| 类别 | 具体对象 | 为什么 git 管不了 | 兜底动作 |
|---|---|---|---|
| ① 运行时二进制 | `node_modules/**`（Electron 本体 307MB） | gitignore，C1 | 提示重装 / 手动 `npm install` |
| ② 原生模块 | `*.node`、需 node-gyp 编译的依赖 | 绑定 Node ABI，跨平台二进制不在 git | 重装 + 编译工具链 |
| ③ 依赖版本变化 | `package.json` / `package-lock.json` 变化 | **文件本身能被 pull**，但它只是「信号」，真正的重装对象是 ① | **先自动 `npm ci`；成功 → 降级为 restart；失败 → reinstall** |
| ④ 平台/外部二进制 | `.dylib` / `.dll` / 捆绑的外部程序 | 不在 git 或需平台专属构建 | 重装 |
| ⑤ 契约不兼容 | `contractVersion` 主版本跳跃、入口文件被改名/删除 | 运行中的壳读不懂新契约 → **无法自举** | 重装（唯一「壳自身救不了」的情形） |
| ⑥ 签名与公证 | 若将来放弃源码运行，entitlements / 公证 | 出本方案边界 | 走正规分发渠道 |

**第 ③ 条是设计要点**：要把「信号文件」和「重装对象」分开。
`package.json` 在 git 里、能被 pull，所以它变化时正确的处理不是「提示重装」，而是
**触发一次 `npm ci`；成功就降级成重启，失败才升级成重装提示**。
只有 ①②⑤⑥ 才是真正的「必须重装」。

### 3.3 为什么现在会误报（已有实证）

`updater.js:97` 的 `onlyRendererChanges()` 用路径前缀反推：

```js
return files.every((f) => f.startsWith(rendererPrefix));  // 越出 renderer 即「需重启」
```

实测两次误报：

- `1f4fdd0 → 547b7d4` 只改了 `docs/` 两个 md，界面却显示「✅ 已拉取更新，**需重启应用生效**」。
- 同理，`scripts/`、`README.md` 的任何改动都会弹重启提示。

根因：**启发式是在猜「有没有破坏性」，而答案应该写在契约里。**

### 3.4 `hot` 的隐含条件：契约指纹

renderer 单独变（旧 main + 旧 preload + 新 renderer）只在**桥接契约没变**时才安全；
一旦 `bridgeApi` 名单变了，旧 preload 提供不了新 renderer 要调的方法 → `undefined is not a function`。

所以 `hot` 的完整判据是：**变更集全部落在 `class: hot` 的单元内，且 `bridgeApi` 未变。**
`bridgeApi` 变化 → 一律降为 `restart`（保守）。

> 放宽条件待实测：Electron 每次 reload 都会重新执行 preload 脚本，理论上 `bridgeApi`
> 变了也可能热更成功。**未实测，当前按保守处理**（见第 10 节）。

---

## 4. 实体一：白名单 `updateUnits`

### 4.1 结构

（`registry.json` 片段，落地时作为顶层字段）

```json
"updateUnits": [
  { "name": "renderer", "class": "hot",
    "paths": ["src/application/renderer/"],
    "action": "reload" },

  { "name": "shell", "class": "restart",
    "paths": ["src/application/main.js", "src/application/preload.js",
              "src/application/registry.js", "src/application/updater.js",
              "src/application/registry.json"],
    "action": "relaunch" },

  { "name": "deps", "class": "restart",
    "paths": ["package.json", "package-lock.json"],
    "action": "npm-ci-then-relaunch", "fallback": "reinstall" },

  { "name": "docs", "class": "none",
    "paths": ["docs/", "README.md", "scripts/"],
    "action": "none" },

  { "name": "runtime", "class": "reinstall",
    "paths": ["node_modules/"],
    "action": "prompt-reinstall", "unreachableByGit": true }
]
```

四个字段：`name`（人类可读）、`class`（能力分类）、`paths`（路径或前缀）、`action`（落地动作）。

### 4.2 类别与动作对照

| class | 含义 | 判定后的默认动作 | 用户感受 |
|---|---|---|---|
| `hot` | 文档重载即可接管 | `reload` | 无感热更（UI 状态会丢） |
| `restart` | 需重启进程 | `relaunch`（可先 `npm ci`） | 弹确认 → 重启 |
| `reinstall` | git 管不了，需重装/人工 | `prompt-reinstall` | 明确告知要重装 |
| `none` | 与运行态无关 | `none` | 静默，不打扰（**修复 docs 误报**） |
| `unknown` | **未登记**（兜底） | 按 `restart` 处理 + `[warn]` 告警 | 保守且不静默 |

### 4.3 匹配与冲突规则

1. 路径以 `/` 结尾 = 目录前缀匹配；否则 = 精确文件匹配。
2. **最长前缀优先**：精细单元覆盖粗单元（例如 `renderer/` 里的 `renderer/legacy/` 可单列）。
3. 同一路径被两个单元声明 → **契约校验直接报错**（不是静默取第一个）。
4. 变更集里出现未匹配任何单元的路径 → 记 `unknown`，按 `restart` 处理并打印告警。
5. **`unknown` 不静默**是白名单机制的精髓：宁可保守 + 吵闹，也不要自作聪明地猜。

### 4.4 覆盖率要求

白名单的前提是「所有路径都登记」。因此需要一个**覆盖率检查**：枚举仓库全部 tracked 文件，
列出未被任何单元覆盖者，交由人工确认归类（或显式声明 ignore）。这是第 8 节 CI 检查的第一项。

---

## 5. 实体二：时机策略 `updatePolicy`

### 5.1 结构

（`registry.json` 片段，落地时作为顶层字段）

```json
"updatePolicy": {
  "enabled": true,
  "onStartup": "checkAndApply",
  "schedule": { "mode": "interval", "intervalMinutes": 60, "dailyAt": "09:00", "jitterMinutes": 5 },
  "quietHours": { "from": "23:00", "to": "07:00" },
  "apply": "auto",
  "constraints": {
    "skipWhenDirty": true,
    "skipWhenOfflineSilently": true,
    "maxRetries": 3,
    "backoffMinutes": [5, 15, 60]
  }
}
```

| 字段 | 取值 | 说明 |
|---|---|---|
| `enabled` | bool | **总开关**。关 = 只有手动检查（界面可改，写 `config.json`） |
| `onStartup` | `off` / `check` / `checkAndApply` | 开机（启动）那一次的行为。`checkAndApply` = 不等 interval，启动即检测并拉取 |
| `schedule.mode` | `off` / `interval` / `dailyAt` | 运行期的检测节奏 |
| `intervalMinutes` | 整数 | 轮询间隔（默认 60，最小建议 5） |
| `dailyAt` | `"HH:MM"` | 定点检测（配合 `mode: dailyAt`） |
| `jitterMinutes` | 整数 | 随机抖动，**避免大量客户端同时打同一个 git 服务**（惊群） |
| `quietHours` | 起止时间 | 免打扰时段：期间不自动检测/拉取 |
| `apply` | `auto` / `notify` | 拉取后是否自动 reload/relaunch；`notify` = 只提示等用户点 |
| `constraints.skipWhenDirty` | bool | 有未提交改动 → 跳过自动拉取（C3） |
| `backoffMinutes` | 数组 | 连续失败指数退避，失败计数达 `maxRetries` 后本轮放弃 |

### 5.2 pull 模式下的频率设计要点（这是 pull 与 push 的根本差别）

推送模式下服务端决定何时发；pull 模式下**每个客户端都要自己轮询**，成本与风险都在客户端侧：

| 要点 | 设计 | 理由 |
|---|---|---|
| **检测 ≠ 拉取** | 检测（fetch + compare）廉价；拉取（`reset --hard`）昂贵且危险 | 可以频繁检测、谨慎拉取 |
| **两级节奏** | 检测按 `schedule`；拉取受 `apply` + dirty + 免打扰约束 | 检测频繁不会打扰用户 |
| **抖动 jitter** | 定点时间上加 ±N 分钟随机 | 同一时刻几百个客户端同时 fetch 会打爆 git 服务 |
| **免打扰** | `quietHours` 期间不自动动作 | 夜间自动 reload 会打断正在使用的人 |
| **退避** | 连续失败按 `backoffMinutes` 增长 | 断网/限流时不要死循环重试 |
| **dirty 优先** | 任何自动拉取前先 `isDirty()`（C3） | 自动更新无人值守，比手动更危险 |
| **apply 需确认** | 默认 `auto`（保持现行为），可配 `notify` | reload 会丢 UI 状态；`notify` 把打断权交还用户 |

### 5.3 界面开关与持久化分层

遵循既有分层（C4/C5 之外最容易被破坏的一条）：

```
registry.json（进 git）   = 默认值 / 团队约定   → updatePolicy 的默认值
config.json （gitignore） = 本机差异            → enabled / onStartup / schedule 的用户选择
```

界面新增控件：**启用自动更新**（复选框）、**开机自动更新**（复选框）、**检测频率**（关闭 / 每 N 分钟 / 每天定点 + 时间）、
**立即检查**（按钮）、状态区显示上次检测时间与下次检测时间。

界面的开关变更通过新的 bridge API 写回 `config.json`——这会**改动 `bridgeApi` 名单**（契约变更），
所以必须与 `contractVersion` 同批实施（见第 9 节 P0/P1 合并说明）。

> **旧字段 `autoPull` 已于 2026-09-30 废弃**（语义并入 `updatePolicy.apply`）。
> 它属于「两个开关表达同一件事」的典型冗余：只影响界面显示、不影响真实行为，
> 于是出现「抬头写着仅提示、点检查更新却自动拉取并 reload」的假象。
> 删除时的迁移规则落在 `registry.js` 的 `legacyApplyFrom()`：
> 旧 `config.json` 里 `autoPull:false` 且未显式给 `apply` → 视为 `notify`，
> 保证用户原本「别擅自拉」的意图不会因为删字段被静默反转。规则本身有单测锁定。

### 5.4 运行时状态必须出仓库（C5）

下次检测时间、连续失败次数、上次结果这类状态**写 `app.getPath('userData')`，不写仓库**：
写仓库会被 `reset --hard` 覆盖或让 `isDirty()` 永久为真（自动更新从此失效）。

---

## 6. 实体三：模块形态 `update-kit`

### 6.1 三层结构

```
update-kit/
├── core/                  ← 纯 node，零 electron 依赖，可 CI 单测
│   ├── engine.js          ← git 封装：fetch / compare / diff / pull / isDirty
│   ├── classifier.js      ← 白名单分类器：变更集 → hot/restart/reinstall/none/unknown
│   ├── policy.js          ← 时机判定：此刻该不该检测、该不该拉取
│   └── contract.js        ← 契约加载 + 校验（schema / 路径冲突 / 覆盖率 / bridgeApi 一致）
├── host/                  ← electron 适配层（薄，只做接线）
│   ├── main-host.js       ← 窗口 / 定时器 / IPC / userData 状态
│   └── preload-host.js    ← 按 bridgeApi 名单生成 window.api（双向校验闸门）
└── contract.template.json ← 第三方照填的模板
```

红线：**`core/` 不 require electron、不读业务代码、只依赖契约文件 + git。**
这条红线是「能进 CI」的前提（现在的 `preload.js` 首行 `require('electron')`，静态检查根本跑不了）。

### 6.2 第三方只需填什么

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

五到六项（`remote` / `branch` / `paths` 两项 / `updateUnits` / `bridgeApi`），
其余（时机策略、分类器、git 引擎、契约校验）全部走默认值。
第三方业务代码只在 `rendererDir` 里——**出圈的改动一律升级为 restart**，这条规则本身就是契约。

### 6.3 分发方式取舍

| 方式 | 模块能被用户端 git pull 更新吗 | 第三方接入 | 判据 |
|---|---|---|---|
| **git subtree** | **能**（源码在第三方仓库内，随 release 一起 pull） | `git subtree add` 一条命令 | **推荐**：守住 C1 |
| npm 包 | **不能**（在 `node_modules`） | `npm i` 一条命令 | 出局：模块升级变成 reinstall 类，与「git 当 CDN」模型冲突 |
| 模板仓库 fork | 能（复制一份） | fork 即可 | 起步最省事，但升级靠手动同步 |
| git submodule | 内容在外仓库，`reset --hard` 不更新子模块 | 需改 pull 参数 | 有坑，不推荐 |

**结论：subtree。** 理由不是它最好用，而是只有它同时满足 C1（可更新物在 git 内）和低接入成本。

### 6.4 接入步骤（第三方视角）

```bash
git subtree add --prefix=update-kit <模块仓库URL> release --squash   # 引入
cp update-kit/contract.template.json update-kit/contract.json        # 填 5 项
# main.js 里两行：
#   const kit = require('./update-kit/host/main-host');
#   kit.init({ contract: './update-kit/contract.json', window: win });
npm start
```

升级模块：`git subtree pull --prefix=update-kit <模块仓库URL> release --squash`

---

## 7. 取舍汇总

| 决策点 | 选项 | 选择 | 理由 |
|---|---|---|---|
| 判据依据 | 路径前缀启发式 / **白名单** | 白名单 | 启发式会误报（已实证）；白名单把答案写进契约 |
| 未登记路径 | 默认 hot / 默认 restart / **unknown+告警** | unknown + 按 restart 处理 + 告警 | 保守但不重伤；吵闹比静默猜错好 |
| package.json 变化 | 直接 reinstall / **先 npm ci，失败才 reinstall** | 后者 | 区分「信号文件」与「重装对象」 |
| 模块分发 | npm 包 / **subtree** / 模板 / submodule | subtree | 唯一同时满足 C1 与低接入成本 |
| 运行时状态 | 仓库内 / **userData** | userData | C5，否则 dirty check 会永久为真 |
| apply 默认 | **auto** / notify | auto（可配 notify） | 保持现有体验；notify 供打断敏感场景 |
| 检测频率默认 | 30 / **60** / 120 分钟 | 60 分钟 + jitter 5 | pull 模式要对远程友善 |

---

## 8. 契约加固与 CI（下一阶段，本阶段只预留接口）

| # | 检查 | 形态 | 拦什么 |
|---|---|---|---|
| 1 | **覆盖率检查** | `npm run contract-check` | 列出未被任何 `updateUnit` 覆盖的 tracked 文件 |
| 2 | **契约自检** | 同上 | schema 合法；路径存在；单元无冲突；`appEntry` 在 `rendererDir` 内；`hot` 单元必须完全位于 `rendererDir` |
| 3 | **bridgeApi 双向一致** | 同上（AST/正则解析，不 require electron） | 声明未实现 / 实现未声明 |
| 4 | **发版预演** | `npm run update-plan -- <from>..<to>` | 对任意两个 commit 输出分类结果；CI 中断言「本次发版的分类符合预期」（例如不该出现 `unknown`） |
| 5 | **pre-commit hook** | git hook | 改了 `registry.json` / `contract.json` 必须重跑 1–3 |
| 6 | **真实链路回归** | `scripts/verify.sh` | 已有的三档验收，改造后重跑 |
| 7 | **主进程接线冒烟** | `npm run smoke`（**已实施**） | 用 stub 顶掉 electron 跑完 `main.js`：契约校验 / 抬头 / IPC / 下发负载 |
| 8 | **策略与界面组合矩阵** | `npm run matrix-test`（**已实施**） | 穷举 `updatePolicy` / 界面决策的全部维度笛卡尔积，断言不变量 |

第 8 项补的是「单因子测试」的盲区：`core-test` 每条只动一个维度（单独关开关、单独进免打扰……），
但真实配置是这些维度的**笛卡尔积**，手点 UI 只能覆盖其中十几条。
组合矩阵的做法是**穷举 + 断言不变量**，而不是给每个组合写死期望值——写不过来，也容易自证。
10 条不变量覆盖：开关关闭时全自动路径全关、`shouldCheck` 必须与未截断的排期时刻一致（防止拿被 clamp 的
`nextCheckAt` 判定，这是本项目踩过的坑）、免打扰顺延、退避优先于 interval、抖动边界、坏输入不抛异常。

> 界面决策（置灰级联 / 「更新」按钮显隐）原本裸在 `renderer.js` 里没法测
> （它顶层要用 `window.api`，node 一 require 就炸）。已抽成纯函数
> `src/application/renderer/ui-state.js`，浏览器挂 `window.uiState`、node 走 `module.exports`，
> 于是界面组合也能进同一个矩阵。

第 4 项是关键：它让「分类判据」本身可被测试——
在 CI 里对两个 tag 之间的 diff 跑同一个分类器，断言结果，判据就不会在无人察觉时漂移。

第 7 项补的是前面 1–4 都碰不到的盲区：**接线层**。
本项目就在这上面吃过亏 —— preload 在沙箱里 `require` 失败静默挂掉，
而 `[contract]` 打印一切正常（那只证明主进程侧没事）。冒烟会真的调
`did-finish-load` 回调和两个 IPC，断言下发负载里 policy / units / env 都在。

---

## 9. 实施阶段划分

| 阶段 | 内容 | 是否契约变更 | 验收方式 | 状态 |
|---|---|---|---|---|
| **P0** | `registry.json` 加 `contractVersion`、`updateUnits`；新建 `core/classifier.js` 替换 `onlyRendererChanges`；`contract-check` 覆盖率与自检 | 是（加字段，不改名） | node 单测：同一组 diff 输入 → 分类输出正确（含 docs 应判 `none`） | ✅ 已实施 |
| **P1** | `updatePolicy` + `core/policy.js` + 主进程定时器 + 界面开关（新增 bridge API 写 config）+ 状态存 userData | 是（`bridgeApi` +`setUpdatePolicy` → `contractVersion` 1.0.0→1.1.0 护航） | V1 抬头 + 界面开关可见可改；V3 用户态观察定时检测 | ✅ 已实施 |
| **P2** | 拆分 `core/` 与 `host/`，模块 subtree 化，写第三方接入示例 | 是（路径变动） | 新建第三方示例仓库跑通一次完整更新 | ⬜ 未实施 |
| **P3** | CI / pre-commit / `update-plan` 断言 | 否 | 故意引入一个未登记路径，CI 应失败 | ⬜ 未实施（`contract-check` 已可跑，只差接进 CI） |

**P0 与 P1 建议合并实施**：界面开关必然要加 bridge API，而加 bridge API 需要 `contractVersion` 与兼容策略先就位，
否则会复现「旧 preload 没有新方法」那个洞。—— **已按此合并实施。**

### 9.1 P0/P1 实测结果（2026-09-30）

代码落点：

| 文件 | 作用 |
|---|---|
| `src/update-kit/core/classifier.js` | 白名单分类器（纯 node） |
| `src/update-kit/core/policy.js` | 时机策略引擎（纯 node） |
| `src/update-kit/core/contract.js` | 契约自检 / 覆盖率 / bridgeApi 双向一致（纯 node） |
| `src/tools/contract-check.js` | `npm run contract-check` 三项体检 |
| `src/tools/core-selftest.js` | `npm run core-test`，51 条断言（含组合矩阵暴露问题的回归锁定） |
| `src/tools/policy-matrix.js` | `npm run matrix-test`，策略 103680 组合 + 界面 64 组合 + 边界专项 |
| `src/application/renderer/ui-state.js` | 界面决策纯函数（置灰 / 按钮显隐），可被 node 直接测 |

关键实测：

1. **误报已修复** —— 真实 diff `1f4fdd0..547b7d4`（只改 `docs/` 两个 md）：
   旧逻辑 `onlyRendererChanges` 判「需重启」，新分类器判 **`none` / `needsRestart=false`**。
   正是截图里那次实证的误报。
2. **契约版本就位** —— `contractVersion=1.1.0`、`contractMinSupported=1.0.0`；
   bridgeApi 从 5 个增到 6 个（`setUpdatePolicy`），按「只增不改不删」走 minor 升级。
3. **覆盖率 100%** —— 20 个 tracked 文件 + 6 个新增未提交文件，全部登记进 `updateUnits`，无 unknown。
4. **bridgeApi 双向一致** —— 声明 6 个 = 实现 6 个（正则解析 preload.js，不 require electron）。
5. **旧判据已删** —— `updater.onlyRendererChanges` 移除，避免两套判据并存。
6. **组合矩阵全绿** —— 策略 103680 组合 × 10 条不变量、界面 64 组合 × 7 条不变量、16 项边界退化配置，全部通过。
7. **矩阵暴露并修复的三个「不崩但有害」的配置**（单因子测试抓不到，因为每条都不报错）：

   | 坏配置 | 修复前行为 | 修复后 |
   |---|---|---|
   | `intervalMinutes` = 0 / 负数 / NaN | 排期落在过去 → `nextDelayMs` 被 clamp 到 **1 秒** → 每秒一次 git fetch（自我 DoS） | 非法值回落 60 分钟；合法但 <5 分钟抬到 5 分钟下限；契约校验直接报错 |
   | `maxRetries` = 0 | `0 ≥ 0` 成立 → **一次没失败就判定放弃**，自动更新被静默禁用 | 语义修正为「失败一次即放弃」；未失败时正常安排 |
   | `quietHours` 退化（`from===to`）或只写一半 | 免打扰**静默失效**，用户以为设了其实没设 | 契约校验：只写一半报错，起止相同告警 |

   分层原则：**契约校验拦写配置的人**（`contract.js` → `npm run contract-check`），
   **policy 拦运行时**（用户还能经 `setUpdatePolicy` 改），两层都写进回归测试锁死。

未做的（有意为之，不是遗漏）：`deps` 单元的 `npm ci` 默认**不自动执行**
（`constraints.autoNpmCi: false`）——见第 10 节待实测第 3 项，耗时与失败率未测。
分类已就位，实测后再开。

---

## 10. 待实测 / 未决项

| # | 问题 | 现状 |
|---|---|---|
| 1 | `bridgeApi` 变化时能否安全热更 | 未实测（理论上 reload 会重新执行 preload）。当前按保守降为 `restart` |
| 2 | preload 改动能否热更 | 同上，当前归入 `restart` |
| 3 | `npm ci` 在用户端的耗时与失败率 | 未测。`deps` 单元的降级/升级策略依赖它 |
| 4 | 定时检测的远程负载 | 未测。`jitter` 是预防性设计 |
| 5 | 第三方 subtree 引入后 `shellDir` 与 `repoPath` 的相对关系 | 需重新推导（模块在子目录里，`..` 不再是仓库根） |
