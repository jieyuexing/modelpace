import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  T3RpcError,
  connectT3,
  splitCommandArgs,
  unwrapRpcExit,
  validateT3ServerConfig,
} from './t3-rpc.mjs';
import { DEFAULT_PACING_CONFIG, evaluateFreshness } from '../core/pacing.mjs';

const execFileAsync = promisify(execFile);

export const T3_BUNDLE_ID = 'com.t3tools.t3code';
const SESSION_TTL = '2m';
const SESSION_LABEL = 'modelpace';
// server.getConfig 与 server.refreshProviders 只需要这一项权限；不传 --scope 时 T3 会签发包含终端与文件写入的标准客户端全套权限。
const SESSION_SCOPE = 'orchestration:read';
const SERVER_ENTRY = 'Contents/Resources/app.asar/apps/server/dist/bin.mjs';
const DEFAULT_REFRESH_TIMEOUT_MS = 40_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

const isExecutable = (file) => {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

function findOnPath(name, env) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function bundleId(appDir) {
  try {
    const plist = fs.readFileSync(path.join(appDir, 'Contents', 'Info.plist'), 'utf8');
    return /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null;
  } catch {
    return null;
  }
}

function findMacApp(appDirs) {
  for (const dir of appDirs) {
    let names;
    try {
      names = fs.readdirSync(dir).filter((name) => name.endsWith('.app'));
    } catch {
      continue;
    }
    for (const name of names) {
      const appDir = path.join(dir, name);
      if (bundleId(appDir) !== T3_BUNDLE_ID) continue;
      const exeDir = path.join(appDir, 'Contents', 'MacOS');
      const exe = fs.readdirSync(exeDir).map((entry) => path.join(exeDir, entry)).find(isExecutable);
      const entry = path.join(appDir, SERVER_ENTRY);
      if (exe) return { file: exe, args: [entry], env: { ELECTRON_RUN_AS_NODE: '1' }, source: 'app-bundle' };
    }
  }
  return null;
}

/** 发现本机 T3 Code CLI：MODELPACE_T3_BIN > PATH 上的 t3 > macOS 应用包（bundle id 匹配）。 */
export function discoverT3Cli({ env = process.env, homeDir = os.homedir(), platform = process.platform, appDirs } = {}) {
  if (env.MODELPACE_T3_BIN?.trim()) {
    const [file, ...args] = splitCommandArgs(env.MODELPACE_T3_BIN);
    return { file, args, env: {}, source: 'env' };
  }
  const onPath = findOnPath('t3', env);
  if (onPath) return { file: onPath, args: [], env: {}, source: 'path' };
  if (platform === 'darwin') {
    const found = findMacApp(appDirs ?? ['/Applications', path.join(homeDir, 'Applications')]);
    if (found) return found;
  }
  throw new T3RpcError('Local T3 Code CLI not found (set MODELPACE_T3_BIN, or put t3 on PATH)', {
    code: 'T3_CLI_NOT_FOUND',
  });
}

const processAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

/** 本机服务 origin 取自运行态记录（只含 pid/端口/origin，不含任何凭据）。 */
export function discoverT3Origin({ baseDir, origin } = {}) {
  if (origin) return origin;
  const file = path.join(baseDir, 'userdata', 'server-runtime.json');
  let state;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new T3RpcError('No running local T3 Code server found (start T3 Code, or pass an origin)', {
      code: 'T3_SERVER_NOT_FOUND',
    });
  }
  if (typeof state?.origin !== 'string' || (Number.isInteger(state.pid) && !processAlive(state.pid))) {
    throw new T3RpcError('The recorded local T3 Code server is not running', { code: 'T3_SERVER_NOT_RUNNING' });
  }
  return state.origin;
}

function policyInstanceIds(policy) {
  if (!policy || typeof policy !== 'object') return null;
  const ids = new Set();
  for (const id of Object.keys(policy.instances ?? {})) {
    ids.add(id);
  }
  for (const slot of Object.values(policy.slots ?? {})) {
    for (const candidate of slot?.candidates ?? []) {
      if (candidate?.enabled !== false && candidate?.instanceId) {
        ids.add(candidate.instanceId);
      }
    }
  }
  return ids.size > 0 ? ids : null;
}

