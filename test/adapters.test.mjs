import test from 'node:test';
import assert from 'node:assert/strict';
import {
  T3RpcError,
  connectT3,
  fetchT3ServerConfig,
  normalizeT3ConfigToSnapshot,
  normalizeSnapshot,
  overlayBudgetEntries,
} from '../src/index.mjs';
import { startMockT3Server } from './helpers/mock-t3-server.mjs';

test('T3 WS RPC client fetches server.getConfig via bearer and tokenCommand', async () => {
  const sampleConfig = {
    providers: [
      {
        instanceId: 'codex',
        driver: 'codex',
        displayName: 'Codex',
        enabled: true,
        installed: true,
        status: 'ready',
        auth: { status: 'authenticated', label: 'ChatGPT Pro 200 Subscription' },
        models: [{ id: 'gpt-5.3-codex' }],
        usageLimits: {
          checkedAt: '2026-11-23T07:00:00.000Z',
          windows: [
            { id: 'primary', kind: 'session', label: '5h', usedPercent: 15, resetsAt: '2026-11-23T11:00:00.000Z', windowDurationMins: 300 },
            { id: 'secondary', kind: 'weekly', label: 'Weekly', usedPercent: 40, resetsAt: '2026-11-28T07:00:00.000Z', windowDurationMins: 10080 },
          ],
          resetCredits: { availableCount: 1, nextExpiresAt: '2026-11-30T00:00:00.000Z' },
        },
      },
    ],
  };

  const srv = await startMockT3Server({ expectedToken: 'demo-tok-42', serverConfigPayload: sampleConfig });
  try {
    const cfg1 = await fetchT3ServerConfig({ origin: srv.origin, bearer: 'demo-tok-42' });
    assert.equal(cfg1.providers.length, 1);
    assert.equal(cfg1.providers[0].instanceId, 'codex');

    const cfg2 = await fetchT3ServerConfig({
      origin: srv.origin,
      tokenCommand: [process.execPath, '-e', 'process.stdout.write("demo-tok-42")'],
    });
    assert.equal(cfg2.providers[0].usageLimits.windows.length, 2);

    const rpc = await connectT3(srv.origin, 'demo-tok-42');
    const chunk = await rpc.call('stream.test', {}, { stream: true });
    assert.equal(chunk._tag, 'Chunk');
    assert.equal(chunk.values[0].ok, true);
    rpc.close();

    await assert.rejects(
      () => fetchT3ServerConfig({ origin: srv.origin, bearer: 'wrong-token' }),
      (err) => err instanceof T3RpcError && err.status === 401,
    );
  } finally {
    await srv.close();
  }
});

