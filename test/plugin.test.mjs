import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activate } from '../plugin/index.mjs';
import { writeClaudeFixture, writeCodexFixture } from './helpers/speed-fixtures.mjs';

const PLUGIN_DIR = path.join(import.meta.dirname, '..', 'plugin');
const SNAPSHOT = path.join(import.meta.dirname, '..', 'examples', 'sample-snapshot.json');
const NAMESPACE = 'com.jieyuexing.t3code';

test('plugin.json follows the Agent Plugins 1.0 shape the T3 host loader accepts', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'plugin.json'), 'utf8'));
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.match(manifest.name, /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
  const allowed = ['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions'];
  assert.deepEqual(Object.keys(manifest).filter((key) => !allowed.includes(key)), []);

  const extension = manifest.extensions[NAMESPACE];
  assert.equal(extension.apiVersion, 1);
  assert.deepEqual(extension.capabilities.toSorted(), ['settings', 'views']);
  for (const file of [extension.entry, ...extension.views.map((view) => view.html)]) {
    assert.match(file, /^(?!\/)(?!.*\.\.)[^\\:\0]+$/);
    assert.ok(fs.statSync(path.join(PLUGIN_DIR, file)).isFile());
  }
  for (const view of extension.views) {
    assert.equal(view.placement, 'side-panel');
    assert.match(view.id, /^[a-z][a-z0-9-]*$/);
    assert.ok(view.title.length <= 60);
  }
  assert.deepEqual(extension.provides.map((service) => service.name), ['dispatch.plan', 'dispatch.scores', 'dispatch.speed']);
  for (const service of extension.provides) {
    assert.match(service.name, /^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/);
    for (const method of service.methods) {
      assert.match(method.name, /^[A-Za-z][A-Za-z0-9_]*$/);
      assert.equal(method.readOnly, true);
    }
  }
  assert.equal(fs.statSync(path.join(PLUGIN_DIR, 'view.html')).size < 5 * 1024 * 1024, true);
});

test('the plugin serves read-only services and dashboard handlers by reusing the engine', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelpace-plugin-'));
  const saved = { ...process.env };
  try {
    const now = Date.now();
    writeClaudeFixture(path.join(dir, 'claude'), now);
    writeCodexFixture(path.join(dir, 'codex'), now);
    Object.assign(process.env, {
      MODELPACE_CLAUDE_DIR: path.join(dir, 'claude'),
      MODELPACE_CODEX_DIR: path.join(dir, 'codex'),
      MODELPACE_OPENCODE_DB: path.join(dir, 'missing.db'),
      MODELPACE_ANTIGRAVITY_PATHS: path.join(dir, 'missing'),
      MODELPACE_SPEED_CACHE: path.join(dir, 'cache.json'),
    });
    const settings = { snapshotPath: SNAPSHOT, t3Auto: false, days: 7, scoresPath: path.join(dir, 'scores.jsonl') };
    const services = {};
    const handlers = {};
    await activate({
      settings: { get: async (key) => settings[key] ?? null },
      provide: (name, methods) => { services[name] = methods; },
      handle: (name, fn) => { handlers[name] = fn; },
    });
    assert.deepEqual(Object.keys(services), ['dispatch.plan', 'dispatch.scores', 'dispatch.speed']);
    assert.deepEqual(Object.keys(handlers), ['view:dashboard:html', 'view:dashboard:data']);

    const decision = await services['dispatch.plan'].run({ task: 'slice', tier: 'personal' });
    assert.ok(['run', 'wait', 'redeem', 'refresh', 'pause'].includes(decision.action));
    const codex = decision.candidates.find((c) => c.model === 'gpt-5.3-codex');
    assert.ok(Math.abs(codex.speedLongRate - 150) / 150 <= 0.01);

    const speed = await services['dispatch.speed'].get({});
    assert.deepEqual(speed.ranking.map((row) => row.model), ['gpt-5.3-codex', 'claude-opus-5-5']);
    assert.equal((await services['dispatch.scores'].get()).totalRecords, 0);

    const html = await handlers['view:dashboard:html']();
    assert.match(html, /Speed Leaderboard/);
    assert.doesNotMatch(html, /https?:\/\//);
    const data = await handlers['view:dashboard:data']();
    assert.equal(data.live, true);
    assert.ok(data.quota.instances.length > 0);

    settings.snapshotPath = null;
    await assert.rejects(() => services['dispatch.plan'].run({}), /No usage source/);
    const fallback = await handlers['view:dashboard:data']();
    assert.deepEqual(fallback.quota.instances, []);
    assert.ok(fallback.speed.ranking.length > 0);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
