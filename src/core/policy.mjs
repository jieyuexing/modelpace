import { DEFAULT_PACING_CONFIG } from './pacing.mjs';
import { DEFAULT_SCORING_CONFIG, TASKS } from './scores.mjs';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isPercent = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
const isPositive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;

export const DEFAULT_POLICY = Object.freeze({
  schemaVersion: 2,
  tiers: ['work', 'personal', 'public'],
  defaultTier: null,
  taskToSlot: {
    general: 'worker',
    research: 'worker',
    review: 'review',
    slice: 'worker',
    long: 'heavy',
  },
  instances: {},
  slots: {},
  pacing: DEFAULT_PACING_CONFIG,
  scoring: DEFAULT_SCORING_CONFIG,
});

/**
 * 内置默认策略：只用官方 T3 Code 的默认实例 id（等于 driver 名），一种 driver 一个实例。
 * 多账号、多订阅的组合见 examples/multi-account.config.json。
 */
export function starterPolicy() {
  return {
    schemaVersion: 2,
    tiers: ['work', 'personal', 'public'],
    defaultTier: null,
    taskToSlot: {
      general: 'worker',
      research: 'worker',
      review: 'review',
      slice: 'worker',
      long: 'heavy',
    },
    instances: {
      codex: { driver: 'codex', shortWindowMaxUsedPercent: 90 },
      claudeAgent: { driver: 'claudeAgent', shortWindowMaxUsedPercent: 90 },
      antigravity: { driver: 'antigravity', shortWindowMaxUsedPercent: 90 },
    },
    slots: {
      worker: {
        candidates: [
          { id: 'codex-worker', instanceId: 'codex', model: 'gpt-5.3-codex', effort: 'high', options: { reasoningEffort: 'high' }, priority: 1 },
          { id: 'gemini-worker', instanceId: 'antigravity', model: 'gemini-4-hydrogen', pool: 'gemini', effort: 'high', priority: 2 },
          { id: 'claude-worker', instanceId: 'claudeAgent', model: 'claude-sonnet-4-5', effort: 'high', priority: 3 },
        ],
      },
      heavy: {
        candidates: [
          { id: 'claude-opus-heavy', instanceId: 'claudeAgent', model: 'claude-opus-4-5', effort: 'high', priority: 1 },
          { id: 'codex-heavy', instanceId: 'codex', model: 'gpt-5.3-codex', effort: 'xhigh', options: { reasoningEffort: 'xhigh' }, priority: 2 },
        ],
      },
      review: {
        candidates: [
          { id: 'claude-review', instanceId: 'claudeAgent', model: 'claude-sonnet-4-5', effort: 'high', tasks: ['review', 'research'], priority: 1 },
          { id: 'codex-review', instanceId: 'codex', model: 'gpt-5.3-codex', effort: 'high', priority: 2 },
        ],
      },
    },
  };
}

