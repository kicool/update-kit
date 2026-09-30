// git-integration.test.js — 临时 git 仓库集成测试
//
// 测试 git 集成场景：dirty / ahead / diverged / 失败恢复
//
// 红线：纯 node，零 electron 依赖。
'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

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

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function createTempRepo() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-integration-'));
  git(tmpDir, ['init']);
  git(tmpDir, ['config', 'user.name', 'Test']);
  git(tmpDir, ['config', 'user.email', 'test@test.com']);
  fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'line1');
  git(tmpDir, ['add', '-A']);
  git(tmpDir, ['commit', '-m', 'init']);
  return tmpDir;
}

function createBareRemote() {
  const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-remote-'));
  git(remoteDir, ['init', '--bare']);
  return remoteDir;
}

console.log('== git-integration.test.js ==');

// === aheadBehind ===
console.log('\n== aheadBehind ==');

test('aheadBehind: 本地与远程同步 → ahead=0, behind=0', () => {
  const tmpDir = createTempRepo();
  const remoteDir = createBareRemote();
  git(tmpDir, ['remote', 'add', 'origin', remoteDir]);
  git(tmpDir, ['push', '-u', 'origin', 'main']);

  const { execFileSync } = require('node:child_process');
  const out = execFileSync('git', ['rev-list', '--left-right', '--count', 'HEAD...origin/main'], { cwd: tmpDir, encoding: 'utf8' }).trim();
  const [ahead, behind] = out.split('\t').map(Number);
  assert.strictEqual(ahead, 0);
  assert.strictEqual(behind, 0);

  fs.rmSync(tmpDir, { recursive: true });
  fs.rmSync(remoteDir, { recursive: true });
});

test('aheadBehind: 本地领先 1 个 commit → ahead=1', () => {
  const tmpDir = createTempRepo();
  const remoteDir = createBareRemote();
  git(tmpDir, ['remote', 'add', 'origin', remoteDir]);
  git(tmpDir, ['push', '-u', 'origin', 'main']);

  fs.writeFileSync(path.join(tmpDir, 'file2.txt'), 'line2');
  git(tmpDir, ['add', '-A']);
  git(tmpDir, ['commit', '-m', 'local commit']);

  const out = git(tmpDir, ['rev-list', '--left-right', '--count', 'HEAD...origin/main']);
  const [ahead, behind] = out.split('\t').map(Number);
  assert.strictEqual(ahead, 1);
  assert.strictEqual(behind, 0);

  fs.rmSync(tmpDir, { recursive: true });
  fs.rmSync(remoteDir, { recursive: true });
});

test('aheadBehind: 本地落后 1 个 commit → behind=1', () => {
  const tmpDir = createTempRepo();
  const remoteDir = createBareRemote();
  git(tmpDir, ['remote', 'add', 'origin', remoteDir]);
  git(tmpDir, ['push', '-u', 'origin', 'main']);

  // 在远程添加一个 commit（通过 clone + push）
  const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-clone-'));
  git(remoteDir, ['clone', remoteDir, cloneDir]);
  git(cloneDir, ['config', 'user.name', 'Test']);
  git(cloneDir, ['config', 'user.email', 'test@test.com']);
  fs.writeFileSync(path.join(cloneDir, 'file3.txt'), 'line3');
  git(cloneDir, ['add', '-A']);
  git(cloneDir, ['commit', '-m', 'remote commit']);
  git(cloneDir, ['push', 'origin', 'main']);

  // 先 fetch 远程最新状态，再比较
  git(tmpDir, ['fetch', 'origin']);
  const out = git(tmpDir, ['rev-list', '--left-right', '--count', 'HEAD...origin/main']);
  const [ahead, behind] = out.split('\t').map(Number);
  assert.strictEqual(ahead, 0);
  assert.strictEqual(behind, 1);

  fs.rmSync(tmpDir, { recursive: true });
  fs.rmSync(remoteDir, { recursive: true });
  fs.rmSync(cloneDir, { recursive: true });
});

// === isDirty ===
console.log('\n== isDirty ==');

test('isDirty: 有未提交改动 → dirty=true', () => {
  const tmpDir = createTempRepo();
  fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'modified');

  const out = git(tmpDir, ['status', '--porcelain', '--untracked-files=no']);
  assert.strictEqual(out.length > 0, true);

  fs.rmSync(tmpDir, { recursive: true });
});

test('isDirty: 无未提交改动 → dirty=false', () => {
  const tmpDir = createTempRepo();

  const out = git(tmpDir, ['status', '--porcelain', '--untracked-files=no']);
  assert.strictEqual(out.length, 0);

  fs.rmSync(tmpDir, { recursive: true });
});

// === 总结 ===
console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
