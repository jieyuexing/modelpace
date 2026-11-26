#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizePolicy,
  starterPolicy,
  appendDispatchRecord,
  collectDispatchScores,
  formatDispatchScores,
  formatDecisionText,
  collectSpeed,
  formatSpeedText,
  renderDashboardHtml,
  startDashboardServer,
} from '../src/index.mjs';
import { planDispatch, resolveDays } from '../src/context.mjs';

const HELP_EN = `modelpace - Multi-model dispatch, quota pacing & acceptance scoring for T3 Code

Usage:
  modelpace plan [options]       Recommend the best delegate_task target
  modelpace record --json FILE|- [--format text|json] Append a dispatch acceptance record (JSONL)
  modelpace scores [options]     Summarize and rank acceptance scores
  modelpace speed [options]      Local Speed leaderboard from session logs
  modelpace dashboard [options]  Write a self-contained HTML dashboard (quota, speed, scores)
  modelpace serve [options]      Serve the live dashboard on localhost
  modelpace validate --config F  Validate a dispatch.config.json (schemaVersion 2)
  modelpace init [--out FILE]    Print or write a starter dispatch.config.json

Plan options:
  --config FILE         Path to dispatch.config.json (or MODELPACE_CONFIG)
  --slot SLOT           Target slot name (defaults via taskToSlot)
  --task TASK           general | research | review | slice | long (default: general)
  --tier TIER           Sensitivity / permission tier
  --wait-minutes N      Max minutes willing to wait for a reset (0..1440)
  --claude-model ID     Optional Claude model family (e.g. sonnet, opus)
  --snapshot FILE|-     Usage snapshot JSON file (v2, T3 getConfig, v1, or Claude JSON)
  --budget FILE         Optional pay-as-you-go budget overlay JSON file
  --t3-origin URL       Live T3 server origin (or MODELPACE_ORIGIN)
  --t3-token TOKEN      Bearer token for T3 server (or MODELPACE_TOKEN)
  --t3-token-cmd CMD    Command to mint a short-lived bearer token (or MODELPACE_TOKEN_CMD)
  --t3-auto             Discover the local T3 Code and use a 2-minute session (or MODELPACE_AUTO=1)
  --scores FILE         JSONL acceptance scores file (or MODELPACE_SCORES; default: $XDG_DATA_HOME/modelpace/scores.jsonl)
  --speed FILE          Optional speed metrics JSON ({ "<model>": { "longRate": 120 } })
  --speed-scan          Measure Speed from local session logs and use it as a tie-breaker
  --days N              Speed window in days (default: 30)
  --now ISO             Evaluate at this instant instead of the current time (replays a saved snapshot)
  --format text|json    Output format (default: text)
  --lang en|zh          Output language (default: en)

Speed options:
  --days N              Window in days (default: 30)
  --format text|json|html   Output format (default: text)
  --out FILE            Write the output to FILE instead of stdout
  --scores FILE         Add the Dispatch Pass column from an acceptance ledger

Dashboard / serve options:
  Accept the plan options above (snapshot source, --scores, --days, --task, ...).
  dashboard --out FILE  Write HTML to FILE (default: stdout)
  serve --port N        Listen on 127.0.0.1:N (default: 0, a free port)

Next steps:
  1. modelpace plan --t3-auto --task slice            Ask the local T3 Code for a recommendation
     (offline replay: plan --snapshot examples/sample-snapshot.json --now 2026-11-23T07:05:00Z --task slice)
  2. Read the "Action:" line: run -> pass the printed delegate_task target; refresh -> see the hint in the reasons
  3. After verifying the delegated result: modelpace record --json record.json   (template: examples/record.example.json)
  Agents: read AGENTS.md; field reference: docs/SCHEMA.md
`;

