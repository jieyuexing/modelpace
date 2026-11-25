// 决策核的生成式不变式测试（种子化、可复跑，见 test/helpers/prop.mjs）。
// 每条不变式注明出处：文档或代码里的契约行。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TASKS,
  betaQuantile,
  decideDispatch,
  evaluateInstanceCandidate,
  evaluateWindow,
  normalizePolicy,
  summarizeDispatchScores,
} from '../src/index.mjs';
import { forAll } from './helpers/prop.mjs';

const NOW = Date.parse('2026-11-23T07:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const DURATIONS = [0, 1, 4, 5, 5.5, 6, 8, 10, 11, 12, 20];
const MODES = ['demote', 'strict', 'advisory'];

function genWindow(g, index) {
  const short = g.bool();
  const duration = short ? 300 : 10080;
  const win = { id: `${short ? 's' : 'w'}${index}`, kind: short ? 'session' : 'weekly' };
  if (g.bool(0.9)) win.windowDurationMins = duration;
  const used = g.pick([0, 100, 50, g.int(0, 100), g.float(0, 100)]);
  if (g.bool(0.8)) win.usedPercent = used;
  else win.remainingPercent = 100 - used;
  if (g.bool(0.9)) win.resetsAt = iso(NOW + g.float(0.5, duration) * 60000);
  return win;
}

function genCard(g, index) {
  return {
    creditId: `card${index}`,
    resetType: g.pick(['custom', 'claudeSession', 'claudeWeekly', 'codexRateLimits']),
    status: g.pick(['available', 'available', 'used']),
    resetsLeft: g.pick([0, 1, 2]),
    ...(g.bool() ? { coversWindowIds: [g.pick(['s0', 's1', 'w0', 'w1', 'five_hour'])] } : {}),
    ...(g.bool(0.7) ? { expiresAt: iso(NOW + g.float(-2, 200) * 3600000) } : {}),
  };
}

function genInstance(g, { staleOnly = false } = {}) {
  const ageMin = staleOnly ? g.pick([15, 16, 60, 600]) : g.pick([0.5, 1, 5, 14.9, 15, 30, -3]);
  return {
    driver: g.pick(['codex', 'claudeAgent', 'antigravity', 'opencode']),
    enabled: g.bool(0.9),
    status: g.pick(['ready', 'ready', 'ready', 'ready', 'unavailable', 'disabled']),
    ...(staleOnly || g.bool(0.95) ? { checkedAt: iso(NOW - ageMin * 60000) } : {}),
    windows: g.array(0, 3, (i) => genWindow(g, i)),
    ...(g.bool(0.4) ? { resetCredits: { known: true, cards: g.array(0, 2, (i) => genCard(g, i)) } } : {}),
  };
}

function genRecords(g, provider, model, effort, task, { ranking = false } = {}) {
  const n = ranking ? g.pick([2, 6, 6, 9, 20]) : g.pick([0, 1, 4, 5, 6, 9, 20]);
  const passRatio = ranking ? g.pick([0.5, 1, 1, 1]) : g.pick([0, 0.5, 0.8, 0.9, 1]);
  const duration = g.pick(DURATIONS);
  return Array.from({ length: n }, (_, i) => ({
    date: '2026-11-23',
    taskId: null,
    title: 't',
    task,
    executor: { provider, model, effort, tier: 'default', site: 'local' },
    scorer: 'orchestrator',
    accepted: i < Math.round(n * passRatio),
    firstPass: true,
    reworkRounds: 0,
    scopeViolation: false,
    falseReport: false,
    stoppedOnDenial: null,
    durationMin: duration,
    quotaDelta: null,
    note: '',
  }));
}

/** 生成一次完整的 decideDispatch 输入；候选 id 与 priority 显式给出且互不相同，排序不靠下标兜底。 */
// ranking=true 时所有实例健康、样本多数达标，让排序本身成为被测对象，而不是被额度门槛挡掉。
function genDecisionInput(g, { staleOnly = false, ranking = false, mode = g.pick(MODES) } = {}) {
  const instanceIds = ['i0', 'i1', 'i2', 'i3'];
  const instances = {};
  for (const id of instanceIds.slice(0, ranking ? 4 : g.int(1, 4))) {
    instances[id] = ranking
      ? { driver: 'codex', enabled: true, status: 'ready', checkedAt: iso(NOW - 60000), windows: [] }
      : genInstance(g, { staleOnly });
  }
  const task = g.pick(TASKS);
  const count = g.int(1, 6);
  const priorities = g.shuffle(Array.from({ length: count }, (_, i) => i + 1));
  const candidates = Array.from({ length: count }, (_, i) => ({
    id: `c${i}`,
    instanceId: g.pick(ranking ? instanceIds : [...instanceIds, 'ghost']),
    model: g.pick(['m1', 'm2']),
    effort: `e${i}`,
    priority: priorities[i],
    ...(!ranking && g.bool(0.1) ? { enabled: false } : {}),
    ...(!ranking && g.bool(0.1) ? { tasks: [g.pick(TASKS)] } : {}),
  }));
  const policy = {
    instances: Object.fromEntries([...instanceIds, 'ghost'].map((id) => [id, { scoreProvider: id }])),
    slots: { worker: { candidates } },
    taskToSlot: Object.fromEntries(TASKS.map((t) => [t, 'worker'])),
    scoring: { mode },
  };
  const records = candidates.flatMap((c) => genRecords(g, c.instanceId, c.model, c.effort, task, { ranking }));
  const speedMetrics = Object.fromEntries(
    candidates.filter(() => g.bool(0.5)).map((c) => [`${c.instanceId}/${c.model}/${c.effort}/default`, { longRate: g.pick([10, 50, 100]) }]),
  );
  return {
    snapshot: { schemaVersion: 2, observedAt: iso(NOW), instances },
    policy,
    scoresSummary: summarizeDispatchScores(records),
    speedMetrics,
    request: { task, waitMinutes: g.pick([0, 30, 600]) },
    now: NOW,
  };
}

const decide = (input) => decideDispatch(structuredClone(input));
const byId = (decision) => new Map(decision.candidates.map((c) => [c.candidateId, c]));

// docs/SCHEMA.md「scoring」+ README「Exact Beta(1, 1) posterior pass rate and 90% credible intervals」：
// 区间在 [0,1]，点估计（后验均值 passRate）落在 5%–95% 分位之间。scores.mjs:372-376。
test('property: Beta 90% interval stays in [0,1] and brackets the posterior pass rate', () => {
  forAll('beta interval', { runs: 300 }, (g) => ({ s: g.int(0, 150), f: g.int(0, 150) }), ({ s, f }) => {
    const records = [];
    for (let i = 0; i < s + f; i++) {
      records.push({
        date: '2026-11-23', taskId: null, title: 't', task: 'slice',
        executor: { provider: 'p', model: 'm', effort: 'e', tier: 'default', site: 'local' },
        scorer: 'o', accepted: i < s, firstPass: true, reworkRounds: 0, scopeViolation: false,
        falseReport: false, stoppedOnDenial: null, durationMin: 1, quotaDelta: null, note: '',
      });
    }
    const [cell] = summarizeDispatchScores(records).cells;
    if (!cell) return;
    if (cell.n < 5) {
      assert.equal(cell.passRate, null);
      assert.equal(cell.interval90, null);
      return;
    }
    const [lo, hi] = cell.interval90;
    assert.ok(lo >= 0 && hi <= 1, `interval ${lo}..${hi} outside [0,1]`);
    assert.ok(lo <= cell.passRate && cell.passRate <= hi, `passRate ${cell.passRate} outside ${lo}..${hi}`);
  });
});

// betaQuantile 的差分性质：分位函数对 p 单调；Beta(a,b) 与 Beta(b,a) 关于 1/2 对称。scores.mjs:241-258。
test('property: betaQuantile is monotone in p and symmetric under swapping a and b', () => {
  forAll('beta quantile', { runs: 200 }, (g) => ({ a: g.int(1, 300), b: g.int(1, 300), p: g.float(0.01, 0.98) }), ({ a, b, p }) => {
    const q = betaQuantile(p, a, b);
    assert.ok(q > 0 && q < 1);
    assert.ok(betaQuantile(p + 0.01, a, b) >= q - 1e-12, 'quantile must not decrease with p');
    assert.ok(Math.abs(q - (1 - betaQuantile(1 - p, b, a))) < 1e-9, 'Beta(a,b) and Beta(b,a) mirror each other');
  });
});

// Window 视图：README「Compares effectiveRemainingPercent against remainingTimePercent」，pacing.mjs:84-99。
test('property: evaluateWindow keeps percentages in range and classifies pace consistently', () => {
  forAll('evaluateWindow', { runs: 400 }, (g, i) => ({ win: genWindow(g, i), margin: g.pick([1, 10, 25]) }), ({ win, margin }) => {
    const view = evaluateWindow(win, { now: NOW, paceMarginPercent: margin });
    assert.equal(view.valid, true);
    assert.ok(Math.abs(view.usedPercent + view.remainingPercent - 100) <= 1);
    assert.ok(view.effectiveRemainingPercent >= 0 && view.effectiveRemainingPercent <= 100);
    if (view.remainingTimePercent !== null) assert.ok(view.remainingTimePercent > 0 && view.remainingTimePercent <= 100);
    if (view.paceBalancePercent === null) {
      assert.equal(view.pace, 'unknown');
    } else {
      const expected = view.paceBalancePercent >= margin ? 'surplus' : view.paceBalancePercent <= -margin ? 'conserve' : 'balanced';
      assert.equal(view.pace, expected);
    }
  });
});

// Even Pace 门槛单调：同一窗口少用一些额度，不会多出拦截，也不会让原本 available 的候选变得不可用。
// pacing.mjs:421-486。只测不带重置卡的 Even Pace 门槛：带卡时“卡在耗尽前是否过期”与“临近重置不用卡”
// 都会让结论随余量非单调变化，属于设计取舍，不在这里断言。
test('property: using less of a window never adds blockers or loses the available state', () => {
  forAll('pace monotone', { runs: 400 }, (g) => {
    const instance = genInstance(g);
    instance.enabled = true;
    instance.status = 'ready';
    instance.checkedAt = iso(NOW - 60000);
    delete instance.resetCredits;
    const index = instance.windows.length ? g.int(0, instance.windows.length - 1) : -1;
    return { instance, index, less: g.float(0, 100), task: g.pick(TASKS) };
  }, ({ instance, index, less, task }) => {
    if (index < 0) return;
    const policy = normalizePolicy({ slots: { worker: { candidates: [] } } });
    const evalWith = (inst) => evaluateInstanceCandidate({ instance: inst, request: { task }, pacingConfig: policy.pacing, now: NOW });
    const before = evalWith(instance);
    const lighter = structuredClone(instance);
    const win = lighter.windows[index];
    const used = win.usedPercent ?? 100 - win.remainingPercent;
    const lowered = Math.max(0, used - less);
    delete win.remainingPercent;
    win.usedPercent = lowered;
    const after = evalWith(lighter);
    const beforeIds = new Set(before.blockers.map((b) => b.windowId));
    for (const b of after.blockers) assert.ok(beforeIds.has(b.windowId), `used ${used} -> ${lowered} added blocker ${b.windowId}`);
    if (before.quotaState === 'available') assert.equal(after.quotaState, 'available');
  });
});

// decideDispatch 的整体不变式（AGENTS.md「Reading a plan」、README「Quality × Speed Fusion」、decide.mjs:195-219, 300-377）。
test('property: decideDispatch is deterministic, gates quality per mode, and keeps action and recommended consistent', () => {
  forAll('decide invariants', { runs: 400 }, (g) => genDecisionInput(g, { ranking: g.bool(0.3) }), (input) => {
    const decision = decide(input);
    assert.deepEqual(decide(input), decision, 'same input must give the same output');
    const mode = input.policy.scoring.mode;
    const cands = byId(decision);
    const minSamples = 5;

    for (const c of decision.candidates) {
      // n < minSamples：永远 trial，质量不拦（AGENTS.md「until then it is trial and is never blocked」）。
      const n = c.scoreCell?.n ?? 0;
      if (c.compliant && n < minSamples) {
        assert.equal(c.qualityTier, 'trial');
        assert.equal(c.rejectionReasons.some((r) => r.startsWith('quality below threshold')), false);
      }
      // strict 不返回低于门槛的 n>=5 候选（SCHEMA「strict (drop)」）。
      if (mode === 'strict' && c.qualityTier === 'below_threshold') assert.equal(c.eligible, false);
      // 过期快照的候选永不可派发（SCHEMA「maxSnapshotAgeMinutes ... yields refresh」）。
      if (c.freshness === 'stale' || c.freshness === 'future') assert.equal(c.eligible, false);
    }

    assert.deepEqual(
      [...decision.rankedEligibleIds].sort(),
      decision.candidates.filter((c) => c.eligible).map((c) => c.candidateId).sort(),
    );

    // demote：低于门槛的 n>=5 候选排在所有其它候选之后（SCHEMA「demote」，decide.mjs:31-36）。
    if (mode === 'demote') {
      const tiers = decision.rankedEligibleIds.map((id) => cands.get(id).qualityTier);
      const firstBelow = tiers.indexOf('below_threshold');
      if (firstBelow >= 0) assert.ok(tiers.slice(firstBelow).every((t) => t === 'below_threshold'), tiers.join(','));
    }

    // action 与 recommended 一致：run 必有 target 且就是排名第一；其它动作没有 recommended。
    if (decision.action === 'run') {
      assert.ok(decision.recommended);
      assert.equal(decision.recommended.candidateId, decision.rankedEligibleIds[0]);
      assert.equal(decision.recommended.target.providerInstanceId, decision.recommended.instanceId);
      assert.equal(decision.recommended.target.model, decision.recommended.model);
    } else {
      assert.equal(decision.recommended, null);
      assert.equal(decision.rankedEligibleIds.length, 0);
    }
    assert.equal(decision.waitUntil !== null, decision.action === 'wait');
    assert.equal(decision.redeemCandidate !== null, decision.action === 'redeem');
    if (decision.action === 'wait') {
      const waited = (Date.parse(decision.waitUntil) - NOW) / 60000;
      assert.ok(waited > 0 && waited <= input.request.waitMinutes);
    }
    assert.ok(Date.parse(decision.nextCheckAt) >= NOW, 'nextCheckAt is never in the past');
  });
});

// 排序只取决于候选本身，不取决于它们在配置里的先后（id 与 priority 已显式给定）。
// advisory 模式下合格与非合格候选混排的问题另见 RECORD「疑似、待用户定」，这里只测 demote / strict。
test('property: ranking does not depend on the order candidates are listed in the config', () => {
  forAll('permutation', { runs: 400 }, (g) => {
    const input = genDecisionInput(g, { ranking: g.bool(), mode: g.pick(['demote', 'strict']) });
    const shuffled = structuredClone(input);
    shuffled.policy.slots.worker.candidates = g.shuffle(shuffled.policy.slots.worker.candidates);
    return { input, shuffled };
  }, ({ input, shuffled }) => {
    const a = decide(input);
    const b = decide(shuffled);
    assert.deepEqual(b.rankedEligibleIds, a.rankedEligibleIds);
    assert.equal(b.action, a.action);
  });
});

// 快照全部过期（超过 maxSnapshotAgeMinutes=15）时，只要有一个启用的合规候选，动作就是 refresh
// （AGENTS.md「refresh: The usage snapshot is missing or stale」，decide.mjs:370-372）。
test('property: when every snapshot is stale, plan asks for refresh', () => {
  forAll('stale refresh', { runs: 300 }, (g) => genDecisionInput(g, { staleOnly: true }), (input) => {
    const decision = decide(input);
    assert.equal(decision.rankedEligibleIds.length, 0);
    const live = decision.candidates.some((c) => {
      const inst = input.snapshot.instances[c.instanceId];
      return c.compliant && inst && inst.enabled !== false && inst.status !== 'disabled';
    });
    if (live) assert.equal(decision.action, 'refresh');
  });
});
