// host.test.js — mock electron 测试 host 编排
//
// 测试 host/ 模块的功能：state-store、local-config、scheduler、ipc-bridge
//
// 红线：纯 node，零 electron 依赖（通过 mock electron）。
'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createStateStore } = require('../host/state-store');
const { createLocalConfig } = require('../host/local-config');
const { createScheduler } = require('../host/scheduler');
const { registerIpcBridge } = require('../host/ipc-bridge');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
    failed++;
  }
}

console.log('== host.test.js ==');

// === state-store ===
console.log('\n== state-store ==');

test('state-store: 保存和读取', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-store-'));
  const store = createStateStore(tmpDir);
  store.save({ lastCheckAt: 123, failures: 0 });
  const state = store.load();
  assert.strictEqual(state.lastCheckAt, 123);
  fs.rmSync(tmpDir, { recursive: true });
});

test('state-store: patch', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-store-'));
  const store = createStateStore(tmpDir);
  store.save({ lastCheckAt: 123, failures: 0 });
  store.patch('failures', 1);
  const state = store.load();
  assert.strictEqual(state.failures, 1);
  fs.rmSync(tmpDir, { recursive: true });
});

// === local-config ===
console.log('\n== local-config ==');

test('local-config: 读取不存在的文件 → 空对象', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-config-'));
  const config = createLocalConfig(tmpDir);
  const result = config.read();
  assert.deepStrictEqual(result, {});
  fs.rmSync(tmpDir, { recursive: true });
});

test('local-config: mergePolicy', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-config-'));
  const config = createLocalConfig(tmpDir);
  config.write({ updatePolicy: { enabled: true } });
  const merged = config.mergePolicy({ apply: 'notify' });
  assert.strictEqual(merged.enabled, true);
  assert.strictEqual(merged.apply, 'notify');
  fs.rmSync(tmpDir, { recursive: true });
});

// === scheduler ===
console.log('\n== scheduler ==');

test('scheduler: start 和 stop', (done) => {
  let ran = false;
  const scheduler = createScheduler({
    policy: { nextDelayMs: () => 100 },
    state: {},
    run: () => { ran = true; },
    onChange: () => {},
  });
  scheduler.start();
  setTimeout(() => {
    assert.strictEqual(ran, true);
    scheduler.stop();
  }, 150);
});

// === ipc-bridge ===
console.log('\n== ipc-bridge ==');

test('ipc-bridge: 缺少实现 → throw', () => {
  const bridgeApi = [{ name: 'checkUpdate', type: 'invoke', channel: 'test:check' }];
  assert.throws(() => {
    registerIpcBridge({}, bridgeApi, {});
  }, /缺少实现/);
});

test('ipc-bridge: 多余实现 → throw', () => {
  const handlers = {};
  const ipcMain = {
    handle: (channel, fn) => { handlers[channel] = fn; },
    on: (channel, fn) => { handlers[channel] = fn; },
  };
  const bridgeApi = [{ name: 'checkUpdate', type: 'invoke', channel: 'test:check' }];
  assert.throws(() => {
    registerIpcBridge(ipcMain, bridgeApi, { checkUpdate: () => {}, extra: () => {} });
  }, /多余实现/);
});

test('ipc-bridge: 正常注册 → 无错误', () => {
  const handlers = {};
  const ipcMain = {
    handle: (channel, fn) => { handlers[channel] = fn; },
    on: (channel, fn) => { handlers[channel] = fn; },
  };
  const bridgeApi = [
    { name: 'checkUpdate', type: 'invoke', channel: 'test:check' },
    { name: 'onStatus', type: 'on', channel: 'test:status' },
  ];
  const impl = {
    checkUpdate: () => {},
    onStatus: () => {},
  };
  registerIpcBridge(ipcMain, bridgeApi, impl);
  // on 类型不需要主进程注册，所以只有 1 个 handler
  assert.strictEqual(Object.keys(handlers).length, 1);
});

// === 总结 ===
console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
