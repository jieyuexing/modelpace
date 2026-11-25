import { evaluateInstanceCandidate } from './pacing.mjs';
import { normalizePolicy } from './policy.mjs';
import { TASKS, scoreIdentity } from './scores.mjs';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function resolveSpeedRate(speedMetrics, candidate, identity) {
  if (!speedMetrics || !isObject(speedMetrics)) return null;
  const lookup = (entry) => {
    if (typeof entry === 'number' && Number.isFinite(entry)) return entry;
    if (isObject(entry)) {
      const rate = entry.longRate ?? entry.tokensPerSec ?? entry.tokPerSec ?? entry.rate;
      if (typeof rate === 'number' && Number.isFinite(rate)) return rate;
    }
    return null;
  };
  return (
    lookup(speedMetrics[candidate.model]) ??
    lookup(speedMetrics.models?.[candidate.model]) ??
    lookup(speedMetrics[identity]) ??
    lookup(speedMetrics.identities?.[identity]) ??
    null
  );
}

function lookupScoreCell(scoresSummary, identity, task) {
  if (!scoresSummary || !Array.isArray(scoresSummary.cells)) return null;
  return scoresSummary.cells.find((c) => c.identity === identity && c.task === task) ?? null;
}

function qualityTierRank(qualityTier, mode) {
  if (mode === 'advisory') return 0;
  if (qualityTier === 'qualified') return 0;
  if (qualityTier === 'trial') return 1;
  return 2; // below_threshold (demote)
}

/**
 * 合格候选按耗时中位数分档：从最快者起，相对本档最快者不超过 marginRatio 的归入同档，档内再走决胜键。
 * 逐对“容差内算平”不传递（10/11/12 分钟两两相邻算平、首尾不算），排序会随输入顺序变化；先分档再比档号才是全序。
 */
function durationBands(candidates, marginRatio) {
  const bands = new Map();
  const timed = candidates
    .filter((c) => c.qualityTier === 'qualified' && c.scoreCell?.durationMedianMin != null)
    .sort((a, b) => a.scoreCell.durationMedianMin - b.scoreCell.durationMedianMin);
  let band = -1;
  let anchor = null;
  for (const c of timed) {
    const duration = c.scoreCell.durationMedianMin;
    const tied = anchor !== null && (anchor === 0 ? duration === 0 : (duration - anchor) / anchor <= marginRatio);
    if (!tied) {
      band += 1;
      anchor = duration;
    }
    bands.set(c, band);
  }
  return bands;
}

function compareCandidates(a, b, policy, bands) {
  const mode = policy.scoring.mode;

  // 1. Quality tier (qualified > trial > below_threshold when mode === 'demote')
  const qRankDiff = qualityTierRank(a.qualityTier, mode) - qualityTierRank(b.qualityTier, mode);
  if (qRankDiff !== 0) return qRankDiff;

  // 2. Within qualified: faster duration band first (no duration sorts last), then tie-breakers
  if (a.qualityTier === 'qualified' && b.qualityTier === 'qualified') {
    const aBand = bands.get(a) ?? Infinity;
    const bBand = bands.get(b) ?? Infinity;
    if (aBand !== bBand) return aBand < bBand ? -1 : 1;

    // Tie-breaker 1: Speed longRate descending
    const aRate = a.speedLongRate ?? -Infinity;
    const bRate = b.speedLongRate ?? -Infinity;
    if (aRate !== bRate) return bRate - aRate;

    // Tie-breaker 2: Expiring-soon boost descending
    if (a.expiringBonus !== b.expiringBonus) return b.expiringBonus - a.expiringBonus;

    // Tie-breaker 3: Even Pace surplus descending
    const aPace = a.paceScore ?? -Infinity;
    const bPace = b.paceScore ?? -Infinity;
    if (aPace !== bPace) return bPace - aPace;

    // Tie-breaker 4: Configured priority ascending
    return a.priority - b.priority || a.orderIndex - b.orderIndex;
  }

  // 3. Within trial (or advisory): configured priority first, then expiring boost, Even Pace, Speed longRate
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.expiringBonus !== b.expiringBonus) return b.expiringBonus - a.expiringBonus;
  const aPace = a.paceScore ?? -Infinity;
  const bPace = b.paceScore ?? -Infinity;
  if (aPace !== bPace) return bPace - aPace;
  const aRate = a.speedLongRate ?? -Infinity;
  const bRate = b.speedLongRate ?? -Infinity;
  if (aRate !== bRate) return bRate - aRate;

  return a.orderIndex - b.orderIndex;
}

