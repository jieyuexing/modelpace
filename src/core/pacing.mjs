const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export const DEFAULT_PACING_CONFIG = Object.freeze({
  paceMarginPercent: 10,
  longTaskMinRemainingPercent: 30,
  defaultMinRemainingPercent: 20,
  shortWindowMaxUsedPercent: 90,
  recheckAfterMinutes: 15,
  maxSnapshotAgeMinutes: 15,
  resetCredit: {
    skipIfResetWithinHours: 6,
    expiryWarnHours: 72,
  },
  expiringBoost: {
    resetWithinHours: 24,
    minRemainingPercent: 30,
    maxShortUsedPercent: 70,
  },
});

const isPercent = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;

function parseTimestampMs(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    return Number.isFinite(new Date(ms).getTime()) ? ms : NaN;
  }
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : NaN;
  }
  return NaN;
}

export function inferAntigravityPool(model) {
  if (typeof model !== 'string' || !model.trim()) return null;
  const base = model.slice(model.lastIndexOf('/') + 1).toLowerCase();
  if (base.includes('argon')) return 'argon';
  if (base.includes('carbon')) return 'carbon';
  if (base.startsWith('gemini')) return 'gemini';
  if (base.startsWith('claude')) return 'claude';
  if (base.startsWith('gpt')) return 'gpt';
  return null;
}

export function evaluateWindow(win, { now = Date.now(), paceMarginPercent = 10 } = {}) {
  if (!isObject(win)) {
    return { valid: false, issue: 'Window must be an object' };
  }
  const nowMs = now instanceof Date ? now.getTime() : now;
  const hasUsed = win.usedPercent != null;
  const hasRem = win.remainingPercent != null;
  if (!hasUsed && !hasRem) {
    return { valid: false, issue: `Window ${win.id ?? 'unknown'} missing percentage` };
  }
  if ((hasUsed && !isPercent(win.usedPercent)) || (hasRem && !isPercent(win.remainingPercent))) {
    return { valid: false, issue: `Window ${win.id ?? 'unknown'} percentage out of range 0..100` };
  }
  if (hasUsed && hasRem && Math.abs(win.usedPercent + win.remainingPercent - 100) > 1) {
    return { valid: false, issue: `Window ${win.id ?? 'unknown'} usedPercent + remainingPercent mismatch` };
  }

  const usedPercent = hasUsed ? win.usedPercent : 100 - win.remainingPercent;
  const remainingPercent = hasRem ? win.remainingPercent : 100 - win.usedPercent;
  const effectiveRemainingPercent = hasUsed && hasRem
    ? Math.min(win.remainingPercent, 100 - win.usedPercent)
    : remainingPercent;

  const resetsAtMs = parseTimestampMs(win.resetsAt);
  if (win.resetsAt != null && Number.isNaN(resetsAtMs)) {
    return { valid: false, issue: `Window ${win.id ?? 'unknown'} invalid resetsAt` };
  }
  const duration = win.windowDurationMins;
  if (duration != null && (!Number.isFinite(duration) || duration <= 0)) {
    return { valid: false, issue: `Window ${win.id ?? 'unknown'} invalid windowDurationMins` };
  }

  const resetsAt = resetsAtMs !== null ? new Date(resetsAtMs).toISOString() : null;
  const resetsInMins = resetsAtMs !== null ? (resetsAtMs - nowMs) / 60000 : null;
  const resetsInHours = resetsInMins !== null ? resetsInMins / 60 : null;
  const expiredReset = resetsInMins !== null && resetsInMins <= 0;

  const remainingTimePercent = Number.isFinite(duration) && duration > 0
    && resetsInMins !== null && resetsInMins > 0 && resetsInMins <= duration
    ? (resetsInMins / duration) * 100
    : null;

  const paceBalancePercent = remainingTimePercent !== null
    ? effectiveRemainingPercent - remainingTimePercent
    : null;

  const pace = paceBalancePercent === null
    ? 'unknown'
    : paceBalancePercent >= paceMarginPercent
      ? 'surplus'
      : paceBalancePercent <= -paceMarginPercent
        ? 'conserve'
        : 'balanced';

  return {
    valid: true,
    id: win.id ?? null,
    kind: win.kind ?? 'other',
    label: win.label ?? win.id ?? 'window',
    pool: win.pool ?? null,
    modelIds: Array.isArray(win.modelIds) ? win.modelIds : null,
    providerIds: Array.isArray(win.providerIds) ? win.providerIds : null,
    applicableByDefault: win.applicableByDefault !== false,
    usedPercent,
    remainingPercent,
    effectiveRemainingPercent,
    resetsAt,
    resetsAtMs,
    resetsInMins,
    resetsInHours,
    expiredReset,
    windowDurationMins: Number.isFinite(duration) && duration > 0 ? duration : null,
    remainingTimePercent,
    paceBalancePercent,
    pace,
    creditAdjustedBalancePercent: paceBalancePercent,
    creditAdjustedPace: pace,
    creditBacked: false,
  };
}

