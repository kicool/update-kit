// engine.js — Git 操作引擎
//
// 职责：
//   1. 封装 git 命令（fetch、compare、pull 等）
//   2. 提供纯 node 接口，零 electron 依赖
//
// 约定：所有函数【绝不抛异常】，统一返回 { ok, ... } 结果对象。
//   - 调用方（host/main-host.js）按结果对象分支，不用 try/catch 当控制流。
//   - 每条返回值注明是否可能 offline（网络类操作）。
//
// 红线：纯 node，零 electron 依赖。
'use strict';
const { spawn } = require('node:child_process');

const MAX_OUTPUT = 1024 * 1024 * 16;

/**
 * 执行 git 命令（底层原语，其余函数都经这里出去）
 * @param {Array} args — git 参数
 * @param {object} opts — 选项
 * @param {string} opts.cwd — 工作目录
 * @param {number} opts.timeoutMs — 硬超时（网络不通时 connect 可能挂 75s+，必须截断）
 * @returns {Promise<{ok:boolean, stdout:string, error?:string}>}
 */
function runGit(args, { cwd, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    // detached：让 git 自成一个进程组。https fetch 时 git 会派生 git-remote-https 子进程，
    // 超时时必须按组杀掉（kill(-pid)），否则子进程占着管道，close 事件永远不来 ——
    // execFile 的 timeout 只杀直接子进程，实测会无限挂起（界面卡在「初始化…」的根源之一）。
    const child = spawn('git', args, { cwd, detached: process.platform !== 'win32' });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 组已退出 */ }
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      finish({ ok: false, stdout: '', error: `git ${args[0]} 超时（${timeoutMs}ms）` });
    }, timeoutMs);

    child.stdout.on('data', (d) => { if (stdout.length < MAX_OUTPUT) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_OUTPUT) stderr += d; });
    child.on('error', (e) => finish({ ok: false, stdout: '', error: String(e.message) }));
    child.on('close', (code) => {
      // 只剥行尾换行，不能 trim 行首 —— porcelain 的行首空格是状态位的一部分，
      // trim 后 isDirty 的 slice(3) 会错位切掉路径第一个字符（实测踩过）。
      finish({
        ok: code === 0,
        stdout: stdout.replace(/[\r\n]+$/, ''),
        error: code === 0 ? undefined : String(stderr || `exit code ${code}`).trim(),
      });
    });
  });
}

/**
 * 从远程拉取最新信息（--prune 清掉远程已删分支的残留引用）。
 * 网络类操作：connect 超时 15s + 整体硬超时 30s，失败一律按离线处理。
 * @param {string} remote — 远程名称
 * @param {object} opts — 选项
 * @param {string} opts.cwd — 工作目录
 * @returns {Promise<{ok:boolean, error?:string}>} ok=false 视为离线/无法连接远程
 */
async function fetch(remote, { cwd } = {}) {
  return runGit(['-c', 'http.connectTimeout=15', 'fetch', remote, '--prune'], { cwd, timeoutMs: 30000 });
}

/**
 * 比较本地和远程是否落后
 * @param {object} opts — 选项
 * @param {string} opts.remote — 远程名称
 * @param {string} opts.branch — 分支名称
 * @param {string} opts.cwd — 工作目录
 * @returns {Promise<{ok:boolean, behind:boolean, offline:boolean, local:string|null, remote:string|null, error?:string}>}
 */
async function compare({ remote, branch, cwd } = {}) {
  const remoteResult = await runGit(['rev-parse', `${remote}/${branch}`], { cwd });
  if (!remoteResult.ok) {
    return { ok: false, behind: false, offline: true, local: null, remote: null, error: remoteResult.error };
  }
  const localResult = await runGit(['rev-parse', branch], { cwd });
  const local = localResult.ok ? localResult.stdout : null;
  return {
    ok: true,
    behind: local !== remoteResult.stdout,
    offline: false,
    local,
    remote: remoteResult.stdout,
  };
}

/**
 * 获取 ahead/behind 数量
 * @param {object} opts — 选项
 * @param {string} opts.remote — 远程名称
 * @param {string} opts.branch — 分支名称
 * @param {string} opts.cwd — 工作目录
 * @returns {Promise<{ok:boolean, ahead:number, behind:number, error?:string}>}
 */