export function normalizePolicy(rawPolicy) {
  if (!isObject(rawPolicy)) {
    throw new Error('Policy error: dispatch config must be an object');
  }
  if (rawPolicy.schemaVersion != null && rawPolicy.schemaVersion !== 2) {
    throw new Error(`Policy error: unsupported schemaVersion ${rawPolicy.schemaVersion} (expected 2)`);
  }

  const tiers = rawPolicy.tiers ?? DEFAULT_POLICY.tiers;
  if (!Array.isArray(tiers) || !tiers.every((t) => typeof t === 'string' && t.trim())) {
    throw new Error('Policy error: tiers must be an array of non-empty strings');
  }

  const defaultTier = rawPolicy.defaultTier ?? null;
  if (defaultTier !== null && !tiers.includes(defaultTier)) {
    throw new Error(`Policy error: defaultTier "${defaultTier}" must be listed in tiers`);
  }

  const taskToSlot = {
    ...DEFAULT_POLICY.taskToSlot,
    ...(isObject(rawPolicy.taskToSlot) ? rawPolicy.taskToSlot : {}),
  };

  const pacing = {
    ...DEFAULT_PACING_CONFIG,
    ...(isObject(rawPolicy.pacing) ? rawPolicy.pacing : {}),
    resetCredit: {
      ...DEFAULT_PACING_CONFIG.resetCredit,
      ...(isObject(rawPolicy.pacing?.resetCredit) ? rawPolicy.pacing.resetCredit : {}),
    },
    expiringBoost: rawPolicy.pacing?.expiringBoost === null
      ? null
      : {
          ...DEFAULT_PACING_CONFIG.expiringBoost,
          ...(isObject(rawPolicy.pacing?.expiringBoost) ? rawPolicy.pacing.expiringBoost : {}),
        },
  };

  for (const key of ['paceMarginPercent', 'longTaskMinRemainingPercent', 'defaultMinRemainingPercent', 'shortWindowMaxUsedPercent']) {
    if (!isPercent(pacing[key])) {
      throw new Error(`Policy error: pacing.${key} must be 0..100`);
    }
  }
  if (pacing.paceMarginPercent <= 0) {
    throw new Error('Policy error: pacing.paceMarginPercent must be > 0');
  }
  for (const key of ['recheckAfterMinutes', 'maxSnapshotAgeMinutes']) {
    if (!isPositive(pacing[key])) {
      throw new Error(`Policy error: pacing.${key} must be > 0`);
    }
  }
  if (!isPositive(pacing.resetCredit.skipIfResetWithinHours) || !isPositive(pacing.resetCredit.expiryWarnHours)) {
    throw new Error('Policy error: pacing.resetCredit hours must be > 0');
  }
  if (pacing.expiringBoost !== null) {
    if (!isPositive(pacing.expiringBoost.resetWithinHours)) {
      throw new Error('Policy error: pacing.expiringBoost.resetWithinHours must be > 0');
    }
    if (!isPercent(pacing.expiringBoost.minRemainingPercent) || !isPercent(pacing.expiringBoost.maxShortUsedPercent)) {
      throw new Error('Policy error: pacing.expiringBoost percentages must be 0..100');
    }
  }

  const rawScoring = isObject(rawPolicy.scoring) ? rawPolicy.scoring : {};
  const scoring = {
    ...DEFAULT_SCORING_CONFIG,
    ...rawScoring,
    aliases: {
      provider: {
        ...DEFAULT_SCORING_CONFIG.aliases.provider,
        ...(isObject(rawScoring.aliases?.provider) ? rawScoring.aliases.provider : {}),
      },
      tier: {
        ...DEFAULT_SCORING_CONFIG.aliases.tier,
        ...(isObject(rawScoring.aliases?.tier) ? rawScoring.aliases.tier : {}),
      },
      ...(isObject(rawScoring.aliases?.model) ? { model: rawScoring.aliases.model } : {}),
      ...(isObject(rawScoring.aliases?.effort) ? { effort: rawScoring.aliases.effort } : {}),
    },
    pricing: {
      ...DEFAULT_SCORING_CONFIG.pricing,
      ...(isObject(rawScoring.pricing) ? rawScoring.pricing : {}),
    },
  };

  if (!['demote', 'strict', 'advisory'].includes(scoring.mode)) {
    throw new Error(`Policy error: scoring.mode must be demote, strict, or advisory`);
  }
  if (!Number.isFinite(scoring.minPassRate) || scoring.minPassRate < 0 || scoring.minPassRate > 1) {
    throw new Error('Policy error: scoring.minPassRate must be in 0..1');
  }
  if (!Number.isSafeInteger(scoring.minSamples) || scoring.minSamples < 1) {
    throw new Error('Policy error: scoring.minSamples must be a positive integer');
  }
  if (!Number.isFinite(scoring.speedTieBreakerMarginRatio) || scoring.speedTieBreakerMarginRatio < 0) {
    throw new Error('Policy error: scoring.speedTieBreakerMarginRatio must be >= 0');
  }

  const instances = {};
  if (isObject(rawPolicy.instances)) {
    for (const [id, inst] of Object.entries(rawPolicy.instances)) {
      if (!isObject(inst)) throw new Error(`Policy error: instances.${id} must be an object`);
      if (inst.tiers != null && (!Array.isArray(inst.tiers) || !inst.tiers.every((t) => tiers.includes(t)))) {
        throw new Error(`Policy error: instances.${id}.tiers contains unknown tier`);
      }
      if (inst.shortWindowMaxUsedPercent != null && !isPercent(inst.shortWindowMaxUsedPercent)) {
        throw new Error(`Policy error: instances.${id}.shortWindowMaxUsedPercent must be 0..100`);
      }
      if (inst.weeklyMinRemainingPercent != null && !isPercent(inst.weeklyMinRemainingPercent)) {
        throw new Error(`Policy error: instances.${id}.weeklyMinRemainingPercent must be 0..100`);
      }
      instances[id] = {
        enabled: inst.enabled !== false,
        ...inst,
      };
    }
  }

  if (!isObject(rawPolicy.slots) || Object.keys(rawPolicy.slots).length === 0) {
    throw new Error('Policy error: slots must define at least one slot');
  }
  const slots = {};
  for (const [slotName, slotDef] of Object.entries(rawPolicy.slots)) {
    if (!isObject(slotDef) || !Array.isArray(slotDef.candidates)) {
      throw new Error(`Policy error: slots.${slotName}.candidates must be an array`);
    }
    const seenIds = new Set();
    const candidates = slotDef.candidates.map((cand, index) => {
      if (!isObject(cand)) {
        throw new Error(`Policy error: slots.${slotName}.candidates[${index}] must be an object`);
      }
      if (typeof cand.instanceId !== 'string' || !cand.instanceId.trim()) {
        throw new Error(`Policy error: slots.${slotName}.candidates[${index}].instanceId is required`);
      }
      if (typeof cand.model !== 'string' || !cand.model.trim()) {
        throw new Error(`Policy error: slots.${slotName}.candidates[${index}].model is required`);
      }
      const id = typeof cand.id === 'string' && cand.id.trim() ? cand.id.trim() : `${cand.instanceId}:${cand.model}:${index}`;
      if (seenIds.has(id)) {
        throw new Error(`Policy error: duplicate candidate id "${id}" in slot "${slotName}"`);
      }
      seenIds.add(id);
      if (cand.tiers != null && (!Array.isArray(cand.tiers) || !cand.tiers.every((t) => tiers.includes(t)))) {
        throw new Error(`Policy error: candidate "${id}" tiers contains unknown tier`);
      }
      if (cand.tasks != null && (!Array.isArray(cand.tasks) || !cand.tasks.every((t) => TASKS.includes(t)))) {
        throw new Error(`Policy error: candidate "${id}" tasks contains invalid task`);
      }
      if (cand.maxShortUsedPercent != null && !isPercent(cand.maxShortUsedPercent)) {
        throw new Error(`Policy error: candidate "${id}" maxShortUsedPercent must be 0..100`);
      }
      if (cand.minRemainingPercent != null && !isPercent(cand.minRemainingPercent)) {
        throw new Error(`Policy error: candidate "${id}" minRemainingPercent must be 0..100`);
      }
      return {
        ...cand,
        id,
        enabled: cand.enabled !== false,
        effort: typeof cand.effort === 'string' && cand.effort.trim() ? cand.effort.trim() : 'default',
        priority: Number.isFinite(cand.priority) ? cand.priority : index + 1,
      };
    });
    slots[slotName] = {
      ...slotDef,
      candidates,
    };
  }

  return {
    schemaVersion: 2,
    tiers: [...tiers],
    defaultTier,
    taskToSlot,
    instances,
    slots,
    pacing,
    scoring,
  };
}

export function validatePolicy(rawPolicy) {
  return normalizePolicy(rawPolicy);
}
