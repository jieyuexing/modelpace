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

export function inferWindowPool(driver, window) {
  if (typeof window?.pool === 'string' && window.pool.trim()) {
    return window.pool.trim().toLowerCase();
  }
  if (driver !== 'antigravity' && driver !== 'gemini') return null;
  const id = String(window?.id ?? '').toLowerCase();
  const label = String(window?.label ?? '').toLowerCase();
  if (id.startsWith('3p-') || label.includes('3p') || id.startsWith('claude-') || id.startsWith('gpt-')) {
    return id.startsWith('claude-') ? 'claude' : id.startsWith('gpt-') ? 'gpt' : '3p';
  }
  if (id.includes('argon') || label.includes('argon')) return 'argon';
  if (id.includes('carbon') || label.includes('carbon')) return 'carbon';
  if (id.startsWith('gemini') || label.includes('gemini')) return 'gemini';
  return null;
}

function inferWindowDuration(driver, win) {
  if (Number.isFinite(win?.windowDurationMins) && win.windowDurationMins > 0) {
    return win.windowDurationMins;
  }
  const id = String(win?.id ?? '');
  if (driver === 'claudeAgent' || driver === 'claude') {
    if (id === 'five_hour') return 300;
    if (id === 'seven_day' || id.startsWith('seven_day_')) return 10080;
  }
  if (win?.kind === 'session') return 300;
  if (win?.kind === 'weekly') return 10080;
  return null;
}

function inferWindowKind(win) {
  if (['session', 'weekly', 'monthly', 'other'].includes(win?.kind)) return win.kind;
  const id = String(win?.id ?? '');
  if (id === 'five_hour' || id === 'primary' || id.endsWith('-5h')) return 'session';
  if (id === 'seven_day' || id.startsWith('seven_day_') || id === 'secondary' || id.endsWith('-weekly')) {
    return 'weekly';
  }
  if (id === 'individual' || id === 'monthly_spend') return 'monthly';
  if (Number.isFinite(win?.windowDurationMins)) {
    if (win.windowDurationMins < 1440) return 'session';
    if (win.windowDurationMins === 10080) return 'weekly';
    if (win.windowDurationMins >= 40000) return 'monthly';
  }
  return 'other';
}

function inferClaudeResetType(option) {
  const id = String(option?.creditId ?? '').toLowerCase();
  const label = String(option?.label ?? '').toLowerCase();
  const desc = String(option?.description ?? '').toLowerCase();
  const combined = `${id} ${label} ${desc}`;
  if (combined.includes('full') || combined.includes('all limits')) {
    return { resetType: 'claudeFull', coversWindowIds: null, coversWindowPrefixes: null };
  }
  if (combined.includes('fable')) {
    return { resetType: 'claudeFable', coversWindowIds: ['seven_day_fable'], coversWindowPrefixes: null };
  }
  if (combined.includes('session') || combined.includes('5-hour') || combined.includes('five_hour')) {
    return { resetType: 'claudeSession', coversWindowIds: ['five_hour'], coversWindowPrefixes: null };
  }
  if (combined.includes('weekly') || combined.includes('7-day') || combined.includes('seven_day')) {
    const modelMatch = id.match(/seven_day_([a-z0-9_]+)/) || label.match(/weekly\s*·\s*([a-z0-9_-]+)/);
    if (modelMatch && !['all', 'all_models'].includes(modelMatch[1])) {
      return {
        resetType: 'custom',
        coversWindowIds: [`seven_day_${modelMatch[1].replace(/-/g, '_')}`],
        coversWindowPrefixes: null,
      };
    }
    return { resetType: 'claudeWeekly', coversWindowIds: null, coversWindowPrefixes: ['seven_day'] };
  }
  return { resetType: 'custom', coversWindowIds: null, coversWindowPrefixes: null };
}