async function aheadBehind({ remote, branch, cwd } = {}) {
  const result = await runGit(['rev-list', '--left-right', '--count', `${branch}...${remote}/${branch}`], { cwd });
  if (!result.ok) {
    return { ok: false, ahead: 0, behind: 0, error: result.error };
  }
  const [ahead, behind] = result.stdout.split('\t').map(Number);
  return { ok: true, ahead, behind };
}

/**
 * 检查是否有未提交的修改。
 * 只看 tracked（--untracked-files=no）：untracked 不会被 reset --hard 删除，
 * 拦它属于过度保护（用户数据文件放仓库里不该让更新失败）。
 * @param {object} opts — 选项
 * @param {string} opts.cwd — 工作目录
 * @returns {Promise<{ok:boolean, dirty:boolean, count:number, files:string[], error?:string}>}
 */
async function isDirty({ cwd } = {}) {
  const result = await runGit(['status', '--porcelain', '--untracked-files=no'], { cwd });
  if (!result.ok) {
    return { ok: false, dirty: false, count: 0, files: [], error: result.error };
  }
  // 注意：不能先 trim 再 slice(3) —— trim 会把行首的「状态空格」吃掉，slice 错位切掉路径第一个字符。
  // porcelain 格式为 XY<空格>PATH，前 3 个字符固定是状态位。
  const lines = result.stdout.split('\n').filter((line) => line.trim());
  return {
    ok: true,
    dirty: lines.length > 0,
    count: lines.length,
    files: lines.map((line) => line.slice(3)).slice(0, 8),
  };
}

/**
 * 获取差异文件列表（两点 diff：local..remote，列出落后期间变更的文件）
 * @param {string} local — 本地 commit
 * @param {string} remote — 远程 commit
 * @param {object} opts — 选项
 * @param {string} opts.cwd — 工作目录
 * @returns {Promise<{ok:boolean, files:string[], error?:string}>}
 */
async function diffFiles(local, remote, { cwd } = {}) {
  if (!local || !remote) return { ok: true, files: [] };
  const result = await runGit(['diff', '--name-only', `${local}..${remote}`], { cwd });
  if (!result.ok) {
    return { ok: false, files: [], error: result.error };
  }
  return { ok: true, files: result.stdout.split('\n').map((s) => s.trim()).filter(Boolean) };
}

/**
 * 获取当前版本（git describe，人类可读的版本标记）
 * @param {object} opts — 选项
 * @param {string} opts.cwd — 工作目录
 * @returns {Promise<{ok:boolean, version:string}>} 失败时 version='unknown'
 */
async function getVersion({ cwd } = {}) {
  const result = await runGit(['describe', '--tags', '--always'], { cwd });
  return { ok: result.ok, version: result.ok ? result.stdout : 'unknown' };
}

/**
 * 获取本地分支的 ref
 * @param {string} branch — 分支名称
 * @param {object} opts — 选项
 * @param {string} opts.cwd — 工作目录
 * @returns {Promise<{ok:boolean, ref:string|null, error?:string}>}
 */
async function localRef(branch, { cwd } = {}) {
  const result = await runGit(['rev-parse', branch], { cwd });
  return { ok: result.ok, ref: result.ok ? result.stdout : null, error: result.error };
}

/**
 * 同步到远程分支：fetch 后 reset --hard，保证干净，避免本地改动冲突。
 * 「1 份化」后的硬保护：reset --hard 会抹掉未提交的改动、丢弃未推送的 commit ——
 * 所以调用方必须先过 isDirty / aheadBehind 两关（见 host/main-host.js）。
 * @param {object} opts — 选项
 * @param {string} opts.remote — 远程名称
 * @param {string} opts.branch — 分支名称
 * @param {string} opts.cwd — 工作目录
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function pull({ remote, branch, cwd } = {}) {
  const f = await fetch(remote, { cwd });
  if (!f.ok) return f;
  return runGit(['reset', '--hard', `${remote}/${branch}`], { cwd });
}

module.exports = {
  runGit,
  fetch,
  compare,
  aheadBehind,
  isDirty,
  diffFiles,
  getVersion,
  localRef,
  pull,
};