test('normalizeT3ConfigToSnapshot handles Codex, Claude, Gemini multi-instance/pool, Grok, OpenCode, and usageLimitSources', () => {
  const now = Date.parse('2026-11-23T07:00:00.000Z');
  const snapshot = normalizeT3ConfigToSnapshot(
    {
      providers: [
        {
          instanceId: 'codex',
          driver: 'codex',
          enabled: true,
          installed: true,
          status: 'ready',
          auth: { status: 'authenticated', label: 'ChatGPT Pro 200 Subscription' },
          usageLimits: {
            checkedAt: '2026-11-23T06:58:00.000Z',
            windows: [
              { id: 'primary', kind: 'session', label: '5h', usedPercent: 20, resetsAt: '2026-11-23T11:00:00.000Z' },
              { id: 'secondary', kind: 'weekly', label: 'Weekly', usedPercent: 35, resetsAt: '2026-11-28T07:00:00.000Z' },
              { id: 'individual', kind: 'monthly', label: 'Credits', usedPercent: 100 },
            ],
            resetCredits: { availableCount: 2, nextExpiresAt: '2026-11-30T00:00:00.000Z' },
          },
        },
        {
          instanceId: 'claude',
          driver: 'claudeAgent',
          enabled: true,
          installed: true,
          status: 'ready',
          auth: { status: 'authenticated', label: 'Max' },
          usageLimits: {
            checkedAt: '2026-11-23T06:59:00.000Z',
            windows: [
              { id: 'five_hour', kind: 'session', label: '5-hour limit', usedPercent: 10, resetsAt: '2026-11-23T10:00:00.000Z' },
              { id: 'seven_day', kind: 'weekly', label: 'Weekly · all models', usedPercent: 50, resetsAt: '2026-11-27T00:00:00.000Z' },
              { id: 'seven_day_sonnet', kind: 'weekly', label: 'Weekly · Sonnet', usedPercent: 95, resetsAt: '2026-11-27T00:00:00.000Z' },
            ],
            resetCredits: {
              availableCount: 1,
              options: [
                { creditId: 'weekly-reset', label: 'Weekly reset', description: 'Refills weekly', availableCount: 1, expiresAt: '2026-11-29T00:00:00.000Z' },
              ],
            },
          },
        },
        {
          instanceId: 'antigravity',
          driver: 'antigravity',
          displayName: 'Antigravity Ultra',
          enabled: true,
          installed: true,
          status: 'ready',
          auth: { status: 'authenticated', label: 'Ultra' },
          usageLimits: {
            checkedAt: '2026-11-23T06:59:00.000Z',
            windows: [
              { id: 'gemini-5h', kind: 'session', label: 'Gemini 5h', usedPercent: 15 },
              { id: 'gemini-carbon-5h', kind: 'session', label: 'Carbon 5h', usedPercent: 40 },
              { id: 'gemini-argon-weekly', kind: 'weekly', label: 'Argon Weekly', usedPercent: 5 },
              { id: '3p-5h', kind: 'session', label: '3P Claude/GPT', usedPercent: 80 },
            ],
          },
        },
        {
          instanceId: 'antigravity_2',
          driver: 'antigravity',
          displayName: 'Antigravity Pro',
          enabled: true,
          installed: true,
          status: 'ready',
          usageLimits: {
            checkedAt: '2026-11-23T06:59:00.000Z',
            windows: [{ id: 'gemini-5h', kind: 'session', label: 'Gemini 5h', usedPercent: 60 }],
          },
        },
        {
          instanceId: 'grok',
          driver: 'grok',
          enabled: true,
          installed: true,
          status: 'ready',
          usageLimits: {
            checkedAt: '2026-11-23T06:59:00.000Z',
            windows: [{ id: 'weekly', kind: 'weekly', label: 'Weekly', usedPercent: 25 }],
          },
        },
        {
          instanceId: 'opencode',
          driver: 'opencode',
          enabled: true,
          installed: true,
          status: 'ready',
          usageLimits: {
            checkedAt: '2026-11-23T06:59:00.000Z',
            windows: [{ id: 'go_weekly', kind: 'weekly', label: 'OpenCode Go', usedPercent: 100 }],
          },
        },
      ],
      usageLimitSources: [
        {
          id: 'hub-1',
          kind: 'cliproxy',
          label: 'Shared Hub',
          checkedAt: '2026-11-23T06:59:00.000Z',
          accounts: [
            {
              id: 'acc-a',
              driver: 'codex',
              plan: 'Plus',
              usageLimits: {
                checkedAt: '2026-11-23T06:59:00.000Z',
                windows: [{ id: 'primary', kind: 'session', label: '5h', usedPercent: 30 }],
              },
            },
          ],
        },
      ],
    },
    now,
  );

  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.source, 't3-rpc');
  const codexInd = snapshot.instances.codex.windows.find((w) => w.id === 'individual');
  assert.equal(codexInd.applicableByDefault, false);
  assert.equal(snapshot.instances.codex.resetCredits.cards[0].resetType, 'codexRateLimits');
  assert.equal(snapshot.instances.claude.resetCredits.cards[0].resetType, 'claudeWeekly');

  const agWins = snapshot.instances.antigravity.windows;
  assert.equal(agWins.find((w) => w.id === 'gemini-5h').pool, 'gemini');
  assert.equal(agWins.find((w) => w.id === 'gemini-carbon-5h').pool, 'carbon');
  assert.equal(agWins.find((w) => w.id === 'gemini-argon-weekly').pool, 'argon');
  assert.equal(agWins.find((w) => w.id === '3p-5h').pool, '3p');
  assert.ok(snapshot.instances['antigravity_2']);
  assert.ok(snapshot.instances['hub-1:acc-a']);
});

test('normalizeSnapshot converts legacy v1, standalone Claude JSON, and overlays pay-as-you-go budgets', () => {
  const now = Date.parse('2026-11-23T07:00:00.000Z');
  const v1 = normalizeSnapshot(
    {
      schemaVersion: 1,
      observedAt: Math.floor(now / 1000) - 60,
      providers: [
        {
          provider: 'codex',
          status: 'ready',
          remainingPercent: 75,
          resetsAt: Math.floor(now / 1000) + 7200,
          windowDurationMins: 300,
        },
        {
          provider: 'claude',
          status: 'ok',
          windows: [
            { label: '5-hour limit', percentUsed: 20, resetsAt: '2026-11-23T11:00:00.000Z' },
            { label: 'Weekly · all models', percentUsed: 40, resetsAt: '2026-11-28T07:00:00.000Z' },
          ],
        },
      ],
    },
    { now },
  );

  assert.equal(v1.instances.codex.windows[0].remainingPercent, 75);
  assert.equal(v1.instances.claude.windows[0].id, 'five_hour');
  assert.equal(v1.instances.claude.windows[1].id, 'seven_day');

  const standaloneClaude = normalizeSnapshot(
    {
      plan: {
        status: 'ok',
        windows: [{ label: '5-hour limit', percentUsed: 12 }],
      },
    },
    { now },
  );
  assert.equal(standaloneClaude.instances.claude.windows[0].usedPercent, 12);

  const withBudget = overlayBudgetEntries(v1, {
    instanceId: 'deepseek',
    driver: 'api',
    spent: 120,
    budget: 100,
    balance: 50,
    isAvailable: true,
  });
  assert.equal(withBudget.instances.deepseek.budget.spent, 120);
  assert.equal(withBudget.instances.deepseek.budget.budget, 100);
});
