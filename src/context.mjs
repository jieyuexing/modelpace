import { fetchT3AutoConfig } from './adapters/t3-auto.mjs';
import { normalizeSnapshot, overlayBudgetEntries } from './adapters/json-snapshot.mjs';
import { normalizeT3ConfigToSnapshot } from './adapters/t3-config.mjs';
import { fetchT3ServerConfig } from './adapters/t3-rpc.mjs';
import { decideDispatch } from './core/decide.mjs';
import { collectDispatchScores } from './core/scores.mjs';
import { collectSpeed } from './speed/collect.mjs';

/**
 * plan / dashboard / MCP 共用的输入汇集：快照（原始 JSON、本机自动发现或远端 origin）、验收评分与本地速度。
 * 没有任何快照来源时 snapshot 为 null，由调用方决定是否报错。
 */
export async function gatherDispatchInputs({
  policy,
  rawSnapshot = null,
  origin,
  bearer,
  tokenCommand,
  auto = false,
  budget = null,
  scoresPath,
  speedMetrics = null,
  speedScan = false,
  days = 30,
  scan = {},
  env = process.env,
  now = Date.now,
} = {}) {
  const readNow = typeof now === 'function' ? now : () => now;
  let snapshot = null;
  if (rawSnapshot) {
    snapshot = normalizeSnapshot(rawSnapshot, { now: readNow() });
  } else if (auto) {
    const config = await fetchT3AutoConfig({ env, origin, policy, now: readNow });
    snapshot = normalizeT3ConfigToSnapshot(config, readNow());
  } else if (origin) {
    snapshot = normalizeT3ConfigToSnapshot(await fetchT3ServerConfig({ origin, bearer, tokenCommand }), readNow());
  }
  if (snapshot && budget) snapshot = overlayBudgetEntries(snapshot, budget);

  const scoresSummary = collectDispatchScores({ scoresFile: scoresPath, env }, policy.scoring);

  let speed = null;
  if (speedScan) {
    speed = await collectSpeed({ days, now: readNow(), scan, scoresFile: scoresPath, scoring: policy.scoring, env });
  }
  return { snapshot, scoresSummary, speed, speedMetrics: speedMetrics ?? speed?.metrics ?? null };
}

/** 汇集输入后做一次派发决策；没有快照来源时 decision 为 null，由调用方决定是否报错。 */
export async function planDispatch({ policy, request = {}, now = Date.now, ...inputArgs } = {}) {
  const readNow = typeof now === 'function' ? now : () => now;
  const inputs = await gatherDispatchInputs({ policy, now: readNow, ...inputArgs });
  const decisionNow = readNow();
  const decision = inputs.snapshot
    ? decideDispatch({
        snapshot: inputs.snapshot,
        policy,
        scoresSummary: inputs.scoresSummary,
        speedMetrics: inputs.speedMetrics,
        request,
        now: decisionNow,
      })
    : null;
  return { ...inputs, decision, now: decisionNow };
}

/** 速度窗口天数：1..365 的整数，缺省 30。 */
export function resolveDays(value, label = 'days') {
  if (value === undefined || value === null) return 30;
  if (!Number.isInteger(value) && !(typeof value === 'string' && /^\d+$/.test(value))) {
    throw new Error(`${label} must be an integer in 1..365`);
  }
  const days = Number(value);
  if (days < 1 || days > 365) throw new Error(`${label} must be an integer in 1..365`);
  return days;
}
