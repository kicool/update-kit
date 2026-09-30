// run-all.js — 编排所有 kit 测试
//
// 串行执行：
//   1. core.test.js
//   2. host.test.js
//   3. git-integration.test.js
//
// 用法：
//   node src/update-kit/test/run-all.js
//
// 红线：纯 node，零 electron 依赖。
'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const tests = [
  'core.test.js',
  'host.test.js',
  'git-integration.test.js',
];

let failed = 0;

console.log('== run-all.js ==\n');

for (const test of tests) {
  const testPath = path.join(__dirname, test);
  console.log(`\n--- ${test} ---`);
  try {
    execFileSync('node', [testPath], { stdio: 'inherit' });
  } catch (e) {
    failed++;
    console.log(`\n✗ ${test} 失败`);
  }
}

console.log(`\n== 总结 ==`);
if (failed > 0) {
  console.log(`✗ ${failed} 个测试失败`);
  process.exit(1);
} else {
  console.log('✓ 全部通过');
}
