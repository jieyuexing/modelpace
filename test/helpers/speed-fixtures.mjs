import fs from 'node:fs';
import path from 'node:path';

export const FIXTURE_NOW = Date.parse('2026-11-23T08:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

function touch(file, now) {
  const when = new Date(now);
  fs.utimesSync(file, when, when);
}

function write(file, lines, now) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')}\n`, 'utf8');
  touch(file, now);
}

/** Claude Code：25 个 2000 token / 20 秒（100 tok/s）的长请求、3 个 200 token / 4 秒的短请求、1 个合成消息。 */
export function writeClaudeFixture(dir, now = FIXTURE_NOW) {
  const lines = [];
  let t = now - 3600_000;
  const exchange = (id, model, tokens, seconds) => {
    lines.push({ type: 'user', uuid: `u-${id}`, timestamp: iso(t), message: { role: 'user', content: 'go' } });
    lines.push({ type: 'assistant', timestamp: iso(t + 1000), message: { id, model, usage: { output_tokens: 20 } } });
    lines.push({ type: 'assistant', timestamp: iso(t + seconds * 1000), message: { id, model, usage: { output_tokens: tokens } } });
    t += (seconds + 5) * 1000;
  };
  for (let i = 0; i < 25; i++) exchange(`long-${i}`, 'claude-opus-5-5', 2000, 20);
  for (let i = 0; i < 3; i++) exchange(`short-${i}`, 'claude-opus-5-5', 200, 4);
  exchange('synthetic', '<synthetic>', 2000, 20);
  lines.push('not json at all');
  const file = path.join(dir, 'project-a', 'session.jsonl');
  write(file, lines, now);
  return file;
}

/**
 * Codex：25 个 1500 token / 10 秒（150 tok/s）的请求。前 13 个用旧格式 token_count（其中一个重复上报），
 * 其余用新格式 token_usage_record（并跟一条 token_count，不应重复计数）。
 */
export function writeCodexFixture(dir, now = FIXTURE_NOW) {
  const lines = [{ timestamp: iso(now - 7200_000), type: 'turn_context', payload: { model: 'gpt-5.3-codex' } }];
  let t = now - 7200_000 + 1000;
  for (let i = 0; i < 25; i++) {
    const count = {
      timestamp: iso(t + 10_500),
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { total_tokens: (i + 1) * 5000 }, last_token_usage: { output_tokens: 1500 } } },
    };
    lines.push(
      { timestamp: iso(t), type: 'event_msg', payload: { type: 'task_started' } },
      { timestamp: iso(t + 2000), type: 'response_item', payload: { type: 'reasoning' } },
      { timestamp: iso(t + 10_000), type: 'response_item', payload: { type: 'message', role: 'assistant' } },
    );
    if (i < 13) {
      lines.push(count);
      if (i === 3) lines.push(count);
    } else {
      lines.push(
        { timestamp: iso(t + 10_100), type: 'token_usage_record', payload: { response_id: `resp-${i}`, usage: { output_tokens: 1500, reasoning_output_tokens: 700 } } },
        count,
      );
    }
    t += 20_000;
  }
  const file = path.join(dir, '2026', '11', '23', 'rollout-a.jsonl');
  write(file, lines, now);
  return file;
}

/** OpenCode：12 条（低于 20 的样本门槛） assistant 消息，输出 1200 + 推理 300 = 1500 token / 10 秒，外加一条用户消息。 */
export async function writeOpencodeFixture(file, now = FIXTURE_NOW) {
  const { DatabaseSync } = await import('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)');
  const insert = db.prepare('INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)');
  for (let i = 0; i < 12; i++) {
    const created = now - 3600_000 + i * 30_000;
    insert.run(`m${i}`, 's1', JSON.stringify({
      role: 'assistant', modelID: 'deepseek-v4', providerID: 'deepseek',
      time: { created, completed: created + 10_000 }, tokens: { output: 1200, reasoning: 300 },
    }));
  }
  insert.run('user', 's1', JSON.stringify({ role: 'user', time: { created: now } }));
  db.close();
  touch(file, now);
  return file;
}

/** 通用速度事件（Antigravity / Gemini）：effort 与 trial 后缀的同一模型应并成一行。 */
export function writeAntigravityFixture(dir, now = FIXTURE_NOW) {
  const events = [];
  const variants = ['gemini-4-hydrogen-high', 'gemini-4-hydrogen', 'gemini-4-hydrogen-trial'];
  for (let i = 0; i < 21; i++) {
    const startedAt = now - 3600_000 + i * 60_000;
    events.push({ model: variants[i % 3], outputTokens: 3000, startedAt: iso(startedAt), endedAt: iso(startedAt + 15_000) });
  }
  const file = path.join(dir, 'speed-events.jsonl');
  write(file, events);
  return file;
}

/** 通用速度事件库：表 speed_events，8 个 120 秒内 6000 token（50 tok/s）的请求，模型名带 effort 后缀。 */
export async function writeAntigravitySqliteFixture(file, now = FIXTURE_NOW) {
  const { DatabaseSync } = await import('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE speed_events (model TEXT, output_tokens INTEGER, started_ms INTEGER, ended_ms INTEGER)');
  const insert = db.prepare('INSERT INTO speed_events VALUES (?, ?, ?, ?)');
  for (let i = 0; i < 8; i++) {
    const started = now - 1800_000 + i * 200_000;
    insert.run('gemini-4-argon-high', 6000, started, started + 120_000);
  }
  db.exec('CREATE TABLE unrelated (id INTEGER)');
  db.close();
  touch(file, now);
  return file;
}
