// core.test.js — 纯 core 断言
//
// 测试 core/ 模块的功能：classifier、policy、contract、contract-loader
//
// 红线：纯 node，零 electron 依赖，可进 CI。
'use strict';
const assert = require('node:assert');
const path = require('node:path');

const classifier = require('../core/classifier');
const policy = require('../core/policy');
const contract = require('../core/contract');

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

console.log('== core.test.js ==');

// === classifier ===
console.log('\n== classifier ==');

test('classify: 空变更集 → none', () => {
  const result = classifier.classify([], { units: [] });
  assert.strictEqual(result.klass, 'none');
});

test('classify: renderer 变更 → hot', () => {
  const units = [{ name: 'renderer', class: 'hot', paths: ['src/renderer/'] }];
  const result = classifier.classify(['src/renderer/index.html'], { units });
  assert.strictEqual(result.klass, 'hot');
});

test('classify: shell 变更 → restart', () => {
  const units = [{ name: 'shell', class: 'restart', paths: ['src/main.js'] }];
  const result = classifier.classify(['src/main.js'], { units });
  assert.strictEqual(result.klass, 'restart');
});

test('classify: 未登记文件 → restart + 告警', () => {
  const result = classifier.classify(['unknown.js'], { units: [] });
  assert.strictEqual(result.klass, 'restart');
  assert.strictEqual(result.unknown.length, 1);
});

test('classify: 多单元取最高级别', () => {
  const units = [
    { name: 'renderer', class: 'hot', paths: ['src/renderer/'] },
    { name: 'shell', class: 'restart', paths: ['src/main.js'] },
  ];
  const result = classifier.classify(['src/renderer/index.html', 'src/main.js'], { units });
  assert.strictEqual(result.klass, 'restart');
});

test('compareContract: 主版本不同 → incompatible', () => {
  assert.strictEqual(classifier.compareContract('1.0.0', '2.0.0', '1.0.0'), 'incompatible');
});

test('compareContract: 次版本不同 → restart', () => {
  assert.strictEqual(classifier.compareContract('1.0.0', '1.1.0', '1.0.0'), 'restart');
});

test('compareContract: 相同版本 → compatible', () => {
  assert.strictEqual(classifier.compareContract('1.0.0', '1.0.0', '1.0.0'), 'compatible');
});

// === policy ===
console.log('\n== policy ==');

test('shouldCheck: enabled=false → 不检测', () => {
  const result = policy.shouldCheck({ enabled: false }, Date.now(), {});
  assert.strictEqual(result.check, false);
});

test('shouldCheck: schedule.mode=off → 不检测', () => {
  const result = policy.shouldCheck({ enabled: true, schedule: { mode: 'off' } }, Date.now(), {});
  assert.strictEqual(result.check, false);
});

test('shouldCheck: 已到检测时间 → 检测', () => {
  const now = Date.now();
  const result = policy.shouldCheck({
    enabled: true,
    schedule: { mode: 'interval', intervalMinutes: 60 },
  }, now, { lastCheckAt: now - 61 * 60 * 1000 });
  assert.strictEqual(result.check, true);
});

test('shouldCheck: 未到检测时间 → 不检测', () => {
  const now = Date.now();
  const result = policy.shouldCheck({
    enabled: true,
    schedule: { mode: 'interval', intervalMinutes: 60 },
  }, now, { lastCheckAt: now });
  assert.strictEqual(result.check, false);
});

test('shouldApply: apply=notify → false', () => {
  assert.strictEqual(policy.shouldApply({ apply: 'notify' }, {}), false);
});

test('shouldApply: apply=auto → true', () => {
  assert.strictEqual(policy.shouldApply({ enabled: true, apply: 'auto' }, {}), true);
});

test('shouldApply: dirty → false', () => {
  assert.strictEqual(policy.shouldApply({ apply: 'auto' }, { dirty: true }), false);
});

// === contract ===
console.log('\n== contract ==');

test('validateUnits: 合法单元 → 无错误', () => {
  const errors = classifier.validateUnits([
    { name: 'renderer', class: 'hot', paths: ['src/renderer/'] },
  ]);
  assert.strictEqual(errors.length, 0);
});

test('validateUnits: 路径冲突 → 报错', () => {
  const errors = classifier.validateUnits([
    { name: 'a', class: 'hot', paths: ['src/'] },
    { name: 'b', class: 'restart', paths: ['src/'] },
  ]);
  assert.strictEqual(errors.length, 1);
});

test('validateUnits: 非法 class → 报错', () => {
  const errors = classifier.validateUnits([
    { name: 'a', class: 'invalid', paths: ['src/'] },
  ]);
  assert.strictEqual(errors.length, 1);
});

// === 总结 ===
console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
