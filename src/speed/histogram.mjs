import { DEFAULT_SCORING_CONFIG, dispatchSucceeded } from '../core/scores.mjs';

// 稀疏对数直方图：相邻桶比 1.02，中位数误差不超过 1%。
export const BIN_RATIO = 1.02;
export const BIN_OFFSET = 200;

export const SPEED_MIN_OUTPUT_TOKENS = 100;
export const SPEED_LONG_OUTPUT_TOKENS = 1000;
export const SPEED_SHORT_MAX_OUTPUT_TOKENS = 300;
export const SPEED_LOW_SAMPLE_LONG_REQUESTS = 20;
const MIN_REQUEST_SECONDS = 0.5;
const MAX_REQUEST_SECONDS = 900;

/** 输出过短或耗时过短、过长的请求没有速度意义，返回 null。 */
export function speedSample(outputTokens, startMs, endMs) {
  const seconds = (endMs - startMs) / 1000;
  if (
    !(outputTokens >= SPEED_MIN_OUTPUT_TOKENS) ||
    !(seconds > MIN_REQUEST_SECONDS) ||
    !(seconds < MAX_REQUEST_SECONDS)
  ) {
    return null;
  }
  return { outputTokens, seconds, tokensPerSecond: outputTokens / seconds };
}

const speedBin = (value) => Math.max(0, Math.round(Math.log(value) / Math.log(BIN_RATIO)) + BIN_OFFSET);
const binValue = (bin) => BIN_RATIO ** (bin - BIN_OFFSET);

export function addToBins(bins, value) {
  const bin = speedBin(value);
  bins.set(bin, (bins.get(bin) ?? 0) + 1);
}

export function addPairsToBins(bins, pairs) {
  for (let index = 0; index + 1 < pairs.length; index += 2) {
    bins.set(pairs[index], (bins.get(pairs[index]) ?? 0) + pairs[index + 1]);
  }
}

/** 稀疏直方图序列化为 [bin, count, bin, count, ...]。 */
export const binsToPairs = (bins) => [...bins].sort(([a], [b]) => a - b).flat();

const binsCount = (bins) => [...bins.values()].reduce((sum, value) => sum + value, 0);

export function binsMedian(bins) {
  const sorted = [...bins].sort(([a], [b]) => a - b);
  const total = binsCount(bins);
  if (total === 0) return null;
  const at = (rank) => {
    let seen = 0;
    for (const [bin, count] of sorted) {
      seen += count;
      if (rank < seen) return binValue(bin);
    }
    return binValue(sorted.at(-1)[0]);
  };
  return total % 2 === 1 ? at((total - 1) / 2) : (at(total / 2 - 1) + at(total / 2)) / 2;
}

const ANTIGRAVITY_VARIANT_SUFFIX = /(?:-(?:extra-low|low|medium|high|xhigh|trial))+$/;

/** Antigravity 按 effort 与路由给同一模型起不同名字，合并时剥掉后缀；其他通道的后缀属于模型 id。 */
export const speedModel = (provider, model) =>
  provider === 'antigravity' ? model.replace(ANTIGRAVITY_VARIANT_SUFFIX, '') : model;

const scoreKey = (provider, model) => `${provider}\u0000${speedModel(provider, model)}`;

export const speedRowKey = (row) => JSON.stringify([row.provider, row.model, row.tier ?? null]);

/** 派发评分与速度共用的分组：按 provider × 归一后 model 汇总成功数与总数，成功公式只用 dispatchSucceeded。 */
export function speedDispatchScores(records, aliases = DEFAULT_SCORING_CONFIG.aliases) {
  const grouped = new Map();
  for (const record of records) {
    const provider = aliases?.provider?.[record.executor.provider] ?? record.executor.provider;
    const model = speedModel(provider, record.executor.model);
    const key = scoreKey(provider, model);
    const held = grouped.get(key) ?? { provider, model, successes: 0, total: 0 };
    held.total += 1;
    if (dispatchSucceeded(record)) held.successes += 1;
    grouped.set(key, held);
  }
  return [...grouped.values()];
}

