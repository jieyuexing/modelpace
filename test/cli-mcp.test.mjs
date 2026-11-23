import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCli } from '../bin/modelpace.mjs';
import { handleJsonRpcMessage } from '../bin/modelpace-mcp.mjs';
import { writeClaudeFixture, writeCodexFixture } from './helpers/speed-fixtures.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = path.join(REPO_ROOT, 'bin', 'modelpace.mjs');
const MCP_PATH = path.join(REPO_ROOT, 'bin', 'modelpace-mcp.mjs');
const EXAMPLE_CONFIG = path.join(REPO_ROOT, 'examples', 'multi-account.config.json');
const EXAMPLE_SNAPSHOT = path.join(REPO_ROOT, 'examples', 'multi-account.snapshot.json');
const FIXED_NOW = Date.parse('2026-11-23T07:05:00.000Z');

test('CLI init, validate, record, scores, and plan (en & zh, text & json)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelpace-cli-'));
  const outConfig = path.join(tmpDir, 'dispatch.config.json');
  const scoresFile = path.join(tmpDir, 'scores.jsonl');
  const recordFile = path.join(tmpDir, 'record.json');
  const badRecordFile = path.join(tmpDir, 'bad-record.json');

  try {
    let buf = '';
    const write = (s) => { buf += s; };

    assert.equal(await runCli(['init', '--out', outConfig], { write }), 0);
    assert.ok(fs.existsSync(outConfig));

    buf = '';
    assert.equal(await runCli(['validate', '--config', outConfig], { write }), 0);
    assert.match(buf, /Valid dispatch policy/);

    const validRecord = {
      date: '2026-11-23',
      taskId: 'cli-1',
      title: 'Test slice',
      task: 'slice',
      executor: { provider: 'codex', model: 'gpt-5.3-codex', effort: 'high', tier: 'personal', site: 'local' },
      scorer: 'test',
      accepted: true,
      firstPass: true,
      reworkRounds: 0,
      scopeViolation: false,
      falseReport: false,
      stoppedOnDenial: null,
      durationMin: 4.1,
      quotaDelta: 2,
      note: 'Passed',
    };
    fs.writeFileSync(recordFile, JSON.stringify(validRecord), 'utf8');
    fs.writeFileSync(badRecordFile, JSON.stringify({ ...validRecord, task: 'invalid-task' }), 'utf8');

    buf = '';
    assert.equal(await runCli(['record', '--json', recordFile, '--scores', scoresFile, '--config', EXAMPLE_CONFIG], { write }), 0);
    assert.match(buf, /Recorded/);

    await assert.rejects(
      () => runCli(['record', '--json', badRecordFile, '--scores', scoresFile, '--config', EXAMPLE_CONFIG], { write }),
      /task must be one of/,
    );

    buf = '';
    assert.equal(await runCli(['scores', '--scores', scoresFile, '--config', EXAMPLE_CONFIG, '--lang', 'zh'], { write }), 0);
    assert.match(buf, /试用样本不足/);

    buf = '';
    assert.equal(
      await runCli(
        ['plan', '--config', EXAMPLE_CONFIG, '--snapshot', EXAMPLE_SNAPSHOT, '--scores', scoresFile, '--task', 'slice', '--tier', 'personal', '--format', 'json'],
        { write, now: () => FIXED_NOW },
      ),
      0,
    );
    const parsed = JSON.parse(buf);
    assert.equal(parsed.action, 'run');
    assert.equal(parsed.recommended.delegateReady, true);

    buf = '';
    assert.equal(
      await runCli(
        ['plan', '--config', EXAMPLE_CONFIG, '--snapshot', EXAMPLE_SNAPSHOT, '--task', 'long', '--tier', 'work', '--lang', 'zh'],
        { write, now: () => FIXED_NOW },
      ),
      0,
    );
    assert.match(buf, /建议动作: run/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI binary runs as standalone subprocess', async () => {
  const { code, stdout } = await new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, '--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', (code) => resolve({ code, stdout }));
  });
  assert.equal(code, 0);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('MCP stdio server handles initialize, notifications/initialized, ping, tools/list, and tools/call over subprocess', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelpace-mcp-'));
  const scoresFile = path.join(tmpDir, 'mcp-scores.jsonl');

  // Create a fresh snapshot relative to real Date.now() for the live subprocess
  const liveSnapPath = path.join(tmpDir, 'live-snap.json');
  const snap = JSON.parse(fs.readFileSync(EXAMPLE_SNAPSHOT, 'utf8'));
  const nowIso = new Date().toISOString();
  const in3h = new Date(Date.now() + 3 * 3600000).toISOString();
  const in4d = new Date(Date.now() + 96 * 3600000).toISOString();
  snap.observedAt = nowIso;
  for (const inst of Object.values(snap.instances)) {
    inst.checkedAt = nowIso;
    for (const w of inst.windows) {
      w.resetsAt = w.kind === 'session' ? in3h : in4d;
    }
  }
  fs.writeFileSync(liveSnapPath, JSON.stringify(snap), 'utf8');

  try {
    const child = spawn(process.execPath, [MCP_PATH], {
      env: {
        ...process.env,
        MODELPACE_CONFIG: EXAMPLE_CONFIG,
        MODELPACE_SNAPSHOT: liveSnapPath,
        MODELPACE_SCORES: scoresFile,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const responses = [];
    let outBuf = '';
    let resolveNext = null;
    child.stdout.on('data', (chunk) => {
      outBuf += chunk.toString('utf8');
      while (outBuf.includes('\n')) {
        const idx = outBuf.indexOf('\n');
        const line = outBuf.slice(0, idx).trim();
        outBuf = outBuf.slice(idx + 1);
        if (!line) continue;
        const parsed = JSON.parse(line);
        responses.push(parsed);
        if (resolveNext) {
          const fn = resolveNext;
          resolveNext = null;
          fn(parsed);
        }
      }
    });

    const rpc = (msg) =>
      new Promise((resolve) => {
        resolveNext = resolve;
        child.stdin.write(JSON.stringify(msg) + '\n');
      });

    const initRes = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    assert.equal(initRes.result.serverInfo.name, 'modelpace');

    // Notification produces no response
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const pingRes = await rpc({ jsonrpc: '2.0', id: 2, method: 'ping' });
    assert.deepEqual(pingRes.result, {});

    const listRes = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    assert.deepEqual(
      listRes.result.tools.map((t) => t.name),
      ['dispatch_plan', 'dispatch_record', 'dispatch_scores', 'dispatch_speed'],
    );

    const planRes = await rpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'dispatch_plan', arguments: { task: 'slice', tier: 'personal' } },
    });
    assert.equal(planRes.result.isError, false);
    assert.equal(planRes.result.structuredContent.action, 'run');
    assert.equal(planRes.result.structuredContent.recommended.delegateReady, true);

    const recRes = await rpc({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'dispatch_record',
        arguments: {
          record: {
            date: '2026-11-23',
            taskId: 'mcp-1',
            title: 'MCP recorded slice',
            task: 'slice',
            executor: { provider: 'codex', model: 'gpt-5.3-codex', effort: 'high', tier: 'personal', site: 'local' },
            scorer: 'orchestrator',
            accepted: true,
            firstPass: true,
            reworkRounds: 0,
            scopeViolation: false,
            falseReport: false,
            stoppedOnDenial: null,
            durationMin: 3.5,
            quotaDelta: 1,
            note: 'Verified',
          },
        },
      },
    });
    assert.equal(recRes.result.isError, false);

    const scoresRes = await rpc({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'dispatch_scores', arguments: {} },
    });
    assert.equal(scoresRes.result.structuredContent.totalRecords, 1);

    // Bad tool name returns isError: true
    const errRes = await rpc({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'nonexistent_tool', arguments: {} },
    });
    assert.equal(errRes.result.isError, true);

    child.stdin.end();
    await new Promise((resolve) => child.on('close', resolve));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Also test unknown JSON-RPC method handler directly
  const methodNotFound = await handleJsonRpcMessage({ jsonrpc: '2.0', id: 99, method: 'unknown/method' });
  assert.equal(methodNotFound.error.code, -32601);
});