function isQuotaRefreshCandidate(provider, policy, knownIds) {
  const id = typeof provider?.instanceId === 'string' ? provider.instanceId.trim() : '';
  if (!id) return false;
  if (provider.enabled === false || provider.installed === false) return false;
  if (provider.auth?.status === 'unauthenticated') return false;
  if (provider.usageLimits?.unavailable?.reason === 'unsupported') return false;
  if (policy?.instances?.[id]?.enabled === false) return false;
  if (knownIds !== null && !knownIds.has(id)) return false;
  return true;
}

function isQuotaMissingOrStale(usageLimits, nowMs, maxSnapshotAgeMinutes) {
  const { freshness } = evaluateFreshness(usageLimits?.checkedAt, nowMs, maxSnapshotAgeMinutes);
  return freshness === 'unknown' || freshness === 'stale';
}

function findStaleRefreshPlan(config, policy, nowMs) {
  const maxAge = policy?.pacing?.maxSnapshotAgeMinutes ?? DEFAULT_PACING_CONFIG.maxSnapshotAgeMinutes;
  const knownIds = policyInstanceIds(policy);
  const staleProviderIds = [];
  for (const provider of config.providers ?? []) {
    if (!isQuotaRefreshCandidate(provider, policy, knownIds)) continue;
    if (isQuotaMissingOrStale(provider.usageLimits, nowMs, maxAge)) {
      staleProviderIds.push(provider.instanceId.trim());
    }
  }
  const staleSourceAccountKeys = [];
  for (const source of Array.isArray(config.usageLimitSources) ? config.usageLimitSources : []) {
    if (!source || typeof source.id !== 'string') continue;
    for (const account of Array.isArray(source.accounts) ? source.accounts : []) {
      if (!account || typeof account.id !== 'string') continue;
      const key = `${source.id}:${account.id}`;
      if (policy?.instances?.[key]?.enabled === false) continue;
      if (knownIds !== null && !knownIds.has(key)) continue;
      if (account.usageLimits?.unavailable?.reason === 'unsupported') continue;
      if (isQuotaMissingOrStale(account.usageLimits, nowMs, maxAge)) {
        staleSourceAccountKeys.push(key);
      }
    }
  }
  return {
    staleProviderIds,
    staleSourceAccountKeys,
    needsGlobalRefresh: staleSourceAccountKeys.length > 0,
  };
}

function areTargetsFresh(config, plan, policy, nowMs) {
  const maxAge = policy?.pacing?.maxSnapshotAgeMinutes ?? DEFAULT_PACING_CONFIG.maxSnapshotAgeMinutes;
  const knownIds = policyInstanceIds(policy);
  const byId = new Map(
    (config.providers ?? [])
      .filter((p) => typeof p?.instanceId === 'string' && p.instanceId.trim())
      .map((p) => [p.instanceId.trim(), p]),
  );
  for (const id of plan.staleProviderIds) {
    const provider = byId.get(id);
    if (!provider || !isQuotaRefreshCandidate(provider, policy, knownIds)) continue;
    if (isQuotaMissingOrStale(provider.usageLimits, nowMs, maxAge)) return false;
  }
  if (plan.staleSourceAccountKeys.length > 0) {
    const byKey = new Map();
    for (const source of Array.isArray(config.usageLimitSources) ? config.usageLimitSources : []) {
      for (const account of Array.isArray(source?.accounts) ? source.accounts : []) {
        if (source?.id && account?.id) byKey.set(`${source.id}:${account.id}`, account);
      }
    }
    for (const key of plan.staleSourceAccountKeys) {
      const account = byKey.get(key);
      if (!account || policy?.instances?.[key]?.enabled === false) continue;
      if (account.usageLimits?.unavailable?.reason === 'unsupported') continue;
      if (isQuotaMissingOrStale(account.usageLimits, nowMs, maxAge)) return false;
    }
  }
  return true;
}

async function withDeadline(promise, remainingMs) {
  if (remainingMs <= 0) {
    promise.catch(() => {});
    return { timedOut: true, value: undefined };
  }
  let timer;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => {
      promise.catch(() => {});
      resolve({ timedOut: true, value: undefined });
    }, remainingMs);
  });
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false, value })),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 零配置连接本机 T3 Code：经官方 CLI 签发 2 分钟、仅含 orchestration:read 的会话令牌，拉取 server.getConfig；
 * 若存在启用实例的额度缺失或过期，则调用 server.refreshProviders 并轮询 server.getConfig 至多 40 秒，
 * 无论成败都吊销该会话。不读取任何凭据或 auth 缓存文件。
 */
