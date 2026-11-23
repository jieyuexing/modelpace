import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSnapshot,
  summarizeDispatchScores,
  decideDispatch,
} from '../src/index.mjs';
import { multiAccountPolicy } from './helpers/multi-account.mjs';

const NOW = Date.parse('2026-11-23T07:00:00.000Z');
const hoursLater = (h) => new Date(NOW + h * 3600000).toISOString();
const freshAt = new Date(NOW - 60_000).toISOString();

function makeScoreRecords(provider, model, effort, tier, count, { passCount = count, durationMin = 5, task = 'slice' } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    date: '2026-11-23',
    taskId: `${provider}-${i}`,
    title: 'Eval',
    task,
    executor: { provider, model, effort, tier, site: 'local' },
    scorer: 'orchestrator',
    accepted: i < passCount,
    firstPass: i < passCount,
    reworkRounds: 0,
    scopeViolation: false,
    falseReport: false,
    stoppedOnDenial: null,
    durationMin,
    quotaDelta: 2,
    note: 'ok',
  }));
}

function makeSnapshot(overrides = {}) {
  return normalizeSnapshot(
    {
      schemaVersion: 2,
      observedAt: freshAt,
      source: 'json',
      instances: {
        codex: {
          driver: 'codex',
          enabled: true,
          status: 'ready',
          checkedAt: freshAt,
          windows: [
            { id: 'primary', kind: 'session', usedPercent: 20, resetsAt: hoursLater(4), windowDurationMins: 300 },
            { id: 'secondary', kind: 'weekly', usedPercent: 30, resetsAt: hoursLater(120), windowDurationMins: 10080 },
          ],
          ...overrides.codex,
        },
        claude: {
          driver: 'claudeAgent',
          enabled: true,
          status: 'ready',
          checkedAt: freshAt,
          windows: [
            { id: 'five_hour', kind: 'session', usedPercent: 20, resetsAt: hoursLater(4), windowDurationMins: 300 },
            { id: 'seven_day', kind: 'weekly', usedPercent: 30, resetsAt: hoursLater(120), windowDurationMins: 10080 },
          ],
          ...overrides.claude,
        },
        antigravity: {
          driver: 'antigravity',
          enabled: true,
          status: 'ready',
          checkedAt: freshAt,
          windows: [
            { id: 'gemini-5h', kind: 'session', pool: 'gemini', usedPercent: 10, resetsAt: hoursLater(4), windowDurationMins: 300 },
            { id: 'gemini-carbon-5h', kind: 'session', pool: 'carbon', usedPercent: 10, resetsAt: hoursLater(4), windowDurationMins: 300 },
          ],
          ...overrides.antigravity,
        },
        'antigravity-pro': {
          driver: 'antigravity',
          enabled: true,
          status: 'ready',
          checkedAt: freshAt,
          windows: [
            { id: 'gemini-5h', kind: 'session', pool: 'gemini', usedPercent: 20, resetsAt: hoursLater(4), windowDurationMins: 300 },
          ],
          ...overrides['antigravity-pro'],
        },
      },
    },
    { now: NOW },
  );
}

test('Step 1 & Step 2: tier scope and secondary overflow spill to primary', () => {
  const policy = multiAccountPolicy();
  // Remove codex from snapshot so gemini-pro vs gemini-ultra compete
  const snap = makeSnapshot({
    codex: { enabled: false, status: 'disabled', windows: [] },
    'antigravity-pro': {
      windows: [{ id: 'gemini-5h', kind: 'session', pool: 'gemini', usedPercent: 75, resetsAt: hoursLater(4), windowDurationMins: 300 }],
    },
  });

  // For personal tier, gemini-pro is blocked by maxShortUsedPercent=70 -> spills to antigravity ultra
  const personal = decideDispatch({
    snapshot: snap,
    policy,
    request: { task: 'slice', tier: 'personal' },
    now: NOW,
  });
  assert.equal(personal.action, 'run');
  assert.equal(personal.recommended.instanceId, 'antigravity');
  assert.deepEqual(personal.recommended.target, {
    providerInstanceId: 'antigravity',
    model: 'gemini-4-hydrogen',
  });

  // For work tier, antigravity-pro is not even in allowed tiers (skipped in Step 1)
  const work = decideDispatch({
    snapshot: snap,
    policy,
    request: { task: 'slice', tier: 'work' },
    now: NOW,
  });
  const proAudit = work.candidates.find((c) => c.candidateId === 'gemini-pro-worker');
  assert.equal(proAudit.compliant, false);
});

