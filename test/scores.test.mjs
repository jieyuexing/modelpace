import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  betaQuantile,
  validateDispatchRecord,
  dispatchSucceeded,
  appendDispatchRecord,
  readDispatchRecords,
  resolveScoresFile,
  summarizeDispatchScores,
  rankDispatchScores,
} from '../src/index.mjs';

function makeRecord(overrides = {}) {
  return {
    date: '2026-11-23',
    taskId: 't-1',
    title: 'Sample slice task',
    task: 'slice',
    executor: {
      provider: 'codex',
      model: 'gpt-5.3-codex',
      effort: 'high',
      tier: 'personal',
      site: 'local',
    },
    scorer: 'orchestrator',
    accepted: true,
    firstPass: true,
    reworkRounds: 0,
    scopeViolation: false,
    falseReport: false,
    stoppedOnDenial: null,
    durationMin: 4.5,
    quotaDelta: 2,
    note: 'Clean pass',
    ...overrides,
  };
}

test('betaQuantile matches exact Beta(1,1) posterior quantiles within 1e-4', () => {
  // Beta(1, 1) is Uniform(0, 1) => q(0.05) = 0.05, q(0.95) = 0.95
  assert.ok(Math.abs(betaQuantile(0.05, 1, 1) - 0.05) < 1e-6);
  assert.ok(Math.abs(betaQuantile(0.95, 1, 1) - 0.95) < 1e-6);

  // Beta(6, 1) CDF is x^6 => q(0.05) = 0.05^(1/6) ≈ 0.60696223
  assert.ok(Math.abs(betaQuantile(0.05, 6, 1) - Math.pow(0.05, 1 / 6)) < 1e-5);
  assert.ok(Math.abs(betaQuantile(0.95, 6, 1) - Math.pow(0.95, 1 / 6)) < 1e-5);

  // Beta(10, 2) CDF is 1 - (1-x)^10*(1+10x), verify monotonicity and bounds
  const low = betaQuantile(0.05, 10, 2);
  const high = betaQuantile(0.95, 10, 2);
  assert.ok(low > 0.55 && low < 0.65);
  assert.ok(high > 0.94 && high < 0.99);
});

test('authoritative success formula and legacy JSONL compatibility', () => {
  assert.equal(dispatchSucceeded(makeRecord()), true);
  assert.equal(dispatchSucceeded(makeRecord({ reworkRounds: 1 })), true);
  assert.equal(dispatchSucceeded(makeRecord({ reworkRounds: 2 })), false);
  assert.equal(dispatchSucceeded(makeRecord({ falseReport: true })), false);
  assert.equal(dispatchSucceeded(makeRecord({ scopeViolation: true })), false);
  assert.equal(dispatchSucceeded(makeRecord({ stoppedOnDenial: false })), false);
  assert.equal(dispatchSucceeded(makeRecord({ stoppedOnDenial: true })), true);
});

