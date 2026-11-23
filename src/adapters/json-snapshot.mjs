import { normalizeT3ConfigToSnapshot, inferWindowPool } from './t3-config.mjs';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function toIsoTimestamp(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value < 1e12 ? value * 1000 : value;
    const d = new Date(millis);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  return null;
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function normalizeLegacyClaudeEntry(entry, observedIso) {
  const plan = isObject(entry.plan) ? entry.plan : entry;
  const rawStatus = plan.status;
  const status = rawStatus === 'ok' || rawStatus === 'ready'
    ? 'ready'
    : ['unavailable', 'not_applicable', 'disabled'].includes(rawStatus)
      ? rawStatus
      : 'unavailable';

  const windows = [];
  if (status === 'ready' && Array.isArray(plan.windows)) {
    for (const win of plan.windows) {
      if (!isObject(win)) continue;
      const label = typeof win.label === 'string' ? win.label : null;
      let id = typeof win.id === 'string' && win.id ? win.id : null;
      if (!id && label) {
        if (label === '5-hour limit') id = 'five_hour';
        else if (label === 'Weekly · all models') id = 'seven_day';
        else if (label.startsWith('Weekly · ') && label.slice(9).trim()) {
          id = `seven_day_${label.slice(9).trim().toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
        }
      }
      const usedRaw = clampPercent(win.percentUsed ?? win.usedPercent);
      const remRaw = clampPercent(win.remainingPercent);
      const usedPercent = usedRaw ?? (remRaw !== null ? clampPercent(100 - remRaw) : null);
      const remainingPercent = remRaw ?? (usedRaw !== null ? clampPercent(100 - usedRaw) : null);
      const windowDurationMins = Number.isFinite(win.windowDurationMins) && win.windowDurationMins > 0
        ? win.windowDurationMins
        : id === 'five_hour'
          ? 300
          : id === 'seven_day' || id?.startsWith('seven_day_')
            ? 10080
            : null;
      windows.push({
        id: id ?? label ?? 'window',
        kind: id === 'five_hour' ? 'session' : id === 'seven_day' || id?.startsWith('seven_day_') ? 'weekly' : 'other',
        label: label ?? id ?? 'window',
        pool: null,
        modelIds: null,
        providerIds: null,
        usedPercent,
        remainingPercent,
        resetsAt: toIsoTimestamp(win.resetsAt),
        windowDurationMins,
      });
    }
  }

  let resetCredits = null;
  if (Array.isArray(plan.resetCredits)) {
    const cards = plan.resetCredits
      .filter((c) => isObject(c) && typeof c.resetType === 'string')
      .map((c, idx) => {
        const type = c.resetType;
        const coversWindowIds = type === 'claudeSession'
          ? ['five_hour']
          : type === 'claudeFable'
            ? ['seven_day_fable']
            : null;
        const coversWindowPrefixes = type === 'claudeWeekly' ? ['seven_day'] : null;
        return {
          creditId: c.creditId ?? `claude-card-${idx + 1}`,
          resetType: type,
          status: c.status ?? 'available',
          resetsLeft: Number.isSafeInteger(c.resetsLeft) ? c.resetsLeft : 0,
          coversWindowIds,
          coversWindowPrefixes,
          expiresAt: toIsoTimestamp(c.expiresAt),
        };
      });
    const availSum = cards.filter((c) => c.status === 'available').reduce((sum, c) => sum + c.resetsLeft, 0);
    const known = Number.isSafeInteger(plan.resetCreditAvailableCount)
      ? plan.resetCreditAvailableCount === availSum
      : true;
    resetCredits = {
      known,
      availableCount: Number.isSafeInteger(plan.resetCreditAvailableCount)
        ? plan.resetCreditAvailableCount
        : availSum,
      nextExpiresAt: toIsoTimestamp(plan.resetCreditExpiresAt) ?? cards.find((c) => c.expiresAt)?.expiresAt ?? null,
      cards,
    };
  }

  return {
    instanceId: entry.instanceId ?? 'claude',
    driver: 'claudeAgent',
    displayName: entry.displayName ?? 'Claude',
    enabled: status !== 'disabled',
    status,
    plan: typeof plan.plan === 'string'
      ? plan.plan
      : typeof plan.planType === 'string'
        ? plan.planType
        : null,
    checkedAt: toIsoTimestamp(plan.observedAt ?? entry.observedAt) ?? observedIso,
    detail: typeof plan.detail === 'string' ? plan.detail : null,
    windows,
    resetCredits,
    budget: null,
  };
}

function normalizeLegacyGenericEntry(entry, observedIso) {
  const provider = String(entry.instanceId ?? entry.provider ?? '').trim();
  const driver = String(entry.driver ?? provider).trim();
  const status = ['ready', 'unavailable', 'not_applicable', 'disabled'].includes(entry.status)
    ? entry.status
    : 'unavailable';

  let rawWindows = [];
  if (status === 'ready') {
    if (Array.isArray(entry.windows)) {
      rawWindows = entry.windows;
    } else if (Number.isFinite(entry.remainingPercent) || Number.isFinite(entry.usedPercent)) {
      rawWindows = [{
        id: 'primary',
        label: 'primary',
        remainingPercent: entry.remainingPercent,
        usedPercent: entry.usedPercent,
        resetsAt: entry.resetsAt,
        windowDurationMins: entry.windowDurationMins,
      }];
    }
  }

  const windows = rawWindows.filter(isObject).map((win, idx) => {
    const usedRaw = clampPercent(win.usedPercent);
    const remRaw = clampPercent(win.remainingPercent);
    const usedPercent = usedRaw ?? (remRaw !== null ? clampPercent(100 - remRaw) : null);
    const remainingPercent = remRaw ?? (usedRaw !== null ? clampPercent(100 - usedRaw) : null);
    const duration = Number.isFinite(win.windowDurationMins) && win.windowDurationMins > 0
      ? win.windowDurationMins
      : null;
    return {
      id: win.id ?? `window-${idx + 1}`,
      kind: win.kind ?? (duration && duration < 1440 ? 'session' : duration === 10080 ? 'weekly' : 'other'),
      label: win.label ?? win.id ?? `window-${idx + 1}`,
      pool: inferWindowPool(driver, win),
      modelIds: Array.isArray(win.modelIds) ? [...win.modelIds] : null,
      providerIds: Array.isArray(win.providerIds) ? [...win.providerIds] : null,
      usedPercent,
      remainingPercent,
      resetsAt: toIsoTimestamp(win.resetsAt),
      windowDurationMins: duration,
    };
  });

  let resetCredits = null;
  if (Array.isArray(entry.resetCredits) || Number.isSafeInteger(entry.resetCreditAvailableCount)) {
    const cards = Array.isArray(entry.resetCredits)
      ? entry.resetCredits.filter(isObject).map((c, idx) => ({
          creditId: c.creditId ?? `card-${idx + 1}`,
          resetType: c.resetType ?? 'codexRateLimits',
          status: c.status ?? 'available',
          resetsLeft: Number.isSafeInteger(c.resetsLeft) ? c.resetsLeft : 1,
          coversWindowIds: null,
          coversWindowPrefixes: null,
          expiresAt: toIsoTimestamp(c.expiresAt),
        }))
      : [];
    const avail = cards.filter((c) => c.status === 'available').length;
    const count = Number.isSafeInteger(entry.resetCreditAvailableCount) ? entry.resetCreditAvailableCount : avail;
    resetCredits = {
      known: cards.length > 0 ? count === avail : false,
      availableCount: count,
      nextExpiresAt: toIsoTimestamp(entry.resetCreditExpiresAt) ?? cards.find((c) => c.expiresAt)?.expiresAt ?? null,
      cards,
    };
  }

  return {
    instanceId: provider,
    driver,
    displayName: entry.displayName ?? provider,
    enabled: status !== 'disabled',
    status,
    plan: entry.planType ?? entry.plan ?? null,
    checkedAt: toIsoTimestamp(entry.observedAt) ?? observedIso,
    detail: typeof entry.detail === 'string' ? entry.detail : null,
    windows,
    resetCredits,
    budget: null,
  };
}

export function overlayBudgetEntries(snapshot, budgets) {
  if (!budgets) return snapshot;
  const list = Array.isArray(budgets)
    ? budgets
    : isObject(budgets) && typeof budgets.instanceId === 'string'
      ? [budgets]
      : isObject(budgets)
        ? Object.entries(budgets).map(([instanceId, value]) => ({ instanceId, ...(isObject(value) ? value : {}) }))
        : [];

  if (!list.length) return snapshot;

  const instances = { ...snapshot.instances };
  for (const item of list) {
    if (!isObject(item) || typeof item.instanceId !== 'string' || !item.instanceId.trim()) continue;
    const id = item.instanceId.trim();
    const existing = instances[id];
    const budget = {
      spent: Number.isFinite(item.spent) ? item.spent : 0,
      budget: Number.isFinite(item.budget) ? item.budget : null,
      balance: Number.isFinite(item.balance) ? item.balance : null,
      isAvailable: typeof item.isAvailable === 'boolean' ? item.isAvailable : true,
      currency: typeof item.currency === 'string' ? item.currency : null,
      month: typeof item.month === 'string' ? item.month : null,
      resetsAt: toIsoTimestamp(item.resetsAt),
    };
    const isUnavailable = budget.isAvailable === false;
    instances[id] = existing
      ? {
          ...existing,
          budget,
        }
      : {
          instanceId: id,
          driver: item.driver ?? 'api',
          displayName: item.displayName ?? id,
          enabled: item.enabled !== false,
          status: item.enabled === false ? 'disabled' : isUnavailable ? 'unavailable' : 'ready',
          plan: item.plan ?? 'pay-as-you-go',
          checkedAt: toIsoTimestamp(item.checkedAt) ?? snapshot.observedAt,
          detail: typeof item.detail === 'string' ? item.detail : null,
          windows: [],
          resetCredits: null,
          budget,
        };
  }

  return {
    ...snapshot,
    source: snapshot.source === 't3-rpc' ? 'mixed' : snapshot.source,
    instances,
  };
}

export function normalizeSnapshot(input, { now = Date.now(), budgets = null } = {}) {
  if (!isObject(input)) {
    throw new Error('Snapshot input must be a JSON object');
  }
  const nowMs = now instanceof Date ? now.getTime() : now;
  const observedIso = new Date(nowMs).toISOString();
  let snapshot;

  // 1. Native UsageSnapshot v2
  if (input.schemaVersion === 2 && isObject(input.instances)) {
    const instances = {};
    for (const [key, inst] of Object.entries(input.instances)) {
      if (!isObject(inst)) continue;
      const driver = String(inst.driver ?? key);
      const windows = Array.isArray(inst.windows)
        ? inst.windows.filter(isObject).map((win) => {
            const usedRaw = clampPercent(win.usedPercent);
            const remRaw = clampPercent(win.remainingPercent);
            return {
              ...win,
              usedPercent: usedRaw ?? (remRaw !== null ? clampPercent(100 - remRaw) : null),
              remainingPercent: remRaw ?? (usedRaw !== null ? clampPercent(100 - usedRaw) : null),
              pool: inferWindowPool(driver, win),
              resetsAt: toIsoTimestamp(win.resetsAt),
            };
          })
        : [];
      instances[key] = {
        instanceId: inst.instanceId ?? key,
        driver,
        displayName: inst.displayName ?? key,
        enabled: inst.enabled !== false,
        status: inst.status ?? (inst.enabled === false ? 'disabled' : 'ready'),
        plan: inst.plan ?? null,
        checkedAt: toIsoTimestamp(inst.checkedAt) ?? toIsoTimestamp(input.observedAt) ?? observedIso,
        detail: inst.detail ?? null,
        ...(Array.isArray(inst.models) ? { models: [...inst.models] } : {}),
        windows,
        resetCredits: inst.resetCredits ?? null,
        budget: inst.budget ?? null,
      };
    }
    snapshot = {
      schemaVersion: 2,
      observedAt: toIsoTimestamp(input.observedAt) ?? observedIso,
      source: input.source ?? 'json',
      instances,
      ...(Array.isArray(input.usageLimitSources) ? { usageLimitSources: input.usageLimitSources } : {}),
    };
  }
  // 2. T3 server.getConfig dump
  else if (
    (Array.isArray(input.providers) && input.schemaVersion !== 1) ||
    isObject(input.value) && Array.isArray(input.value.providers)
  ) {
    snapshot = {
      ...normalizeT3ConfigToSnapshot(input, nowMs),
      source: 'json',
    };
  }
  // 3. Legacy schemaVersion 1 report
  else if (input.schemaVersion === 1 && Array.isArray(input.providers)) {
    const instances = {};
    for (const entry of input.providers) {
      if (!isObject(entry) || typeof entry.provider !== 'string') continue;
      const norm = entry.provider === 'claude' || entry.provider === 'claudeAgent'
        ? normalizeLegacyClaudeEntry(entry, observedIso)
        : normalizeLegacyGenericEntry(entry, observedIso);
      instances[norm.instanceId] = norm;
    }
    snapshot = {
      schemaVersion: 2,
      observedAt: toIsoTimestamp(input.observedAt) ?? observedIso,
      source: 'json',
      instances,
    };
  }
  // 4. Standalone Claude desktop/plan JSON
  else if (
    isObject(input.plan) ||
    (Array.isArray(input.windows) && ['ok', 'ready', 'unavailable', 'not_applicable'].includes(input.status))
  ) {
    const claudeInst = normalizeLegacyClaudeEntry(input, observedIso);
    snapshot = {
      schemaVersion: 2,
      observedAt: claudeInst.checkedAt ?? observedIso,
      source: 'json',
      instances: {
        [claudeInst.instanceId]: claudeInst,
      },
    };
  } else {
    throw new Error('Unsupported snapshot format');
  }

  return overlayBudgetEntries(snapshot, budgets);
}
