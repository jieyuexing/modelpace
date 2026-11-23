import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { T3RpcError, fetchT3ServerConfig, splitCommandArgs } from './t3-rpc.mjs';

const execFileAsync = promisify(execFile);

export const T3_BUNDLE_ID = 'com.t3tools.t3code';
const SESSION_TTL = '2m';
const SESSION_LABEL = 't3-dispatch';
// server.getConfig 只需要这一项权限；不传 --scope 时 T3 会签发包含终端与文件写入的标准客户端全套权限。
const SESSION_SCOPE = 'orchestration:read';
const SERVER_ENTRY = 'Contents/Resources/app.asar/apps/server/dist/bin.mjs';

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

/** 发现本机 T3 Code CLI：T3_DISPATCH_T3_BIN > PATH 上的 t3 > macOS 应用包（bundle id 匹配）。 */
export function discoverT3Cli({ env = process.env, homeDir = os.homedir(), platform = process.platform, appDirs } = {}) {
  if (env.T3_DISPATCH_T3_BIN?.trim()) {
    const [file, ...args] = splitCommandArgs(env.T3_DISPATCH_T3_BIN);
    return { file, args, env: {}, source: 'env' };
  }
  const onPath = findOnPath('t3', env);
  if (onPath) return { file: onPath, args: [], env: {}, source: 'path' };
  if (platform === 'darwin') {
    const found = findMacApp(appDirs ?? ['/Applications', path.join(homeDir, 'Applications')]);
    if (found) return found;
  }
  throw new T3RpcError('Local T3 Code CLI not found (set T3_DISPATCH_T3_BIN, or put t3 on PATH)', {
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

/**
 * 零配置连接本机 T3 Code：经官方 CLI 签发 2 分钟、仅含 orchestration:read 的会话令牌，拉取 server.getConfig，
 * 无论成败都吊销该会话。不读取任何凭据或 auth 缓存文件。
 */
export async function fetchT3AutoConfig({
  env = process.env,
  homeDir = os.homedir(),
  baseDir,
  origin,
  cli,
  run = (file, args, options) => execFileAsync(file, args, options),
  fetchConfig = fetchT3ServerConfig,
  timeoutMs = 15_000,
} = {}) {
  const resolvedBase = baseDir ?? env.T3CODE_HOME ?? path.join(homeDir, '.t3');
  const command = cli ?? discoverT3Cli({ env, homeDir });
  const serverOrigin = discoverT3Origin({ baseDir: resolvedBase, origin: origin ?? env.T3_DISPATCH_ORIGIN });
  const exec = (args) =>
    run(command.file, [...command.args, ...args, '--base-dir', resolvedBase], {
      env: { ...env, ...command.env },
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });

  let issued;
  try {
    const { stdout } = await exec(['auth', 'session', 'issue', '--scope', SESSION_SCOPE, '--ttl', SESSION_TTL, '--label', SESSION_LABEL, '--json']);
    issued = JSON.parse(String(stdout));
  } catch {
    throw new T3RpcError('Failed to issue a temporary T3 session via the local T3 CLI', { code: 'T3_ISSUE_FAILED' });
  }
  if (typeof issued?.token !== 'string' || typeof issued?.sessionId !== 'string') {
    throw new T3RpcError('The local T3 CLI returned an unexpected session payload', { code: 'T3_ISSUE_FAILED' });
  }

  try {
    return await fetchConfig({ origin: serverOrigin, bearer: issued.token, timeoutMs });
  } finally {
    // 失败时不掩盖原错误，令牌自身 2 分钟后也会过期。
    await exec(['auth', 'session', 'revoke', issued.sessionId]).catch(() => {});
  }
}
