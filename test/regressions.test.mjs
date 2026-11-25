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

test('plan does not suggest redeeming a reset credit that cannot clear every blocker', () => {
  // 两个周窗都用尽，卡只覆盖 w0：兑换后 w1 仍然用尽，建议兑换只会白白耗掉这张卡。
  const resetsAt = (hours) => new Date(NOW + hours * 3600000).toISOString();
  const instance = {
    driver: 'codex',
    enabled: true,
    status: 'ready',
    checkedAt: fresh,
    windows: [
      { id: 'w0', kind: 'weekly', usedPercent: 100, resetsAt: resetsAt(127), windowDurationMins: 10080 },
      { id: 'w1', kind: 'weekly', usedPercent: 100, resetsAt: resetsAt(108), windowDurationMins: 10080 },
    ],
    resetCredits: {
      known: true,
      cards: [{ creditId: 'card0', resetType: 'codexRateLimits', status: 'available', resetsLeft: 2, coversWindowIds: ['w0'] }],
    },
  };
  const policy = { slots: { worker: { candidates: [{ id: 'c0', instanceId: 'codex', model: 'm' }] } } };
  const partial = decideDispatch({ snapshot: { schemaVersion: 2, instances: { codex: instance } }, policy, request: { task: 'slice' }, now: NOW });
  assert.equal(partial.action, 'pause');
  assert.equal(partial.redeemCandidate, null);

  // 卡覆盖全部拦截时仍然建议兑换。
  const full = structuredClone(instance);
  full.resetCredits.cards[0].coversWindowIds = ['w0', 'w1'];
  const covered = decideDispatch({ snapshot: { schemaVersion: 2, instances: { codex: full } }, policy, request: { task: 'slice' }, now: NOW });
  assert.equal(covered.action, 'redeem');
  assert.equal(covered.redeemCandidate.creditId, 'card0');
});
