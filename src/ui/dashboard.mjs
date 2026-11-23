import fs from 'node:fs';
import http from 'node:http';
import { evaluateWindow } from '../core/pacing.mjs';

const STYLE = fs.readFileSync(new URL('./dashboard.css', import.meta.url), 'utf8');
const CLIENT = fs.readFileSync(new URL('./client.js', import.meta.url), 'utf8');

const DAY_MS = 86_400_000;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

function quotaView(snapshot, nowMs) {
  const instances = [];
  const poolMap = new Map();
  for (const instance of Object.values(snapshot?.instances ?? {})) {
    const windows = (instance.windows ?? [])
      .map((win) => evaluateWindow(win, { now: nowMs }))
      .filter((win) => win.valid)
      .map(({ valid, ...win }) => win);
    for (const win of windows) {
      if (!win.pool) continue;
      if (!poolMap.has(win.pool)) poolMap.set(win.pool, []);
      poolMap.get(win.pool).push({ instance: instance.displayName ?? instance.instanceId, window: win });
    }
    instances.push({
      id: instance.instanceId,
      displayName: instance.displayName ?? instance.instanceId,
      driver: instance.driver ?? null,
      plan: instance.plan ?? null,
      status: instance.status ?? 'unknown',
      windows,
      resetCredits: instance.resetCredits ?? null,
    });
  }
  return { instances, pools: [...poolMap].map(([pool, windows]) => ({ pool, windows })) };
}

const decisionView = (decision) =>
  decision
    ? {
        action: decision.action,
        slot: decision.slot,
        task: decision.task,
        tier: decision.tier,
        nextCheckAt: decision.nextCheckAt,
        recommended: decision.recommended
          ? { instanceId: decision.recommended.instanceId, model: decision.recommended.model }
          : null,
        candidates: decision.candidates.map((c) => ({
          candidateId: c.candidateId,
          instanceId: c.instanceId,
          model: c.model,
          eligible: c.eligible,
          quotaState: c.quotaState,
          qualityTier: c.qualityTier,
          speedLongRate: c.speedLongRate ?? null,
          paceScore: c.paceScore ?? null,
          rejectionReasons: c.rejectionReasons ?? [],
          warnings: c.warnings ?? [],
        })),
      }
    : null;

const scoresView = (summary) => ({
  minSamples: summary?.minSamples ?? 5,
  cells: (summary?.cells ?? []).map(({ identity, task, n, s, f, passRate, interval90, durationMedianMin, costMedian, costCurrency }) => ({
    identity, task, n, s, f, passRate, interval90, durationMedianMin, costMedian, costCurrency,
  })),
});

/** 把派发决策、用量快照、验收评分与速度排行整理成页面数据（不含原始派发记录）。 */
export function buildDashboardData({ decision = null, snapshot = null, scoresSummary = null, speedRanking = [], options = {} } = {}) {
  const nowMs = options.now ?? Date.now();
  const days = options.days ?? 30;
  return {
    generatedAt: new Date(nowMs).toISOString(),
    live: options.live === true,
    quota: quotaView(snapshot, nowMs),
    speed: {
      days,
      sinceDay: day(nowMs - days * DAY_MS),
      untilDay: day(nowMs),
      ranking: speedRanking,
      warnings: options.warnings ?? [],
    },
    scores: scoresView(scoresSummary),
    decision: decisionView(decision),
  };
}

const embedJson = (value) =>
  JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** 输出完全自包含的单文件 HTML：无外部资源，样式与脚本内联。 */
export function renderDashboardHtml(input = {}) {
  const data = buildDashboardData(input);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>t3-dispatch dashboard</title>
<style>${STYLE}</style>
</head>
<body>
<div id="t3d-root"></div>
<script type="application/json" id="t3d-data">${embedJson(data)}</script>
<script>${CLIENT}</script>
</body>
</html>
`;
}

/**
 * 本地轻量服务：GET / 返回页面，GET /api/data 返回当前数据；每次请求重新取数，页面每 15 秒刷新。
 * 默认只绑定本机回环地址。
 */
export async function startDashboardServer({ port = 0, host = '127.0.0.1', load, options = {} } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'GET' || !['/', '/api/data'].includes(url.pathname)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found\n');
      return;
    }
    try {
      const input = { ...(await load()), options: { ...options, live: true, now: Date.now() } };
      if (url.pathname === '/api/data') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(buildDashboardData(input)));
      } else {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(renderDashboardHtml(input));
      }
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(`${error?.message ?? error}\n`);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  return {
    server,
    url: `http://${host === '::1' ? '[::1]' : host}:${address.port}/`,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