export function decideDispatch({
  snapshot,
  policy: rawPolicy,
  scoresSummary = null,
  speedMetrics = null,
  request = {},
  now = Date.now(),
} = {}) {
  const policy = normalizePolicy(rawPolicy);
  const nowMs = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(nowMs) || !Number.isFinite(new Date(nowMs).getTime())) {
    throw new Error('Invalid now timestamp');
  }

  const task = request.task ?? 'general';
  if (!TASKS.includes(task)) {
    throw new Error(`Invalid task "${task}": expected one of ${TASKS.join(', ')}`);
  }
  const tier = request.tier ?? policy.defaultTier ?? null;
  if (tier !== null && !policy.tiers.includes(tier)) {
    throw new Error(`Invalid tier "${tier}": expected one of ${policy.tiers.join(', ')} (tiers come from the config; omit --tier to skip tier gating)`);
  }
  const waitMinutes = request.waitMinutes ?? 0;
  if (!Number.isFinite(waitMinutes) || waitMinutes < 0 || waitMinutes > 1440) {
    throw new Error('Invalid waitMinutes: expected 0..1440');
  }
  const slot = request.slot ?? policy.taskToSlot[task] ?? Object.keys(policy.slots)[0];
  const slotDef = policy.slots[slot];
  if (!slotDef) {
    throw new Error(`Unknown dispatch slot "${slot}": expected one of ${Object.keys(policy.slots).join(', ')} (slots come from the config; omit --slot to use taskToSlot)`);
  }

  const instances = snapshot?.instances ?? {};
  const audit = [];
  const reasons = [];

  for (let idx = 0; idx < slotDef.candidates.length; idx++) {
    const candidate = slotDef.candidates[idx];
    const instancePolicy = policy.instances[candidate.instanceId] ?? {};
    const instance = instances[candidate.instanceId] ?? null;

    // Step 1: Compliance & Scope Gate
    const scopeRejections = [];
    if (candidate.enabled === false || instancePolicy.enabled === false) {
      scopeRejections.push('disabled by policy');
    }
    if (tier !== null) {
      const allowedTiers = candidate.tiers ?? instancePolicy.tiers ?? null;
      if (Array.isArray(allowedTiers) && !allowedTiers.includes(tier)) {
        scopeRejections.push(`tier "${tier}" not allowed (allowed: ${allowedTiers.join(', ')})`);
      }
    }
    const allowedTasks = candidate.tasks ?? instancePolicy.tasks ?? null;
    if (Array.isArray(allowedTasks) && !allowedTasks.includes(task)) {
      scopeRejections.push(`task "${task}" not allowed (allowed: ${allowedTasks.join(', ')})`);
    }

    if (scopeRejections.length > 0) {
      audit.push({
        candidateId: candidate.id,
        instanceId: candidate.instanceId,
        driver: instance?.driver ?? instancePolicy.driver ?? null,
        model: candidate.model,
        effort: candidate.effort,
        priority: candidate.priority,
        orderIndex: idx,
        compliant: false,
        eligible: false,
        quotaState: 'skipped',
        qualityTier: null,
        rejectionReasons: scopeRejections,
        warnings: [],
      });
      continue;
    }

    // Step 2: Quota, Even Pace & Reset Credit Gate
    const pacingEval = evaluateInstanceCandidate({
      instance,
      instancePolicy,
      candidate,
      request: { ...request, task, waitMinutes, tier },
      pacingConfig: policy.pacing,
      now: nowMs,
    });

    // Step 3: Quality × Speed Fusion
    const rawProvider = instancePolicy.scoreProvider ?? instance?.driver ?? candidate.instanceId;
    const executor = {
      provider: rawProvider,
      model: candidate.model,
      effort: candidate.effort ?? 'default',
      tier: candidate.scoreTier ?? candidate.serviceTier ?? 'default',
    };
    const identity = scoreIdentity(executor, policy.scoring.aliases);
    const cell = lookupScoreCell(scoresSummary, identity, task);
    const speedLongRate = resolveSpeedRate(speedMetrics, candidate, identity);

    const minSamples = policy.scoring.minSamples;
    const minPassRate = policy.scoring.minPassRate;
    let qualityTier = 'trial';
    let qualityEligible = true;
    const qualityWarnings = [];
    const qualityRejections = [];

    if (cell && cell.n >= minSamples && cell.passRate !== null) {
      if (cell.passRate >= minPassRate) {
        qualityTier = 'qualified';
      } else {
        qualityTier = 'below_threshold';
        const pctStr = `${(cell.passRate * 100).toFixed(1)}%`;
        const minStr = `${(minPassRate * 100).toFixed(1)}%`;
        if (policy.scoring.mode === 'strict') {
          qualityEligible = false;
          qualityRejections.push(`quality below threshold (${pctStr} < ${minStr}, n=${cell.n}, strict mode)`);
        } else if (policy.scoring.mode === 'demote') {
          qualityWarnings.push(`demoted: passRate ${pctStr} < ${minStr} (n=${cell.n})`);
        } else {
          qualityWarnings.push(`advisory: passRate ${pctStr} < ${minStr} (n=${cell.n})`);
        }
      }
    }

    const combinedWarnings = [...pacingEval.warnings, ...qualityWarnings];
    const rejectionReasons = [
      ...pacingEval.issues,
      ...pacingEval.blockers.map((b) => b.reason),
      ...qualityRejections,
    ];
    const eligible = pacingEval.eligible && qualityEligible;

    audit.push({
      candidateId: candidate.id,
      instanceId: candidate.instanceId,
      driver: instance?.driver ?? instancePolicy.driver ?? null,
      model: candidate.model,
      effort: candidate.effort,
      options: candidate.options ?? null,
      pool: candidate.pool ?? null,
      priority: candidate.priority,
      orderIndex: idx,
      compliant: true,
      eligible,
      quotaState: pacingEval.quotaState,
      qualityTier,
      scoreIdentity: identity,
      scoreExecutor: executor,
      scoreCell: cell
        ? {
            n: cell.n,
            s: cell.s,
            f: cell.f,
            passRate: cell.passRate,
            interval90: cell.interval90,
            durationMedianMin: cell.durationMedianMin,
            costMedian: cell.costMedian,
            costCurrency: cell.costCurrency,
          }
        : null,
      speedLongRate,
      paceScore: pacingEval.paceScore,
      expiringBonus: pacingEval.expiringBonus,
      availableAfter: pacingEval.availableAfter,
      coveringCredits: pacingEval.coveringCredits,
      applicableWindows: pacingEval.applicableWindows,
      blockers: pacingEval.blockers,
      freshness: pacingEval.freshness,
      checkedAt: pacingEval.checkedAt,
      warnings: combinedWarnings,
      rejectionReasons,
    });
  }

  // Rank eligible candidates
  const eligible = audit.filter((c) => c.eligible);
  const bands = durationBands(eligible, policy.scoring.speedTieBreakerMarginRatio ?? 0.15);
  const eligibleCandidates = eligible.sort((a, b) => compareCandidates(a, b, policy, bands));
  const compliant = audit.filter((c) => c.compliant);

  // Compute resetEvents & nextCheckAt
  const resetEvents = [];
  const seenWindow = new Set();
  for (const c of compliant) {
    for (const win of c.applicableWindows ?? []) {
      if (win.resetsAt && win.resetsInHours > 0) {
        const key = `${c.instanceId}:${win.id ?? win.label}:${win.resetsAt}`;
        if (!seenWindow.has(key)) {
          seenWindow.add(key);
          resetEvents.push({
            instanceId: c.instanceId,
            windowId: win.id ?? win.label,
            at: win.resetsAt,
          });
        }
      }
    }
  }
  resetEvents.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const anyStaleOrUnknown = compliant.some((c) => c.quotaState === 'unknown');
  const expiryTimes = compliant
    .filter((c) => c.checkedAt && c.freshness === 'fresh')
    .map((c) => Date.parse(c.checkedAt) + policy.pacing.maxSnapshotAgeMinutes * 60000);

  let nextCheckAtMs = anyStaleOrUnknown
    ? nowMs
    : Math.min(
        nowMs + policy.pacing.recheckAfterMinutes * 60000,
        ...resetEvents.map((e) => Date.parse(e.at)),
        ...expiryTimes,
      );

  let action = 'pause';
  let recommended = null;
  let waitUntil = null;
  let redeemCandidate = null;

  if (eligibleCandidates.length > 0) {
    const winner = eligibleCandidates[0];
    action = 'run';
    recommended = {
      candidateId: winner.candidateId,
      instanceId: winner.instanceId,
      driver: winner.driver,
      model: winner.model,
      effort: winner.effort,
      options: winner.options,
      target: {
        providerInstanceId: winner.instanceId,
        model: winner.model,
        ...(winner.options ? { options: winner.options } : {}),
      },
      delegateReady: true,
      quotaState: winner.quotaState,
      qualityTier: winner.qualityTier,
      scoreIdentity: winner.scoreIdentity,
      executor: winner.scoreExecutor,
      paceScore: winner.paceScore,
      warnings: winner.warnings,
    };
    reasons.push(
      `Selected ${winner.candidateId} (${winner.instanceId}/${winner.model}) for slot=${slot}, task=${task}` +
        (tier ? `, tier=${tier}` : '') +
        ` [quota=${winner.quotaState}, quality=${winner.qualityTier}` +
        (winner.scoreCell?.durationMedianMin != null ? `, median=${winner.scoreCell.durationMedianMin.toFixed(1)}m` : '') +
        (winner.speedLongRate != null ? `, speed=${winner.speedLongRate} tok/s` : '') +
        `].`,
    );
    if (winner.warnings.length > 0) {
      reasons.push(`Warnings: ${winner.warnings.join('; ')}.`);
    }
  } else {
    // Check wait budget
    const waitable = compliant
      .filter((c) => ['exhausted', 'low'].includes(c.quotaState) && c.availableAfter)
      .filter((c) => (Date.parse(c.availableAfter) - nowMs) / 60000 <= waitMinutes)
      .sort((a, b) => Date.parse(a.availableAfter) - Date.parse(b.availableAfter));

    const redeemable = compliant.find((c) => c.quotaState === 'credit_redeem');

    if (waitable.length > 0) {
      action = 'wait';
      waitUntil = waitable[0].availableAfter;
      nextCheckAtMs = Date.parse(waitUntil);
      reasons.push(
        `No candidate currently eligible; ${waitable[0].candidateId} resets at ${waitUntil} (within ${waitMinutes}m wait budget).`,
      );
    } else if (redeemable) {
      action = 'redeem';
      nextCheckAtMs = nowMs;
      const card = redeemable.coveringCredits[0];
      redeemCandidate = {
        candidateId: redeemable.candidateId,
        instanceId: redeemable.instanceId,
        driver: redeemable.driver,
        creditId: card?.creditId ?? null,
        resetType: card?.resetType ?? null,
        expiresAt: card?.expiresAt ?? null,
      };
      reasons.push(
        `No candidate available naturally; redeem reset credit "${card?.creditId}" (${card?.resetType}) on ${redeemable.instanceId} and re-query.`,
      );
    } else if (anyStaleOrUnknown) {
      action = 'refresh';
      reasons.push('Relevant provider snapshot is missing, stale, or unavailable; refresh usage snapshot before dispatching (live: use --t3-auto or --t3-origin; replaying a saved file: pass --now close to its observedAt).');
    } else {
      action = 'pause';
      reasons.push('All compliant candidates are blocked by quota or strict quality gates; retry after nextCheckAt, raise --wait-minutes, or relax the config (scoring.mode, pacing thresholds).');
    }
  }

  for (const c of audit) {
    if (c.candidateId === recommended?.candidateId) continue;
    if (!c.compliant) {
      reasons.push(`Skipped ${c.candidateId}: ${c.rejectionReasons.join('; ')}.`);
    } else if (!c.eligible) {
      reasons.push(`Blocked ${c.candidateId} (${c.quotaState}): ${c.rejectionReasons.join('; ')}.`);
    }
  }

  return {
    action,
    slot,
    task,
    tier,
    recommended,
    waitUntil,
    redeemCandidate,
    nextCheckAt: new Date(nextCheckAtMs).toISOString(),
    resetEvents,
    reasons,
    candidates: audit,
    rankedEligibleIds: eligibleCandidates.map((c) => c.candidateId),
  };
}

