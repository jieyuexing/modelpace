import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {
  buildDashboardData,
  collectDispatchScores,
  decideDispatch,
  normalizeSnapshot,
  rankSpeedRows,
  renderDashboardHtml,
  scanSpeed,
  speedDispatchScores,
} from '../src/index.mjs';
import { MULTI_ACCOUNT_SNAPSHOT, multiAccountPolicy } from './helpers/multi-account.mjs';
import { runCli } from '../bin/modelpace.mjs';
import { runDashboardClient } from './helpers/fake-dom.mjs';
import {
  FIXTURE_NOW,
  writeClaudeFixture,
  writeCodexFixture,
  writeOpencodeFixture,
} from './helpers/speed-fixtures.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SNAPSHOT = path.join(ROOT, 'examples', 'sample-snapshot.json');
const NOW = Date.parse('2026-11-23T07:05:00.000Z');

async function makeInputs({ withLowSample = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelpace-dash-'));
  const options = {
    claudeDir: path.join(dir, 'claude'),
    codexDir: path.join(dir, 'codex'),
    opencodeDb: path.join(dir, 'opencode.db'),
    antigravityPaths: [path.join(dir, 'ag')],
    cacheFile: path.join(dir, 'cache.json'),
  };
  writeClaudeFixture(options.claudeDir);
  writeCodexFixture(options.codexDir);
  if (withLowSample) await writeOpencodeFixture(options.opencodeDb);
  const scan = await scanSpeed({ ...options, now: FIXTURE_NOW });
  const policy = multiAccountPolicy();
  const snapshot = normalizeSnapshot(JSON.parse(fs.readFileSync(MULTI_ACCOUNT_SNAPSHOT, 'utf8')), { now: NOW });
  const decision = decideDispatch({ snapshot, policy, request: { task: 'slice' }, now: NOW });
  const ledger = path.join(dir, 'scores.jsonl');
  fs.writeFileSync(ledger, `${JSON.stringify({
    date: '2026-11-23', taskId: null, title: 't', task: 'slice',
    executor: { provider: 'codex', model: 'gpt-5.3-codex', effort: 'high', tier: 'personal', site: 'local' },
    scorer: 'test', accepted: true, firstPass: true, reworkRounds: 0, scopeViolation: false,
    falseReport: false, stoppedOnDenial: null, durationMin: 3, quotaDelta: 1, note: '',
  })}\n`);
  const scoresSummary = collectDispatchScores({ scoresFile: ledger }, policy.scoring);
  return {
    dir,
    input: {
      decision,
      snapshot,
      scoresSummary,
      speedRanking: rankSpeedRows(scan.rows, speedDispatchScores(scoresSummary.records)),
      options: { now: FIXTURE_NOW, days: 30 },
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('renderDashboardHtml is one self-contained file with three tabs and the Share Image canvas script', async () => {
  const { input, cleanup } = await makeInputs();
  try {
    const html = renderDashboardHtml(input);
    assert.match(html, /^<!doctype html>/);
    assert.doesNotMatch(html, /https?:\/\//i);
    assert.doesNotMatch(html, /<link\b|<script[^>]*\ssrc=/i);
    assert.doesNotMatch(html, /@import|\burl\(/);
    assert.match(html, /prefers-color-scheme: dark/);
    assert.match(html, /var\(--background/);

    for (const needle of ["tabQuota: 'Quota & Even Pace'", "tabSpeed: 'Speed Leaderboard'", "tabScores: 'Scores & Dispatch Audit'",
      "createElement('canvas')", 'toBlob', 'ClipboardItem', 'roundRect', 'Generated with modelpace', 'Dispatch Pass', 'modelpace:share-rows:v1']) {
      assert.ok(html.includes(needle), `missing ${needle}`);
    }
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1);
    assert.doesNotThrow(() => new vm.Script(scripts[0][1]));

    const hostile = renderDashboardHtml({ ...input, speedRanking: input.speedRanking.map((row) => ({ ...row, model: '</script><b>x' })) });
    assert.equal([...hostile.matchAll(/<\/script>/g)].length, 2);
  } finally {
    cleanup();
  }
});

test('buildDashboardData derives Even Pace, pools and the audit without leaking raw records', async () => {
  const { input, cleanup } = await makeInputs();
  try {
    const data = buildDashboardData(input);
    const codex = data.quota.instances.find((inst) => inst.id === 'codex');
    const weekly = codex.windows.find((win) => win.id === 'secondary');
    assert.ok(weekly.remainingTimePercent > 0 && weekly.remainingTimePercent < 100);
    assert.equal(weekly.effectiveRemainingPercent, 60);
    assert.equal(codex.resetCredits.availableCount, 1);
    assert.ok(data.quota.pools.length > 0);
    assert.equal(data.speed.sinceDay, '2026-10-24');
    assert.equal(data.speed.untilDay, '2026-11-23');
    assert.equal(data.decision.candidates.length, input.decision.candidates.length);
    assert.equal(JSON.stringify(data).includes('"records"'), false);
    assert.deepEqual(buildDashboardData({}).quota, { instances: [], pools: [] });
  } finally {
    cleanup();
  }
});

test('buildDashboardData hides instances disabled by policy or snapshot, matching the dispatch decision', () => {
  const policy = multiAccountPolicy();
  policy.instances['antigravity-pro'].enabled = false;
  const raw = JSON.parse(fs.readFileSync(MULTI_ACCOUNT_SNAPSHOT, 'utf8'));
  raw.instances.grok.enabled = false;
  const snapshot = normalizeSnapshot(raw, { now: NOW });
  const decision = decideDispatch({ snapshot, policy, request: { task: 'slice' }, now: NOW });
  assert.ok(decision.candidates.some((c) => c.instanceId === 'antigravity-pro'), 'the decision still audits the disabled candidate');

  const data = buildDashboardData({ decision, snapshot, policy, options: { now: NOW } });
  const shown = data.quota.instances.map((inst) => inst.id);
  assert.deepEqual(shown, ['codex', 'claude', 'antigravity']);
  assert.equal(data.quota.pools.some((pool) => pool.windows.some((w) => w.instance === 'Antigravity Pro')), false);
  assert.equal(data.decision.candidates.some((c) => c.instanceId === 'antigravity-pro'), false);
  assert.ok(data.decision.candidates.length > 0);
  assert.equal(data.decision.recommended.instanceId, decision.recommended.instanceId);
});

test('the dashboard client renders all tabs, EN/ZH, and draws and persists the Share Image', async () => {
  const { input, cleanup } = await makeInputs({ withLowSample: true });
  try {
    const html = renderDashboardHtml(input);
    const page = runDashboardClient(html);
    assert.match(page.text(), /Quota & Even Pace/);
    assert.match(page.text(), /Codex Pro/);
    assert.match(page.text(), /Even Pace/);
    assert.match(page.text(), /resets in/);

    await page.buttons('Speed Leaderboard')[0].click();
    assert.match(page.text(), /Claude Opus 5\.5/);
    assert.match(page.text(), /GPT-5\.3 Codex/);
    assert.match(page.text(), /Dispatch Pass/);
    assert.match(page.text(), /1\/1/);
    assert.equal(page.find((el) => el.className.includes('hatched')).length, 0);
    assert.match(page.text(), /Show 1 low-sample rows/);
    await page.buttons('Show 1 low-sample rows')[0].click();
    assert.equal(page.find((el) => el.className.includes('hatched')).length, 1);

    await page.buttons('Share Image')[0].click();
    await page.flush();
    assert.equal(page.drawn.canvases.at(-1).width, 2400);
    assert.ok(page.drawn.texts.includes('Generated with modelpace'));
    assert.ok(page.drawn.texts.includes('Output Speed of the Models I Use'));
    assert.ok(page.drawn.texts.includes('Claude Opus 5.5'));
    assert.ok(page.drawn.texts.includes('1/1'));
    assert.equal(page.drawn.texts.includes('DeepSeek V4'), false);

    const boxes = page.find((el) => el.tag === 'input');
    assert.equal(boxes.length, 3);
    assert.equal(boxes.filter((box) => box.attributes.checked !== undefined).length, 2);
    const lowSampleBox = page.find((el) => el.tag === 'label' && el.textContent.includes('DeepSeek'))[0].find((el) => el.tag === 'input')[0];
    await lowSampleBox.fire('change', { target: { checked: true } });
    await page.flush();
    assert.ok(page.drawn.texts.includes('DeepSeek V4'));
    assert.deepEqual(Object.values(JSON.parse(page.storage['modelpace:share-rows:v1'])), [true]);

    page.drawn.texts.length = 0;
    await page.buttons('ZH').at(-1).click();
    await page.flush();
    assert.equal(page.storage['modelpace:lang'], 'zh');
    assert.ok(page.drawn.texts.includes('由 modelpace 生成'));
    assert.ok(page.drawn.texts.includes('我用过的模型 · 输出速率排行'));

    await page.buttons('复制到剪贴板')[0].click();
    assert.equal(page.copied.length, 1);

    await page.buttons('关闭')[0].click();
    await page.buttons('验收评分与派发审计')[0].click();
    assert.match(page.text(), /最近一次派发决策/);
    assert.match(page.text(), /gpt-5\.3-codex/);
  } finally {
    cleanup();
  }
});

test('the dashboard client restores the language and share choices from storage and survives empty data', async () => {
  const empty = runDashboardClient(renderDashboardHtml({}), { storage: { 'modelpace:lang': 'zh', 'modelpace:tab': 'speed' } });
  assert.match(empty.text(), /没有找到本地速度样本/);
  const quota = runDashboardClient(renderDashboardHtml({}), { storage: { 'modelpace:tab': 'quota' } });
  assert.match(quota.text(), /No usage snapshot available/);
  const scores = runDashboardClient(renderDashboardHtml({}), { storage: { 'modelpace:tab': 'scores' } });
  assert.match(scores.text(), /No acceptance records/);
  assert.match(scores.text(), /No dispatch decision available/);
});

function isolatedEnv(dir) {
  return {
    MODELPACE_CLAUDE_DIR: path.join(dir, 'claude'),
    MODELPACE_CODEX_DIR: path.join(dir, 'codex'),
    MODELPACE_OPENCODE_DB: path.join(dir, 'opencode.db'),
    MODELPACE_ANTIGRAVITY_PATHS: path.join(dir, 'ag'),
    MODELPACE_SPEED_CACHE: path.join(dir, 'cache.json'),
    PATH: '',
  };
}

test('CLI speed and dashboard commands write text, json and html outputs', async () => {
  const { dir, cleanup } = await makeInputs();
  try {
    const env = isolatedEnv(dir);
    let out = '';
    const write = (s) => { out += s; };
    assert.equal(await runCli(['speed', '--days', '365'], { env, write, now: () => FIXTURE_NOW }), 0);
    assert.match(out, /Speed leaderboard/);

    out = '';
    assert.equal(await runCli(['speed', '--format', 'json', '--scores', path.join(dir, 'scores.jsonl')], { env, write, now: () => FIXTURE_NOW }), 0);
    const parsed = JSON.parse(out);
    assert.equal(parsed.ranking.length, 2);
    assert.ok(parsed.metrics['gpt-5.3-codex'].longRate > 140);
    assert.deepEqual(parsed.ranking.find((r) => r.model === 'gpt-5.3-codex').dispatch, { successes: 1, total: 1 });

    const htmlFile = path.join(dir, 'out', 'speed.html');
    out = '';
    assert.equal(await runCli(['speed', '--format', 'html', '--out', htmlFile], { env, write, now: () => FIXTURE_NOW }), 0);
    assert.match(fs.readFileSync(htmlFile, 'utf8'), /Speed Leaderboard/);

    const dashFile = path.join(dir, 'dash.html');
    assert.equal(await runCli(['dashboard', '--snapshot', SNAPSHOT, '--out', dashFile, '--task', 'slice'], { env, write, now: () => NOW }), 0);
    const dash = fs.readFileSync(dashFile, 'utf8');
    assert.match(dash, /Codex Pro/);
    assert.doesNotMatch(dash, /https?:\/\//);

    await assert.rejects(() => runCli(['speed', '--format', 'pdf'], { env, write }), /--format must be/);
    await assert.rejects(() => runCli(['speed', '--days', '0'], { env, write }), /--days must be/);
  } finally {
    cleanup();
  }
});

test('plan --speed-scan folds measured local speed into the decision', async () => {
  const { dir, cleanup } = await makeInputs();
  try {
    let out = '';
    await runCli(['plan', '--snapshot', SNAPSHOT, '--task', 'slice', '--speed-scan', '--format', 'json'], {
      env: isolatedEnv(dir),
      write: (s) => { out += s; },
      now: () => FIXTURE_NOW,
    });
    const codex = JSON.parse(out).candidates.find((c) => c.model === 'gpt-5.3-codex');
    assert.ok(Math.abs(codex.speedLongRate - 150) / 150 <= 0.01);
  } finally {
    cleanup();
  }
});

test('serve exposes the live dashboard over HTTP on localhost and stops on abort', async () => {
  const { dir, cleanup } = await makeInputs();
  const controller = new AbortController();
  try {
    let out = '';
    const served = runCli(['serve', '--port', '0', '--snapshot', SNAPSHOT], {
      env: isolatedEnv(dir),
      write: (s) => { out += s; },
      now: () => NOW,
      signal: controller.signal,
    });
    while (!/https?:\/\/\S+/.test(out)) await new Promise((resolve) => setImmediate(resolve));
    const url = out.match(/http:\/\/\S+/)[0];
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);

    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const html = await page.text();
    assert.match(html, /"live":true/);
    assert.match(html, /Codex Pro/);

    const api = await (await fetch(new URL('api/data', url))).json();
    assert.equal(api.live, true);
    assert.ok(api.quota.instances.length > 0);

    assert.equal((await fetch(new URL('secret', url))).status, 404);
    assert.equal((await fetch(url, { method: 'POST' })).status, 404);

    controller.abort();
    assert.equal(await served, 0);
    await assert.rejects(() => fetch(url));
  } finally {
    controller.abort();
    cleanup();
  }
});
