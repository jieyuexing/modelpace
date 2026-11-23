import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../bin/modelpace.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const ENV = { HOME: os.tmpdir(), XDG_DATA_HOME: path.join(os.tmpdir(), 'modelpace-readme-none') };

// signal 预先中止：万一 serve 没有拒绝参数，也会立刻停下而不是挂住测试。
async function run(args) {
  let out = '';
  const code = await runCli(args, { env: ENV, write: (text) => { out += text; }, signal: AbortSignal.abort() });
  return { code, out };
}

/** Quick Start 里第一条 plan 命令（续行合并后按空白切分）与紧随其后的 Output 块。 */
function quickStart() {
  const section = README.slice(README.indexOf('## Quick Start'));
  const command = /```bash\n# [^\n]*\n(node \.\/bin\/modelpace\.mjs plan[\s\S]*?)\n```/.exec(section)[1];
  const output = /Output:\n\n```text\n([\s\S]*?)```/.exec(section)[1];
  return { args: command.replace(/\\\n/g, ' ').split(/\s+/).slice(2), output };
}

test('README Quick Start 的命令原样运行，得到 README 里写的输出（run，而不是 refresh）', async () => {
  const { args, output } = quickStart();
  assert.equal(args[0], 'plan');
  assert.ok(args.includes('--now'));
  const { code, out } = await run(args.map((arg) => (arg.startsWith('examples/') ? path.join(ROOT, arg) : arg)));
  assert.equal(code, 0);
  assert.equal(out, output);
  assert.match(out, /^Note: using the built-in default policy[^\n]*\nAction: run -> /);
});

test('--now 只接受 ISO 时间，并且 serve 不接受', async () => {
  const snapshot = path.join(ROOT, 'examples', 'sample-snapshot.json');
  await assert.rejects(run(['plan', '--snapshot', snapshot, '--now', 'tomorrow']), /--now must be an ISO 8601 timestamp/);
  await assert.rejects(run(['serve', '--snapshot', snapshot, '--now', '2026-11-23T07:05:00Z']), /--now is not supported for serve/);

  const stale = await run(['plan', '--snapshot', snapshot, '--now', '2026-11-23T09:05:00Z', '--format', 'json']);
  assert.equal(JSON.parse(stale.out).action, 'refresh');
});

test('--config 指向自己的策略时不出现内置策略提示', async () => {
  const snapshot = path.join(ROOT, 'examples', 'multi-account.snapshot.json');
  const config = path.join(ROOT, 'examples', 'multi-account.config.json');
  const { out } = await run(['plan', '--snapshot', snapshot, '--config', config, '--now', '2026-11-23T07:05:00Z', '--task', 'slice']);
  assert.doesNotMatch(out, /built-in default policy/);
  assert.match(out, /^Action: run -> /);
});
