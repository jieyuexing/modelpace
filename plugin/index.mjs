import fs from 'node:fs';
import path from 'node:path';
import {
  buildDashboardData,
  collectDispatchScores,
  collectSpeed,
  normalizePolicy,
  renderDashboardHtml,
  starterPolicy,
} from '../src/index.mjs';
import { planDispatch, resolveDays } from '../src/context.mjs';

const readJson = (file) => JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));

async function readSettings(context) {
  const text = async (key) => {
    const value = await context.settings.get(key);
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  const days = await context.settings.get('days');
  return {
    snapshotPath: await text('snapshotPath'),
    configPath: await text('configPath'),
    scoresPath: await text('scoresPath'),
    auto: (await context.settings.get('t3Auto')) !== false,
    days: resolveDays(typeof days === 'number' ? days : undefined),
  };
}

async function plan(context, request = {}, { requireSource = true } = {}) {
  const settings = await readSettings(context);
  const policy = settings.configPath ? normalizePolicy(readJson(settings.configPath)) : starterPolicy();
  const rawSnapshot = settings.snapshotPath ? readJson(settings.snapshotPath) : null;
  const planned = await planDispatch({
    policy,
    request,
    rawSnapshot,
    auto: !rawSnapshot && settings.auto,
    scoresPath: settings.scoresPath,
    speedScan: true,
    days: settings.days,
  });
  if (requireSource && !planned.decision) {
    throw new Error('No usage source: enable the local T3 Code connection or set a snapshot file in the plugin settings');
  }
  return { planned, settings, policy };
}

// 看板在连不上本机 T3 时仍展示速度与评分，只是没有额度页。
async function dashboardInput(context) {
  let result;
  let warning = null;
  try {
    result = await plan(context, {}, { requireSource: false });
  } catch (error) {
    warning = error.message;
    const settings = await readSettings(context);
    const policy = settings.configPath ? normalizePolicy(readJson(settings.configPath)) : starterPolicy();
    result = {
      planned: await planDispatch({ policy, scoresPath: settings.scoresPath, speedScan: true, days: settings.days }),
      settings,
    };
  }
  const { planned, settings } = result;
  return {
    decision: planned.decision,
    snapshot: planned.snapshot,
    scoresSummary: planned.scoresSummary,
    speedRanking: planned.speed?.ranking ?? [],
    options: { now: planned.now, days: settings.days, live: true, warnings: [...(planned.speed?.warnings ?? []), ...(warning ? [warning] : [])] },
  };
}

export async function activate(context) {
  const scoresSummary = async () => {
    const settings = await readSettings(context);
    const policy = settings.configPath ? normalizePolicy(readJson(settings.configPath)) : starterPolicy();
    const { records, ...summary } = collectDispatchScores({ scoresFile: settings.scoresPath }, policy.scoring);
    return { ...summary, totalRecords: records.length };
  };

  context.provide('dispatch.plan', {
    run: async (input) => (await plan(context, input ?? {})).planned.decision,
  });
  context.provide('dispatch.scores', { get: scoresSummary });
  context.provide('dispatch.speed', {
    get: async (input) => {
      const settings = await readSettings(context);
      const policy = settings.configPath ? normalizePolicy(readJson(settings.configPath)) : starterPolicy();
      const days = resolveDays(input?.days ?? settings.days);
      const { ranking, metrics, sources, warnings } = await collectSpeed({ days, scoresFile: settings.scoresPath, scoring: policy.scoring });
      return { days, ranking, metrics, sources, warnings };
    },
  });

  context.handle('view:dashboard:html', async () => renderDashboardHtml(await dashboardInput(context)));
  context.handle('view:dashboard:data', async () => buildDashboardData(await dashboardInput(context)));
}
