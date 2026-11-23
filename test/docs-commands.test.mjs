import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../bin/t3-dispatch.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PREFIXES = ['node ./bin/t3-dispatch.mjs ', 't3-dispatch '];

/** `<!-- docs-test[ expect: 文本] -->` 后紧跟的 ```bash 代码块。 */
function docTestBlocks(file) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return [...text.matchAll(/<!-- docs-test(?: expect: (.+?))? -->\n```bash\n([\s\S]*?)\n```/g)].map((match) => ({
    expect: match[1] ?? null,
    commands: match[2]
      .replace(/\\\n/g, ' ')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#')),
  }));
}

async function runCommand(command, cwd, env) {
  const prefix = PREFIXES.find((candidate) => command.startsWith(candidate));
  assert.ok(prefix, `docs-test block may only run t3-dispatch commands: ${command}`);
  const args = command.slice(prefix.length).split(/\s+/).filter(Boolean);
  let out = '';
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    const code = await runCli(args, { env, write: (text) => { out += text; }, signal: AbortSignal.abort() });
    assert.equal(code, 0, `exit code for: ${command}`);
  } finally {
    process.chdir(previous);
  }
  return out;
}

// 文档里标记为可运行的命令，在夹具目录（拷贝 examples、空 HOME、空账本目录）里按文档顺序跑通。
for (const [file, minBlocks] of [['AGENTS.md', 4], ['README.md', 3], ['README.zh-CN.md', 3]]) {
  test(`${file} 中标记 docs-test 的命令可以执行`, async () => {
    const blocks = docTestBlocks(file);
    assert.ok(blocks.length >= minBlocks, `${file} should keep at least ${minBlocks} runnable blocks, found ${blocks.length}`);

    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't3-dispatch-docs-')));
    fs.cpSync(path.join(ROOT, 'examples'), path.join(dir, 'examples'), { recursive: true });
    const env = { HOME: dir, XDG_DATA_HOME: path.join(dir, 'xdg') };
    try {
      for (const block of blocks) {
        let out = '';
        for (const command of block.commands) out += await runCommand(command, dir, env);
        if (block.expect) assert.ok(out.includes(block.expect), `output of ${block.commands.join(' && ')} should contain "${block.expect}", got:\n${out}`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