function normalizeResetCredits(driver, rawCredits) {
  if (!rawCredits || !isObject(rawCredits)) return null;

  // Already normalized v2 shape
  if (Array.isArray(rawCredits.cards)) {
    const cards = rawCredits.cards
      .filter((c) => isObject(c) && typeof c.resetType === 'string')
      .map((c, idx) => ({
        creditId: c.creditId ?? `card-${idx + 1}`,
        resetType: c.resetType,
        status: c.status ?? 'available',
        resetsLeft: Number.isSafeInteger(c.resetsLeft) ? c.resetsLeft : 1,
        coversWindowIds: Array.isArray(c.coversWindowIds) ? [...c.coversWindowIds] : null,
        coversWindowPrefixes: Array.isArray(c.coversWindowPrefixes) ? [...c.coversWindowPrefixes] : null,
        expiresAt: toIsoTimestamp(c.expiresAt),
      }));
    const availableCount = Number.isSafeInteger(rawCredits.availableCount)
      ? rawCredits.availableCount
      : cards.filter((c) => c.status === 'available').reduce((sum, c) => sum + c.resetsLeft, 0);
    return {
      known: rawCredits.known !== false,
      availableCount,
      nextExpiresAt: toIsoTimestamp(rawCredits.nextExpiresAt) ?? cards.find((c) => c.expiresAt)?.expiresAt ?? null,
      cards,
    };
  }

  // T3 ServerProviderResetCredits shape: { availableCount, nextExpiresAt, nextCreditId, options }
  const availableCount = Number.isSafeInteger(rawCredits.availableCount) ? rawCredits.availableCount : null;
  if (availableCount === null) return null;
  const nextExpiresAt = toIsoTimestamp(rawCredits.nextExpiresAt);
  const options = Array.isArray(rawCredits.options) ? rawCredits.options : [];
  const cards = [];

  if (options.length > 0) {
    for (const opt of options) {
      if (!isObject(opt) || !Number.isSafeInteger(opt.availableCount)) continue;
      const meta = (driver === 'claudeAgent' || driver === 'claude')
        ? inferClaudeResetType(opt)
        : driver === 'codex'
          ? { resetType: 'codexRateLimits', coversWindowIds: null, coversWindowPrefixes: null }
          : { resetType: 'custom', coversWindowIds: null, coversWindowPrefixes: null };
      cards.push({
        creditId: String(opt.creditId ?? 'credit'),
        resetType: meta.resetType,
        status: opt.availableCount > 0 ? 'available' : 'unusable',
        resetsLeft: opt.availableCount,
        coversWindowIds: meta.coversWindowIds,
        coversWindowPrefixes: meta.coversWindowPrefixes,
        expiresAt: toIsoTimestamp(opt.expiresAt) ?? nextExpiresAt,
      });
    }
  } else if (driver === 'codex') {
    cards.push({
      creditId: rawCredits.nextCreditId ?? 'codex-reset',
      resetType: 'codexRateLimits',
      status: availableCount > 0 ? 'available' : 'unusable',
      resetsLeft: availableCount,
      coversWindowIds: null,
      coversWindowPrefixes: null,
      expiresAt: nextExpiresAt,
    });
  } else if (driver === 'claudeAgent' || driver === 'claude') {
    // Unknown coverage if Claude has options omitted while count > 0
    return {
      known: availableCount === 0,
      availableCount,
      nextExpiresAt,
      cards: [],
    };
  }

  return {
    known: true,
    availableCount,
    nextExpiresAt,
    cards,
  };
}

function normalizeWindows(driver, rawWindows) {
  if (!Array.isArray(rawWindows)) return [];
  const hasCodexPlanWindows = driver === 'codex'
    && rawWindows.some((w) => w?.id === 'primary' || w?.id === 'secondary');

  return rawWindows
    .filter((win) => isObject(win))
    .map((win) => {
      const usedRaw = clampPercent(win.usedPercent);
      const remRaw = clampPercent(win.remainingPercent);
      const usedPercent = usedRaw ?? (remRaw !== null ? clampPercent(100 - remRaw) : null);
      const remainingPercent = remRaw ?? (usedRaw !== null ? clampPercent(100 - usedRaw) : null);
      const kind = inferWindowKind(win);
      const windowDurationMins = inferWindowDuration(driver, { ...win, kind });
      const id = typeof win.id === 'string' && win.id ? win.id : null;
      const pool = inferWindowPool(driver, win);
      const applicableByDefault = driver === 'codex' && id === 'individual' && hasCodexPlanWindows
        ? false
        : win.applicableByDefault !== false;

      return {
        id,
        kind,
        label: typeof win.label === 'string' && win.label ? win.label : (id ?? kind),
        pool,
        modelIds: Array.isArray(win.modelIds) ? [...win.modelIds] : null,
        providerIds: Array.isArray(win.providerIds) ? [...win.providerIds] : null,
        usedPercent,
        remainingPercent,
        resetsAt: toIsoTimestamp(win.resetsAt),
        windowDurationMins,
        ...(applicableByDefault ? {} : { applicableByDefault: false }),
      };
    });
}