export function formatDecisionText(decision, { lang = 'en' } = {}) {
  const zh = lang === 'zh';
  const lines = [];
  if (decision.action === 'run' && decision.recommended) {
    const r = decision.recommended;
    lines.push(
      zh
        ? `建议动作: run → ${r.instanceId} / ${r.model} (槽位 ${decision.slot}, 任务 ${decision.task}${decision.tier ? `, 档位 ${decision.tier}` : ''})`
        : `Action: run -> ${r.instanceId} / ${r.model} (slot=${decision.slot}, task=${decision.task}${decision.tier ? `, tier=${decision.tier}` : ''})`,
    );
    lines.push(
      zh
        ? `delegate_task target: ${JSON.stringify(r.target)}`
        : `delegate_task target: ${JSON.stringify(r.target)}`,
    );
  } else {
    lines.push(
      zh
        ? `建议动作: ${decision.action}${decision.waitUntil ? ` (等待至 ${decision.waitUntil})` : ''}`
        : `Action: ${decision.action}${decision.waitUntil ? ` (waitUntil ${decision.waitUntil})` : ''}`,
    );
  }
  for (const reason of decision.reasons) {
    lines.push(`- ${reason}`);
  }
  lines.push(
    zh
      ? `下次检查: ${decision.nextCheckAt}`
      : `Next check: ${decision.nextCheckAt}`,
  );
  return lines.join('\n') + '\n';
}
