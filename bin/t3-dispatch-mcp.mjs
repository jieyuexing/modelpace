#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizePolicy,
  starterPolicy,
  appendDispatchRecord,
  collectDispatchScores,
  collectSpeed,
} from '../src/index.mjs';
import { planDispatch, resolveDays } from '../src/context.mjs';
import pkg from '../package.json' with { type: 'json' };

const SERVER_INFO = { name: 't3-dispatch', version: pkg.version };
const PROTOCOL_VERSION = '2024-11-05';

const CONFIG_PATH = {
  type: 'string',
  description: 'Path to a dispatch.config.json policy. Omit to use T3_DISPATCH_CONFIG, else the built-in policy for the official T3 Code instances codex, claudeAgent and antigravity.',
};
const SCORES_PATH = {
  type: 'string',
  description: 'Path to the JSONL acceptance ledger. Omit to use T3_DISPATCH_SCORES, else $XDG_DATA_HOME/t3-dispatch/scores.jsonl (%LOCALAPPDATA% on Windows).',
};
const DAYS = {
  type: 'integer',
  minimum: 1,
  maximum: 365,
  description: 'Speed window in days (default 30).',
};

export const MCP_TOOLS = [
  {
    name: 'dispatch_plan',
    description:
      'Call this BEFORE delegate_task to choose which provider instance and model should take a task. It gates candidates on live quota (Even Pace, reset credits), prefers models with passing acceptance records, and returns a recommendation only; it never starts anything. ' +
      'Read `action`: "run" -> pass `recommended.target` ({ providerInstanceId, model, options }) to delegate_task as is; "wait" -> retry at `waitUntil`; "redeem" -> ask the user to redeem the reset credit in `redeemCandidate`, then call again; "refresh" -> the usage snapshot is missing or stale, retry with a fresh source (t3Auto or t3Origin); "pause" -> every candidate is blocked, see `reasons`, retry at `nextCheckAt`. ' +
      'Keep `recommended.executor` and add a `site` label to it when you later call dispatch_record. ' +
      'Needs a usage source: t3Auto (local T3 Code), t3Origin (with T3_DISPATCH_TOKEN), or snapshotPath/snapshot; without one the call fails with an error that names these options.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          enum: ['general', 'research', 'review', 'slice', 'long'],
          description: 'Task category; selects the slot through the config\'s taskToSlot and the score cell that is looked up. Default general. Use slice for a bounded implementation piece, long for large or hard work, review for read-only checking, research for investigation.',
        },
        tier: { type: 'string', description: 'Permission/sensitivity tier from the config\'s `tiers` (for example work, personal, public); candidates not allowed for it are skipped. Omit to skip tier gating. Not the score tier.' },
        slot: { type: 'string', description: 'Policy slot name; overrides the slot chosen through task. Leave unset unless you know the config\'s slots.' },
        waitMinutes: { type: 'number', minimum: 0, maximum: 1440, description: 'How many minutes you are willing to wait for a quota reset before settling for "wait" (default 0).' },
        claudeModel: { type: 'string', description: 'Claude model family (for example sonnet, opus) when a Claude window is shared by family.' },
        configPath: CONFIG_PATH,
        scoresPath: SCORES_PATH,
        t3Auto: { type: 'boolean', description: 'Read quota from the local T3 Code through a 2-minute orchestration:read session that is revoked afterwards (also enabled by T3_DISPATCH_AUTO=1).' },
        t3Origin: { type: 'string', description: 'URL of a running T3 server (for example http://127.0.0.1:3773). The bearer token comes from T3_DISPATCH_TOKEN or T3_DISPATCH_TOKEN_CMD.' },
        snapshotPath: { type: 'string', description: 'Path to a saved usage snapshot JSON (see docs/SCHEMA.md); also T3_DISPATCH_SNAPSHOT. Snapshots older than 15 minutes produce "refresh".' },
        snapshot: { type: 'object', description: 'The same as snapshotPath, passed inline: a UsageSnapshot v2 or a raw T3 server.getConfig response.' },
        budgetPath: { type: 'string', description: 'Optional pay-as-you-go budget overlay JSON for API-billed instances.' },
        includeSpeed: { type: 'boolean', description: 'Measure real tok/s from local session logs and use it to break ties between equally qualified candidates. Scans log files, so it is slower.' },
        speedMetrics: { type: 'object', description: 'Explicit speed metrics keyed by model, for example { "gpt-5.3-codex": { "longRate": 120 } }; overrides includeSpeed.' },
        days: DAYS,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dispatch_record',
    description:
      'Call this AFTER you have independently verified a delegated task (tests, diff review or explicit user acceptance), never on the sub-agent\'s own report. It appends one acceptance record to the ledger so later dispatch_plan calls can prefer models that really pass; a candidate becomes "qualified" after 5 successful records for the same executor and task. ' +
      'Build `record.executor` from `recommended.executor` of the plan you followed plus a `site` label (for example "local"). All fifteen record fields are required; an invalid record is rejected with a message naming the missing or wrong field. Returns { file, identity, task }.',
    inputSchema: {
      type: 'object',
      required: ['record'],
      properties: {
        record: {
          type: 'object',
          description: 'One acceptance record with all fifteen fields: date (YYYY-MM-DD), taskId, title, task (general|research|review|slice|long), executor { provider, model, effort, tier, site }, scorer, accepted, firstPass, reworkRounds, scopeViolation, falseReport, stoppedOnDenial (boolean or null), durationMin (number or null), quotaDelta (number or null), note (string). Field meanings: docs/SCHEMA.md.',
        },
        scoresPath: SCORES_PATH,
        configPath: CONFIG_PATH,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dispatch_scores',
    description:
      'Read-only summary of the acceptance ledger: for every executor identity and task the pass rate with its 90% credible interval, sample count, median duration of successes and nominal cost, plus the qualified / trial ranking per task. Use it to see why dispatch_plan prefers a model or to review quality over time. An empty or missing ledger returns an empty summary, not an error.',
    inputSchema: {
      type: 'object',
      properties: {
        scoresPath: SCORES_PATH,
        configPath: CONFIG_PATH,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dispatch_speed',
    description:
      'Read-only local speed leaderboard: median tok/s of long requests and short-request latency per model, measured from this machine\'s own session logs (Claude Code, Codex, OpenCode, Antigravity), merged with dispatch pass counts from the ledger. Rows with fewer than 20 long requests are marked lowSample and are not used as tie-breakers. Returns { days, ranking, metrics, sources, warnings }; `warnings` lists log sources that were missing or unreadable.',
    inputSchema: {
      type: 'object',
      properties: {
        days: DAYS,
        scoresPath: SCORES_PATH,
        configPath: CONFIG_PATH,
      },
      additionalProperties: false,
    },
  },
];

function loadPolicy(configPath, env) {
  const target = configPath ?? env.T3_DISPATCH_CONFIG;
  if (!target) return starterPolicy();
  return normalizePolicy(JSON.parse(fs.readFileSync(path.resolve(target), 'utf8')));
}

export async function handleToolCall(name, args = {}, { env = process.env, now = () => Date.now() } = {}) {
  if (name === 'dispatch_plan') {
    const policy = loadPolicy(args.configPath, env);
    const currentMs = now();
    const snapFile = args.snapshotPath ?? env.T3_DISPATCH_SNAPSHOT;
    const rawSnapshot = args.snapshot
      ?? (snapFile ? JSON.parse(fs.readFileSync(path.resolve(snapFile), 'utf8')) : null);
    const origin = args.t3Origin ?? env.T3_DISPATCH_ORIGIN;
    const auto = args.t3Auto === true || env.T3_DISPATCH_AUTO === '1';
    if (!rawSnapshot && !origin && !auto) {
      throw new Error('No usage source configured: set t3Auto: true (local T3 Code), t3Origin (with T3_DISPATCH_TOKEN), snapshotPath, or snapshot; the T3_DISPATCH_AUTO=1, T3_DISPATCH_ORIGIN and T3_DISPATCH_SNAPSHOT environment variables work too');
    }
    const planned = await planDispatch({
      policy,
      request: {
        ...(args.slot ? { slot: args.slot } : {}),
        ...(args.task ? { task: args.task } : {}),
        ...(args.tier ? { tier: args.tier } : {}),
        ...(args.claudeModel ? { claudeModel: args.claudeModel } : {}),
        waitMinutes: args.waitMinutes ?? 0,
      },
      rawSnapshot,
      origin,
      bearer: env.T3_DISPATCH_TOKEN,
      tokenCommand: env.T3_DISPATCH_TOKEN_CMD,
      auto,
      budget: args.budgetPath ? JSON.parse(fs.readFileSync(path.resolve(args.budgetPath), 'utf8')) : null,
      scoresPath: args.scoresPath ?? env.T3_DISPATCH_SCORES,
      speedMetrics: args.speedMetrics ?? null,
      speedScan: args.includeSpeed === true,
      days: resolveDays(args.days),
      env,
      now: currentMs,
    });

    return planned.decision;
  }

  if (name === 'dispatch_speed') {
    const policy = loadPolicy(args.configPath, env);
    const speed = await collectSpeed({
      days: resolveDays(args.days),
      now: now(),
      scoresFile: args.scoresPath ?? env.T3_DISPATCH_SCORES,
      scoring: policy.scoring,
      env,
    });
    return {
      days: speed.days,
      ranking: speed.ranking,
      metrics: speed.metrics,
      sources: speed.sources,
      warnings: speed.warnings,
    };
  }

  if (name === 'dispatch_record') {
    const policy = loadPolicy(args.configPath, env);
    if (!args.record || typeof args.record !== 'object') {
      throw new Error('dispatch_record requires a record object');
    }
    return appendDispatchRecord(args.record, {
      scoresFile: args.scoresPath,
      env,
      config: policy.scoring,
    });
  }

  if (name === 'dispatch_scores') {
    const policy = loadPolicy(args.configPath, env);
    return collectDispatchScores({ scoresFile: args.scoresPath, env }, policy.scoring);
  }

  throw new Error(`Unknown tool: ${name}`);
}

export async function handleJsonRpcMessage(msg, context = {}) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return {
      jsonrpc: '2.0',
      id: msg?.id ?? null,
      error: { code: -32600, message: 'Invalid Request' },
    };
  }

  const hasId = Object.hasOwn(msg, 'id') && msg.id !== undefined;
  const { method, params, id } = msg;

  // Notifications have no id and expect no response
  if (method.startsWith('notifications/') || !hasId) {
    return null;
  }

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    };
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: MCP_TOOLS },
    };
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments ?? {};
    try {
      const output = await handleToolCall(toolName, toolArgs, context);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
          isError: false,
        },
      };
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: String(error?.message ?? error) }],
          isError: true,
        },
      };
    }
  }

  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