export function isWindowApplicable(win, { driver, model = null, pool = null, claudeModel = null } = {}) {
  if (win.applicableByDefault === false) return false;

  const baseModel = typeof model === 'string' && model.trim()
    ? model.slice(model.lastIndexOf('/') + 1)
    : null;

  if (Array.isArray(win.modelIds) && win.modelIds.length > 0) {
    if (!model) return false;
    const matches = win.modelIds.includes(model) || (baseModel && win.modelIds.includes(baseModel));
    if (!matches) return false;
  }

  if (Array.isArray(win.providerIds) && win.providerIds.length > 0 && model) {
    const prefix = model.includes('/') ? model.split('/')[0] : null;
    if (prefix && !win.providerIds.includes(prefix)) return false;
  }

  if (driver === 'antigravity' || driver === 'gemini' || pool) {
    const candPool = (pool ?? inferAntigravityPool(model))?.toLowerCase() ?? null;
    const winPool = win.pool?.toLowerCase() ?? null;
    if (candPool && winPool) {
      if (candPool !== winPool) {
        const threePartyWindowCovers = winPool === '3p' && (candPool === 'claude' || candPool === 'gpt');
        const threePartyCandCovers = candPool === '3p' && (winPool === 'claude' || winPool === 'gpt');
        if (!threePartyWindowCovers && !threePartyCandCovers) return false;
      }
    }
  }

  if ((driver === 'claudeAgent' || driver === 'claude') && typeof win.id === 'string' && win.id.startsWith('seven_day_')) {
    const suffix = win.id.slice('seven_day_'.length).toLowerCase();
    const explicitClaudeModel = claudeModel?.trim().toLowerCase() ?? null;
    if (explicitClaudeModel) {
      return explicitClaudeModel === suffix;
    }
    if (baseModel) {
      const tokens = baseModel.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      return tokens.includes(suffix);
    }
    return false;
  }

  if (driver === 'opencode' && typeof win.id === 'string' && win.id.startsWith('go_') && model) {
    if (!model.startsWith('opencode-go/')) return false;
  }

  return true;
}

export function cardCoversWindow(card, win) {
  if (!card || !win) return false;
  if (Array.isArray(card.coversWindowIds) && card.coversWindowIds.length > 0) {
    return card.coversWindowIds.includes(win.id);
  }
  if (Array.isArray(card.coversWindowPrefixes) && card.coversWindowPrefixes.length > 0) {
    return typeof win.id === 'string' && card.coversWindowPrefixes.some((p) => win.id.startsWith(p));
  }
  switch (card.resetType) {
    case 'claudeSession':
      return win.id === 'five_hour';
    case 'claudeWeekly':
      return win.id === 'seven_day' || (typeof win.id === 'string' && win.id.startsWith('seven_day_'));
    case 'claudeFable':
      return win.id === 'seven_day_fable';
    case 'claudeFull':
    case 'codexRateLimits':
    case 'custom':
    default:
      return true;
  }
}

