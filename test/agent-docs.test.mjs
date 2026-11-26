import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../bin/modelpace.mjs';
import { MCP_TOOLS, handleJsonRpcMessage } from '../bin/modelpace-mcp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const SNAPSHOT = path.join(ROOT, 'examples', 'sample-snapshot.json');
const ENV = { HOME: os.tmpdir(), XDG_DATA_HOME: path.join(os.tmpdir(), 'modelpace-agent-docs-none') };

async function cli(args) {
  let out = '';
  const code = await runCli(args, { env: ENV, write: (text) => { out += text; }, signal: AbortSignal.abort() });
  return { code, out };
}

test('SKILL.md 符合 Agent Skills 规范的 frontmatter，示例记录与 examples/record.example.json 一致', () => {
  const text = read('skills/modelpace/SKILL.md');
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text)[1];
  const field = (key) => new RegExp(`^${key}: (.+)$`, 'm').exec(front)?.[1];

  assert.equal(field('name'), 'modelpace');
  assert.match(field('name'), /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(field('name').length <= 64);
  const description = field('description');
  assert.ok(description.length > 100 && description.length <= 1024);
  assert.match(description, /Use before calling delegate_task/);
  assert.match(description, /Triggers on/);
  assert.ok(field('compatibility').length <= 500);

  const example = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text.slice(text.indexOf('## 2. Record')))[1]);
  assert.deepEqual(example, JSON.parse(read('examples/record.example.json')));
});

test('llms.txt 按 llmstxt.org 格式，索引的每个文件都存在，核心入口都在索引里', () => {
  const lines = read('llms.txt').split('\n');
  assert.equal(lines[0], '# modelpace');
  assert.match(lines.find((line) => line.trim()  && line !== lines[0]), /^> /);
  assert.ok(lines.some((line) => line === '## Docs'));
  assert.ok(lines.some((line) => line === '## Optional'));

  const base = 'https://raw.githubusercontent.com/jieyuexing/modelpace/main/';
  const links = lines.map((line) => /^- \[[^\]]+\]\((\S+)\)(?:: .+)?$/.exec(line)?.[1]).filter(Boolean);
  const files = links.map((link) => {
    assert.ok(link.startsWith(base), link);
    return link.slice(base.length);
  });
  for (const file of files) assert.ok(fs.statSync(path.join(ROOT, file)).isFile(), file);
  for (const required of ['README.md', 'AGENTS.md', 'docs/SCHEMA.md', 'skills/modelpace/SKILL.md', 'examples/record.example.json']) {
    assert.ok(files.includes(required), `${required} missing from llms.txt`);
  }
});

test('npm 包带上 AGENTS.md 与 llms.txt', () => {
  const { files } = JSON.parse(read('package.json'));
  assert.ok(files.includes('AGENTS.md') && files.includes('llms.txt'));
});

test('MCP tools/list：每个工具与每个参数都有 agent 能据此选用和填写的描述', async () => {
  const listed = (await handleJsonRpcMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools;
  assert.deepEqual(listed.map((tool) => tool.name), ['dispatch_plan', 'dispatch_record', 'dispatch_scores', 'dispatch_speed']);
  for (const tool of MCP_TOOLS) {
    assert.ok(tool.description.length >= 150, `${tool.name} description is too short`);
    for (const [name, schema] of Object.entries(tool.inputSchema.properties)) {
      assert.ok(schema.description?.length >= 20, `${tool.name}.${name} needs a description`);
    }
  }
  const plan = MCP_TOOLS.find((tool) => tool.name === 'dispatch_plan');
  for (const action of ['run', 'wait', 'redeem', 'refresh', 'pause']) assert.match(plan.description, new RegExp(`"${action}"`));
  assert.match(plan.description, /recommended\.executor/);
  const record = MCP_TOOLS.find((tool) => tool.name === 'dispatch_record');
  assert.match(record.description, /AFTER/);
  assert.match(record.description, /executedModel/);
  assert.match(record.description, /warnings/);
  assert.match(record.inputSchema.properties.record.description, /executedModel/);
  assert.deepEqual(record.inputSchema.required, ['record']);
});

test('CLI --help 以「下一步」收尾，中英文都有', async () => {
  const en = (await cli(['--help'])).out;
  assert.match(en, /Next steps:\n[\s\S]*modelpace plan --t3-auto[\s\S]*examples\/record\.example\.json[\s\S]*AGENTS\.md/);
  const zh = (await cli(['--help', 'zh'])).out;
  assert.match(zh, /下一步：\n[\s\S]*plan --t3-auto[\s\S]*record\.example\.json/);
});

test('错误信息带可执行的修法提示', async () => {
  await assert.rejects(cli(['plan']), /plan needs a usage source: pass --t3-auto .*--snapshot FILE/);
  await assert.rejects(cli(['plan', '--snapshot', path.join(os.tmpdir(), 'no-such-snapshot.json')]), /Cannot read .*no-such-snapshot\.json: ENOENT \(a saved usage snapshot; examples\/sample-snapshot\.json/);
  await assert.rejects(cli(['plan', '--snapshot', SNAPSHOT, '--now', '2026-11-23T07:05:00Z', '--config', path.join(os.tmpdir(), 'no-such.json')]), /modelpace init --out FILE/);
  await assert.rejects(cli(['validate']), /modelpace init --out dispatch\.config\.json/);
  await assert.rejects(cli(['record']), /examples\/record\.example\.json/);

  const base = ['plan', '--snapshot', SNAPSHOT, '--now', '2026-11-23T07:05:00Z'];
  await assert.rejects(cli([...base, '--slot', 'nope']), /Unknown dispatch slot "nope": expected one of worker, heavy, review .*omit --slot/);
  await assert.rejects(cli([...base, '--tier', 'nope']), /Invalid tier "nope": expected one of work, personal, public .*omit --tier/);
  await assert.rejects(cli([...base, '--task', 'nope']), /Invalid task "nope": expected one of general, research, review, slice, long/);

  const stale = JSON.parse((await cli([...base.slice(0, 3), '--now', '2026-11-23T09:05:00Z', '--format', 'json'])).out);
  assert.equal(stale.action, 'refresh');
  assert.match(stale.reasons[0], /--t3-auto or --t3-origin; replaying a saved file: pass --now close to its observedAt/);
});
