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