export function evaluateFreshness(checkedAt, nowMs, maxSnapshotAgeMinutes = 15) {
  if (!checkedAt) return { freshness: 'unknown', ageMinutes: null, checkedAtIso: null };
  const ms = parseTimestampMs(checkedAt);
  if (Number.isNaN(ms)) return { freshness: 'unknown', ageMinutes: null, checkedAtIso: null };
  const ageMinutes = (nowMs - ms) / 60000;
  const freshness = ageMinutes < 0
    ? 'future'
    : ageMinutes >= maxSnapshotAgeMinutes
      ? 'stale'
      : 'fresh';
  return { freshness, ageMinutes, checkedAtIso: new Date(ms).toISOString() };
}

export function evaluateBudget(budget, nowMs) {
  if (!budget || !isObject(budget)) return null;
  const spent = Number.isFinite(budget.spent) ? budget.spent : 0;
  const limit = Number.isFinite(budget.budget) && budget.budget > 0 ? budget.budget : null;
  const balance = Number.isFinite(budget.balance) ? budget.balance : null;
  const isAvailable = budget.isAvailable !== false;
  const resetsAtMs = parseTimestampMs(budget.resetsAt);
  const resetsAt = resetsAtMs && !Number.isNaN(resetsAtMs) ? new Date(resetsAtMs).toISOString() : null;

  const budgetRemainingPct = limit !== null ? Math.max(0, ((limit - spent) / limit) * 100) : null;
  const balanceRemainingPct = limit !== null && balance !== null
    ? (isAvailable ? Math.max(0, (balance / limit) * 100) : 0)
    : null;
  const remainingPercent = budgetRemainingPct !== null && balanceRemainingPct !== null
    ? Math.min(budgetRemainingPct, balanceRemainingPct)
    : (budgetRemainingPct ?? (balance !== null && balance <= 0 ? 0 : null));

  const blockers = [];
  if (!isAvailable) {
    blockers.push({
      windowId: 'account-balance',
      state: 'exhausted',
      remainingPercent: 0,
      minimumRemainingPercent: 0,
      resetsAt: null,
      reason: 'Pay-as-you-go account marked unavailable',
    });
  } else if (balance !== null && balance <= 0) {
    blockers.push({
      windowId: 'account-balance',
      state: 'exhausted',
      remainingPercent: 0,
      minimumRemainingPercent: 0,
      resetsAt: null,
      reason: `Account balance exhausted (${balance})`,
    });
  }
  if (limit !== null && spent >= limit) {
    blockers.push({
      windowId: 'monthly-budget',
      state: 'exhausted',
      remainingPercent: 0,
      minimumRemainingPercent: 0,
      resetsAt: resetsAtMs && resetsAtMs > nowMs ? resetsAt : null,
      reason: `Spent ${spent} reached budget ${limit}`,
    });
  }

  return {
    spent,
    budget: limit,
    balance,
    isAvailable,
    remainingPercent,
    resetsAt,
    blockers,
  };
}

