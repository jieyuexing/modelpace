import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {
  SPEED_LONG_OUTPUT_TOKENS,
  SPEED_SHORT_MAX_OUTPUT_TOKENS,
  addToBins,
  binsToPairs,
  speedSample,
} from './histogram.mjs';

const CACHE_VERSION = 1;
const DAY_MS = 86_400_000;

// 只读本地日志与数据库；路径全部可注入，默认才落到家目录。
export function resolveSpeedPaths({ homeDir, env = process.env, ...overrides } = {}) {
  const home = homeDir ?? os.homedir();
  const listFromEnv = (value) => (value ? value.split(path.delimiter).filter(Boolean) : null);
  const cacheBase = env.XDG_CACHE_HOME ? env.XDG_CACHE_HOME : path.join(home, '.cache');
  return {
    claudeDir: overrides.claudeDir ?? env.MODELPACE_CLAUDE_DIR ?? path.join(home, '.claude', 'projects'),
    codexDir: overrides.codexDir ?? env.MODELPACE_CODEX_DIR ?? path.join(home, '.codex', 'sessions'),
    opencodeDb:
      overrides.opencodeDb ?? env.MODELPACE_OPENCODE_DB ?? path.join(home, '.local', 'share', 'opencode', 'opencode.db'),
    antigravityPaths:
      overrides.antigravityPaths ??
      listFromEnv(env.MODELPACE_ANTIGRAVITY_PATHS) ?? [path.join(home, '.gemini', 'antigravity')],
    cacheFile:
      overrides.cacheFile ?? env.MODELPACE_SPEED_CACHE ?? path.join(cacheBase, 'modelpace', 'speed-cache.json'),
  };
}

function parseMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e11 ? value * 1000 : value;
  if (typeof value === 'string' && value) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** 单个文件内的请求累加器，按 provider × model × tier × UTC 日分行，便于缓存后再按窗口筛选。 */
class RowAccumulator {
  #rows = new Map();

  add(provider, model, tier, outputTokens, startMs, endMs) {
    if (!model || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return;
    const sample = speedSample(outputTokens, startMs, endMs);
    if (sample === null) return;
    const day = new Date(endMs).toISOString().slice(0, 10);
    const key = JSON.stringify([provider, model, tier ?? null, day]);
    let row = this.#rows.get(key);
    if (!row) {
      row = {
        provider, model, ...(tier ? { tier } : {}), day,
        long: new Map(), all: new Map(), short: new Map(),
        outputTokens: 0, firstMs: endMs, lastMs: endMs,
      };
      this.#rows.set(key, row);
    }
    addToBins(row.all, sample.tokensPerSecond);
    if (outputTokens >= SPEED_LONG_OUTPUT_TOKENS) addToBins(row.long, sample.tokensPerSecond);
    if (outputTokens <= SPEED_SHORT_MAX_OUTPUT_TOKENS) addToBins(row.short, sample.seconds);
    row.outputTokens += outputTokens;
    row.firstMs = Math.min(row.firstMs, endMs);
    row.lastMs = Math.max(row.lastMs, endMs);
  }

  toRows() {
    return [...this.#rows.values()].map((row) => ({
      ...row,
      long: binsToPairs(row.long),
      all: binsToPairs(row.all),
      short: binsToPairs(row.short),
    }));
  }
}

async function forEachLine(file, onLine) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) onLine(line);
}

const parseJson = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

// Claude Code：type=user 条目为起点，同 message.id 最后一块的时间戳为终点。
async function scanClaudeFile(file) {
  const acc = new RowAccumulator();
  let lastUserMs = null;
  let current = null;
  const flush = () => {
    if (current && current.startMs !== null && !String(current.model ?? '<').startsWith('<')) {
      acc.add('claude', current.model, null, current.tokens, current.startMs, current.endMs);
    }
    current = null;
  };
  await forEachLine(file, (line) => {
    const userLine = line.includes('"type":"user"');
    if (!userLine && !line.includes('"output_tokens"')) return;
    const entry = parseJson(line);
    if (!entry) return;
    const ms = parseMs(entry.timestamp);
    if (entry.type === 'user') {
      flush();
      if (ms !== null) lastUserMs = ms;
      return;
    }
    const message = entry.message;
    if (entry.type !== 'assistant' || !message?.id || ms === null) return;
    const tokens = message.usage?.output_tokens;
    if (!Number.isFinite(tokens)) return;
    if (current?.id !== message.id) {
      flush();
      current = { id: message.id, model: message.model, startMs: lastUserMs, endMs: ms, tokens };
    }
    current.endMs = Math.max(current.endMs, ms);
    current.tokens = Math.max(current.tokens, tokens);
  });
  flush();
  return acc.toRows();
}

