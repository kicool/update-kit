// engine.test.js — Git 操作引擎（core/engine.js）集成测试
//
// 用临时仓库 + 本地裸远程跑真 git，覆盖：
//   fetch / compare / aheadBehind / isDirty / diffFiles / getVersion / localRef / pull + 回滚
//
// 这批测试的存在理由：engine 是 kit 拆分后新写的模块，曾出现「返回形状与 host 期望不符」
// 的接线回归（classify 收到 {ok,files} 对象、version 变成 [object Object]）。
// 这里把 engine 的返回形状固化为可断言的契约。
//
// 红线：纯 node，零 electron 依赖；远程是本地裸仓库，不依赖网络。
'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const engine = require('../core/engine');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-repo-'));
  git(tmpDir, ['init']);
  git(tmpDir, ['config', 'user.name', 'Test']);
  git(tmpDir, ['config', 'user.email', 'test@test.com']);
  fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'line1');
  git(tmpDir, ['add', '-A']);
  git(tmpDir, ['commit', '-m', 'init']);
  return tmpDir;
}

function createBareRemote() {
  const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-remote-'));
  git(remoteDir, ['init', '--bare']);
  return remoteDir;
}

// 在远程上推一个新 commit（模拟「远端发布了更新」）
function pushRemoteCommit(remoteDir, fileName, content) {
  const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-clone-'));
  git(remoteDir, ['clone', remoteDir, cloneDir]);
  git(cloneDir, ['config', 'user.name', 'Test']);
  git(cloneDir, ['config', 'user.email', 'test@test.com']);
  fs.writeFileSync(path.join(cloneDir, fileName), content);
  git(cloneDir, ['add', '-A']);
  git(cloneDir, ['commit', '-m', 'remote: ' + fileName]);
  git(cloneDir, ['push', 'origin', 'main']);
  fs.rmSync(cloneDir, { recursive: true });
}

console.log('== engine.test.js ==');