test('Step 3: Quality × Speed fusion, demote/strict/advisory modes, and trial cold-start', () => {
  const policy = multiAccountPolicy();
  const snap = makeSnapshot();

  // Build scores:
  // - codex: qualified, duration 8m
  // - claude: qualified, duration 5m (wins on duration!)
  // - antigravity-pro: below threshold (2/6) -> demoted below trial & qualified
  // - antigravity-ultra: trial (only 2 records) -> stays ahead of demoted, behind qualified
  const records = [
    ...makeScoreRecords('codex', 'gpt-5.3-codex', 'high', 'default', 6, { passCount: 6, durationMin: 8 }),
    ...makeScoreRecords('claude', 'claude-sonnet-4-5', 'high', 'default', 6, { passCount: 6, durationMin: 5 }),
    ...makeScoreRecords('antigravity-pro', 'gemini-4-hydrogen', 'high', 'default', 6, { passCount: 2, durationMin: 2 }),
    ...makeScoreRecords('antigravity-ultra', 'gemini-4-hydrogen', 'high', 'default', 2, { passCount: 2, durationMin: 3 }),
  ];
  const scoresSummary = summarizeDispatchScores(records, policy.scoring);

  // Permission tier ('personal' / 'work') must not overwrite executor service tier ('default') during score lookup
  const resDemote = decideDispatch({
    snapshot: snap,
    policy,
    scoresSummary,
    request: { task: 'slice', tier: 'personal' },
    now: NOW,
  });
  assert.equal(resDemote.action, 'run');
  assert.equal(resDemote.recommended.instanceId, 'claude');
  assert.equal(resDemote.recommended.scoreIdentity, 'claude/claude-sonnet-4-5/high/default');
  assert.deepEqual(resDemote.rankedEligibleIds, [
    'claude-worker',
    'codex-worker',
    'gemini-ultra-worker',
    'gemini-pro-worker',
  ]);

  // Strict mode excludes antigravity-pro completely
  const strictPolicy = { ...policy, scoring: { ...policy.scoring, mode: 'strict' } };
  const resStrict = decideDispatch({
    snapshot: snap,
    policy: strictPolicy,
    scoresSummary,
    request: { task: 'slice', tier: 'personal' },
    now: NOW,
  });
  assert.equal(resStrict.rankedEligibleIds.includes('gemini-pro-worker'), false);

  // Speed tie-breaker when median durations are within 15% margin (5.0m vs 5.3m -> 6% diff)
  const tieRecords = [
    ...makeScoreRecords('codex', 'gpt-5.3-codex', 'high', 'default', 6, { passCount: 6, durationMin: 5.0 }),
    ...makeScoreRecords('claude', 'claude-sonnet-4-5', 'high', 'default', 6, { passCount: 6, durationMin: 5.3 }),
  ];
  const tieSummary = summarizeDispatchScores(tieRecords, policy.scoring);
  const resSpeedTie = decideDispatch({
    snapshot: snap,
    policy,
    scoresSummary: tieSummary,
    speedMetrics: {
      'gpt-5.3-codex': { longRate: 70 },
      'claude-sonnet-4-5': { longRate: 130 },
    },
    request: { task: 'slice', tier: 'personal' },
    now: NOW,
  });
  assert.equal(resSpeedTie.recommended.instanceId, 'claude');
});

test('Step 4: wait, redeem, refresh, and pause fallback actions', () => {
  const policy = multiAccountPolicy();
  // Only review slot with claude + codex
  const exhaustedWaitable = makeSnapshot({
    codex: {
      windows: [{ id: 'primary', kind: 'session', usedPercent: 100, resetsAt: new Date(NOW + 10 * 60000).toISOString(), windowDurationMins: 300 }],
    },
    claude: {
      windows: [
        { id: 'five_hour', kind: 'session', usedPercent: 100, resetsAt: hoursLater(3), windowDurationMins: 300 },
        { id: 'seven_day', kind: 'weekly', usedPercent: 20, resetsAt: hoursLater(120), windowDurationMins: 10080 },
      ],
    },
  });

  const waitDecision = decideDispatch({
    snapshot: exhaustedWaitable,
    policy,
    request: { slot: 'review', task: 'review', waitMinutes: 15 },
    now: NOW,
  });
  assert.equal(waitDecision.action, 'wait');
  assert.equal(waitDecision.waitUntil, new Date(NOW + 10 * 60000).toISOString());

  // Without wait budget, if Claude has a reset credit for 5h -> redeem
  const redeemableSnap = makeSnapshot({
    codex: {
      windows: [{ id: 'primary', kind: 'session', usedPercent: 100, resetsAt: hoursLater(2), windowDurationMins: 300 }],
    },
    claude: {
      windows: [
        { id: 'five_hour', kind: 'session', usedPercent: 100, resetsAt: hoursLater(10), windowDurationMins: 300 },
        { id: 'seven_day', kind: 'weekly', usedPercent: 20, resetsAt: hoursLater(120), windowDurationMins: 10080 },
      ],
      resetCredits: {
        known: true,
        availableCount: 1,
        nextExpiresAt: hoursLater(48),
        cards: [
          { creditId: 'cs-1', resetType: 'claudeSession', status: 'available', resetsLeft: 1, coversWindowIds: ['five_hour'], coversWindowPrefixes: null, expiresAt: hoursLater(48) },
        ],
      },
    },
  });
  const redeemDecision = decideDispatch({
    snapshot: redeemableSnap,
    policy,
    request: { slot: 'review', task: 'review', waitMinutes: 0 },
    now: NOW,
  });
  assert.equal(redeemDecision.action, 'redeem');
  assert.equal(redeemDecision.redeemCandidate.instanceId, 'claude');

  // Stale snapshot -> refresh
  const staleSnap = makeSnapshot({
    codex: { checkedAt: new Date(NOW - 30 * 60000).toISOString() },
    claude: { checkedAt: new Date(NOW - 30 * 60000).toISOString() },
  });
  const refreshDecision = decideDispatch({
    snapshot: staleSnap,
    policy,
    request: { slot: 'review', task: 'review' },
    now: NOW,
  });
  assert.equal(refreshDecision.action, 'refresh');

  // Fully exhausted without credits -> pause
  const pauseSnap = makeSnapshot({
    codex: { windows: [{ id: 'primary', kind: 'session', usedPercent: 100, resetsAt: hoursLater(4), windowDurationMins: 300 }] },
    claude: {
      windows: [
        { id: 'five_hour', kind: 'session', usedPercent: 100, resetsAt: hoursLater(4), windowDurationMins: 300 },
        { id: 'seven_day', kind: 'weekly', usedPercent: 20, resetsAt: hoursLater(120), windowDurationMins: 10080 },
      ],
    },
  });
  const pauseDecision = decideDispatch({
    snapshot: pauseSnap,
    policy,
    request: { slot: 'review', task: 'review' },
    now: NOW,
  });
  assert.equal(pauseDecision.action, 'pause');
});
