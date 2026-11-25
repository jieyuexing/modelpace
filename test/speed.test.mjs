import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addToBins,
  binsMedian,
  binsToPairs,
  collectSpeed,
  decideDispatch,
  formatSpeedText,
  normalizeSnapshot,
  rankSpeedRows,
  scanSpeed,
  speedDispatchScores,
  speedModel,
  speedSample,
  splitSparseRows,
  summarizeDispatchScores,
  toSpeedMetricsMap,
} from '../src/index.mjs';
import { runCli } from '../bin/modelpace.mjs';
import { MULTI_ACCOUNT_SNAPSHOT, multiAccountPolicy } from './helpers/multi-account.mjs';
import {
  FIXTURE_NOW,
  writeAntigravityFixture,
  writeClaudeFixture,
  writeCodexFixture,
  writeAntigravitySqliteFixture,
  writeOpencodeFixture,
} from './helpers/speed-fixtures.mjs';


function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modelpace-speed-'));
  return {
    home,
    options: {
      claudeDir: path.join(home, 'claude'),
      codexDir: path.join(home, 'codex'),
      opencodeDb: path.join(home, 'opencode', 'opencode.db'),
      antigravityPaths: [path.join(home, 'antigravity')],
      cacheFile: path.join(home, 'cache', 'speed-cache.json'),
      homeDir: path.join(home, 'no-home'),
    },
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

async function writeAllFixtures({ options }) {
  return {
    claude: writeClaudeFixture(options.claudeDir),
    codex: writeCodexFixture(options.codexDir),
    opencode: await writeOpencodeFixture(options.opencodeDb),
    antigravity: writeAntigravityFixture(options.antigravityPaths[0]),
  };
}

const record = (overrides = {}) => ({
  date: '2026-11-23', taskId: null, title: 't', task: 'slice',
  executor: { provider: 'codex', model: 'gpt-5.3-codex', effort: 'high', tier: 'personal', site: 'local' },
  scorer: 'test', accepted: true, firstPass: true, reworkRounds: 0, scopeViolation: false,
  falseReport: false, stoppedOnDenial: null, durationMin: 3, quotaDelta: 1, note: '',
  ...overrides,
});

test('histogram median stays within 1% of the exact median and round-trips through pairs', () => {
  let seed = 7;
  const random = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  for (const count of [999, 1000]) {
    const values = Array.from({ length: count }, () => Math.exp(Math.log(5) + random() * Math.log(400)));
    const bins = new Map();
    for (const value of values) addToBins(bins, value);
    const sorted = [...values].sort((a, b) => a - b);
    const exact = count % 2 ? sorted[(count - 1) / 2] : (sorted[count / 2 - 1] + sorted[count / 2]) / 2;
    assert.ok(Math.abs(binsMedian(bins) - exact) / exact <= 0.01);
    const pairs = binsToPairs(bins);
    assert.equal(pairs.length % 2, 0);
    assert.equal(pairs.filter((_, index) => index % 2 === 1).reduce((a, b) => a + b, 0), count);
  }
  assert.equal(binsMedian(new Map()), null);
});

test('speedSample rejects short outputs and implausible spans; speedModel strips Antigravity variants only', () => {
  assert.equal(speedSample(99, 0, 10_000), null);
  assert.equal(speedSample(500, 0, 400), null);
  assert.equal(speedSample(500, 0, 900_000), null);
  assert.equal(speedSample(500, 5_000, 1_000), null);
  assert.equal(speedSample(Number.NaN, 0, 10_000), null);
  assert.deepEqual(speedSample(1000, 0, 10_000), { outputTokens: 1000, seconds: 10, tokensPerSecond: 100 });

  assert.equal(speedModel('antigravity', 'gemini-4-argon-high-trial'), 'gemini-4-argon');
  assert.equal(speedModel('antigravity', 'gemini-4-hydrogen-xhigh'), 'gemini-4-hydrogen');
  assert.equal(speedModel('claude', 'claude-opus-5-5-high'), 'claude-opus-5-5-high');
});

test('scanSpeed reads Claude, Codex, OpenCode and Antigravity fixtures and ranks them', async () => {
  const env = makeHome();
  try {
    await writeAllFixtures(env);
    const scan = await scanSpeed({ ...env.options, now: FIXTURE_NOW });
    assert.deepEqual(scan.warnings, []);
    assert.deepEqual(
      Object.fromEntries(Object.entries(scan.sources).map(([key, value]) => [key, value.files])),
      { claude: 1, codex: 1, opencode: 1, antigravity: 1 },
    );

    const ranking = rankSpeedRows(scan.rows);
    const byModel = Object.fromEntries(ranking.map((row) => [row.model, row]));
    const claude = byModel['claude-opus-5-5'];
    assert.equal(claude.longRequests, 25);
    assert.equal(claude.shortRequests, 3);
    assert.equal(claude.requests, 28);
    assert.ok(Math.abs(claude.longRate - 100) / 100 <= 0.01);
    assert.ok(Math.abs(claude.shortSeconds - 4) / 4 <= 0.01);
    assert.equal(claude.lowSample, false);

    const codex = byModel['gpt-5.3-codex'];
    assert.equal(codex.longRequests, 25);
    assert.ok(Math.abs(codex.longRate - 150) / 150 <= 0.01);

    const opencode = byModel['deepseek-v4'];
    assert.equal(opencode.provider, 'opencode');
    assert.equal(opencode.longRequests, 12);
    assert.equal(opencode.lowSample, true);
    assert.ok(Math.abs(opencode.longRate - 150) / 150 <= 0.01);

    const gemini = ranking.filter((row) => row.provider === 'antigravity');
    assert.equal(gemini.length, 1);
    assert.equal(gemini[0].model, 'gemini-4-hydrogen');
    assert.equal(gemini[0].longRequests, 21);
    assert.ok(Math.abs(gemini[0].longRate - 200) / 200 <= 0.01);

    assert.deepEqual(ranking.map((row) => row.model), ['gemini-4-hydrogen', 'gpt-5.3-codex', 'deepseek-v4', 'claude-opus-5-5']);
  } finally {
    env.cleanup();
  }
});

test('scanSpeed reuses cached files by path, mtime and size and rescans only changed ones', async () => {
  const env = makeHome();
  try {
    const files = await writeAllFixtures(env);
    const stats = (scan) => Object.fromEntries(Object.entries(scan.sources).map(([key, value]) => [key, [value.scanned, value.cached]]));

    const first = await scanSpeed({ ...env.options, now: FIXTURE_NOW });
    assert.deepEqual(stats(first), { claude: [1, 0], codex: [1, 0], opencode: [1, 0], antigravity: [1, 0] });
    assert.ok(fs.existsSync(env.options.cacheFile));
    if (process.platform !== 'win32') assert.equal(fs.statSync(env.options.cacheFile).mode & 0o777, 0o600);

    const second = await scanSpeed({ ...env.options, now: FIXTURE_NOW });
    assert.deepEqual(stats(second), { claude: [0, 1], codex: [0, 1], opencode: [0, 1], antigravity: [0, 1] });
    assert.deepEqual(rankSpeedRows(second.rows), rankSpeedRows(first.rows));

    fs.appendFileSync(files.codex, `${JSON.stringify({ timestamp: new Date(FIXTURE_NOW).toISOString(), type: 'turn_context', payload: { model: 'gpt-5.3-codex' } })}\n`);
    fs.utimesSync(files.codex, new Date(FIXTURE_NOW + 1000), new Date(FIXTURE_NOW + 1000));
    const third = await scanSpeed({ ...env.options, now: FIXTURE_NOW });
    assert.deepEqual(stats(third), { claude: [0, 1], codex: [1, 0], opencode: [0, 1], antigravity: [0, 1] });

    const farFuture = await scanSpeed({ ...env.options, now: FIXTURE_NOW + 400 * 86_400_000, days: 1 });
    assert.deepEqual(farFuture.rows, []);
    const afterWindow = await scanSpeed({ ...env.options, now: FIXTURE_NOW });
    assert.deepEqual(stats(afterWindow), { claude: [0, 1], codex: [0, 1], opencode: [0, 1], antigravity: [0, 1] });

    fs.writeFileSync(env.options.cacheFile, '{ broken', 'utf8');
    const fourth = await scanSpeed({ ...env.options, now: FIXTURE_NOW });
    assert.equal(stats(fourth).claude[0], 1);
  } finally {
    env.cleanup();
  }
});

test('scanSpeed degrades silently on missing sources and honors the day window', async () => {
  const env = makeHome();
  try {
    const empty = await scanSpeed({ ...env.options, now: FIXTURE_NOW });
    assert.deepEqual(empty.rows, []);
    assert.deepEqual(empty.warnings, []);

    writeClaudeFixture(env.options.claudeDir);
    const later = await scanSpeed({ ...env.options, now: FIXTURE_NOW + 40 * 86_400_000, days: 30, cache: false });
    assert.deepEqual(later.rows, []);
    assert.equal(later.sources.claude.skipped, 1);

    fs.mkdirSync(path.dirname(env.options.opencodeDb), { recursive: true });
    fs.writeFileSync(env.options.opencodeDb, 'not a database');
    const broken = await scanSpeed({ ...env.options, now: FIXTURE_NOW, providers: ['opencode'], cache: false });
    assert.deepEqual(broken.rows, []);
    assert.match(broken.warnings[0], /opencode/);
  } finally {
    env.cleanup();
  }
});

test('dispatch pass shares the authoritative success formula of scores.mjs and a bad ledger hides the column', async () => {
  const records = [
    record(),
    record({ reworkRounds: 1 }),
    record({ reworkRounds: 2 }),
    record({ falseReport: true }),
    record({ scopeViolation: true }),
    record({ accepted: false }),
    record({ stoppedOnDenial: false }),
    record({ executor: { provider: 'antigravity', model: 'gemini-4-hydrogen', effort: 'high', tier: 'personal', site: 'local' } }),
  ];
  const scores = speedDispatchScores(records);
  const codex = scores.find((score) => score.provider === 'codex');
  assert.deepEqual([codex.successes, codex.total], [2, 7]);

  const summary = summarizeDispatchScores(records);
  const cell = summary.cells.find((c) => c.identity.startsWith('codex/'));
  assert.deepEqual([cell.s, cell.s + cell.f], [codex.successes, codex.total]);

  const env = makeHome();
  try {
    await writeAllFixtures(env);
    const ledger = path.join(env.home, 'scores.jsonl');
    fs.writeFileSync(ledger, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
    const speed = await collectSpeed({ days: 30, now: FIXTURE_NOW, scan: env.options, scoresFile: ledger });
    const row = speed.ranking.find((r) => r.model === 'gpt-5.3-codex');
    assert.deepEqual(row.dispatch, { successes: 2, total: 7 });
    assert.equal(speed.ranking.find((r) => r.model === 'deepseek-v4').dispatch, null);

    fs.appendFileSync(ledger, `${JSON.stringify({ ...records[0], task: 'bogus' })}\n`);
    const hidden = await collectSpeed({ days: 30, now: FIXTURE_NOW, scan: env.options, scoresFile: ledger });
    assert.ok(hidden.ranking.every((r) => r.dispatch === null));
  } finally {
    env.cleanup();
  }
});

test('splitSparseRows folds low-sample rows unless every row is sparse', () => {
  const rows = [{ id: 1, lowSample: false }, { id: 2, lowSample: true }];
  assert.deepEqual(splitSparseRows(rows), { solid: [rows[0]], sparse: [rows[1]] });
  const sparse = [{ id: 3, lowSample: true }];
  assert.deepEqual(splitSparseRows(sparse), { solid: sparse, sparse: [] });
});

test('toSpeedMetricsMap feeds decideDispatch and skips low-sample rows', async () => {
  const env = makeHome();
  try {
    await writeAllFixtures(env);
    const scan = await scanSpeed({ ...env.options, now: FIXTURE_NOW });
    const ranking = rankSpeedRows(scan.rows);
    const metrics = toSpeedMetricsMap(ranking);
    assert.ok(Math.abs(metrics['gpt-5.3-codex'].longRate - 150) / 150 <= 0.01);
    assert.equal(metrics['deepseek-v4'], undefined);

    const lowSample = toSpeedMetricsMap(ranking.map((row) => ({ ...row, lowSample: true })));
    assert.deepEqual(lowSample, {});

    const snapshot = normalizeSnapshot(JSON.parse(fs.readFileSync(MULTI_ACCOUNT_SNAPSHOT, 'utf8')), { now: Date.parse('2026-11-23T07:05:00.000Z') });
    const decision = decideDispatch({
      snapshot,
      policy: multiAccountPolicy(),
      speedMetrics: metrics,
      request: { task: 'slice' },
      now: Date.parse('2026-11-23T07:05:00.000Z'),
    });
    const codexCandidate = decision.candidates.find((c) => c.model === 'gpt-5.3-codex');
    assert.equal(codexCandidate.speedLongRate, metrics['gpt-5.3-codex'].longRate);
  } finally {
    env.cleanup();
  }
});

test('scanSpeed reads SQLite speed_events databases next to JSONL events and ignores unrelated tables', async () => {
  const env = makeHome();
  try {
    await writeAntigravitySqliteFixture(path.join(env.options.antigravityPaths[0], 'events.db'));
    fs.writeFileSync(path.join(env.options.antigravityPaths[0], 'notes.sqlite'), 'not a database');
    writeAntigravityFixture(env.options.antigravityPaths[0]);
    const scan = await scanSpeed({ ...env.options, now: FIXTURE_NOW, providers: ['antigravity'], cache: false });
    assert.deepEqual(scan.warnings, []);
    assert.equal(scan.sources.antigravity.files, 3);
    const [row] = rankSpeedRows(scan.rows);
    assert.equal(row.model, 'gemini-4-hydrogen');
    const argon = rankSpeedRows(scan.rows).find((r) => r.model === 'gemini-4-argon');
    assert.equal(argon.requests, 8);
    assert.equal(argon.longRequests, 8);
    assert.ok(Math.abs(argon.longRate - 50) / 50 <= 0.01);
  } finally {
    env.cleanup();
  }
});

test('cacheHitRate aggregates Claude, Codex, and generic events, ignores missing cache fields, and invalidates v1 cache', async () => {
  const env = makeHome();
  try {
    const t0 = FIXTURE_NOW - 1800_000;
    const iso = (ms) => new Date(ms).toISOString();

    // 1. Claude Code: same message.id takes max across streaming chunks; total = input + cache_read + cache_creation
    const claudeFile = path.join(env.options.claudeDir, 'proj', 'cache.jsonl');
    fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
    fs.writeFileSync(
      claudeFile,
      [
        { type: 'user', uuid: 'u1', timestamp: iso(t0), message: { role: 'user', content: 'hi' } },
        {
          type: 'assistant',
          timestamp: iso(t0 + 1000),
          message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 400, cache_creation_input_tokens: 100, output_tokens: 20 } },
        },
        {
          type: 'assistant',
          timestamp: iso(t0 + 10_000),
          message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 50, cache_read_input_tokens: 850, cache_creation_input_tokens: 100, output_tokens: 1200 } },
        },
        { type: 'user', uuid: 'u2', timestamp: iso(t0 + 20_000), message: { role: 'user', content: 'no cache fields' } },
        {
          type: 'assistant',
          timestamp: iso(t0 + 30_000),
          message: { id: 'm2', model: 'claude-sonnet-5-5', usage: { input_tokens: 500, output_tokens: 1000 } },
        },
      ].map((x) => JSON.stringify(x)).join('\n') + '\n',
    );
    fs.utimesSync(claudeFile, new Date(FIXTURE_NOW), new Date(FIXTURE_NOW));

    // 2. Codex: token_count + token_usage_record (with both cached_input_tokens and input_tokens_details.cached_tokens) and clamping
    const codexFile = path.join(env.options.codexDir, 'rollout-cache.jsonl');
    fs.mkdirSync(path.dirname(codexFile), { recursive: true });
    fs.writeFileSync(
      codexFile,
      [
        { timestamp: iso(t0), type: 'turn_context', payload: { model: 'gpt-5.3-codex' } },
        { timestamp: iso(t0 + 1000), type: 'event_msg', payload: { type: 'task_started' } },
        { timestamp: iso(t0 + 11_000), type: 'response_item', payload: { type: 'message', role: 'assistant' } },
        {
          timestamp: iso(t0 + 11_100),
          type: 'token_usage_record',
          payload: { response_id: 'r1', usage: { input_tokens: 1000, cached_input_tokens: 950, output_tokens: 1200 } },
        },
        { timestamp: iso(t0 + 20_000), type: 'event_msg', payload: { type: 'task_started' } },
        { timestamp: iso(t0 + 30_000), type: 'response_item', payload: { type: 'message', role: 'assistant' } },
        {
          timestamp: iso(t0 + 30_100),
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: { total_tokens: 3000 },
              last_token_usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 1200 }, output_tokens: 1200 },
            },
          },
        },
      ].map((x) => JSON.stringify(x)).join('\n') + '\n',
    );
    fs.utimesSync(codexFile, new Date(FIXTURE_NOW), new Date(FIXTURE_NOW));

    // 3. Generic events (Antigravity / Gemini): camelCase and snake_case, plus missing cache fields on another model
    const agFile = path.join(env.options.antigravityPaths[0], 'events.jsonl');
    fs.mkdirSync(path.dirname(agFile), { recursive: true });
    fs.writeFileSync(
      agFile,
      [
        { model: 'gemini-4-hydrogen-high', outputTokens: 1500, startedAt: iso(t0), endedAt: iso(t0 + 10_000), inputTokens: 1000, cachedInputTokens: 760 },
        { model: 'gemini-4-hydrogen', output_tokens: 1500, started_at: iso(t0 + 15_000), ended_at: iso(t0 + 25_000), input_tokens: 1000, cached_input_tokens: 760 },
        { model: 'gemini-4-argon', outputTokens: 1500, startedAt: iso(t0 + 30_000), endedAt: iso(t0 + 40_000) },
      ].map((x) => JSON.stringify(x)).join('\n') + '\n',
    );
    fs.utimesSync(agFile, new Date(FIXTURE_NOW), new Date(FIXTURE_NOW));

    // Seed a legacy v1 cache with stale/different rows and verify automatic rescan
    fs.mkdirSync(path.dirname(env.options.cacheFile), { recursive: true });
    const stat = fs.statSync(claudeFile);
    fs.writeFileSync(
      env.options.cacheFile,
      JSON.stringify({
        version: 1,
        files: { [claudeFile]: { signature: `${stat.mtimeMs}|${stat.size}`, rows: [] } },
      }),
    );

    const scan = await scanSpeed({ ...env.options, now: FIXTURE_NOW });
    assert.equal(scan.sources.claude.scanned, 1);
    assert.equal(scan.sources.claude.cached, 0);
    const cacheWritten = JSON.parse(fs.readFileSync(env.options.cacheFile, 'utf8'));
    assert.equal(cacheWritten.version, 2);

    const ranking = rankSpeedRows(scan.rows);
    const byModel = Object.fromEntries(ranking.map((r) => [r.model, r]));

    assert.equal(byModel['claude-opus-5-5'].inputTokens, 1000);
    assert.equal(byModel['claude-opus-5-5'].cachedInputTokens, 850);
    assert.equal(byModel['claude-opus-5-5'].cacheHitRate, 0.85);

    assert.equal(byModel['claude-sonnet-5-5'].inputTokens, 0);
    assert.equal(byModel['claude-sonnet-5-5'].cacheHitRate, null);

    // Codex: r1 (950/1000) + token_count (clamped 1000/1000) => 1950/2000 = 0.975
    assert.equal(byModel['gpt-5.3-codex'].inputTokens, 2000);
    assert.equal(byModel['gpt-5.3-codex'].cachedInputTokens, 1950);
    assert.equal(byModel['gpt-5.3-codex'].cacheHitRate, 0.975);

    assert.equal(byModel['gemini-4-hydrogen'].inputTokens, 2000);
    assert.equal(byModel['gemini-4-hydrogen'].cachedInputTokens, 1520);
    assert.equal(byModel['gemini-4-hydrogen'].cacheHitRate, 0.76);

    assert.equal(byModel['gemini-4-argon'].cacheHitRate, null);

    // CLI text output displays cache= column when any row has cacheHitRate, and '—' for missing ones
    const cliEnv = {
      MODELPACE_CLAUDE_DIR: env.options.claudeDir,
      MODELPACE_CODEX_DIR: env.options.codexDir,
      MODELPACE_OPENCODE_DB: env.options.opencodeDb,
      MODELPACE_ANTIGRAVITY_PATHS: env.options.antigravityPaths[0],
      MODELPACE_SPEED_CACHE: env.options.cacheFile,
      PATH: '',
    };
    let textOut = '';
    assert.equal(await runCli(['speed', '--days', '30'], { env: cliEnv, write: (s) => { textOut += s; }, now: () => FIXTURE_NOW }), 0);
    assert.match(textOut, /claude-opus-5-5.*cache=85\.0%/);
    assert.match(textOut, /gpt-5\.3-codex.*cache=97\.5%/);
    assert.match(textOut, /gemini-4-hydrogen.*cache=76\.0%/);
    assert.match(textOut, /claude-sonnet-5-5.*cache=—/);

    let jsonOut = '';
    assert.equal(await runCli(['speed', '--days', '30', '--format', 'json'], { env: cliEnv, write: (s) => { jsonOut += s; }, now: () => FIXTURE_NOW }), 0);
    const parsed = JSON.parse(jsonOut);
    assert.equal(parsed.ranking.find((r) => r.model === 'gpt-5.3-codex').cacheHitRate, 0.975);
    assert.equal(parsed.ranking.find((r) => r.model === 'gemini-4-argon').cacheHitRate, null);

    // When no row has cacheHitRate, text output omits the cache column for backward compatibility
    const noCacheText = formatSpeedText({
      days: 30,
      ranking: [{ ...byModel['gemini-4-argon'], cacheHitRate: null }],
      warnings: [],
    }).join('\n');
    assert.doesNotMatch(noCacheText, /cache=/);
  } finally {
    env.cleanup();
  }
});