function normalizeProviderEntry(provider, observedIso) {
  const instanceId = String(provider.instanceId ?? provider.id ?? '').trim();
  const driver = String(provider.driver ?? instanceId).trim();
  const enabled = provider.enabled !== false;
  const installed = provider.installed !== false;
  const limits = isObject(provider.usageLimits) ? provider.usageLimits : null;
  const authStatus = provider.auth?.status;

  let status = 'ready';
  let detail = null;

  if (!enabled) {
    status = 'disabled';
    detail = provider.message ?? 'Provider instance disabled';
  } else if (!installed) {
    status = 'unavailable';
    detail = provider.message ?? 'Provider CLI not installed';
  } else if (limits?.unavailable) {
    status = limits.unavailable.reason === 'unsupported' ? 'not_applicable' : 'unavailable';
    detail = limits.unavailable.message ?? limits.unavailable.reason;
  } else if (authStatus === 'unauthenticated') {
    status = 'unavailable';
    detail = provider.message ?? 'Provider unauthenticated';
  } else if (provider.status && provider.status !== 'ready') {
    status = 'unavailable';
    detail = provider.message ?? provider.unavailableReason ?? `Provider status: ${provider.status}`;
  }

  const windows = normalizeWindows(driver, limits?.windows ?? []);
  const checkedAt = toIsoTimestamp(limits?.checkedAt ?? provider.checkedAt) ?? observedIso;
  const resetCredits = normalizeResetCredits(driver, limits?.resetCredits);
  const models = Array.isArray(provider.models)
    ? provider.models
        .map((m) => (typeof m === 'string' ? m : (m?.slug ?? m?.id ?? null)))
        .filter((m) => typeof m === 'string' && m)
    : null;

  return {
    instanceId,
    driver,
    displayName: typeof provider.displayName === 'string' && provider.displayName.trim()
      ? provider.displayName.trim()
      : instanceId,
    enabled,
    status,
    plan: typeof provider.auth?.label === 'string' && provider.auth.label.trim()
      ? provider.auth.label.trim()
      : (typeof provider.plan === 'string' ? provider.plan : null),
    checkedAt,
    detail,
    ...(models ? { models } : {}),
    windows,
    resetCredits,
    budget: null,
  };
}

export function normalizeT3ConfigToSnapshot(serverConfig, now = Date.now()) {
  const raw = isObject(serverConfig?.value)
    ? serverConfig.value
    : isObject(serverConfig?.result)
      ? serverConfig.result
      : serverConfig;
  if (!isObject(raw) || !Array.isArray(raw.providers)) {
    throw new Error('Invalid T3 serverConfig: expected providers array');
  }
  const nowMs = now instanceof Date ? now.getTime() : now;
  const observedAt = new Date(nowMs).toISOString();
  const instances = {};

  for (const provider of raw.providers) {
    if (!isObject(provider) || typeof provider.instanceId !== 'string' || !provider.instanceId.trim()) {
      continue;
    }
    const normalized = normalizeProviderEntry(provider, observedAt);
    instances[normalized.instanceId] = normalized;
  }

  const sources = [];
  if (Array.isArray(raw.usageLimitSources)) {
    for (const source of raw.usageLimitSources) {
      if (!isObject(source) || typeof source.id !== 'string') continue;
      const sourceEntry = {
        id: source.id,
        kind: source.kind ?? 'cliproxy',
        label: source.label ?? source.id,
        origin: source.origin ?? null,
        endpoint: source.endpoint ?? null,
        checkedAt: toIsoTimestamp(source.checkedAt) ?? observedAt,
        error: source.error ?? null,
        accounts: [],
      };
      for (const account of Array.isArray(source.accounts) ? source.accounts : []) {
        if (!isObject(account) || typeof account.id !== 'string') continue;
        const accountKey = `${source.id}:${account.id}`;
        const accNorm = normalizeProviderEntry(
          {
            instanceId: accountKey,
            driver: account.driver,
            displayName: account.email ? `${source.label ?? source.id} · ${account.email}` : `${source.label ?? source.id} · ${account.id}`,
            enabled: true,
            installed: true,
            status: 'ready',
            plan: account.plan ?? null,
            models: account.models ?? null,
            usageLimits: account.usageLimits,
          },
          observedAt,
        );
        sourceEntry.accounts.push(accNorm);
        if (!instances[accountKey]) {
          instances[accountKey] = accNorm;
        }
      }
      sources.push(sourceEntry);
    }
  }

  return {
    schemaVersion: 2,
    observedAt,
    source: 't3-rpc',
    instances,
    ...(sources.length ? { usageLimitSources: sources } : {}),
  };
}