test('MCP dispatch_speed ranks local speed over stdio and dispatch_plan can fold it in', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelpace-mcp-speed-'));
  try {
    const now = Date.now();
    writeClaudeFixture(path.join(tmpDir, 'claude'), now);
    writeCodexFixture(path.join(tmpDir, 'codex'), now);
    const child = spawn(process.execPath, [MCP_PATH], {
      env: {
        PATH: process.env.PATH,
        MODELPACE_CLAUDE_DIR: path.join(tmpDir, 'claude'),
        MODELPACE_CODEX_DIR: path.join(tmpDir, 'codex'),
        MODELPACE_OPENCODE_DB: path.join(tmpDir, 'missing.db'),
        MODELPACE_ANTIGRAVITY_PATHS: path.join(tmpDir, 'missing'),
        MODELPACE_SPEED_CACHE: path.join(tmpDir, 'cache.json'),
        MODELPACE_SCORES: path.join(tmpDir, 'scores.jsonl'),
        MODELPACE_CONFIG: EXAMPLE_CONFIG,
        MODELPACE_SNAPSHOT: EXAMPLE_SNAPSHOT,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let outBuf = '';
    const waiting = new Map();
    child.stdout.on('data', (chunk) => {
      outBuf += chunk.toString('utf8');
      for (let nl = outBuf.indexOf('\n'); nl !== -1; nl = outBuf.indexOf('\n')) {
        const message = JSON.parse(outBuf.slice(0, nl));
        outBuf = outBuf.slice(nl + 1);
        waiting.get(message.id)?.(message);
      }
    });
    const call = (id, name, args) =>
      new Promise((resolve) => {
        waiting.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
      });

    const speed = await call(1, 'dispatch_speed', { days: 7 });
    assert.equal(speed.result.isError, false);
    const ranking = speed.result.structuredContent.ranking;
    assert.deepEqual(ranking.map((row) => row.model), ['gpt-5.3-codex', 'claude-opus-5-5']);
    assert.ok(Math.abs(ranking[0].longRate - 150) / 150 <= 0.01);
    assert.deepEqual(Object.keys(speed.result.structuredContent.metrics), ['gpt-5.3-codex', 'claude-opus-5-5']);

    const plan = await call(2, 'dispatch_plan', { task: 'slice', tier: 'personal', includeSpeed: true, days: 7 });
    assert.equal(plan.result.isError, false);
    const codex = plan.result.structuredContent.candidates.find((c) => c.model === 'gpt-5.3-codex');
    assert.ok(Math.abs(codex.speedLongRate - 150) / 150 <= 0.01);

    const bad = await call(3, 'dispatch_speed', { days: 'many' });
    assert.equal(bad.result.isError, true);

    child.stdin.end();
    await new Promise((resolve) => child.on('close', resolve));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