const CODEX_START_ITEMS = new Set(['function_call_output', 'custom_tool_call_output', 'local_shell_call_output']);
const CODEX_OUTPUT_ITEMS = new Set(['reasoning', 'function_call', 'custom_tool_call', 'local_shell_call']);

// Codex：用户消息 / task_started / 工具输出为起点，本次最后一个模型输出项为终点，
// 在 token_usage_record（新格式）或 token_count（旧格式）处出账。
async function scanCodexFile(file) {
  const acc = new RowAccumulator();
  let model = null;
  let startMs = null;
  let lastOutputMs = null;
  let lastTotal = null;
  const seenResponses = new Set();
  const settle = (out) => {
    if (startMs !== null && lastOutputMs !== null && Number.isFinite(out)) {
      acc.add('codex', model, null, out, startMs, lastOutputMs);
    }
    startMs = null;
    lastOutputMs = null;
  };
  await forEachLine(file, (line) => {
    if (!line.includes('"payload"')) return;
    const entry = parseJson(line);
    const payload = entry?.payload;
    const ms = parseMs(entry?.timestamp);
    if (!payload || ms === null) return;
    if (entry.type === 'turn_context') {
      if (typeof payload.model === 'string') model = payload.model;
    } else if (entry.type === 'token_usage_record') {
      const id = payload.response_id;
      if (id && seenResponses.has(id)) return;
      if (id) seenResponses.add(id);
      settle(payload.usage?.output_tokens);
    } else if (entry.type === 'event_msg') {
      if (payload.type === 'task_started') {
        startMs = ms;
        lastOutputMs = null;
      } else if (payload.type === 'token_count' && payload.info) {
        const total = payload.info.total_token_usage?.total_tokens;
        if (total !== undefined && total === lastTotal) return;
        lastTotal = total ?? null;
        settle(payload.info.last_token_usage?.output_tokens);
      }
    } else if (entry.type === 'response_item') {
      if (payload.type === 'message' && payload.role === 'user') {
        startMs = ms;
        lastOutputMs = null;
      } else if (CODEX_START_ITEMS.has(payload.type)) {
        startMs = ms;
        lastOutputMs = null;
      } else if (CODEX_OUTPUT_ITEMS.has(payload.type) || (payload.type === 'message' && payload.role === 'assistant')) {
        lastOutputMs = ms;
      }
    }
  });
  return acc.toRows();
}

// 通用事件交换格式（Antigravity / Gemini）：每条 { model, outputTokens, startedAt, endedAt }，时间可为毫秒或 ISO。
const addEvent = (acc, event, provider) => {
  if (!event || typeof event !== 'object') return;
  acc.add(
    event.provider ?? provider,
    event.model,
    event.tier ?? null,
    Number(event.outputTokens ?? event.output_tokens),
    parseMs(event.startedAt ?? event.started_at ?? event.startMs ?? event.started_ms),
    parseMs(event.endedAt ?? event.ended_at ?? event.endMs ?? event.ended_ms),
  );
};

async function scanEventsJsonl(file, provider) {
  const acc = new RowAccumulator();
  await forEachLine(file, (line) => {
    if (line.includes('"model"')) addEvent(acc, parseJson(line), provider);
  });
  return acc.toRows();
}

async function openSqlite(file) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
}

// OpenCode：message 表 data 内 time.created → time.completed，输出 = output + reasoning。
async function scanOpencodeDb(file) {
  const db = await openSqlite(file);
  if (!db) return null;
  const acc = new RowAccumulator();
  try {
    for (const { data } of db.prepare('SELECT data FROM message').all()) {
      const message = parseJson(data);
      if (message?.role !== 'assistant' || !message.time?.completed) continue;
      const tokens = (message.tokens?.output ?? 0) + (message.tokens?.reasoning ?? 0);
      acc.add('opencode', message.modelID, null, tokens, parseMs(message.time.created), parseMs(message.time.completed));
    }
  } catch {
    return null;
  } finally {
    db.close();
  }
  return acc.toRows();
}

