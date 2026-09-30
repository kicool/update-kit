// inject-preload.js — 自动注入 preload.js 的 handler 引用
//
// 逻辑：
//   1. 读取项目的 preload.js
//   2. 如果文件不存在 → 生成一个（引用 ./preload-handlers）
//   3. 如果文件存在但没引用 handlers → 注入一行 require
//   4. 如果文件已引用 handlers → 跳过
//
// 用法：
//   node src/update-kit/tools/inject-preload.js
//
// 红线：纯 node，零 electron 依赖。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '../../..');
const preloadPath = path.join(projectRoot, 'src/application/preload.js');
const handlersPath = path.join(projectRoot, 'src/application/preload-handlers.js');

const REFERENCE_LINE = "const handlers = require('./preload-handlers');";

function injectPreload() {
  // 情况 1：preload.js 不存在 → 生成
  if (!fs.existsSync(preloadPath)) {
    const content = `// preload.js — 桥接层
// 本文件由 inject-preload.js 生成，可手动补充业务逻辑
'use strict';
const { contextBridge } = require('electron');

// === 生成的 handlers 引用 ===
const handlers = require('./preload-handlers');

// === 手写业务逻辑 ===
// 在这里补充其他 window 对象，如：
// contextBridge.exposeInMainWorld('utils', {
//   formatDate: (d) => d.toLocaleDateString(),
// });

const api = {};
for (const k of Object.keys(handlers)) api[k] = handlers[k];
contextBridge.exposeInMainWorld('api', api);
`;
    fs.mkdirSync(path.dirname(preloadPath), { recursive: true });
    fs.writeFileSync(preloadPath, content);
    console.log(`✓ 已生成 preload.js: ${path.relative(projectRoot, preloadPath)}`);
    return;
  }

  // 读取现有 preload.js
  const content = fs.readFileSync(preloadPath, 'utf8');

  // 情况 3：已引用 handlers → 跳过
  if (content.includes(REFERENCE_LINE)) {
    console.log(`✓ preload.js 已引用 handlers，跳过`);
    return;
  }

  // 情况 2：存在但没引用 handlers → 注入
  const lines = content.split('\n');

  // 找到 'use strict'; 或第一个 require 之后的位置
  let insertIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("'use strict';") || line.includes('"use strict";')) {
      insertIndex = i + 1;
      break;
    }
    if (line.startsWith('const {') || line.startsWith('const ')) {
      insertIndex = i + 1;
    }
  }

  // 插入引用行
  lines.splice(insertIndex, 0, '', REFERENCE_LINE);

  fs.writeFileSync(preloadPath, lines.join('\n'));
  console.log(`✓ 已注入 handlers 引用: ${path.relative(projectRoot, preloadPath)}`);
}

injectPreload();
