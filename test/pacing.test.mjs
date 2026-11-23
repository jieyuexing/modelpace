import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PACING_CONFIG,
  evaluateWindow,
  isWindowApplicable,
  evaluateInstanceCandidate,
} from '../src/index.mjs';

const NOW = Date.parse('2026-11-23T07:00:00.000Z');
const hoursLater = (h) => new Date(NOW + h * 3600000).toISOString();

test('evaluateWindow computes effectiveRemaining and Even Pace accurately', () => {
  // 7-day window (168h), 84h left -> remainingTimePercent = 50%
  const w = evaluateWindow(
    {
      id: 'seven_day',
      kind: 'weekly',
      usedPercent: 30,
      remainingPercent: 71, // rounding drift: min(71, 70) = 70
      resetsAt: hoursLater(84),
      windowDurationMins: 10080,
    },
    { now: NOW, paceMarginPercent: 10 },
  );
  assert.equal(w.valid, true);
  assert.equal(w.effectiveRemainingPercent, 70);
  assert.ok(Math.abs(w.remainingTimePercent - 50) < 1e-6);
  assert.ok(Math.abs(w.paceBalancePercent - 20) < 1e-6);
  assert.equal(w.pace, 'surplus');

  const invalid = evaluateWindow({ id: 'bad', usedPercent: 80, remainingPercent: 50 }, { now: NOW });
  assert.equal(invalid.valid, false);
});

test('short window guard & secondary overflow cap', () => {
  const instance = {
    instanceId: 'antigravity-pro',
    driver: 'antigravity',
    enabled: true,
    status: 'ready',
    checkedAt: new Date(NOW - 60_000).toISOString(),
    windows: [
      {
        id: 'gemini-5h',
        kind: 'session',
        pool: 'gemini',
        usedPercent: 75,
        remainingPercent: 25,
        resetsAt: hoursLater(3),
        windowDurationMins: 300,
      },
    ],
    resetCredits: null,
    budget: null,
  };

  // Default 90% short cap allows 75% used
  const normalEval = evaluateInstanceCandidate({
    instance,
    candidate: { model: 'gemini-4-hydrogen', pool: 'gemini' },
    request: { task: 'slice' },
    now: NOW,
  });
  assert.equal(normalEval.quotaState, 'available');

  // Secondary overflow cap at 70% blocks 75% used
  const overflowEval = evaluateInstanceCandidate({
    instance,
    candidate: { model: 'gemini-4-hydrogen', pool: 'gemini', maxShortUsedPercent: 70 },
    request: { task: 'slice' },
    now: NOW,
  });
  assert.equal(overflowEval.quotaState, 'low');
  assert.equal(overflowEval.eligible, false);
});

test('Even Pace gates long tasks strictly (balance >= 0) and normal tasks with margin (-10)', () => {
  // 84h left out of 168h => remainingTimePercent = 50%
  // effectiveRemaining = 45% => paceBalance = -5% (ok for slice, blocked for long)
  const instance = {
    instanceId: 'claude',
    driver: 'claudeAgent',
    enabled: true,
    status: 'ready',
    checkedAt: new Date(NOW - 60_000).toISOString(),
    windows: [
      { id: 'five_hour', kind: 'session', usedPercent: 10, remainingPercent: 90, resetsAt: hoursLater(4), windowDurationMins: 300 },
      { id: 'seven_day', kind: 'weekly', usedPercent: 55, remainingPercent: 45, resetsAt: hoursLater(84), windowDurationMins: 10080 },
    ],
    resetCredits: null,
    budget: null,
  };

  const sliceEval = evaluateInstanceCandidate({
    instance,
    candidate: { model: 'claude-sonnet-4-5' },
    request: { task: 'slice' },
    now: NOW,
  });
  assert.equal(sliceEval.quotaState, 'available');

  const longEval = evaluateInstanceCandidate({
    instance,
    candidate: { model: 'claude-sonnet-4-5' },
    request: { task: 'long' },
    now: NOW,
  });
  assert.equal(longEval.quotaState, 'low');
  assert.equal(longEval.eligible, false);
});