test('declarative rejectRules, durationUnreadableProviders, and bad sample rejections', () => {
  const config = {
    durationUnreadableProviders: ['custom-headless'],
    rejectRules: [
      {
        providerIn: ['claude', 'claudeAgent'],
        siteContains: 'managed-gateway',
        reason: 'Gateway traffic must be recorded under provider "gateway"',
      },
    ],
  };

  assert.throws(
    () =>
      validateDispatchRecord(
        makeRecord({
          executor: { provider: 'claudeAgent', model: 'claude-sonnet-4-5', effort: 'high', tier: 'work', site: 'managed-gateway' },
        }),
        config,
      ),
    /Gateway traffic/,
  );

  // Bad samples must fail
  assert.throws(() => validateDispatchRecord(makeRecord({ date: '2026-02-31' })), /YYYY-MM-DD/);
  assert.throws(() => validateDispatchRecord(makeRecord({ reworkRounds: -1 })), /reworkRounds/);
  assert.throws(() => validateDispatchRecord({ ...makeRecord(), extra: 1 }), /unknown field/);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't3-dispatch-scores-'));
  const scoresFile = path.join(tmpDir, 'scores.jsonl');
  try {
    // durationMin null rejected unless provider in durationUnreadableProviders
    assert.throws(
      () => appendDispatchRecord(makeRecord({ durationMin: null }), { scoresFile, config }),
      /durationMin cannot be null/,
    );

    const ok = appendDispatchRecord(
      makeRecord({
        durationMin: null,
        executor: { provider: 'custom-headless', model: 'm1', effort: 'default', tier: 'public', site: 'local' },
      }),
      { scoresFile, config },
    );
    assert.equal(ok.task, 'slice');

    // Corrupt line rejected on read
    fs.appendFileSync(scoresFile, '{"broken": true}\n', 'utf8');
    assert.throws(() => readDispatchRecords({ scoresFile, config }), /line 2/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('summarizeDispatchScores and rankDispatchScores handle aliases and multi-currency pricing', () => {
  const records = [
    // claudeAgent aliases to claude; tier '-' aliases to default
    ...Array.from({ length: 5 }, (_, i) =>
      makeRecord({
        taskId: `c-${i}`,
        executor: { provider: 'claudeAgent', model: 'claude-sonnet-4-5', effort: 'high', tier: '-', site: 'local' },
        durationMin: 3 + i * 0.5,
        quotaDelta: 4,
      }),
    ),
    ...Array.from({ length: 5 }, (_, i) =>
      makeRecord({
        taskId: `x-${i}`,
        executor: { provider: 'codex', model: 'gpt-5.3-codex', effort: 'high', tier: 'default', site: 'local' },
        durationMin: 6 + i * 0.5,
        quotaDelta: 2,
      }),
    ),
    // Trial model (<5 samples)
    makeRecord({
      taskId: 'g-1',
      executor: { provider: 'antigravity', model: 'gemini-4-hydrogen', effort: 'high', tier: 'default', site: 'local' },
      durationMin: 2,
      quotaDelta: 1,
    }),
  ];

  const config = {
    minSamples: 5,
    minPassRate: 0.85,
    aliases: { provider: { claudeAgent: 'claude' }, tier: { '-': 'default' } },
    pricing: {
      currency: 'USD',
      exchangeRates: { USD: 6.67, CNY: 1 },
      monthlyPrice: {
        claude: { amount: 200, currency: 'USD' },
        codex: { usd: 200 },
      },
    },
  };

  const summary = summarizeDispatchScores(records, config);
  const ranking = rankDispatchScores(summary, config);

  const sliceRank = ranking.tasks.find((t) => t.task === 'slice');
  assert.deepEqual(sliceRank.qualified, [
    'claude/claude-sonnet-4-5/high/default',
    'codex/gpt-5.3-codex/high/default',
  ]);
  assert.deepEqual(sliceRank.trial, ['antigravity/gemini-4-hydrogen/high/default']);

  const claudeCell = summary.cells.find((c) => c.identity === 'claude/claude-sonnet-4-5/high/default');
  assert.equal(claudeCell.n, 5);
  assert.ok(Math.abs(claudeCell.passRate - 6 / 7) < 1e-6);
  // 4% of (200 * 12 / 52) = 0.04 * 46.153846 = 1.84615 USD
  assert.ok(Math.abs(claudeCell.costMedian - (0.04 * 200 * 12) / 52) < 1e-4);
});

test('账本路径：--scores / T3_DISPATCH_SCORES 优先，其余落到用户数据目录', () => {
  const cwd = process.cwd();
  assert.equal(resolveScoresFile({ scoresFile: 'a.jsonl', env: { T3_DISPATCH_SCORES: 'b.jsonl' } }), path.resolve(cwd, 'a.jsonl'));
  assert.equal(resolveScoresFile({ env: { T3_DISPATCH_SCORES: 'b.jsonl' } }), path.resolve(cwd, 'b.jsonl'));

  const resolved = resolveScoresFile({ env: { XDG_DATA_HOME: '/xdg-data', LOCALAPPDATA: '/local-app' } });
  const base = process.platform === 'win32' ? '/local-app' : '/xdg-data';
  assert.equal(resolved, path.join(base, 't3-dispatch', 'scores.jsonl'));

  if (process.platform !== 'win32') {
    const home = resolveScoresFile({ env: {} });
    assert.equal(home, path.join(os.homedir(), '.local', 'share', 't3-dispatch', 'scores.jsonl'));
  }
});

test('record 只收紧自己新建的目录，已存在目录的权限保持不变',
  { skip: process.platform === 'win32' },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 't3-dispatch-mode-'));
    try {
      const existing = path.join(root, 'project');
      fs.mkdirSync(existing, { mode: 0o755 });
      fs.chmodSync(existing, 0o755);
      appendDispatchRecord(makeRecord(), { scoresFile: path.join(existing, 'scores.jsonl') });
      assert.equal(fs.statSync(existing).mode & 0o777, 0o755);
      assert.equal(fs.statSync(path.join(existing, 'scores.jsonl')).mode & 0o777, 0o600);

      const fresh = path.join(root, 'new', 'data');
      appendDispatchRecord(makeRecord(), { scoresFile: path.join(fresh, 'scores.jsonl') });
      assert.equal(fs.statSync(fresh).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(root, 'new')).mode & 0o777, 0o700);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
