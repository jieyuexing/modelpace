import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../bin/t3-dispatch.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SNAPSHOT = path.join(ROOT, 'examples', 'sample-snapshot.json');
const NOW = '2026-11-23T07:05:00Z';
const SKILL = fs.readFileSync(path.join(ROOT, 'skills', 't3-dispatch', 'SKILL.md'), 'utf8');

/** SKILL.md 里「Record」一节的 JSON 示例。 */
function skillRecordExample() {
  const section = SKILL.slice(SKILL.indexOf('## 2. Record'));
  return JSON.parse(/```json\n([\s\S]*?)\n```/.exec(section)[1]);
}

async function cli(args, input = '') {
  let out = '';
  const code = await runCli(args, {
    env: { HOME: os.tmpdir() },
    stdin: (async function* () { yield input; })(),
    write: (text) => { out += text; },
  });
  assert.equal(code, 0);
  return out;
}

const plan = async (ledger) =>
  JSON.parse(await cli(['plan', '--snapshot', SNAPSHOT, '--now', NOW, '--task', 'slice', '--scores', ledger, '--format', 'json']));

async function recordFive(ledger, executor) {
  for (let i = 0; i < 5; i += 1) {
    const record = { ...skillRecordExample(), taskId: `task-${i}`, executor };
    await cli(['record', '--json', '-', '--scores', ledger], JSON.stringify(record));
  }
}

test('按 SKILL.md 示例写入 5 条成功记录后，对应候选变为 qualified', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3-dispatch-skill-'));
  const ledger = path.join(dir, 'scores.jsonl');
  const before = await plan(ledger);
  assert.equal(before.recommended.qualityTier, 'trial');

  await recordFive(ledger, skillRecordExample().executor);
  const after = await plan(ledger);
  assert.equal(after.recommended.candidateId, before.recommended.candidateId);
  assert.equal(after.recommended.qualityTier, 'qualified');
});

test('plan 结果里的 recommended.executor 加上 site 即可直接回填为记录', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3-dispatch-skill-'));
  const ledger = path.join(dir, 'scores.jsonl');
  const before = await plan(ledger);
  assert.deepEqual(Object.keys(before.recommended.executor), ['provider', 'model', 'effort', 'tier']);

  await recordFive(ledger, { ...before.recommended.executor, site: 'local' });
  const after = await plan(ledger);
  assert.equal(after.recommended.qualityTier, 'qualified');
  assert.equal(after.recommended.scoreIdentity, before.recommended.scoreIdentity);
});