test('reset credits provide credit_low / credit_redeem and skip near natural reset', () => {
  const baseInstance = {
    instanceId: 'codex',
    driver: 'codex',
    enabled: true,
    status: 'ready',
    checkedAt: new Date(NOW - 60_000).toISOString(),
    windows: [
      { id: 'primary', kind: 'session', usedPercent: 20, remainingPercent: 80, resetsAt: hoursLater(4), windowDurationMins: 300 },
      { id: 'secondary', kind: 'weekly', usedPercent: 90, remainingPercent: 10, resetsAt: hoursLater(120), windowDurationMins: 10080 },
    ],
    resetCredits: {
      known: true,
      availableCount: 1,
      nextExpiresAt: hoursLater(200),
      cards: [
        {
          creditId: 'codex-1',
          resetType: 'codexRateLimits',
          status: 'available',
          resetsLeft: 1,
          coversWindowIds: null,
          coversWindowPrefixes: null,
          expiresAt: hoursLater(200),
        },
      ],
    },
    budget: null,
  };

  // Exhaustion is projected before 120h reset, card expires at 200h > exhaustion -> creditAdjustedBalance = pace + 100 > 0!
  const backed = evaluateInstanceCandidate({
    instance: baseInstance,
    candidate: { model: 'gpt-5.3-codex' },
    request: { task: 'general' },
    now: NOW,
  });
  assert.equal(backed.quotaState, 'available');
  assert.equal(backed.applicableWindows[1].creditBacked, true);

  // When exhausted (0% remaining) and natural reset is 48h away (> skipIfResetWithinHours=6h) -> credit_redeem
  const exhausted = {
    ...baseInstance,
    windows: [
      { id: 'primary', kind: 'session', usedPercent: 100, remainingPercent: 0, resetsAt: hoursLater(48), windowDurationMins: 300 },
    ],
  };
  const redeemEval = evaluateInstanceCandidate({
    instance: exhausted,
    candidate: { model: 'gpt-5.3-codex' },
    request: { task: 'general' },
    now: NOW,
  });
  assert.equal(redeemEval.quotaState, 'credit_redeem');

  // When natural reset is 2h away (<= skipIfResetWithinHours=6h) -> exhausted (do not waste card)
  const nearReset = {
    ...baseInstance,
    windows: [
      { id: 'primary', kind: 'session', usedPercent: 100, remainingPercent: 0, resetsAt: hoursLater(2), windowDurationMins: 300 },
    ],
  };
  const nearEval = evaluateInstanceCandidate({
    instance: nearReset,
    candidate: { model: 'gpt-5.3-codex' },
    request: { task: 'general' },
    now: NOW,
  });
  assert.equal(nearEval.quotaState, 'exhausted');
});

test('snapshot staleness, future timestamp, and pool / model applicability isolation', () => {
  const stale = evaluateInstanceCandidate({
    instance: {
      instanceId: 'grok',
      driver: 'grok',
      enabled: true,
      status: 'ready',
      checkedAt: new Date(NOW - 20 * 60000).toISOString(),
      windows: [{ id: 'primary', kind: 'weekly', usedPercent: 10, remainingPercent: 90 }],
    },
    now: NOW,
    pacingConfig: DEFAULT_PACING_CONFIG,
  });
  assert.equal(stale.freshness, 'stale');
  assert.equal(stale.quotaState, 'unknown');

  const future = evaluateInstanceCandidate({
    instance: {
      instanceId: 'grok',
      driver: 'grok',
      enabled: true,
      status: 'ready',
      checkedAt: new Date(NOW + 5 * 60000).toISOString(),
      windows: [{ id: 'primary', kind: 'weekly', usedPercent: 10, remainingPercent: 90 }],
    },
    now: NOW,
  });
  assert.equal(future.freshness, 'future');
  assert.equal(future.quotaState, 'unknown');

  // Antigravity pool isolation: carbon window does not block gemini model
  assert.equal(
    isWindowApplicable({ id: 'gemini-carbon-5h', pool: 'carbon' }, { driver: 'antigravity', model: 'gemini-4-hydrogen' }),
    false,
  );
  assert.equal(
    isWindowApplicable({ id: 'gemini-carbon-5h', pool: 'carbon' }, { driver: 'antigravity', model: 'gemini-4-carbon' }),
    true,
  );
  assert.equal(
    isWindowApplicable({ id: '3p-5h', pool: '3p' }, { driver: 'antigravity', model: 'claude-sonnet-5-5' }),
    true,
  );

  // Claude seven_day_sonnet applies only when model matches sonnet or claudeModel='sonnet'
  assert.equal(
    isWindowApplicable({ id: 'seven_day_sonnet' }, { driver: 'claudeAgent', model: 'claude-opus-4-5' }),
    false,
  );
  assert.equal(
    isWindowApplicable({ id: 'seven_day_sonnet' }, { driver: 'claudeAgent', model: 'claude-sonnet-4-5' }),
    true,
  );
});

test('pay-as-you-go budget gating blocks when spent >= budget or isAvailable=false', () => {
  const overBudget = evaluateInstanceCandidate({
    instance: {
      instanceId: 'deepseek',
      driver: 'api',
      enabled: true,
      status: 'ready',
      checkedAt: new Date(NOW - 60_000).toISOString(),
      windows: [],
      budget: { spent: 100, budget: 100, balance: 20, isAvailable: true, resetsAt: hoursLater(240) },
    },
    now: NOW,
  });
  assert.equal(overBudget.quotaState, 'exhausted');
  assert.equal(overBudget.eligible, false);
});