export async function fetchT3AutoConfig({
  env = process.env,
  homeDir = os.homedir(),
  baseDir,
  origin,
  cli,
  policy = null,
  now = Date.now,
  run = (file, args, options) => execFileAsync(file, args, options),
  connect = connectT3,
  fetchConfig,
  timeoutMs = 15_000,
  refreshTimeoutMs = DEFAULT_REFRESH_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  platform = process.platform,
} = {}) {
  const readNow = typeof now === 'function' ? now : () => now;
  const resolvedBase = baseDir ?? env.T3CODE_HOME ?? path.join(homeDir, '.t3');
  const command = cli ?? discoverT3Cli({ env, homeDir });
  const serverOrigin = discoverT3Origin({ baseDir: resolvedBase, origin: origin ?? env.MODELPACE_ORIGIN });
  // Windows 上 npm 装的 t3 是 t3.cmd，Node 只能经 shell 执行批处理，参数需逐个加引号。
  const viaShell = platform === 'win32' && /\.(cmd|bat)$/i.test(command.file);
  const quote = (arg) => `"${String(arg).replace(/"/g, '""')}"`;
  const exec = (args) => {
    const argv = [command.file, ...command.args, ...args, '--base-dir', resolvedBase];
    const [file, ...rest] = viaShell ? argv.map(quote) : argv;
    return run(file, rest, {
      env: { ...env, ...command.env },
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      shell: viaShell,
    });
  };

  let issued;
  try {
    const { stdout } = await exec(['auth', 'session', 'issue', '--scope', SESSION_SCOPE, '--ttl', SESSION_TTL, '--label', SESSION_LABEL, '--json']);
    issued = JSON.parse(String(stdout));
  } catch {
    throw new T3RpcError('Failed to issue a temporary T3 session via the local T3 CLI', { code: 'T3_ISSUE_FAILED' });
  }
  if (typeof issued?.token !== 'string' || !/^[\w-]+$/.test(issued?.sessionId ?? '')) {
    throw new T3RpcError('The local T3 CLI returned an unexpected session payload', { code: 'T3_ISSUE_FAILED' });
  }

  try {
    if (fetchConfig) {
      return await fetchConfig({ origin: serverOrigin, bearer: issued.token, timeoutMs });
    }
    const initController = new AbortController();
    const initTimer = setTimeout(() => initController.abort(), timeoutMs);
    let rpc;
    let config;
    try {
      rpc = await connect({
        origin: serverOrigin,
        bearer: issued.token,
        timeoutMs: timeoutMs + refreshTimeoutMs + 5_000,
        signal: initController.signal,
      });
      const getConfig = () => rpc.call('server.getConfig', {}).then((exit) => validateT3ServerConfig(unwrapRpcExit(exit)));
      config = await getConfig();
      clearTimeout(initTimer);

      const plan = findStaleRefreshPlan(config, policy, readNow());
      if (plan.staleProviderIds.length === 0 && plan.staleSourceAccountKeys.length === 0) {
        return config;
      }

      const deadline = Date.now() + refreshTimeoutMs;
      const refreshCall = plan.needsGlobalRefresh
        ? rpc.call('server.refreshProviders', {}).then(unwrapRpcExit)
        : Promise.all(
            plan.staleProviderIds.map((instanceId) =>
              rpc.call('server.refreshProviders', { instanceId }).then(unwrapRpcExit),
            ),
          );
      const refreshResult = await withDeadline(refreshCall, deadline - Date.now());
      if (refreshResult.timedOut) return config;

      while (true) {
        const pollResult = await withDeadline(getConfig(), deadline - Date.now());
        if (pollResult.timedOut) break;
        config = pollResult.value;
        if (areTargetsFresh(config, plan, policy, readNow())) break;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await sleep(Math.min(pollIntervalMs, remaining));
      }
      return config;
    } finally {
      clearTimeout(initTimer);
      rpc?.close();
    }
  } finally {
    // 失败时不掩盖原错误，令牌自身 2 分钟后也会过期。
    await exec(['auth', 'session', 'revoke', issued.sessionId]).catch(() => {});
  }
}