// 通用事件库：表 speed_events(model, output_tokens, started_ms, ended_ms[, provider, tier])。
async function scanEventsSqlite(file, provider) {
  const db = await openSqlite(file);
  const acc = new RowAccumulator();
  if (!db) return acc.toRows();
  try {
    for (const event of db.prepare('SELECT * FROM speed_events').all()) addEvent(acc, event, provider);
  } catch {
    // 没有 speed_events 表的数据库不是速度事件库
  } finally {
    db.close();
  }
  return acc.toRows();
}

function walk(root, extensions, files = []) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walk(full, extensions, files);
    else if (extensions.includes(path.extname(entry.name))) files.push(full);
  }
  return files;
}

const listFiles = (target, extensions) => {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return [];
  }
  return stat.isDirectory() ? walk(target, extensions) : [target];
};

function readCache(cacheFile) {
  try {
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cache?.version === CACHE_VERSION && cache.files && typeof cache.files === 'object') return cache.files;
  } catch {
    // 缓存缺失或损坏时从头扫描
  }
  return {};
}

function writeCache(cacheFile, files) {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true, mode: 0o700 });
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, files }), { mode: 0o600 });
    fs.renameSync(tmp, cacheFile);
  } catch {
    // 缓存只是加速手段，写失败不影响结果
  }
}

/**
 * 增量扫描本地日志与数据库，返回按天分行的速度行（直方图为稀疏对）。
 * 缓存按文件路径 + mtime + size 命中；窗口外且未改动的文件不读。
 */
export async function scanSpeed({
  days = 30,
  now = Date.now(),
  providers = ['claude', 'codex', 'opencode', 'antigravity'],
  cache = true,
  ...pathOptions
} = {}) {
  const paths = resolveSpeedPaths(pathOptions);
  const sinceMs = now - days * DAY_MS;
  const cached = cache ? readCache(paths.cacheFile) : {};
  const next = {};
  const rows = [];
  const sources = {};
  const warnings = [];

  const jobs = [];
  if (providers.includes('claude')) {
    for (const file of listFiles(paths.claudeDir, ['.jsonl'])) jobs.push({ provider: 'claude', file, scan: scanClaudeFile });
  }
  if (providers.includes('codex')) {
    for (const file of listFiles(paths.codexDir, ['.jsonl'])) jobs.push({ provider: 'codex', file, scan: scanCodexFile });
  }
  if (providers.includes('opencode') && fs.existsSync(paths.opencodeDb)) {
    jobs.push({ provider: 'opencode', file: paths.opencodeDb, scan: scanOpencodeDb, extra: [`${paths.opencodeDb}-wal`] });
  }
  if (providers.includes('antigravity')) {
    for (const target of paths.antigravityPaths) {
      for (const file of listFiles(target, ['.jsonl', '.sqlite', '.db'])) {
        const sqlite = path.extname(file) !== '.jsonl';
        jobs.push({
          provider: 'antigravity',
          file,
          scan: (f) => (sqlite ? scanEventsSqlite(f, 'antigravity') : scanEventsJsonl(f, 'antigravity')),
        });
      }
    }
  }

  for (const job of jobs) {
    const source = (sources[job.provider] ??= { files: 0, scanned: 0, cached: 0, skipped: 0 });
    let stat;
    let signature;
    try {
      stat = fs.statSync(job.file);
      const extraStats = (job.extra ?? []).map((extra) => {
        try {
          const s = fs.statSync(extra);
          return `${s.mtimeMs}:${s.size}`;
        } catch {
          return '-';
        }
      });
      signature = [stat.mtimeMs, stat.size, ...extraStats].join('|');
    } catch {
      continue;
    }
    if (stat.mtimeMs < sinceMs) {
      source.skipped += 1;
      if (cached[job.file]?.signature === signature) next[job.file] = cached[job.file];
      continue;
    }
    source.files += 1;
    const hit = cached[job.file];
    let fileRows;
    if (hit && hit.signature === signature) {
      fileRows = hit.rows;
      source.cached += 1;
    } else {
      try {
        fileRows = await job.scan(job.file);
      } catch (error) {
        warnings.push(`${job.provider}: ${path.basename(job.file)}: ${error.message}`);
        continue;
      }
      if (fileRows === null) {
        warnings.push(`${job.provider}: ${path.basename(job.file)} skipped (node:sqlite unavailable or unreadable)`);
        continue;
      }
      source.scanned += 1;
    }
    next[job.file] = { signature, rows: fileRows };
    for (const row of fileRows) {
      if (row.lastMs >= sinceMs) rows.push(row);
    }
  }

  if (cache) writeCache(paths.cacheFile, next);
  return { rows, sources, warnings, sinceMs, days };
}
