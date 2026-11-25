import { DEFAULT_SCORING_CONFIG, readDispatchRecords } from '../core/scores.mjs';
import { rankSpeedRows, speedDispatchScores, toSpeedMetricsMap } from './histogram.mjs';
import { scanSpeed } from './scanner.mjs';

/** 扫描本地日志并排名；派发评分文件缺失或无法解析时整列不显示。 */
export async function collectSpeed({ days = 30, now = Date.now(), scan = {}, scoresFile, scoring = {}, env = process.env } = {}) {
  const scanned = await scanSpeed({ days, now, env, ...scan });
  let scores = [];
  try {
    const records = readDispatchRecords({ scoresFile, env, config: scoring });
    scores = speedDispatchScores(records, scoring.aliases ?? DEFAULT_SCORING_CONFIG.aliases);
  } catch {
    scores = [];
  }
  const ranking = rankSpeedRows(scanned.rows, scores);
  return {
    days,
    sinceMs: scanned.sinceMs,
    untilMs: now,
    ranking,
    metrics: toSpeedMetricsMap(ranking),
    sources: scanned.sources,
    warnings: scanned.warnings,
  };
}

const fmt = (value, digits = 1) => (value === null || value === undefined ? '-' : Number(value).toFixed(digits));
const fmtCache = (rate) => (rate === null || rate === undefined ? '—' : `${(rate * 100).toFixed(1)}%`);

export function formatSpeedText(speed, { lang = 'en' } = {}) {
  const zh = lang === 'zh';
  if (!speed.ranking.length) return [zh ? '没有找到本地速度样本' : 'No local speed samples found.'];
  const showCache = speed.ranking.some((row) => row.cacheHitRate !== null && row.cacheHitRate !== undefined);
  const lines = [
    zh
      ? `速度排行（近 ${speed.days} 天，长输出 ≥1000 token 请求的 tok/s 中位数）`
      : `Speed leaderboard (last ${speed.days} days, median tok/s of requests with >=1000 output tokens)`,
  ];
  speed.ranking.forEach((row, index) => {
    const cache = showCache ? ` cache=${fmtCache(row.cacheHitRate)}` : '';
    const dispatch = row.dispatch ? ` pass=${row.dispatch.successes}/${row.dispatch.total}` : '';
    const low = row.lowSample ? (zh ? ' [样本少]' : ' [low sample]') : '';
    lines.push(
      `${index + 1}. ${row.model} (${row.provider}) long=${fmt(row.longRate)} tok/s all=${fmt(row.allRate)} short=${fmt(row.shortSeconds, 2)}s ` +
        `n=${row.longRequests}/${row.requests}${cache}${dispatch}${low}`,
    );
  });
  for (const warning of speed.warnings) lines.push(`! ${warning}`);
  return lines;
}
