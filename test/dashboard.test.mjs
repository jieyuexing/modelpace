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

function runShareCanvasProbe(html, { storage = {} } = {}) {
  const scripts = [...html.matchAll(/<script(?: type="application\/json" id="t3d-data")?>([\s\S]*?)<\/script>/g)];
  const dataText = html.match(/<script type="application\/json" id="t3d-data">([\s\S]*?)<\/script>/)[1];
  const clientScript = scripts.map((match) => match[1]).find((code) => code !== dataText);
  const elements = new Map();
  class NodeLike {
    constructor() { this.children = []; }
    append(...items) { for (const item of items) this.children.push(typeof item === 'string' ? { textContent: item } : item); }
    replaceChildren(...items) { this.children = []; this.append(...items); }
    remove() {}
    get textContent() { return this.children.map((c) => c.textContent ?? '').join(''); }
    set textContent(v) { this.children = v === '' ? [] : [{ textContent: String(v) }]; }
  }
  class ElLike extends NodeLike {
    constructor(tag) { super(); this.tag = tag; this.attributes = {}; this.listeners = {}; this.className = ''; }
    setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'id') elements.set(String(value), this); }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    async click() { for (const fn of this.listeners.click ?? []) await fn({ target: this, currentTarget: this }); }
    find(pred, out = []) {
      for (const c of this.children) {
        if (c instanceof ElLike) { if (pred(c)) out.push(c); c.find(pred, out); }
      }
      return out;
    }
  }
  const root = new ElLike('div');
  const dataEl = new ElLike('script');
  dataEl.textContent = dataText;
  const canvases = [];
  const makeCanvas = () => {
    const ops = { texts: [], rects: [], roundRects: [] };
    const canvas = {
      width: 0,
      height: 0,
      ops,
      getContext: () => {
        const state = { textAlign: 'left', font: '' };
        return new Proxy(
          {
            measureText: (text) => ({ width: String(text).length * 8 }),
            createLinearGradient: () => ({ addColorStop() {} }),
            createRadialGradient: () => ({ addColorStop() {} }),
          },
          {
            get: (target, key) => target[key] ?? ((...args) => {
              if (key === 'fillText') ops.texts.push({ value: args[0], x: args[1], y: args[2], align: state.textAlign });
              if (key === 'fillRect') ops.rects.push({ x: args[0], y: args[1], w: args[2], h: args[3] });
              if (key === 'roundRect') ops.roundRects.push({ x: args[0], y: args[1], w: args[2], h: args[3] });
            }),
            set: (_t, key, value) => { state[key] = value; return true; },
          },
        );
      },
      toBlob: (cb) => cb(new Blob(['png'], { type: 'image/png' })),
    };
    canvases.push(canvas);
    return canvas;
  };
  const document = {
    title: '',
    documentElement: { lang: 'en' },
    body: new ElLike('body'),
    getElementById: (id) => (id === 't3d-data' ? dataEl : id === 't3d-root' ? root : elements.get(id) ?? null),
    createElement: (tag) => (tag === 'canvas' ? makeCanvas() : new ElLike(tag)),
    createTextNode: (text) => ({ textContent: String(text) }),
    querySelector: () => null,
  };
  const localStorage = { getItem: (k) => storage[k] ?? null, setItem: (k, v) => { storage[k] = String(v); } };
  vm.runInNewContext(clientScript, {
    document, localStorage, Node: NodeLike, Blob, URL, JSON, Math, Date, Number, Object, Set, Promise, Error, String,
    ClipboardItem: class {}, navigator: { clipboard: { write: async () => {} }, language: 'en' },
    fetch: async () => ({ ok: false }), setInterval: () => 0,
  });
  return {
    root,
    canvases,
    buttons: (label) => root.find((el) => el.tag === 'button' && el.textContent === label),
    flush: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

test('Speed table and Share Image render cacheHitRate column with exact coordinates and footnotes (EN/ZH)', async () => {
  const { input, cleanup } = await makeInputs();
  try {
    const withCache = {
      ...input,
      speedRanking: input.speedRanking.map((row, idx) => ({
        ...row,
        cacheHitRate: idx === 0 ? 0.856 : null,
      })),
    };
    const noCache = {
      ...input,
      speedRanking: input.speedRanking.map((row) => ({ ...row, cacheHitRate: null })),
    };

    // 1. Speed table without cacheHitRate stays 7 columns
    const pageNoCache = runDashboardClient(renderDashboardHtml(noCache), { storage: { 'modelpace:tab': 'speed' } });
    const headersNoCache = pageNoCache.find((el) => el.tag === 'th').map((el) => el.textContent);
    assert.deepEqual(headersNoCache, ['#', 'Model', '', 'tok/s', 'Short s', 'Requests', 'Dispatch Pass']);

    // 2. Speed table with cacheHitRate inserts Cache (EN) / 缓存 (ZH) between Requests and Dispatch Pass
    const pageCacheEn = runDashboardClient(renderDashboardHtml(withCache), { storage: { 'modelpace:tab': 'speed' } });
    const headersEn = pageCacheEn.find((el) => el.tag === 'th').map((el) => el.textContent);
    assert.deepEqual(headersEn, ['#', 'Model', '', 'tok/s', 'Short s', 'Requests', 'Cache', 'Dispatch Pass']);
    const tdsEn = pageCacheEn.find((el) => el.tag === 'td').map((el) => ({ cls: el.className, text: el.textContent }));
    assert.ok(tdsEn.some((c) => c.cls === 'num' && c.text === '85.6%'));
    assert.ok(tdsEn.some((c) => c.cls === 'num' && c.text === '—'));

    await pageCacheEn.buttons('ZH')[0].click();
    const headersZh = pageCacheEn.find((el) => el.tag === 'th').map((el) => el.textContent);
    assert.deepEqual(headersZh, ['#', '模型', '', 'tok/s', '短请求秒', '请求数', '缓存', '派发通过']);

    // 3. Share Image: showCache && showDispatch
    const probeBoth = runShareCanvasProbe(renderDashboardHtml(withCache), { storage: { 'modelpace:tab': 'speed' } });
    await probeBoth.buttons('Share Image')[0].click();
    await probeBoth.flush();
    const canvasBothEn = probeBoth.canvases.at(-1);
    assert.equal(canvasBothEn.width, 2400);
    const findText = (canvas, value) => canvas.ops.texts.find((t) => t.value === value);
    assert.equal(findText(canvasBothEn, 'tok/s').x, 928);
    assert.equal(findText(canvasBothEn, 'Cache').x, 1028);
    assert.equal(findText(canvasBothEn, 'Tasks passed').x, 1140);
    assert.equal(findText(canvasBothEn, '85.6%').x, 1028);
    assert.equal(findText(canvasBothEn, '—').x, 1028);
    assert.equal(findText(canvasBothEn, '1/1').x, 1140);
    for (const op of canvasBothEn.ops.texts) assert.ok(op.x <= 1140, `text x=${op.x} exceeds 1140`);
    const trackBarsBoth = canvasBothEn.ops.roundRects.filter((r) => r.x === 412);
    assert.ok(trackBarsBoth.length >= 1);
    for (const bar of trackBarsBoth) assert.ok(bar.x + bar.w <= 840, `bar right ${bar.x + bar.w} overlaps rate col`);
    const allTextsEn = canvasBothEn.ops.texts.map((t) => t.value).join('\n');
    assert.match(allTextsEn, /Cache = cached input tokens ÷ total input tokens across scanned requests/);

    await probeBoth.buttons('ZH').at(-1).click();
    await probeBoth.flush();
    const canvasBothZh = probeBoth.canvases.at(-1);
    assert.equal(findText(canvasBothZh, '速率 tok/s').x, 928);
    assert.equal(findText(canvasBothZh, '缓存命中').x, 1028);
    assert.equal(findText(canvasBothZh, '派发通过').x, 1140);
    assert.match(
      canvasBothZh.ops.texts.map((t) => t.value).join('\n'),
      /缓存命中 = 命中缓存的输入 token ÷ 总输入 token/,
    );

    // 4. Share Image: showCache && !showDispatch
    const withCacheNoDispatch = {
      ...withCache,
      speedRanking: withCache.speedRanking.map((row) => ({ ...row, dispatch: null })),
    };
    const probeCacheOnly = runShareCanvasProbe(renderDashboardHtml(withCacheNoDispatch), { storage: { 'modelpace:tab': 'speed' } });
    await probeCacheOnly.buttons('Share Image')[0].click();
    await probeCacheOnly.flush();
    const canvasCacheOnly = probeCacheOnly.canvases.at(-1);
    assert.equal(findText(canvasCacheOnly, 'tok/s').x, 1040);
    assert.equal(findText(canvasCacheOnly, 'Cache').x, 1140);
    assert.equal(findText(canvasCacheOnly, 'Tasks passed'), undefined);
    assert.equal(findText(canvasCacheOnly, '85.6%').x, 1140);
    const trackBarsCacheOnly = canvasCacheOnly.ops.roundRects.filter((r) => r.x === 412);
    for (const bar of trackBarsCacheOnly) assert.ok(bar.x + bar.w <= 952, `bar right ${bar.x + bar.w} overlaps rate col`);
    for (const op of canvasCacheOnly.ops.texts) assert.ok(op.x <= 1140, `text x=${op.x} exceeds 1140`);
    const cacheOnlyText = canvasCacheOnly.ops.texts.map((t) => t.value).join('\n');
    assert.match(cacheOnlyText, /Cache = cached input tokens/);
    assert.doesNotMatch(cacheOnlyText, /Tasks passed =/);

    // 5. Share Image: !showCache && showDispatch retains legacy geometry (trackW=528, rateR=1028, passR=1140)
    const probeLegacy = runShareCanvasProbe(renderDashboardHtml(noCache), { storage: { 'modelpace:tab': 'speed' } });
    await probeLegacy.buttons('Share Image')[0].click();
    await probeLegacy.flush();
    const canvasLegacy = probeLegacy.canvases.at(-1);
    assert.equal(findText(canvasLegacy, 'tok/s').x, 1028);
    assert.equal(findText(canvasLegacy, 'Tasks passed').x, 1140);
    assert.equal(findText(canvasLegacy, 'Cache'), undefined);
    for (const bar of canvasLegacy.ops.roundRects.filter((r) => r.x === 412)) {
      assert.ok(bar.x + bar.w <= 940, `bar right ${bar.x + bar.w} overlaps rate col`);
    }
  } finally {
    cleanup();
  }
});

test('buildDashboardData forwards abort/cancel stats and Scores table renders Aborts column only when present (EN/ZH)', async () => {
  const policy = multiAccountPolicy();
  const baseCell = {
    date: '2026-11-23', taskId: null, title: 't', task: 'slice',
    scorer: 'test', accepted: true, firstPass: true, reworkRounds: 0, scopeViolation: false,
    falseReport: false, stoppedOnDenial: null, durationMin: 3, quotaDelta: 1, note: '',
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelpace-aborts-'));
  try {
    const cleanLedger = path.join(dir, 'clean.jsonl');
    fs.writeFileSync(cleanLedger, `${JSON.stringify({
      ...baseCell,
      executor: { provider: 'codex', model: 'gpt-5.3-codex', effort: 'high', tier: 'personal', site: 'local' },
    })}\n`);
    const cleanSummary = collectDispatchScores({ scoresFile: cleanLedger }, policy.scoring);
    const cleanData = buildDashboardData({ scoresSummary: cleanSummary, options: { now: NOW } });
    assert.equal(cleanData.scores.cells[0].aborted, 0);
    assert.equal(cleanData.scores.cells[0].cancelled, 0);
    assert.deepEqual(cleanData.scores.cells[0].abortReasons, {});

    const cleanPage = runDashboardClient(renderDashboardHtml({ scoresSummary: cleanSummary, options: { now: NOW } }), { storage: { 'modelpace:tab': 'scores' } });
    const cleanHeaders = cleanPage.find((el) => el.tag === 'table')[0].find((el) => el.tag === 'th').map((el) => el.textContent);
    assert.deepEqual(cleanHeaders, ['Identity', 'Task', 'Pass rate', '90% interval', 'n', 'Median min', 'Cost / run']);

    const abortLedger = path.join(dir, 'aborts.jsonl');
    const mkExec = (model) => ({ provider: 'codex', model, effort: 'high', tier: 'personal', site: 'local' });
    const rows = [
      { ...baseCell, executor: mkExec('model-a'), accepted: false, firstPass: false, durationMin: null, outcome: 'failed', abortReason: 'quota' },
      { ...baseCell, executor: mkExec('model-a'), accepted: false, firstPass: false, durationMin: null, outcome: 'interrupted', abortReason: 'stall' },
      { ...baseCell, executor: mkExec('model-b'), accepted: false, firstPass: false, durationMin: null, outcome: 'cancelled' },
      { ...baseCell, executor: mkExec('model-c'), accepted: false, firstPass: false, durationMin: null, outcome: 'failed', abortReason: 'error' },
      { ...baseCell, executor: mkExec('model-c'), accepted: false, firstPass: false, durationMin: null, outcome: 'cancelled' },
      { ...baseCell, executor: mkExec('model-d') },
    ];
    fs.writeFileSync(abortLedger, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
    const abortSummary = collectDispatchScores({ scoresFile: abortLedger }, policy.scoring);
    const abortData = buildDashboardData({ scoresSummary: abortSummary, options: { now: NOW } });
    const byId = Object.fromEntries(abortData.scores.cells.map((c) => [c.identity, c]));
    assert.equal(byId['codex/model-a/high/personal'].aborted, 2);
    assert.deepEqual(byId['codex/model-a/high/personal'].abortReasons, { quota: 1, stall: 1 });
    assert.equal(byId['codex/model-b/high/personal'].cancelled, 1);

    const abortPage = runDashboardClient(renderDashboardHtml({ scoresSummary: abortSummary, options: { now: NOW } }), { storage: { 'modelpace:tab': 'scores' } });
    const scoresTableEn = abortPage.find((el) => el.tag === 'table')[0];
    const headersEn = scoresTableEn.find((el) => el.tag === 'th').map((el) => el.textContent);
    assert.deepEqual(headersEn, ['Identity', 'Task', 'Pass rate', '90% interval', 'n', 'Median min', 'Cost / run', 'Aborts']);
    const trsEn = scoresTableEn.find((el) => el.tag === 'tbody')[0].find((el) => el.tag === 'tr');
    assert.equal(trsEn[0].find((el) => el.tag === 'td').at(-1).textContent, '2 (quota:1, stall:1)');
    assert.equal(trsEn[1].find((el) => el.tag === 'td').at(-1).textContent, '1 cancelled');
    assert.equal(trsEn[2].find((el) => el.tag === 'td').at(-1).textContent, '1 aborted, 1 cancelled (error:1)');
    assert.equal(trsEn[3].find((el) => el.tag === 'td').at(-1).textContent, '—');

    await abortPage.buttons('ZH')[0].click();
    const scoresTableZh = abortPage.find((el) => el.tag === 'table')[0];
    const headersZh = scoresTableZh.find((el) => el.tag === 'th').map((el) => el.textContent);
    assert.deepEqual(headersZh, ['执行者', '任务', '通过率', '90% 区间', '样本', '耗时中位(分)', '单次成本', '中断/取消']);
    const trsZh = scoresTableZh.find((el) => el.tag === 'tbody')[0].find((el) => el.tag === 'tr');
    assert.equal(trsZh[0].find((el) => el.tag === 'td').at(-1).textContent, '2 (quota:1, stall:1)');
    assert.equal(trsZh[1].find((el) => el.tag === 'td').at(-1).textContent, '1 取消');
    assert.equal(trsZh[2].find((el) => el.tag === 'td').at(-1).textContent, '1 中断, 1 取消 (error:1)');
    assert.equal(trsZh[3].find((el) => el.tag === 'td').at(-1).textContent, '—');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