(async () => {
  // === fetch / compare ===
  console.log('\n== fetch / compare ==');

  await test('fetch: 本地裸远程可用 → ok=true', async () => {
    const repo = createTempRepo();
    const remote = createBareRemote();
    git(repo, ['remote', 'add', 'origin', remote]);
    git(repo, ['push', '-u', 'origin', 'main']);

    const r = await engine.fetch('origin', { cwd: repo });
    assert.strictEqual(r.ok, true);

    fs.rmSync(repo, { recursive: true });
    fs.rmSync(remote, { recursive: true });
  });

  await test('fetch: 远程不存在 → ok=false（按离线处理，不抛异常）', async () => {
    const repo = createTempRepo();
    const r = await engine.fetch('no-such-remote', { cwd: repo });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error);
    fs.rmSync(repo, { recursive: true });
  });

  await test('compare: 同步 → behind=false，local/remote 为 commit 串', async () => {
    const repo = createTempRepo();
    const remote = createBareRemote();
    git(repo, ['remote', 'add', 'origin', remote]);
    git(repo, ['push', '-u', 'origin', 'main']);
    await engine.fetch('origin', { cwd: repo });

    const cmp = await engine.compare({ remote: 'origin', branch: 'main', cwd: repo });
    assert.strictEqual(cmp.ok, true);
    assert.strictEqual(cmp.offline, false);
    assert.strictEqual(cmp.behind, false);
    assert.match(cmp.local, /^[0-9a-f]{40}$/);
    assert.strictEqual(cmp.local, cmp.remote);

    fs.rmSync(repo, { recursive: true });
    fs.rmSync(remote, { recursive: true });
  });

  await test('compare: 落后 → behind=true；远程分支不存在 → offline=true', async () => {
    const repo = createTempRepo();
    const remote = createBareRemote();
    git(repo, ['remote', 'add', 'origin', remote]);
    git(repo, ['push', '-u', 'origin', 'main']);
    pushRemoteCommit(remote, 'new.txt', 'new');

    await engine.fetch('origin', { cwd: repo });
    const cmp = await engine.compare({ remote: 'origin', branch: 'main', cwd: repo });
    assert.strictEqual(cmp.behind, true);
    assert.notStrictEqual(cmp.local, cmp.remote);

    const missing = await engine.compare({ remote: 'origin', branch: 'no-such-branch', cwd: repo });
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(missing.offline, true);

    fs.rmSync(repo, { recursive: true });
    fs.rmSync(remote, { recursive: true });
  });

  // === aheadBehind / isDirty / diffFiles ===
  console.log('\n== aheadBehind / isDirty / diffFiles ==');

  await test('aheadBehind: 返回 {ok, ahead, behind} 数字', async () => {
    const repo = createTempRepo();
    const remote = createBareRemote();
    git(repo, ['remote', 'add', 'origin', remote]);
    git(repo, ['push', '-u', 'origin', 'main']);

    const sync = await engine.aheadBehind({ remote: 'origin', branch: 'main', cwd: repo });
    assert.deepStrictEqual([sync.ok, sync.ahead, sync.behind], [true, 0, 0]);

    pushRemoteCommit(remote, 'r.txt', 'r');
    await engine.fetch('origin', { cwd: repo });
    const behind = await engine.aheadBehind({ remote: 'origin', branch: 'main', cwd: repo });
    assert.deepStrictEqual([behind.ok, behind.ahead, behind.behind], [true, 0, 1]);

    fs.rmSync(repo, { recursive: true });
    fs.rmSync(remote, { recursive: true });
  });

  await test('isDirty: untracked 文件不算脏（reset --hard 动不到它）', async () => {
    const repo = createTempRepo();

    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'user data');
    let d = await engine.isDirty({ cwd: repo });
    assert.strictEqual(d.dirty, false, 'untracked 不应判脏');

    fs.writeFileSync(path.join(repo, 'file.txt'), 'modified');
    d = await engine.isDirty({ cwd: repo });
    assert.strictEqual(d.dirty, true);
    assert.strictEqual(d.count, 1);
    assert.deepStrictEqual(d.files, ['file.txt']);

    fs.rmSync(repo, { recursive: true });
  });

  await test('diffFiles: 返回 {ok, files} 字符串数组（给 classify 的直接可用形状）', async () => {
    const repo = createTempRepo();
    const remote = createBareRemote();
    git(repo, ['remote', 'add', 'origin', remote]);
    git(repo, ['push', '-u', 'origin', 'main']);
    const base = git(repo, ['rev-parse', 'main']);
    pushRemoteCommit(remote, 'app.js', 'code');

    await engine.fetch('origin', { cwd: repo });
    const head = git(repo, ['rev-parse', 'origin/main']);
    const df = await engine.diffFiles(base, head, { cwd: repo });
    assert.strictEqual(df.ok, true);
    assert.deepStrictEqual(df.files, ['app.js']);

    fs.rmSync(repo, { recursive: true });
    fs.rmSync(remote, { recursive: true });
  });

  // === getVersion / localRef / pull + 回滚 ===
  console.log('\n== getVersion / localRef / pull ==');

  await test('getVersion: 返回字符串 version（可直接给界面显示）', async () => {
    const repo = createTempRepo();
    const v = await engine.getVersion({ cwd: repo });
    assert.strictEqual(v.ok, true);
    assert.strictEqual(typeof v.version, 'string');
    assert.match(v.version, /^[0-9a-f]{7,}$/); // describe --always → 短 hash

    fs.rmSync(repo, { recursive: true });
  });

  await test('localRef: {ok, ref}，ref 可直接喂给 reset --hard', async () => {
    const repo = createTempRepo();
    const r = await engine.localRef('main', { cwd: repo });
    assert.strictEqual(r.ok, true);
    assert.match(r.ref, /^[0-9a-f]{40}$/);

    const missing = await engine.localRef('nope', { cwd: repo });
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(missing.ref, null);

    fs.rmSync(repo, { recursive: true });
  });

  await test('pull: fetch + reset --hard → 与远程一致', async () => {
    const repo = createTempRepo();
    const remote = createBareRemote();
    git(repo, ['remote', 'add', 'origin', remote]);
    git(repo, ['push', '-u', 'origin', 'main']);

    pushRemoteCommit(remote, 'v2.txt', 'v2');
    const p = await engine.pull({ remote: 'origin', branch: 'main', cwd: repo });
    assert.strictEqual(p.ok, true);
    assert.strictEqual(git(repo, ['rev-parse', 'main']), git(repo, ['rev-parse', 'origin/main']));
    assert.strictEqual(fs.readFileSync(path.join(repo, 'v2.txt'), 'utf8'), 'v2');

    fs.rmSync(repo, { recursive: true });
    fs.rmSync(remote, { recursive: true });
  });

  await test('pull 失败 + runGit(reset --hard prev.ref) 回滚 → 工作区恢复原样', async () => {
    const repo = createTempRepo();
    const remote = createBareRemote();
    git(repo, ['remote', 'add', 'origin', remote]);
    git(repo, ['push', '-u', 'origin', 'main']);
    const prev = await engine.localRef('main', { cwd: repo });
    assert.strictEqual(prev.ok, true);

    fs.rmSync(remote, { recursive: true }); // 远程消失 → pull 必失败
    const p = await engine.pull({ remote: 'origin', branch: 'main', cwd: repo });
    assert.strictEqual(p.ok, false);

    const rb = await engine.runGit(['reset', '--hard', prev.ref], { cwd: repo });
    assert.strictEqual(rb.ok, true);
    assert.strictEqual(git(repo, ['rev-parse', 'main']), prev.ref);

    fs.rmSync(repo, { recursive: true });
  });

  // === 超时 ===
  console.log('\n== 超时 ==');

  await test('runGit: 网络挂起时按 timeoutMs  settle（ok=false），绝不无限等待', async () => {
    const repo = createTempRepo();
    // 10.255.255.1 是不可路由地址：TCP connect 会挂起到天荒地老
    git(repo, ['remote', 'add', 'hole', 'https://10.255.255.1/x.git']);

    const t0 = Date.now();
    // 直接调 runGit 并给 3s 硬超时（fetch 自身默认 30s 太长，不适合测试）
    const r = await engine.runGit(['-c', 'http.connectTimeout=600', 'fetch', 'hole'], { cwd: repo, timeoutMs: 3000 });
    const elapsed = Date.now() - t0;
    assert.strictEqual(r.ok, false);
    assert.ok(elapsed < 10000, `应在 10s 内 settle，实际 ${elapsed}ms`);
    console.log(`    （${elapsed}ms 后按超时返回）`);

    fs.rmSync(repo, { recursive: true });
  });

  // === 总结 ===
  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
})();