/** 把同一模型跨来源、跨变体的行加总，按长输出速率降序排名，没有长输出样本的行排最后。 */
export function rankSpeedRows(rows, scores = []) {
  const scoreByModel = new Map(scores.map((score) => [scoreKey(score.provider, score.model), score]));
  const grouped = new Map();
  for (const row of rows) {
    const model = speedModel(row.provider, row.model);
    const key = speedRowKey({ provider: row.provider, model, tier: row.tier });
    let group = grouped.get(key);
    if (group === undefined) {
      group = {
        provider: row.provider,
        model,
        tier: row.tier,
        long: new Map(),
        all: new Map(),
        short: new Map(),
        outputTokens: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        firstMs: row.firstMs,
        lastMs: row.lastMs,
      };
      grouped.set(key, group);
    }
    addPairsToBins(group.long, row.long);
    addPairsToBins(group.all, row.all);
    addPairsToBins(group.short, row.short);
    group.outputTokens += row.outputTokens;
    const rowInput = Number.isFinite(row.inputTokens) && row.inputTokens > 0 ? row.inputTokens : 0;
    const rowCached = Number.isFinite(row.cachedInputTokens) && row.cachedInputTokens > 0 ? Math.min(rowInput, row.cachedInputTokens) : 0;
    group.inputTokens += rowInput;
    group.cachedInputTokens += rowCached;
    group.firstMs = Math.min(group.firstMs, row.firstMs);
    group.lastMs = Math.max(group.lastMs, row.lastMs);
  }
  return [...grouped.values()]
    .map((group) => {
      const longRequests = binsCount(group.long);
      const score = scoreByModel.get(scoreKey(group.provider, group.model));
      const cacheHitRate = group.inputTokens > 0
        ? Number(Math.min(1, Math.max(0, group.cachedInputTokens / group.inputTokens)).toFixed(4))
        : null;
      return {
        provider: group.provider,
        model: group.model,
        ...(group.tier ? { tier: group.tier } : {}),
        requests: binsCount(group.all),
        longRequests,
        shortRequests: binsCount(group.short),
        outputTokens: group.outputTokens,
        inputTokens: group.inputTokens,
        cachedInputTokens: group.cachedInputTokens,
        cacheHitRate,
        firstMs: group.firstMs,
        lastMs: group.lastMs,
        longRate: binsMedian(group.long),
        allRate: binsMedian(group.all),
        shortSeconds: binsMedian(group.short),
        lowSample: longRequests < SPEED_LOW_SAMPLE_LONG_REQUESTS,
        dispatch: score === undefined ? null : { successes: score.successes, total: score.total },
      };
    })
    .filter((ranking) => ranking.requests > 0)
    .sort((a, b) => {
      if ((a.longRate === null) !== (b.longRate === null)) return a.longRate === null ? 1 : -1;
      return (b.longRate ?? b.allRate ?? 0) - (a.longRate ?? a.allRate ?? 0);
    });
}

/** 样本少的行折叠到末尾；全部都少时没有可比的基准，不拆分。 */
export function splitSparseRows(rows) {
  const solid = rows.filter((row) => !row.lowSample);
  return solid.length === 0
    ? { solid: rows, sparse: [] }
    : { solid, sparse: rows.filter((row) => row.lowSample) };
}

/**
 * 输出可直接传给 decideDispatch({ speedMetrics }) 的映射 { [model]: { longRate, ... } }。
 * 只收长输出样本足够的行；同一模型经多个通道时取长输出样本最多的一行。
 */
export function toSpeedMetricsMap(ranking) {
  const map = {};
  for (const row of ranking) {
    if (row.longRate === null || row.lowSample) continue;
    const held = map[row.model];
    if (held && held.longRequests >= row.longRequests) continue;
    map[row.model] = {
      longRate: Number(row.longRate.toFixed(2)),
      allRate: row.allRate === null ? null : Number(row.allRate.toFixed(2)),
      shortSeconds: row.shortSeconds === null ? null : Number(row.shortSeconds.toFixed(2)),
      longRequests: row.longRequests,
      cacheHitRate: row.cacheHitRate ?? null,
      provider: row.provider,
    };
  }
  return map;
}
