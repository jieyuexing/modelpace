// 生成式测试挖出的缺陷，缩成最小的固定输入用例。
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideDispatch, summarizeDispatchScores } from '../src/index.mjs';

const NOW = Date.parse('2026-11-23T07:00:00.000Z');
const fresh = new Date(NOW - 60_000).toISOString();

const record = (provider, durationMin) => ({
  date: '2026-11-23', taskId: null, title: 't', task: 'slice',
  executor: { provider, model: 'm', effort: 'default', tier: 'default', site: 'local' },
  scorer: 'orchestrator', accepted: true, firstPass: true, reworkRounds: 0, scopeViolation: false,
  falseReport: false, stoppedOnDenial: null, durationMin, quotaDelta: null, note: '',
});

const PERMUTATIONS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

test('qualified ranking with near-tie durations does not depend on config order', () => {
  // 10 / 11 / 12 分钟：两两相邻都在 15% 内，但 10 与 12 差 20%。逐对“容差内算平”不传递，
  // 再叠加 speed 决胜就成环，旧实现的推荐随候选在配置里的先后而变。
  const records = [10, 11, 12].flatMap((minutes, i) => Array.from({ length: 6 }, () => record(`p${i}`, minutes)));
  const scoresSummary = summarizeDispatchScores(records);
  const speedMetrics = { 'p0/m/default/default': 1, 'p1/m/default/default': 2, 'p2/m/default/default': 3 };
  const candidates = [0, 1, 2].map((i) => ({ id: `c${i}`, instanceId: `p${i}`, model: 'm', priority: i + 1 }));
  const snapshot = {
    schemaVersion: 2,
    instances: Object.fromEntries([0, 1, 2].map((i) => [`p${i}`, { driver: 'codex', enabled: true, status: 'ready', checkedAt: fresh, windows: [] }])),
  };
  const rankings = PERMUTATIONS.map((order) => decideDispatch({
    snapshot,
    policy: { slots: { worker: { candidates: order.map((i) => candidates[i]) } }, instances: { p0: { scoreProvider: 'p0' }, p1: { scoreProvider: 'p1' }, p2: { scoreProvider: 'p2' } } },
    scoresSummary,
    speedMetrics,
    request: { task: 'slice' },
    now: NOW,
  }).rankedEligibleIds);
  for (const ranking of rankings) assert.deepEqual(ranking, rankings[0]);
  // 10 与 11 同属最快一档（相对最快者差 10%），档内按 speed 取 c1；12 比最快者慢 20%，自成下一档。
  assert.deepEqual(rankings[0], ['c1', 'c0', 'c2']);
});