const HELP_ZH = `modelpace - 面向 T3 Code 的多模型派发、节奏门控与验收评分引擎

用法：
  modelpace plan [选项]          推荐最合适的 delegate_task 目标
  modelpace record --json FILE|- 追加一条派发验收记录（JSONL）
  modelpace scores [选项]        汇总并排序历史验收评分
  modelpace speed [选项]         从本机会话日志统计 Speed 排行
  modelpace dashboard [选项]     输出自包含 HTML 仪表盘（额度、速度、评分）
  modelpace serve [选项]         在本机启动实时仪表盘
  modelpace validate --config F  校验 dispatch.config.json (schemaVersion 2)
  modelpace init [--out FILE]    输出或写入初始配置模板

下一步：
  1. modelpace plan --t3-auto --task slice --lang zh   向本机 T3 Code 要一个派发建议
     （离线回放：plan --snapshot examples/sample-snapshot.json --now 2026-11-23T07:05:00Z --task slice）
  2. 看 "建议动作" 一行：run 就把打印的 delegate_task target 交给 delegate_task；refresh 看理由里的提示
  3. 独立验证结果后记录：modelpace record --json record.json（模板：examples/record.example.json）
  选项与英文帮助相同（modelpace --help）；Agent 请读 AGENTS.md
`;

async function readStdin(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function readJsonFile(filePath, hint) {
  let raw;
  try {
    raw = fs.readFileSync(path.resolve(filePath), 'utf8');
  } catch (error) {
    throw new Error(`Cannot read ${filePath}: ${error.code ?? error.message}${hint ? ` (${hint})` : ''}`);
  }
  return parseJson(raw, filePath);
}

function parseFlags(args, valueFlags, booleanFlags = []) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (booleanFlags.includes(arg)) {
      opts[arg.slice(2)] = true;
      continue;
    }
    if (valueFlags.includes(arg)) {
      const val = args[i + 1];
      if (val === undefined || (val.startsWith('--') && val !== '-')) {
        throw new Error(`Missing value for ${arg}`);
      }
      opts[arg.slice(2)] = val;
      i++;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }
    positional.push(arg);
  }
  return { opts, positional };
}

function writeOutput(out, content, write) {
  if (!out) {
    write(content);
    return;
  }
  const outPath = path.resolve(out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, content, 'utf8');
  write(`Wrote ${outPath}\n`);
}

/** 未指定配置时回落到内置默认策略（官方 T3 Code 实例 id），builtin 标记用来在输出里提示。 */
function loadConfig(configPath, env) {
  const resolved = configPath ?? env.MODELPACE_CONFIG;
  if (!resolved) return { policy: normalizePolicy(starterPolicy()), builtin: true };
  return { policy: normalizePolicy(readJsonFile(resolved, 'create one with "modelpace init --out FILE", or omit --config to use the built-in policy')), builtin: false };
}

const BUILTIN_NOTE = {
  en: 'Note: using the built-in default policy (official T3 Code instance ids). Pass --config FILE to use your own; "modelpace init" writes a starting point.\n',
  zh: '提示：正在使用内置默认策略（官方 T3 Code 实例 id）。用 --config FILE 指定自己的策略，"modelpace init" 可生成起点。\n',
};

