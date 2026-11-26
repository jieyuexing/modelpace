import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runCli } from '../bin/modelpace.mjs';
import { handleToolCall } from '../bin/modelpace-mcp.mjs';
import { T3RpcError, decideDispatch, discoverT3Cli, discoverT3Origin, fetchT3AutoConfig, normalizePolicy, normalizeT3ConfigToSnapshot } from '../src/index.mjs';
import { startMockT3Server } from './helpers/mock-t3-server.mjs';

const NOW = Date.parse('2026-11-23T07:05:00.000Z');
const TOKEN = 'demo-tok-42';
const execFileAsync = promisify(execFile);

const SERVER_CONFIG = {
  providers: [
    {
      instanceId: 'codex',
      driver: 'codex',
      displayName: 'Codex',
      enabled: true,
      installed: true,
      status: 'ready',
      auth: { status: 'authenticated', label: 'ChatGPT Pro 200 Subscription' },
      models: [{ id: 'gpt-5.3-codex' }],
      usageLimits: {
        checkedAt: '2026-11-23T07:00:00.000Z',
        windows: [
          { id: 'primary', kind: 'session', label: '5h', usedPercent: 15, resetsAt: '2026-11-23T11:00:00.000Z', windowDurationMins: 300 },
          { id: 'secondary', kind: 'weekly', label: 'Weekly', usedPercent: 40, resetsAt: '2026-11-28T07:00:00.000Z', windowDurationMins: 10080 },
        ],
      },
    },
  ],
};