export function startMcpServer({ stdin = process.stdin, stdout = process.stdout, env = process.env, now = () => Date.now() } = {}) {
  let buffer = Buffer.alloc(0);

  const send = (payload) => {
    if (!payload) return;
    stdout.write(`${JSON.stringify(payload)}\n`);
  };

  const processLine = async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const reply = await handleJsonRpcMessage(msg, { env, now });
    send(reply);
  };

  let chain = Promise.resolve();
  const enqueue = (fn) => {
    chain = chain.then(fn, () => {});
  };

  stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (buffer.length > 0) {
      const head = buffer.subarray(0, 15).toString('ascii');
      if (head.toLowerCase().startsWith('content-length:')) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;
        const headerText = buffer.subarray(0, headerEnd).toString('ascii');
        const match = headerText.match(/content-length:\s*(\d+)/i);
        if (!match) {
          buffer = buffer.subarray(headerEnd + 4);
          continue;
        }
        const length = Number(match[1]);
        const bodyStart = headerEnd + 4;
        if (buffer.length < bodyStart + length) break;
        const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
        buffer = buffer.subarray(bodyStart + length);
        enqueue(() => processLine(body));
      } else {
        const nl = buffer.indexOf('\n');
        if (nl === -1) break;
        const line = buffer.subarray(0, nl).toString('utf8');
        buffer = buffer.subarray(nl + 1);
        enqueue(() => processLine(line));
      }
    }
  });

  stdin.on('end', () => {
    const rest = buffer.toString('utf8').trim();
    if (rest) {
      enqueue(() => processLine(rest));
    }
  });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startMcpServer();
}