export async function runCli(
  argv,
  { env = process.env, stdin = process.stdin, write = (s) => process.stdout.write(s), now = () => Date.now(), signal } = {},
) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    const lang = argv.includes('zh') ? 'zh' : 'en';
    write(lang === 'zh' ? HELP_ZH : HELP_EN);
    return 0;
  }
  if (cmd === '--version' || cmd === '-v') {
    const pkg = JSON.parse(
      fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    write(`${pkg.version}\n`);
    return 0;
  }

  if (cmd === 'init') {
    const { opts } = parseFlags(rest, ['--out']);
    const content = JSON.stringify(starterPolicy(), null, 2) + '\n';
    if (opts.out) {
      const outPath = path.resolve(opts.out);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, content, 'utf8');
      write(`Wrote starter config to ${outPath}\n`);
    } else {
      write(content);
    }
    return 0;
  }

  if (cmd === 'validate') {
    const { opts } = parseFlags(rest, ['--config']);
    const cfgPath = opts.config ?? env.MODELPACE_CONFIG;
    if (!cfgPath) throw new Error('validate requires --config FILE (create one with "modelpace init --out dispatch.config.json")');
    const policy = normalizePolicy(readJsonFile(cfgPath, 'create one with "modelpace init --out FILE"'));
    write(`Valid dispatch policy (schemaVersion=${policy.schemaVersion}, slots=${Object.keys(policy.slots).join(', ')})\n`);
    return 0;
  }

  if (cmd === 'record') {
    const { opts } = parseFlags(rest, ['--json', '--scores', '--config', '--format']);
    if (!opts.json) throw new Error('record requires --json FILE|- (a record file; see examples/record.example.json)');
    const format = opts.format ?? 'text';
    if (!['text', 'json'].includes(format)) throw new Error('--format must be text or json');
    const record = opts.json === '-' ? parseJson(await readStdin(stdin), 'The record on stdin') : readJsonFile(opts.json, 'see examples/record.example.json');
    const { policy } = loadConfig(opts.config, env);
    const result = appendDispatchRecord(record, {
      scoresFile: opts.scores,
      env,
      config: policy.scoring,
    });
    if (format === 'json') {
      write(JSON.stringify(result, null, 2) + '\n');
    } else {
      write(`Recorded ${result.identity} × ${result.task} -> ${result.file}\n`);
      for (const warning of result.warnings) {
        write(`Warning: ${warning}\n`);
      }
    }
    return 0;
  }

  if (cmd === 'scores') {
    const { opts } = parseFlags(rest, ['--scores', '--config', '--format', '--lang']);
    const format = opts.format ?? 'text';
    const lang = opts.lang ?? 'en';
    if (!['text', 'json'].includes(format)) throw new Error('--format must be text or json');
    if (!['en', 'zh'].includes(lang)) throw new Error('--lang must be en or zh');

    const { policy } = loadConfig(opts.config, env);
    const summary = collectDispatchScores({ scoresFile: opts.scores, env }, policy.scoring);
    if (format === 'json') {
      write(JSON.stringify(summary, null, 2) + '\n');
    } else {
      write(formatDispatchScores(summary, { lang }).join('\n') + '\n');
    }
    return 0;
  }

  if (['plan', 'dashboard', 'serve'].includes(cmd)) {
    const { opts } = parseFlags(
      rest,
      [
        '--config', '--slot', '--task', '--tier', '--wait-minutes', '--claude-model',
        '--snapshot', '--budget', '--t3-origin', '--t3-token', '--t3-token-cmd',
        '--scores', '--speed', '--format', '--lang', '--days', '--out', '--port', '--now',
      ],
      ['--t3-auto', '--speed-scan'],
    );
    const format = opts.format ?? 'text';
    const lang = opts.lang ?? 'en';
    if (!['text', 'json'].includes(format)) throw new Error('--format must be text or json');
    if (!['en', 'zh'].includes(lang)) throw new Error('--lang must be en or zh');
    const days = resolveDays(opts.days, '--days');
    const fixedNow = opts.now === undefined ? null : Date.parse(opts.now);
    if (fixedNow !== null && !Number.isFinite(fixedNow)) throw new Error('--now must be an ISO 8601 timestamp');
    if (fixedNow !== null && cmd === 'serve') throw new Error('--now is not supported for serve');

    const { policy, builtin } = loadConfig(opts.config, env);
    const snapshotSource = opts.snapshot ?? env.MODELPACE_SNAPSHOT;
    if (cmd === 'serve' && snapshotSource === '-') throw new Error('serve cannot read the snapshot from stdin');
    const waitMinutes = opts['wait-minutes'] !== undefined ? Number(opts['wait-minutes']) : 0;
    const request = {
      ...(opts.slot ? { slot: opts.slot } : {}),
      ...(opts.task ? { task: opts.task } : {}),
      ...(opts.tier ? { tier: opts.tier } : {}),
      ...(opts['claude-model'] ? { claudeModel: opts['claude-model'] } : {}),
      waitMinutes,
    };
    const hasSource = Boolean(snapshotSource || opts['t3-origin'] || env.MODELPACE_ORIGIN || opts['t3-auto'] || env.MODELPACE_AUTO === '1');

    const load = async () => {
      const rawSnapshot = !snapshotSource
        ? null
        : snapshotSource === '-'
          ? parseJson(await readStdin(stdin), 'The snapshot on stdin')
          : readJsonFile(snapshotSource, 'a saved usage snapshot; examples/sample-snapshot.json shows the shape');
      return planDispatch({
        policy,
        request,
        rawSnapshot,
        origin: opts['t3-origin'] ?? env.MODELPACE_ORIGIN,
        bearer: opts['t3-token'] ?? env.MODELPACE_TOKEN,
        tokenCommand: opts['t3-token-cmd'] ?? env.MODELPACE_TOKEN_CMD,
        auto: Boolean(opts['t3-auto']) || env.MODELPACE_AUTO === '1',
        budget: opts.budget ? readJsonFile(opts.budget) : null,
        scoresPath: opts.scores ?? env.MODELPACE_SCORES,
        speedMetrics: opts.speed ? readJsonFile(opts.speed) : null,
        speedScan: Boolean(opts['speed-scan']) || cmd !== 'plan',
        days,
        env,
        now: fixedNow ?? now,
      });
    };

    if (cmd === 'plan') {
      if (!hasSource) throw new Error('plan needs a usage source: pass --t3-auto (local T3 Code), --t3-origin URL with --t3-token, or --snapshot FILE (replay a saved snapshot with --now)');
      const { decision } = await load();
      if (format === 'json') {
        write(JSON.stringify(decision, null, 2) + '\n');
      } else {
        if (builtin) write(BUILTIN_NOTE[lang]);
        write(formatDecisionText(decision, { lang }));
      }
      return 0;
    }

    const toDashboardInput = (loaded) => ({
      decision: loaded.decision,
      snapshot: loaded.snapshot,
      policy,
      scoresSummary: loaded.scoresSummary,
      speedRanking: loaded.speed?.ranking ?? [],
      options: { now: loaded.now, days, warnings: loaded.speed?.warnings ?? [] },
    });

    if (cmd === 'dashboard') {
      const html = renderDashboardHtml(toDashboardInput(await load()));
      writeOutput(opts.out, html, write);
      return 0;
    }

    const port = opts.port === undefined ? 0 : Number(opts.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer in 0..65535');
    const dashboard = await startDashboardServer({
      port,
      load: async () => toDashboardInput(await load()),
      options: { days },
    });
    write(`modelpace dashboard: ${dashboard.url}\n`);
    await new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      signal?.addEventListener('abort', resolve, { once: true });
      if (!signal) {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
      }
    });
    await dashboard.close();
    return 0;
  }

  if (cmd === 'speed') {
    const { opts } = parseFlags(rest, ['--days', '--format', '--out', '--scores', '--config', '--lang']);
    const format = opts.format ?? 'text';
    const lang = opts.lang ?? 'en';
    if (!['text', 'json', 'html'].includes(format)) throw new Error('--format must be text, json or html');
    if (!['en', 'zh'].includes(lang)) throw new Error('--lang must be en or zh');
    const days = resolveDays(opts.days, '--days');
    const { policy } = loadConfig(opts.config, env);
    const currentMs = now();
    const speed = await collectSpeed({
      days,
      now: currentMs,
      scoresFile: opts.scores ?? env.MODELPACE_SCORES,
      scoring: policy.scoring,
      env,
    });
    let output;
    if (format === 'json') {
      output = JSON.stringify({ days, ranking: speed.ranking, metrics: speed.metrics, sources: speed.sources, warnings: speed.warnings }, null, 2) + '\n';
    } else if (format === 'html') {
      output = renderDashboardHtml({
        speedRanking: speed.ranking,
        options: { now: currentMs, days, warnings: speed.warnings },
      });
    } else {
      output = formatSpeedText(speed, { lang }).join('\n') + '\n';
    }
    writeOutput(opts.out, output, write);
    return 0;
  }

  throw new Error(`Unknown command: ${cmd}. Run "modelpace --help" for usage.`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error?.message ?? error}\n`);
      process.exit(1);
    },
  );
}
