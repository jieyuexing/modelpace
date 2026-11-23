import fs from 'node:fs';
import path from 'node:path';
import { normalizePolicy } from '../../src/index.mjs';

const EXAMPLES = path.join(import.meta.dirname, '..', '..', 'examples');

export const MULTI_ACCOUNT_SNAPSHOT = path.join(EXAMPLES, 'multi-account.snapshot.json');

/** 双 Antigravity 订阅 + Codex + Claude 的多账号示例策略，用来覆盖多实例路径。 */
export const multiAccountPolicy = () =>
  normalizePolicy(JSON.parse(fs.readFileSync(path.join(EXAMPLES, 'multi-account.config.json'), 'utf8')));