export function evaluateInstanceCandidate({
  instance,
  instancePolicy = {},
  candidate = {},
  request = {},
  pacingConfig = DEFAULT_PACING_CONFIG,
  now = Date.now(),
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const task = request.task ?? 'general';
  const waitMinutes = Number.isFinite(request.waitMinutes) ? request.waitMinutes : 0;
  const margin = pacingConfig.paceMarginPercent ?? 10;

  if (!instance) {
    return {
      quotaState: 'unknown',
      eligible: false,
      freshness: 'unknown',
      ageMinutes: null,
      checkedAt: null,
      windows: [],
      applicableWindows: [],
      blockers: [],
      issues: ['Instance not found in snapshot'],
      warnings: [],
      usableCredits: [],
      coveringCredits: [],
      availableAfter: null,
      paceScore: null,
      expiringBonus: 0,
      budgetView: null,
    };
  }

  if (instance.enabled === false || instance.status === 'disabled') {
    return {
      quotaState: 'disabled',
      eligible: false,
      freshness: 'unknown',
      ageMinutes: null,
      checkedAt: instance.checkedAt ?? null,
      windows: [],
      applicableWindows: [],
      blockers: [],
      issues: [],
      warnings: [],
      usableCredits: [],
      coveringCredits: [],
      availableAfter: null,
      paceScore: null,
      expiringBonus: 0,
      budgetView: null,
    };
  }

  const issues = [];
  const warnings = [];
  const { freshness, ageMinutes, checkedAtIso } = evaluateFreshness(
    instance.checkedAt,
    nowMs,
    pacingConfig.maxSnapshotAgeMinutes ?? 15,
  );

  if (instance.status === 'unavailable' || instance.status === 'not_applicable') {
    issues.push(instance.detail || `Instance status is ${instance.status}`);
  } else if (freshness === 'stale' || freshness === 'future') {
    issues.push(`Snapshot is ${freshness} (age ${ageMinutes?.toFixed(1)}m)`);
  } else if (freshness === 'unknown') {
    warnings.push('Snapshot timestamp missing; freshness unknown');
  }

  // Evaluate reset credits
  const rawCards = Array.isArray(instance.resetCredits?.cards) ? instance.resetCredits.cards : [];
  const creditsKnown = instance.resetCredits?.known === true;
  const usableCredits = creditsKnown
    ? rawCards
        .map((card) => {
          const expMs = parseTimestampMs(card.expiresAt);
          const expiresInHours = expMs !== null && !Number.isNaN(expMs) ? (expMs - nowMs) / 3600000 : null;
          const usable = card.status === 'available'
            && Number.isSafeInteger(card.resetsLeft)
            && card.resetsLeft >= 1
            && (expiresInHours === null || expiresInHours > 0);
          return { ...card, expiresInHours, usable };
        })
        .filter((card) => card.usable)
        .sort((a, b) => (a.expiresInHours ?? Infinity) - (b.expiresInHours ?? Infinity))
    : [];

  const expiryWarnHours = pacingConfig.resetCredit?.expiryWarnHours ?? 72;
  if (usableCredits.length > 0 && usableCredits[0].expiresInHours !== null && usableCredits[0].expiresInHours <= expiryWarnHours) {
    warnings.push(`Reset credit ${usableCredits[0].creditId} expires in ${usableCredits[0].expiresInHours.toFixed(1)}h`);
  }

  // Evaluate windows
  const evaluatedWindows = [];
  for (const rawWin of Array.isArray(instance.windows) ? instance.windows : []) {
    const win = evaluateWindow(rawWin, { now: nowMs, paceMarginPercent: margin });
    if (!win.valid) {
      issues.push(win.issue);
      continue;
    }
    if (win.paceBalancePercent !== null && usableCredits.length > 0) {
      const exhaustionAt = nowMs + (win.effectiveRemainingPercent / 100) * win.windowDurationMins * 60000;
      const backed = win.resetsAtMs !== null
        && exhaustionAt < win.resetsAtMs
        && usableCredits.some((card) => cardCoversWindow(card, win) && (card.expiresAt == null || Date.parse(card.expiresAt) > exhaustionAt));
      if (backed) {
        const adjusted = win.paceBalancePercent + 100;
        win.creditBacked = true;
        win.creditAdjustedBalancePercent = adjusted;
        win.creditAdjustedPace = adjusted >= margin ? 'surplus' : adjusted <= -margin ? 'conserve' : 'balanced';
      }
    }
    evaluatedWindows.push(win);
  }

  const applicableWindows = evaluatedWindows.filter((win) =>
    isWindowApplicable(win, {
      driver: instance.driver,
      model: candidate.model ?? request.model ?? null,
      pool: candidate.pool ?? request.pool ?? null,
      claudeModel: request.claudeModel ?? candidate.claudeModel ?? null,
    }),
  );

  for (const win of applicableWindows) {
    if (win.expiredReset) {
      issues.push(`Window ${win.id ?? win.label} reset timestamp (${win.resetsAt}) has already passed`);
    }
  }

  // Evaluate budget
  const budgetView = evaluateBudget(instance.budget, nowMs);
  const blockers = [];
  if (budgetView) {
    blockers.push(...budgetView.blockers);
  }

  if (instance.status === 'ready' && applicableWindows.length === 0 && !budgetView) {
    // Allow zeroSpendCap or explicit API/custom without quota windows if marked ready,
    // otherwise warn if windows were expected
    if (['codex', 'claudeAgent', 'claude', 'antigravity'].includes(instance.driver)) {
      warnings.push('No applicable usage windows reported for candidate');
    }
  }

  // Gate applicable windows
  for (const win of applicableWindows) {
    const isShort = (win.windowDurationMins !== null && win.windowDurationMins < 1440) || win.kind === 'session';
    const rem = win.effectiveRemainingPercent;

    if (isShort) {
      const maxUsed = candidate.maxShortUsedPercent
        ?? instancePolicy.shortWindowMaxUsedPercent
        ?? pacingConfig.shortWindowMaxUsedPercent
        ?? 90;
      const floor = Math.max(0, 100 - maxUsed);
      if (rem === 0 || win.usedPercent >= maxUsed || rem < floor) {
        const state = rem === 0 ? 'exhausted' : 'low';
        blockers.push({
          windowId: win.id ?? win.label,
          state,
          remainingPercent: rem,
          usedPercent: win.usedPercent,
          minimumRemainingPercent: floor,
          maxUsedPercent: maxUsed,
          resetsAt: win.resetsAt,
          reason: `${win.id ?? win.label} ${state}: remaining ${rem.toFixed(1)}% (used ${win.usedPercent.toFixed(1)}%, max allowed ${maxUsed}%)`,
        });
      }
      continue;
    }

    const isLong = (win.windowDurationMins !== null && win.windowDurationMins >= 1440) || win.kind === 'weekly' || win.kind === 'monthly';
    if (isLong && win.remainingTimePercent !== null) {
      const balance = win.creditAdjustedBalancePercent ?? win.paceBalancePercent;
      const lagging = task === 'long' ? balance < 0 : balance < -margin;
      const floor = task === 'long'
        ? win.remainingTimePercent
        : Math.max(0, win.remainingTimePercent - margin);
      if (rem === 0 || lagging) {
        const state = rem === 0 ? 'exhausted' : 'low';
        blockers.push({
          windowId: win.id ?? win.label,
          state,
          remainingPercent: rem,
          minimumRemainingPercent: floor,
          paceBalancePercent: balance,
          resetsAt: win.resetsAt,
          reason: `${win.id ?? win.label} ${state} (Even Pace): remaining ${rem.toFixed(1)}%, pace floor ${floor.toFixed(1)}%`,
        });
      }
    } else {
      const baseFloor = candidate.minRemainingPercent
        ?? instancePolicy.weeklyMinRemainingPercent
        ?? pacingConfig.defaultMinRemainingPercent
        ?? 20;
      const floor = task === 'long'
        ? Math.max(baseFloor, pacingConfig.longTaskMinRemainingPercent ?? 30)
        : baseFloor;
      if (rem === 0 || rem < floor) {
        const state = rem === 0 ? 'exhausted' : 'low';
        blockers.push({
          windowId: win.id ?? win.label,
          state,
          remainingPercent: rem,
          minimumRemainingPercent: floor,
          resetsAt: win.resetsAt,
          reason: `${win.id ?? win.label} ${state}: remaining ${rem.toFixed(1)}%, floor ${floor.toFixed(1)}%`,
        });
      }
    }
  }

  const availableAfter = blockers.length > 0 && blockers.every((b) => b.resetsAt && Date.parse(b.resetsAt) > nowMs)
    ? new Date(Math.max(...blockers.map((b) => Date.parse(b.resetsAt)))).toISOString()
    : null;

  // 只有兑换后能解除全部拦截时才算有卡兜底：卡只覆盖部分窗口（或拦截来自余额、预算）时兑换了仍被拦，白耗一张卡。
  const blockerWindow = (b) => applicableWindows.find((w) => (w.id ?? w.label) === b.windowId);
  const everyBlockerCovered = blockers.length > 0 && blockers.every((b) => {
    const win = blockerWindow(b);
    return win && usableCredits.some((card) => cardCoversWindow(card, win));
  });
  const coveringCredits = everyBlockerCovered
    ? usableCredits.filter((card) => blockers.some((b) => cardCoversWindow(card, blockerWindow(b))))
    : [];

  let quotaState = 'available';
  if (issues.length > 0) {
    quotaState = 'unknown';
  } else if (blockers.length > 0) {
    const anyExhausted = blockers.some((b) => b.state === 'exhausted');
    const skipHours = pacingConfig.resetCredit?.skipIfResetWithinHours ?? 6;
    const resetNear = availableAfter !== null
      && (Date.parse(availableAfter) - nowMs) / 60000 <= Math.max(waitMinutes, skipHours * 60);

    if (coveringCredits.length > 0 && !resetNear && candidate.allowRedeem !== false) {
      quotaState = anyExhausted ? 'credit_redeem' : 'credit_low';
      if (quotaState === 'credit_low') {
        warnings.push('Running below floor backed by reset credit; manual redeem needed if exhausted');
      }
    } else {
      quotaState = anyExhausted ? 'exhausted' : 'low';
    }
  }

  // Compute paceScore & expiringBonus for tie-breaking across sibling instances
  const pacedWindows = applicableWindows.filter((w) => w.paceBalancePercent !== null);
  let paceScore = null;
  if (pacedWindows.length > 0) {
    paceScore = Math.min(...pacedWindows.map((w) => w.creditAdjustedBalancePercent ?? w.paceBalancePercent));
  } else if (applicableWindows.length > 0) {
    paceScore = Math.min(...applicableWindows.map((w) => w.effectiveRemainingPercent)) - 50;
  } else if (budgetView?.remainingPercent != null) {
    paceScore = budgetView.remainingPercent - 50;
  }

  let expiringBonus = 0;
  const boost = pacingConfig.expiringBoost;
  if (boost && (quotaState === 'available' || quotaState === 'credit_low')) {
    const shortHot = applicableWindows.some(
      (w) => ((w.windowDurationMins !== null && w.windowDurationMins < 1440) || w.kind === 'session')
        && w.usedPercent >= (boost.maxShortUsedPercent ?? 70),
    );
    const hasExpiringSurplus = !shortHot && applicableWindows.some(
      (w) => (w.windowDurationMins === null || w.windowDurationMins >= 1440)
        && w.resetsInHours !== null
        && w.resetsInHours > 0
        && w.resetsInHours <= (boost.resetWithinHours ?? 24)
        && w.effectiveRemainingPercent >= (boost.minRemainingPercent ?? 30)
        && (w.creditAdjustedPace === 'surplus' || w.pace === 'surplus'),
    );
    if (hasExpiringSurplus) {
      expiringBonus = 1;
    }
  }

  return {
    quotaState,
    eligible: quotaState === 'available' || quotaState === 'credit_low',
    freshness,
    ageMinutes,
    checkedAt: checkedAtIso,
    windows: evaluatedWindows,
    applicableWindows,
    blockers,
    issues,
    warnings,
    usableCredits,
    coveringCredits,
    availableAfter,
    paceScore,
    expiringBonus,
    budgetView,
  };
}
