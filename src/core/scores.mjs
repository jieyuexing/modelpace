import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TASKS = Object.freeze(['general', 'research', 'review', 'slice', 'long']);
export const OUTCOMES = Object.freeze(['completed', 'failed', 'interrupted', 'cancelled']);
export const ABORT_REASONS = Object.freeze(['quota', 'stall', 'timeout', 'error', 'user', 'other']);

const FIELDS = [
  'date', 'taskId', 'title', 'task', 'executor', 'scorer',
  'accepted', 'firstPass', 'reworkRounds', 'scopeViolation', 'falseReport',
  'stoppedOnDenial', 'durationMin', 'quotaDelta', 'note',
];
const OPTIONAL_FIELDS = ['outcome', 'abortReason'];
const IDENTITY = ['provider', 'model', 'effort', 'tier', 'site'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const token = (value) => nonempty(value) && !/[\s/\x00-\x1f\x7f]/.test(value);

export const DEFAULT_SCORING_CONFIG = Object.freeze({
  mode: 'demote',
  minPassRate: 0.85,
  minSamples: 5,
  speedTieBreakerMarginRatio: 0.15,
  costWeight: 0,
  aliases: {
    provider: { claudeAgent: 'claude' },
    tier: { '-': 'default' },
  },
  durationUnreadableProviders: [],
  rejectRules: [],
  disabledProviders: [],
  pricing: {
    currency: 'USD',
    exchangeRates: { USD: 6.67, CNY: 1 },
    monthlyPrice: {},
  },
});

function exactFields(value, keys, label, optional = []) {
  if (!isObject(value)) throw new Error(`Invalid dispatch record: ${label} must be an object`);
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new Error(`Invalid dispatch record: missing ${label}.${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key) && !optional.includes(key)) throw new Error(`Invalid dispatch record: unknown field ${label}.${key}`);
  }
}

function matchesRejectRule(record, rule) {
  if (!isObject(rule)) return false;
  const exec = record.executor;
  if (Array.isArray(rule.providerIn) && !rule.providerIn.includes(exec.provider)) return false;
  if (Array.isArray(rule.providerNotIn) && rule.providerNotIn.includes(exec.provider)) return false;
  if (typeof rule.siteContains === 'string' && !exec.site.split('+').includes(rule.siteContains) && !exec.site.includes(rule.siteContains)) return false;
  if (Array.isArray(rule.modelIn) && !rule.modelIn.includes(exec.model)) return false;
  if (Array.isArray(rule.tierIn) && !rule.tierIn.includes(exec.tier)) return false;
  return true;
}

const isUnfinished = (record) => (record.outcome ?? 'completed') !== 'completed';

export function validateDispatchRecord(record, config = {}) {
  exactFields(record, FIELDS, 'record', OPTIONAL_FIELDS);
  if (
    typeof record.date !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(record.date) ||
    !Number.isFinite(Date.parse(record.date)) ||
    new Date(record.date).toISOString().slice(0, 10) !== record.date
  ) {
    throw new Error('Invalid dispatch record: date must be valid YYYY-MM-DD');
  }
  if (record.taskId !== null && !nonempty(record.taskId)) {
    throw new Error('Invalid dispatch record: taskId must be non-empty string or null');
  }
  for (const key of ['title', 'scorer']) {
    if (!nonempty(record[key])) {
      throw new Error(`Invalid dispatch record: ${key} must be non-empty string`);
    }
  }
  if (!TASKS.includes(record.task)) {
    throw new Error(`Invalid dispatch record: task must be one of ${TASKS.join(', ')}`);
  }
  exactFields(record.executor, IDENTITY, 'executor');
  for (const key of IDENTITY) {
    if (!token(record.executor[key])) {
      throw new Error(`Invalid dispatch record: executor.${key} must be a non-empty token without whitespace or '/'`);
    }
  }
  for (const rule of Array.isArray(config.rejectRules) ? config.rejectRules : []) {
    if (matchesRejectRule(record, rule)) {
      throw new Error(`Invalid dispatch record: ${rule.reason || 'rejected by policy rule'}`);
    }
  }
  for (const key of ['accepted', 'firstPass', 'scopeViolation', 'falseReport']) {
    if (typeof record[key] !== 'boolean') {
      throw new Error(`Invalid dispatch record: ${key} must be boolean`);
    }
  }
  if (record.stoppedOnDenial !== null && typeof record.stoppedOnDenial !== 'boolean') {
    throw new Error('Invalid dispatch record: stoppedOnDenial must be boolean or null');
  }
  if (!Number.isSafeInteger(record.reworkRounds) || record.reworkRounds < 0) {
    throw new Error('Invalid dispatch record: reworkRounds must be non-negative integer');
  }
  if (record.durationMin !== null && (!Number.isFinite(record.durationMin) || record.durationMin < 0)) {
    throw new Error('Invalid dispatch record: durationMin must be non-negative finite number or null');
  }
  if (record.quotaDelta !== null && !Number.isFinite(record.quotaDelta)) {
    throw new Error('Invalid dispatch record: quotaDelta must be finite number or null');
  }
  if (typeof record.note !== 'string') {
    throw new Error('Invalid dispatch record: note must be string');
  }
  if (record.outcome != null && !OUTCOMES.includes(record.outcome)) {
    throw new Error(`Invalid dispatch record: outcome must be one of ${OUTCOMES.join(', ')} or null`);
  }
  if (record.abortReason != null) {
    if (!ABORT_REASONS.includes(record.abortReason)) {
      throw new Error(`Invalid dispatch record: abortReason must be one of ${ABORT_REASONS.join(', ')} or null`);
    }
    if (record.outcome == null || record.outcome === 'completed') {
      throw new Error('Invalid dispatch record: abortReason requires outcome failed, interrupted or cancelled');
    }
  }
  if (isUnfinished(record) && (record.accepted || record.firstPass)) {
    throw new Error(`Invalid dispatch record: outcome ${record.outcome} requires accepted and firstPass to be false`);
  }
  return record;
}

export const executorIdentity = (executor) => IDENTITY.map((key) => executor[key]).join('/');

export function scoreIdentity(executor, aliases = DEFAULT_SCORING_CONFIG.aliases) {
  const providerAlias = aliases?.provider ?? DEFAULT_SCORING_CONFIG.aliases.provider;
  const tierAlias = aliases?.tier ?? DEFAULT_SCORING_CONFIG.aliases.tier;
  const modelAlias = aliases?.model ?? {};
  const effortAlias = aliases?.effort ?? {};

  const provider = providerAlias?.[executor.provider] ?? executor.provider;
  const model = modelAlias?.[executor.model] ?? executor.model;
  const effort = effortAlias?.[executor.effort] ?? executor.effort;
  const tier = tierAlias?.[executor.tier] ?? executor.tier;
  return [provider, model, effort, tier].join('/');
}

export const dispatchSucceeded = (record) =>
  (record.outcome ?? 'completed') === 'completed' &&
  record.accepted &&
  !record.falseReport &&
  !record.scopeViolation &&
  record.stoppedOnDenial !== false &&
  record.reworkRounds <= 1;

/** 默认账本目录：$XDG_DATA_HOME，缺省 ~/.local/share；Windows 用 %LOCALAPPDATA%。 */
function defaultScoresFile(env) {
  const base = process.platform === 'win32'
    ? env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    : env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'modelpace', 'scores.jsonl');
}

/** 账本路径优先级：file > scoresFile（--scores）> MODELPACE_SCORES > 用户数据目录下的默认账本。 */
export function resolveScoresFile({ file, scoresFile, env = process.env } = {}) {
  if (typeof file === 'string' && file.trim()) return path.resolve(file.trim());
  if (typeof scoresFile === 'string' && scoresFile.trim()) return path.resolve(scoresFile.trim());
  if (typeof env.MODELPACE_SCORES === 'string' && env.MODELPACE_SCORES.trim()) {
    return path.resolve(env.MODELPACE_SCORES.trim());
  }
  return defaultScoresFile(env);
}

export function appendDispatchRecord(record, options = {}) {
  const config = options.config ?? {};
  validateDispatchRecord(record, config);
  const unreadable = Array.isArray(config.durationUnreadableProviders)
    ? config.durationUnreadableProviders
    : [];
  if (record.durationMin === null && !isUnfinished(record) && !unreadable.includes(record.executor.provider)) {
    throw new Error(
      `Invalid dispatch record: durationMin cannot be null unless provider (${record.executor.provider}) is listed in durationUnreadableProviders`,
    );
  }
  const file = resolveScoresFile(options);
  const dir = path.dirname(file);
  // 只对本次新建的目录收紧权限（mkdir 的 mode 受 umask 影响，故不依赖它），已存在的目录保持原样。
  const created = fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (created !== undefined && process.platform !== 'win32') fs.chmodSync(created, 0o700);
  const fd = fs.openSync(file, 'a+', 0o600);
  try {
    if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
    const size = fs.fstatSync(fd).size;
    const last = Buffer.alloc(1);
    if (size > 0) fs.readSync(fd, last, 0, 1, size - 1);
    fs.appendFileSync(fd, `${size > 0 && last[0] !== 10 ? '\n' : ''}${JSON.stringify(record)}\n`, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  return { file, identity: executorIdentity(record.executor), task: record.task };
}

export function readDispatchRecords(options = {}) {
  const file = resolveScoresFile(options);
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  const config = options.config ?? {};
  for (const [index, line] of content.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      records.push(validateDispatchRecord(JSON.parse(line), config));
    } catch (error) {
      throw new Error(`Corrupt or invalid dispatch record at line ${index + 1}: ${error.message}`);
    }
  }
  return records;
}

// Lanczos log-Gamma and continued fraction for the regularized incomplete beta.
function logGamma(z) {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406,
    12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7,
  ];
  z -= 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < coefficients.length; i++) {
    x += coefficients[i] / (z + i + 1);
  }
  const t = z + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function betaFraction(a, b, x) {
  const floor = (value) => (Math.abs(value) < 1e-300 ? 1e-300 : value);
  let c = 1;
  let d = 1 / floor(1 - ((a + b) * x) / (a + 1));
  let h = d;
  for (let m = 1; m <= 10000; m++) {
    const twice = 2 * m;
    let aa = (m * (b - m) * x) / ((a + twice - 1) * (a + twice));
    d = 1 / floor(1 + aa * d);
    c = floor(1 + aa / c);
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + twice) * (a + twice + 1));
    d = 1 / floor(1 + aa * d);
    c = floor(1 + aa / c);
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 3e-14) return h;
  }
  throw new Error('Beta quantile failed to converge');
}

export function betaQuantile(p, a, b) {
  if (!(p > 0 && p < 1 && Number.isSafeInteger(a) && a > 0 && Number.isSafeInteger(b) && b > 0)) {
    throw new Error('Invalid Beta quantile parameters');
  }
  const logNorm = logGamma(a + b) - logGamma(a) - logGamma(b);
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 60; iteration++) {
    const x = (low + high) / 2;
    const factor = Math.exp(logNorm + a * Math.log(x) + b * Math.log1p(-x));
    const cdf = x < (a + 1) / (a + b + 2)
      ? (factor * betaFraction(a, b, x)) / a
      : 1 - (factor * betaFraction(b, a, 1 - x)) / b;
    if (cdf < p) low = x;
    else high = x;
  }
  return (low + high) / 2;
}

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function resolveWeeklyPrices(pricingInput = {}) {
  // Supports both v2 { currency, exchangeRates, monthlyPrice: { p: { amount, currency } } }
  // and legacy { usdCnyRate, monthlyPrice: { p: { usd: 200 } | { cny: 100 } } }
  const targetCurrency = pricingInput.currency ?? (pricingInput.usdCnyRate ? 'CNY' : 'USD');
  const rates = {
    USD: pricingInput.exchangeRates?.USD ?? pricingInput.usdCnyRate ?? 6.67,
    CNY: pricingInput.exchangeRates?.CNY ?? 1,
    ...(pricingInput.exchangeRates ?? {}),
  };

  const toTarget = (amount, fromCurrency) => {
    const upperFrom = String(fromCurrency).toUpperCase();
    const upperTarget = String(targetCurrency).toUpperCase();
    if (upperFrom === upperTarget) return amount;
    if (upperFrom === 'USD' && upperTarget === 'CNY') return amount * (rates.USD ?? 6.67);
    if (upperFrom === 'CNY' && upperTarget === 'USD') return amount / (rates.USD ?? 6.67);
    if (rates[upperFrom] && rates[upperTarget]) {
      return (amount * rates[upperFrom]) / rates[upperTarget];
    }
    return amount;
  };

  const weeklyByProvider = {};
  for (const [provider, price] of Object.entries(pricingInput.monthlyPrice ?? {})) {
    if (!isObject(price)) continue;
    let amount = null;
    let currency = null;
    if (Number.isFinite(price.amount) && price.amount > 0 && typeof price.currency === 'string') {
      amount = price.amount;
      currency = price.currency;
    } else if (Number.isFinite(price.usd) && price.usd > 0) {
      amount = price.usd;
      currency = 'USD';
    } else if (Number.isFinite(price.cny) && price.cny > 0) {
      amount = price.cny;
      currency = 'CNY';
    }
    if (amount !== null && currency !== null) {
      weeklyByProvider[provider] = (toTarget(amount, currency) * 12) / 52;
    }
  }

  return { currency: String(targetCurrency).toUpperCase(), weeklyByProvider, rates };
}

export function summarizeDispatchScores(records, config = {}) {
  const minSamples = Number.isSafeInteger(config.minSamples) && config.minSamples > 0
    ? config.minSamples
    : DEFAULT_SCORING_CONFIG.minSamples;
  const aliases = config.aliases ?? DEFAULT_SCORING_CONFIG.aliases;
  const pricing = resolveWeeklyPrices(config.pricing ?? {});

  const cells = new Map();
  for (const record of records) {
    validateDispatchRecord(record, config);
    const identity = scoreIdentity(record.executor, aliases);
    const key = JSON.stringify([identity, record.task]);
    if (!cells.has(key)) {
      cells.set(key, {
        identity,
        task: record.task,
        s: 0,
        f: 0,
        outcomes: { completed: 0, failed: 0, interrupted: 0, cancelled: 0 },
        abortReasons: {},
        firstPass: 0,
        durations: [],
        quotaDeltas: [],
        costs: [],
      });
    }
    const cell = cells.get(key);
    const outcome = record.outcome ?? 'completed';
    cell.outcomes[outcome]++;
    if (record.abortReason != null) {
      cell.abortReasons[record.abortReason] = (cell.abortReasons[record.abortReason] ?? 0) + 1;
    }
    const succeeded = dispatchSucceeded(record);
    if (succeeded) cell.s++;
    else if (outcome !== 'cancelled') cell.f++;
    if (record.firstPass) cell.firstPass++;
    if (succeeded && record.durationMin !== null) cell.durations.push(record.durationMin);
    if (record.quotaDelta !== null) cell.quotaDeltas.push(record.quotaDelta);

    const aliasedProvider = aliases?.provider?.[record.executor.provider] ?? record.executor.provider;
    const weekly = pricing.weeklyByProvider[aliasedProvider] ?? pricing.weeklyByProvider[record.executor.provider];
    if (weekly !== undefined && record.quotaDelta !== null) {
      cell.costs.push((record.quotaDelta / 100) * weekly);
    }
  }

  return {
    totalRecords: records.length,
    minSamples,
    currency: pricing.currency,
    cells: [...cells.values()]
      .sort((a, b) => a.identity.localeCompare(b.identity) || a.task.localeCompare(b.task))
      .map(({ firstPass, durations, quotaDeltas, costs, ...cell }) => {
        const n = cell.s + cell.f;
        const enough = n >= minSamples;
        const costMedian = median(costs);
        const costCnyMedian = costMedian === null
          ? null
          : pricing.currency === 'CNY'
            ? costMedian
            : pricing.currency === 'USD'
              ? costMedian * (pricing.rates.USD ?? 6.67)
              : null;

        return {
          ...cell,
          aborted: cell.outcomes.failed + cell.outcomes.interrupted,
          cancelled: cell.outcomes.cancelled,
          n,
          passRate: enough ? (cell.s + 1) / (n + 2) : null,
          rawPassRate: n > 0 ? cell.s / n : null,
          interval90: enough
            ? [betaQuantile(0.05, cell.s + 1, cell.f + 1), betaQuantile(0.95, cell.s + 1, cell.f + 1)]
            : null,
          firstPassRate: enough ? firstPass / n : null,
          durationMedianMin: median(durations),
          durationSamples: durations.length,
          quotaDeltaMedian: median(quotaDeltas),
          quotaDeltaSamples: quotaDeltas.length,
          costMedian,
          costCurrency: costMedian !== null ? pricing.currency : null,
          costCnyMedian,
          costSamples: costs.length,
        };
      }),
    records,
  };
}

export function rankDispatchScores(summary, config = {}) {
  const minPassRate = Number.isFinite(config.minPassRate)
    ? config.minPassRate
    : DEFAULT_SCORING_CONFIG.minPassRate;
  const disabledProviders = Array.isArray(config.disabledProviders) ? config.disabledProviders : [];
  const byTask = new Map();

  for (const cell of summary.cells) {
    const provider = cell.identity.split('/')[0];
    if (disabledProviders.includes(provider)) continue;
    if (!byTask.has(cell.task)) {
      byTask.set(cell.task, { task: cell.task, qualified: [], trial: [], below: [] });
    }
    const group = byTask.get(cell.task);
    if (cell.passRate === null) {
      group.trial.push(cell.identity);
    } else if (cell.passRate >= minPassRate) {
      group.qualified.push(cell.identity);
    } else {
      group.below.push(cell.identity);
    }
  }

  const cellOf = (task, identity) => summary.cells.find((c) => c.task === task && c.identity === identity);
  for (const group of byTask.values()) {
    group.qualified.sort((a, b) => {
      const [x, y] = [cellOf(group.task, a), cellOf(group.task, b)];
      return (x.durationMedianMin ?? Infinity) - (y.durationMedianMin ?? Infinity) || y.passRate - x.passRate;
    });
  }

  return {
    minPassRate,
    minSamples: summary.minSamples,
    tasks: [...byTask.values()].sort((a, b) => a.task.localeCompare(b.task)),
  };
}

export function collectDispatchScores(options = {}, config = {}) {
  const records = readDispatchRecords({ ...options, config });
  const summary = summarizeDispatchScores(records, config);
  return { ...summary, ranking: rankDispatchScores(summary, config) };
}

const pct = (value) => `${(value * 100).toFixed(1)}%`;

export function formatDispatchScores(summary, { lang = 'en' } = {}) {
  const zh = lang === 'zh';
  if (!summary.totalRecords) {
    return [zh ? '暂无评分记录' : 'No dispatch records found.'];
  }

  const ranking = summary.ranking ?? rankDispatchScores(summary);
  const cellOf = (task, identity) => summary.cells.find((c) => c.task === task && c.identity === identity);
  const fmtDuration = (cell) => cell.durationMedianMin === null
    ? (zh ? '耗时未记' : 'duration n/a')
    : (zh
        ? `耗时中位 ${Number(cell.durationMedianMin.toFixed(1))} 分 (${cell.durationSamples})`
        : `median ${Number(cell.durationMedianMin.toFixed(1))}m (${cell.durationSamples})`);
  const fmtCost = (cell) => {
    if (cell.costMedian === null) return zh ? '成本未记' : 'cost n/a';
    const symbol = cell.costCurrency === 'CNY' ? '¥' : cell.costCurrency === 'USD' ? '$' : `${cell.costCurrency} `;
    return zh
      ? `成本中位 ${symbol}${cell.costMedian.toFixed(2)}/次 (${cell.costSamples})`
      : `cost ${symbol}${cell.costMedian.toFixed(2)}/run (${cell.costSamples})`;
  };

  const lines = [
    zh
      ? `选型（通过率 >= ${pct(ranking.minPassRate)} 且 n >= ${ranking.minSamples} 后按耗时中位数升序；成本仅作参考）`
      : `Ranking (passRate >= ${pct(ranking.minPassRate)}, n >= ${ranking.minSamples}, sorted by median duration ascending)`,
  ];

  for (const group of ranking.tasks) {
    const qStr = group.qualified
      .map((identity, idx) => {
        const c = cellOf(group.task, identity);
        const lower = c.interval90[0];
        const lowNote = lower < ranking.minPassRate ? (zh ? '，90%下界偏低' : ', CI low') : '';
        return `${idx + 1}. ${identity} (${fmtDuration(c)}; ${fmtCost(c)}; CI90>=${pct(lower)}${lowNote})`;
      })
      .join('; ');
    const bStr = group.below.length ? (zh ? ` | 未过门槛: ${group.below.join(', ')}` : ` | below: ${group.below.join(', ')}`) : '';
    const tStr = group.trial.length ? (zh ? ` | 试用中: ${group.trial.join(', ')}` : ` | trial: ${group.trial.join(', ')}`) : '';
    lines.push(`${group.task}: ${qStr || (zh ? '暂无达标执行者' : 'none qualified')}${bStr}${tStr}`);
  }

  // 中断/取消标注：无中断与取消时返回空串，明细行与旧版逐字节一致；原因计数覆盖全部非 completed 记录。
  const fmtAborts = (cell) => {
    const reasons = Object.entries(cell.abortReasons ?? {}).map(([reason, count]) => `${reason}:${count}`).join(', ');
    const parts = [];
    if (cell.aborted > 0) parts.push(`${zh ? '中断/失败' : 'aborted'} ${cell.aborted}`);
    if (cell.cancelled > 0) parts.push(`${zh ? '取消' : 'cancelled'} ${cell.cancelled}`);
    const note = parts.join(zh ? '，' : ', ');
    if (!note) return '';
    const withReasons = cell.aborted > 0 && reasons ? `${note} (${reasons})` : note;
    return `${zh ? '，' : ', '}${withReasons}`;
  };

  lines.push('', zh ? '明细单元' : 'Score Cells');
  for (const cell of summary.cells) {
    if (cell.n < summary.minSamples) {
      lines.push(`- ${cell.identity} × ${cell.task}: ${zh ? `试用样本不足 n=${cell.n}` : `trial n=${cell.n} (<${summary.minSamples})`}${fmtAborts(cell)}`);
    } else {
      lines.push(
        `- ${cell.identity} × ${cell.task}: pass ${pct(cell.passRate)} (90% CI ${cell.interval90.map(pct).join('–')}), n=${cell.n} (${cell.s}✓/${cell.f}✗), firstPass ${pct(cell.firstPassRate)}, ${fmtDuration(cell)}, ${fmtCost(cell)}${fmtAborts(cell)}`,
      );
    }
  }

  return lines;
}