// 模拟官方 T3 CLI：issue 打印会话 JSON，所有调用记入日志。
function makeSandbox({ failIssue = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelpace-auto-'));
  const baseDir = path.join(dir, 't3-home');
  const log = path.join(dir, 'calls.jsonl');
  const script = path.join(dir, 'mock-t3.mjs');
  fs.writeFileSync(
    script,
    `import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (${failIssue} && args.includes('issue')) process.exit(3);
if (args.includes('issue')) process.stdout.write(JSON.stringify({ sessionId: 'sess-1', token: ${JSON.stringify(TOKEN)} }));
else process.stdout.write('Revoked session sess-1.\\n');
`,
    'utf8',
  );
  fs.mkdirSync(path.join(baseDir, 'userdata'), { recursive: true });
  const writeRuntime = (origin, pid = process.pid) =>
    fs.writeFileSync(path.join(baseDir, 'userdata', 'server-runtime.json'), JSON.stringify({ version: 1, pid, port: 1, origin }), 'utf8');
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  return {
    dir,
    baseDir,
    writeRuntime,
    calls,
    env: { PATH: '', HOME: dir, MODELPACE_T3_BIN: `'${process.execPath}' '${script}'`, T3CODE_HOME: baseDir },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('fetchT3AutoConfig issues a 2-minute session through the official CLI and always revokes it', async () => {
  const sandbox = makeSandbox();
  const server = await startMockT3Server({ expectedToken: TOKEN, serverConfigPayload: SERVER_CONFIG });
  try {
    sandbox.writeRuntime(server.origin);
    const config = await fetchT3AutoConfig({ env: sandbox.env, homeDir: sandbox.dir, now: () => NOW });
    assert.equal(config.providers[0].instanceId, 'codex');
    assert.deepEqual(sandbox.calls(), [
      ['auth', 'session', 'issue', '--scope', 'orchestration:read', '--ttl', '2m', '--label', 'modelpace', '--json', '--base-dir', sandbox.baseDir],
      ['auth', 'session', 'revoke', 'sess-1', '--base-dir', sandbox.baseDir],
    ]);
  } finally {
    await server.close();
    sandbox.cleanup();
  }
});

test('the session is revoked when fetching fails after issuing, and the original error survives', async () => {
  const sandbox = makeSandbox();
  const server = await startMockT3Server({ expectedToken: 'another-token', serverConfigPayload: SERVER_CONFIG });
  try {
    sandbox.writeRuntime(server.origin);
    await assert.rejects(
      () => fetchT3AutoConfig({ env: sandbox.env, homeDir: sandbox.dir }),
      (error) => error instanceof T3RpcError && error.code === 'WS_TICKET_FAILED',
    );
    assert.deepEqual(sandbox.calls().map((call) => call[2]), ['issue', 'revoke']);

    const boom = new Error('boom');
    await assert.rejects(
      () => fetchT3AutoConfig({ env: sandbox.env, homeDir: sandbox.dir, fetchConfig: async () => { throw boom; } }),
      (error) => error === boom,
    );
    assert.deepEqual(sandbox.calls().map((call) => call[2]), ['issue', 'revoke', 'issue', 'revoke']);

    await assert.rejects(
      () => fetchT3AutoConfig({
        env: sandbox.env,
        homeDir: sandbox.dir,
        run: async (file, args, options) => {
          if (args.includes('revoke')) throw new Error('revoke failed');
          return execFileAsync(file, args, options);
        },
        fetchConfig: async () => { throw boom; },
      }),
      (error) => error === boom,
    );
  } finally {
    await server.close();
    sandbox.cleanup();
  }
});

test('a failed issue stops before any connection and revokes nothing', async () => {
  const sandbox = makeSandbox({ failIssue: true });
  try {
    sandbox.writeRuntime('http://127.0.0.1:9');
    await assert.rejects(
      () => fetchT3AutoConfig({ env: sandbox.env, homeDir: sandbox.dir, fetchConfig: async () => assert.fail('must not connect') }),
      (error) => error instanceof T3RpcError && error.code === 'T3_ISSUE_FAILED',
    );
    assert.deepEqual(sandbox.calls().map((call) => call[2]), ['issue']);
  } finally {
    sandbox.cleanup();
  }
});

test('auto discovery reads only the runtime record and never credential files', async () => {
  const sandbox = makeSandbox();
  const server = await startMockT3Server({ expectedToken: TOKEN, serverConfigPayload: SERVER_CONFIG });
  try {
    sandbox.writeRuntime(server.origin);
    fs.mkdirSync(path.join(sandbox.baseDir, 'userdata', 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(sandbox.baseDir, 'userdata', 'secrets', 'auth.json'), '{"token":"leak"}');
    const read = [];
    const original = fs.readFileSync;
    fs.readFileSync = (file, ...rest) => {
      read.push(String(file));
      return original(file, ...rest);
    };
    try {
      await fetchT3AutoConfig({ env: sandbox.env, homeDir: sandbox.dir, now: () => NOW });
    } finally {
      fs.readFileSync = original;
    }
    assert.deepEqual(read, [path.join(sandbox.baseDir, 'userdata', 'server-runtime.json')]);
  } finally {
    await server.close();
    sandbox.cleanup();
  }
});

test('CLI plan --t3-auto and MCP dispatch_plan with MODELPACE_AUTO=1 plan from the local T3 and revoke', async () => {
  const sandbox = makeSandbox();
  const server = await startMockT3Server({ expectedToken: TOKEN, serverConfigPayload: SERVER_CONFIG });
  try {
    sandbox.writeRuntime(server.origin);
    let out = '';
    assert.equal(
      await runCli(['plan', '--t3-auto', '--task', 'slice', '--format', 'json'], { env: sandbox.env, write: (s) => { out += s; }, now: () => NOW }),
      0,
    );
    assert.ok(['run', 'wait', 'redeem', 'refresh', 'pause'].includes(JSON.parse(out).action));
    assert.deepEqual(sandbox.calls().map((call) => call[2]), ['issue', 'revoke']);

    const decision = await handleToolCall('dispatch_plan', { task: 'slice' }, { env: { ...sandbox.env, MODELPACE_AUTO: '1' }, now: () => NOW });
    assert.ok(decision.candidates.length > 0);
    assert.deepEqual(sandbox.calls().map((call) => call[2]), ['issue', 'revoke', 'issue', 'revoke']);

    await assert.rejects(() => handleToolCall('dispatch_plan', {}, { env: { ...sandbox.env, MODELPACE_T3_BIN: '' }, now: () => NOW }), /No usage source/);
  } finally {
    await server.close();
    sandbox.cleanup();
  }
});

test('discoverT3Cli prefers the env override, then PATH, then a macOS bundle with the T3 bundle id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelpace-discover-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 't3'), '#!/bin/sh\n', { mode: 0o755 });
    const makeApp = (name, id) => {
      const macos = path.join(dir, 'Applications', `${name}.app`, 'Contents', 'MacOS');
      fs.mkdirSync(macos, { recursive: true });
      fs.writeFileSync(path.join(macos, name), '#!/bin/sh\n', { mode: 0o755 });
      fs.writeFileSync(
        path.join(dir, 'Applications', `${name}.app`, 'Contents', 'Info.plist'),
        `<plist><dict><key>CFBundleIdentifier</key>\n<string>${id}</string></dict></plist>`,
      );
      return path.join(macos, name);
    };
    const other = makeApp('Other', 'com.example.other');
    const t3App = makeApp('T3 Code', 'com.t3tools.t3code');
    const appDirs = [path.join(dir, 'Applications')];

    assert.equal(discoverT3Cli({ env: { PATH: bin, MODELPACE_T3_BIN: '/opt/t3 --flag' }, platform: 'darwin', appDirs }).file, '/opt/t3');
    assert.equal(discoverT3Cli({ env: { PATH: bin }, platform: 'darwin', appDirs }).source, 'path');
    const app = discoverT3Cli({ env: { PATH: '' }, platform: 'darwin', appDirs });
    assert.equal(app.file, t3App);
    assert.notEqual(app.file, other);
    assert.equal(app.env.ELECTRON_RUN_AS_NODE, '1');
    assert.throws(() => discoverT3Cli({ env: { PATH: '' }, platform: 'linux', appDirs }), /not found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverT3Origin rejects a missing or dead runtime record', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelpace-origin-'));
  try {
    assert.throws(() => discoverT3Origin({ baseDir: dir }), (error) => error.code === 'T3_SERVER_NOT_FOUND');
    fs.mkdirSync(path.join(dir, 'userdata'));
    fs.writeFileSync(path.join(dir, 'userdata', 'server-runtime.json'), JSON.stringify({ pid: 2 ** 22 + 12345, origin: 'http://127.0.0.1:1' }));
    assert.throws(() => discoverT3Origin({ baseDir: dir }), (error) => error.code === 'T3_SERVER_NOT_RUNNING');
    assert.equal(discoverT3Origin({ baseDir: dir, origin: 'http://127.0.0.1:2' }), 'http://127.0.0.1:2');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('on Windows a t3.cmd shim runs through the shell with every argument quoted', async () => {
  const sandbox = makeSandbox();
  try {
    sandbox.writeRuntime('http://127.0.0.1:1');
    const seen = [];
    const run = async (file, args, options) => {
      seen.push({ file, args, shell: options.shell });
      return { stdout: args.includes('"issue"') ? JSON.stringify({ sessionId: 'sess-1', token: TOKEN }) : '' };
    };
    const cli = { file: 'C:\\Program Files\\t3\\t3.cmd', args: [], env: {} };
    await fetchT3AutoConfig({ env: sandbox.env, cli, run, platform: 'win32', fetchConfig: async () => SERVER_CONFIG });
    assert.equal(seen.length, 2);
    assert.equal(seen[0].file, '"C:\\Program Files\\t3\\t3.cmd"');
    assert.equal(seen[0].shell, true);
    assert.ok(seen.every(({ args }) => args.every((arg) => arg.startsWith('"') && arg.endsWith('"'))));
  } finally {
    sandbox.cleanup();
  }
});

test('a session id that is not a plain token is rejected before any revoke command', async () => {
  const sandbox = makeSandbox();
  try {
    sandbox.writeRuntime('http://127.0.0.1:1');
    const seen = [];
    const run = async (file, args) => {
      seen.push(args);
      return { stdout: JSON.stringify({ sessionId: 'x & del *', token: TOKEN }) };
    };
    await assert.rejects(
      () => fetchT3AutoConfig({ env: sandbox.env, cli: { file: 't3', args: [], env: {} }, run, fetchConfig: async () => SERVER_CONFIG }),
      /unexpected session payload/,
    );
    assert.equal(seen.length, 1);
  } finally {
    sandbox.cleanup();
  }
});

const REFRESH_POLICY = normalizePolicy({
  schemaVersion: 2,
  taskToSlot: { slice: 'worker', general: 'worker' },
  instances: {
    antigravity: { driver: 'antigravity', enabled: true },
    claudeAgent: { driver: 'claudeAgent', enabled: true },
    codex: { driver: 'codex', enabled: false },
  },
  slots: {
    worker: {
      candidates: [
        { id: 'gemini-worker', instanceId: 'antigravity', model: 'gemini-4-hydrogen', pool: 'gemini', effort: 'high', priority: 1 },
        { id: 'claude-worker', instanceId: 'claudeAgent', model: 'claude-sonnet-4-5', effort: 'high', priority: 2 },
        { id: 'codex-worker', instanceId: 'codex', model: 'gpt-5.3-codex', effort: 'high', priority: 3 },
      ],
    },
  },
});

function makeConfigSnapshot({ antigravityCheckedAt, claudeCheckedAt, codexCheckedAt } = {}) {
  return {
    providers: [
      {
        instanceId: 'antigravity',
        driver: 'antigravity',
        displayName: 'Antigravity',
        enabled: true,
        installed: true,
        status: 'ready',
        auth: { status: 'authenticated', label: 'Ultra' },
        ...(antigravityCheckedAt
          ? {
              usageLimits: {
                checkedAt: antigravityCheckedAt,
                windows: [
                  { id: 'gemini-5h', kind: 'session', label: 'Gemini 5h', usedPercent: 10, resetsAt: '2026-11-23T11:00:00.000Z', windowDurationMins: 300 },
                  { id: 'gemini-weekly', kind: 'weekly', label: 'Gemini Weekly', usedPercent: 20, resetsAt: '2026-11-28T07:00:00.000Z', windowDurationMins: 10080 },
                ],
              },
            }
          : {}),
      },
      {
        instanceId: 'claudeAgent',
        driver: 'claudeAgent',
        displayName: 'Claude',
        enabled: true,
        installed: true,
        status: 'ready',
        auth: { status: 'authenticated', label: 'Max' },
        ...(claudeCheckedAt
          ? {
              usageLimits: {
                checkedAt: claudeCheckedAt,
                windows: [
                  { id: 'five_hour', kind: 'session', label: '5h', usedPercent: 15, resetsAt: '2026-11-23T11:00:00.000Z', windowDurationMins: 300 },
                  { id: 'seven_day', kind: 'weekly', label: 'Weekly', usedPercent: 30, resetsAt: '2026-11-28T07:00:00.000Z', windowDurationMins: 10080 },
                ],
              },
            }
          : {}),
      },
      {
        instanceId: 'codex',
        driver: 'codex',
        displayName: 'Codex',
        enabled: true,
        installed: true,
        status: 'ready',
        auth: { status: 'authenticated' },
        ...(codexCheckedAt ? { usageLimits: { checkedAt: codexCheckedAt, windows: [] } } : {}),
      },
    ],
  };
}

test('fresh quota makes zero server.refreshProviders calls on CLI --t3-auto and MCP MODELPACE_AUTO=1', async () => {
  const sandbox = makeSandbox();
  const cfgPath = path.join(sandbox.dir, 'policy.json');
  fs.writeFileSync(cfgPath, JSON.stringify(REFRESH_POLICY));
  const freshPayload = makeConfigSnapshot({
    antigravityCheckedAt: '2026-11-23T07:00:00.000Z',
    claudeCheckedAt: '2026-11-23T07:01:00.000Z',
    // Disabled in policy: must not trigger refresh even when missing usageLimits
  });
  const server = await startMockT3Server({ expectedToken: TOKEN, serverConfigPayload: freshPayload });
  try {
    sandbox.writeRuntime(server.origin);
    let out = '';
    const code = await runCli(
      ['plan', '--t3-auto', '--config', cfgPath, '--task', 'slice', '--format', 'json'],
      { env: sandbox.env, write: (s) => { out += s; }, now: () => NOW },
    );
    assert.equal(code, 0);
    assert.equal(JSON.parse(out).action, 'run');

    const mcpDecision = await handleToolCall(
      'dispatch_plan',
      { task: 'slice', configPath: cfgPath },
      { env: { ...sandbox.env, MODELPACE_AUTO: '1' }, now: () => NOW },
    );
    assert.equal(mcpDecision.action, 'run');

    assert.deepEqual(
      server.requests.map((r) => r.tag),
      ['server.getConfig', 'server.getConfig'],
    );
  } finally {
    await server.close();
    sandbox.cleanup();
  }
});

test('stale or missing quota triggers server.refreshProviders, polls until checkedAt refreshes, and plans with fresh data (CLI & MCP)', async () => {
  const sandbox = makeSandbox();
  const cfgPath = path.join(sandbox.dir, 'policy.json');
  fs.writeFileSync(cfgPath, JSON.stringify(REFRESH_POLICY));

  const stalePayload = makeConfigSnapshot({
    antigravityCheckedAt: '2026-11-23T06:40:00.000Z', // 25m old (> 15m)
    claudeCheckedAt: null, // missing usageLimits
  });
  const freshPayload = makeConfigSnapshot({
    antigravityCheckedAt: '2026-11-23T07:04:55.000Z',
    claudeCheckedAt: '2026-11-23T07:04:58.000Z',
  });

  let refreshed = false;
  let pollsAfterRefresh = 0;
  const server = await startMockT3Server({
    expectedToken: TOKEN,
    onRefreshProviders: () => {
      refreshed = true;
      return { providers: [] };
    },
    getServerConfig: () => {
      if (!refreshed) return stalePayload;
      pollsAfterRefresh += 1;
      // First getConfig after refreshProviders still shows old snapshot (async probe in flight)
      return pollsAfterRefresh >= 2 ? freshPayload : stalePayload;
    },
  });

  try {
    sandbox.writeRuntime(server.origin);
    let out = '';
    const code = await runCli(
      ['plan', '--t3-auto', '--config', cfgPath, '--task', 'slice', '--format', 'json'],
      { env: sandbox.env, write: (s) => { out += s; }, now: () => NOW },
    );
    assert.equal(code, 0);
    const cliDecision = JSON.parse(out);
    assert.equal(cliDecision.action, 'run');
    assert.equal(cliDecision.recommended.instanceId, 'antigravity');

    const refreshCalls = server.requests.filter((r) => r.tag === 'server.refreshProviders');
    assert.deepEqual(
      refreshCalls.map((r) => r.payload.instanceId).sort(),
      ['antigravity', 'claudeAgent'],
    );
    assert.ok(refreshCalls.every((r) => r.payload.refreshModels === undefined));

    // Reset state and verify MCP MODELPACE_AUTO=1 follows the same refresh-and-poll path
    refreshed = false;
    pollsAfterRefresh = 0;
    server.requests.length = 0;
    const mcpDecision = await handleToolCall(
      'dispatch_plan',
      { task: 'slice', configPath: cfgPath },
      { env: { ...sandbox.env, MODELPACE_AUTO: '1' }, now: () => NOW },
    );
    assert.equal(mcpDecision.action, 'run');
    assert.ok(server.requests.some((r) => r.tag === 'server.refreshProviders'));
    assert.ok(server.requests.filter((r) => r.tag === 'server.getConfig').length >= 3);
    assert.deepEqual(
      sandbox.calls().map((call) => call[2]),
      ['issue', 'revoke', 'issue', 'revoke'],
    );
  } finally {
    await server.close();
    sandbox.cleanup();
  }
});

test('when quota remains stale past the refresh timeout, fetchT3AutoConfig returns the snapshot and decision degrades to refresh', async () => {
  const sandbox = makeSandbox();
  const stalePayload = makeConfigSnapshot({
    antigravityCheckedAt: '2026-11-23T06:40:00.000Z',
    claudeCheckedAt: '2026-11-23T06:42:00.000Z',
  });
  const server = await startMockT3Server({
    expectedToken: TOKEN,
    serverConfigPayload: stalePayload,
  });
  try {
    sandbox.writeRuntime(server.origin);
    const started = Date.now();
    const config = await fetchT3AutoConfig({
      env: sandbox.env,
      homeDir: sandbox.dir,
      policy: REFRESH_POLICY,
      now: () => NOW,
      refreshTimeoutMs: 120,
      pollIntervalMs: 25,
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, `Expected timeout quickly, took ${elapsed}ms`);
    assert.ok(server.requests.some((r) => r.tag === 'server.refreshProviders'));
    assert.ok(server.requests.filter((r) => r.tag === 'server.getConfig').length >= 2);

    const snapshot = normalizeT3ConfigToSnapshot(config, NOW);
    const decision = decideDispatch({
      snapshot,
      policy: REFRESH_POLICY,
      request: { task: 'slice' },
      now: NOW,
    });
    assert.equal(decision.action, 'refresh');
    assert.deepEqual(sandbox.calls().map((call) => call[2]), ['issue', 'revoke']);
  } finally {
    await server.close();
    sandbox.cleanup();
  }
});
