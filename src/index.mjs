export { T3RpcError, connectT3, fetchT3ServerConfig, resolveBearer, splitCommandArgs } from './adapters/t3-rpc.mjs';
export { discoverT3Cli, discoverT3Origin, fetchT3AutoConfig } from './adapters/t3-auto.mjs';
export { normalizeT3ConfigToSnapshot, inferWindowPool } from './adapters/t3-config.mjs';
export { normalizeSnapshot, overlayBudgetEntries } from './adapters/json-snapshot.mjs';
export {
  DEFAULT_PACING_CONFIG,
  inferAntigravityPool,
  evaluateWindow,
  isWindowApplicable,
  cardCoversWindow,
  evaluateFreshness,
  evaluateBudget,
  evaluateInstanceCandidate,
} from './core/pacing.mjs';
export {
  TASKS,
  DEFAULT_SCORING_CONFIG,
  validateDispatchRecord,
  executorIdentity,
  scoreIdentity,
  dispatchSucceeded,
  resolveScoresFile,
  appendDispatchRecord,
  readDispatchRecords,
  betaQuantile,
  resolveWeeklyPrices,
  summarizeDispatchScores,
  rankDispatchScores,
  collectDispatchScores,
  formatDispatchScores,
} from './core/scores.mjs';
export { DEFAULT_POLICY, starterPolicy, normalizePolicy, validatePolicy } from './core/policy.mjs';
export { decideDispatch, formatDecisionText } from './core/decide.mjs';
export {
  speedSample,
  addToBins,
  binsToPairs,
  binsMedian,
  speedModel,
  speedRowKey,
  speedDispatchScores,
  rankSpeedRows,
  splitSparseRows,
  toSpeedMetricsMap,
} from './speed/histogram.mjs';
export { resolveSpeedPaths, scanSpeed } from './speed/scanner.mjs';
export { collectSpeed, formatSpeedText } from './speed/collect.mjs';
export { buildDashboardData, renderDashboardHtml, startDashboardServer } from './ui/dashboard.mjs';
