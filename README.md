# modelpace

**for T3 Code**

> **Unofficial community tool** — not affiliated with or endorsed by T3 Tools Inc.

Zero-dependency (Node.js >= 22 ESM) multi-model dispatch, Even Pace quota pacing, reset-credit accounting, and Bayesian acceptance-scoring engine for **T3 Code**.

[中文文档](./README.zh-CN.md)

## What it does

Before an agent calls `delegate_task`, modelpace answers one question: *which provider instance and model should take this task right now?* It reads your live T3 Code quota (Even Pace, reset credits), prefers models that actually passed your earlier acceptance checks, and prints a ready-to-use target. It only advises; your agent still starts the work.

## Give this to your agent

Paste this into Claude Code, Codex, T3 Code or any coding agent:

```text
Set up modelpace for me. Read AGENTS.md at https://github.com/jieyuexing/modelpace (or in the clone), clone the repo and check it works with the offline replay from AGENTS.md (in a scratch directory; never record the demo record into my real ledger), register its MCP server with this client, and then call dispatch_plan before every delegate_task and dispatch_record after I accept a result. Ask me before using --t3-auto.
```

Agents can also start from [AGENTS.md](./AGENTS.md) (install, commands, MCP tools, privacy, troubleshooting), [llms.txt](./llms.txt) (index) and [skills/modelpace/SKILL.md](./skills/modelpace/SKILL.md).

## Install

Requires Node.js 22 or newer. There is nothing to build and no dependencies to install.

```bash
git clone https://github.com/jieyuexing/modelpace.git
cd modelpace
node ./bin/modelpace.mjs --version

npx github:jieyuexing/modelpace --version
npx modelpace --version
```

The examples below use the checkout form `node ./bin/modelpace.mjs`; replace it with `npx modelpace` if you installed from npm.

## Quick Start

<!-- docs-test expect: Action: run -> codex -->
```bash
# Replay a saved snapshot at a fixed instant (--now keeps the example reproducible)
node ./bin/modelpace.mjs plan \
  --snapshot examples/sample-snapshot.json \
  --now 2026-11-23T07:05:00Z \
  --task slice
```

Output:

```text
Note: using the built-in default policy (official T3 Code instance ids). Pass --config FILE to use your own; "modelpace init" writes a starting point.
Action: run -> codex / gpt-5.3-codex (slot=worker, task=slice)
delegate_task target: {"providerInstanceId":"codex","model":"gpt-5.3-codex","options":{"reasoningEffort":"high"}}
- Selected codex-worker (codex/gpt-5.3-codex) for slot=worker, task=slice [quota=available, quality=trial].
Next check: 2026-11-23T07:15:00.000Z
```

A snapshot older than 15 minutes yields `Action: refresh`, so a saved file only works with `--now` set near its `observedAt`. Against a live T3 Code there is nothing to pin:

```bash
# Zero-config: discover the local T3 Code (see "Connecting to T3 Code" below)
node ./bin/modelpace.mjs plan --t3-auto --task slice

# Or a T3 server you point at explicitly
node ./bin/modelpace.mjs plan --t3-origin http://127.0.0.1:3773 --t3-token "$T3_TOKEN" --task long
```

### Policy

Without `--config` (or `MODELPACE_CONFIG`) the built-in default policy is used, and `plan` says so in its text output. It targets the official T3 Code default instance ids `codex`, `claudeAgent` and `antigravity` — one instance per driver — with three slots (`worker`, `heavy`, `review`). Candidates whose instance is missing from the snapshot are skipped.

To change models, priorities, thresholds or to add more accounts (several Codex or Antigravity subscriptions, custom instance ids), start from the built-in policy or an example:

<!-- docs-test expect: Valid dispatch policy -->
```bash
node ./bin/modelpace.mjs init --out dispatch.config.json
node ./bin/modelpace.mjs validate --config dispatch.config.json
```

`examples/multi-account.config.json` (with `examples/multi-account.snapshot.json`) shows a setup with two Antigravity subscriptions, a Codex and a Claude instance. Every field is documented in [docs/SCHEMA.md](./docs/SCHEMA.md).

### Recording outcomes

`plan` only recommends; the agent that calls `delegate_task` does the dispatching. After you have verified a result, record it so later plans can prefer models that actually pass:

<!-- docs-test expect: Recorded codex/gpt-5.3-codex/high/default/local -->
```bash
node ./bin/modelpace.mjs plan --snapshot examples/sample-snapshot.json --now 2026-11-23T07:05:00Z --task slice --format json
# copy decision.recommended.executor into a record and add "site"; examples/record.example.json is a complete template
node ./bin/modelpace.mjs record --json examples/record.example.json --scores demo-scores.jsonl
node ./bin/modelpace.mjs scores --scores demo-scores.jsonl
```

The example record is fake and `demo-scores.jsonl` is a throwaway demo ledger: delete it afterwards, and without `--scores` records go to your real ledger (see below).

The ledger defaults to `$XDG_DATA_HOME/modelpace/scores.jsonl` (`~/.local/share/modelpace/scores.jsonl`; `%LOCALAPPDATA%\modelpace\scores.jsonl` on Windows). Override it with `--scores FILE` or `MODELPACE_SCORES`. `record` creates missing directories with mode 0700 and the ledger with mode 0600, and leaves existing directories untouched. Agents can follow [skills/modelpace/SKILL.md](./skills/modelpace/SKILL.md). A candidate becomes `qualified` after 5 successful records for the same executor identity and task; the record fields and the identity rules are in [docs/SCHEMA.md](./docs/SCHEMA.md#record-one-json-object-per-ledger-line).

### Connecting to T3 Code

`--t3-auto` runs the local T3 CLI (`t3 auth session issue --scope orchestration:read --ttl 2m --label modelpace`), reads `server.getConfig` with that token, and revokes the session in a `finally` step. The session lives at most 2 minutes and can only read orchestration state — it cannot open terminals or write files. It is opt-in per command (`--t3-auto` or `MODELPACE_AUTO=1`); leave it off and use `--snapshot` or `--t3-origin` with your own token if you prefer. Every `plan --t3-auto` issues one session. `dashboard` also scans local session logs for Speed, and `serve` re-runs the whole load every 15 seconds while its page is open, so `serve --t3-auto` issues and revokes a session every 15 seconds.

Prefer `MODELPACE_TOKEN` or `--t3-token-cmd` over `--t3-token`, which is visible in the process list.

## Features

- **Zero Runtime Dependencies**: Pure Node.js ESM (`>= 22.0.0`), using built-in `node:*`, `fetch`, and `WebSocket`. No `node_modules` needed.
- **Direct T3 WebSocket RPC Adapter**: Fetches live `server.getConfig` (`usageLimits` + `usageLimitSources`) from T3 Code via `/api/auth/websocket-ticket` and `/ws?orchestrationProtocol=2`. Supports an explicit bearer token or an external token command without ever reading credential cache files.
- **Multi-Provider `UsageSnapshot v2`**: Normalizes Codex, Claude, Gemini / Antigravity (multi-instance + `gemini`/`carbon`/`argon`/`3p` pool isolation), Grok, OpenCode, and optional pay-as-you-go API budgets.
- **Even Pace & Reset Credits**:
  - Compares `effectiveRemainingPercent` against `remainingTimePercent` across weekly/long windows.
  - Supports short-window burst caps (`shortWindowMaxUsedPercent`) and secondary-account overflow thresholds (`maxShortUsedPercent`).
  - Accounts for Codex (`codexRateLimits`) and Claude (`claudeSession`, `claudeWeekly`, `claudeFable`, `claudeFull`) reset credits with near-reset skip logic.
- **Quality × Speed Fusion**:
  - Exact Beta(1, 1) posterior pass rate and 90% credible intervals (Lanczos log-Gamma + continued fraction).
  - Separates `qualified`, `trial` (cold start, never blocked), and `below_threshold` (`demote` / `strict` / `advisory`).
  - Ranks qualified models by median successful duration ascending, with Speed `longRate` (tok/s) and Even Pace surplus tie-breaking.
- **Local Speed Leaderboard**: measures real output speed from your own session logs (Claude Code, Codex, OpenCode, plus a generic event format for Antigravity / Gemini). Sparse log-scale histograms (bin ratio 1.02, median error <= 1%), incremental cache, read-only. Feeds `plan` as a tie-breaker.
- **Zero-config T3 connection** (`--t3-auto`): discovers the local T3 Code, issues a 2-minute `orchestration:read` session through the official `auth session issue` CLI, reads `server.getConfig`, and always revokes the session. No credential file is read.
- **Self-contained dashboard**: one HTML file (no CDN, light/dark, EN/ZH) with Quota & Even Pace, a Speed leaderboard with a one-click Share Image (1200px @2x PNG), and acceptance scores with a dispatch audit.
- **CLI & Zero-Dependency MCP Server**:
  - `modelpace` (`plan`, `record`, `scores`, `speed`, `dashboard`, `serve`, `validate`, `init`)
  - `modelpace-mcp` (stdio JSON-RPC 2.0 MCP server exposing `dispatch_plan`, `dispatch_record`, `dispatch_scores`, `dispatch_speed`)
- **Experimental T3 plugin** (`plugin/`, repository only): see [T3 Plugin](#t3-plugin-experimental).

## Speed & Dashboard

```bash
# Local speed leaderboard (text | json | html)
node ./bin/modelpace.mjs speed --days 30
node ./bin/modelpace.mjs speed --format html --out speed.html

# Zero-config: plan against the local T3 Code and fold measured speed into the decision
node ./bin/modelpace.mjs plan --t3-auto --speed-scan --task slice

# One self-contained HTML dashboard, or a live one on localhost
node ./bin/modelpace.mjs dashboard --t3-auto --scores dispatch-scores.jsonl --out dashboard.html
node ./bin/modelpace.mjs serve --t3-auto --scores dispatch-scores.jsonl --port 8787
```

Speed rules (per request): output tokens / wall time, counted only for >= 100 output tokens and 0.5 s < duration < 900 s. The headline number is the median tok/s of requests with >= 1000 output tokens; rows with fewer than 20 such requests are marked low-sample and excluded from `plan` tie-breaking. The Dispatch Pass column uses the same success formula as the acceptance scores.

Per-request tok/s differs from end-to-end `delegate_task` wall time: short bounded slices often finish in 2–6 minutes end-to-end while heavy multi-step work can take 15–20+ minutes across tool calls and checks, so `plan` orders qualified models by ledger task duration median first and uses Speed only to break near-ties. When session logs carry input and cache token fields (Claude Code, Codex, or generic events), `speed` also reports an optional `cacheHitRate` (`cachedInputTokens / inputTokens`, `0..1`, shown as `cache=` in text output when available) strictly for quota-efficiency observation without affecting `plan` ranking weights.

Sources (all read-only, all paths overridable): `MODELPACE_CLAUDE_DIR` (default `~/.claude/projects`), `MODELPACE_CODEX_DIR` (`~/.codex/sessions`), `MODELPACE_OPENCODE_DB` (`~/.local/share/opencode/opencode.db`, needs `node:sqlite`), `MODELPACE_ANTIGRAVITY_PATHS` (default `~/.gemini/antigravity`; JSONL files or SQLite files with a `speed_events` table, one event `{ model, outputTokens, startedAt, endedAt }` per request). `MODELPACE_SPEED_CACHE` moves the incremental cache (default `~/.cache/modelpace/speed-cache.json`).

`--t3-auto` / `MODELPACE_AUTO=1` finds the T3 CLI via `MODELPACE_T3_BIN`, then `t3` on `PATH`, then the macOS app bundle with id `com.t3tools.t3code`; the server origin comes from the running server's `userdata/server-runtime.json` under `T3CODE_HOME` (default `~/.t3`) or `MODELPACE_ORIGIN`.

The dashboard is a pure function: `renderDashboardHtml({ decision, snapshot, scoresSummary, speedRanking, options })` returns the HTML string, so it also works inside T3 Code's `html_render`.

## T3 Plugin (experimental)

`plugin/` is an Agent Plugins 1.0 package. It only works in a T3 Code build that implements the plugin-host extension it declares (the `com.jieyuexing.t3code` extension namespace); the official T3 Code release has no plugin host, so the plugin does nothing there. It is not part of the npm package: use it from a checkout, because it reuses the engine in `../src`.

- view `dashboard` (side panel) — the same dashboard, refreshed through the host bridge;
- read-only services `dispatch.plan` (`run`), `dispatch.scores` (`get`), `dispatch.speed` (`get`), callable by agents;
- settings: local T3 connection, snapshot file, config, scores ledger, speed window.

## MCP Integration

The MCP server speaks stdio. Register it with the client your agent runs in, using an absolute path to the checkout (T3 Code launches Claude and Codex itself and, per its source, loads their normal settings — Claude's user, project and local scopes and Codex's `config.toml`, unless a provider instance has its own home directory — so there is no separate T3 Code MCP setting; this was read from the source, not run):

```bash
# Claude Code
claude mcp add modelpace -- node /absolute/path/to/modelpace/bin/modelpace-mcp.mjs
# Codex CLI
codex mcp add modelpace -- node /absolute/path/to/modelpace/bin/modelpace-mcp.mjs
```

These leave quota access off. To let the server read quota from the local T3 Code (a 2-minute `orchestration:read` session, see [Connecting to T3 Code](#connecting-to-t3-code)), add `-e MODELPACE_AUTO=1` after the name for Claude Code or `--env MODELPACE_AUTO=1` for Codex.

Codex `~/.codex/config.toml` (the `env` table opts into `--t3-auto`; omit it to keep quota access off):

```toml
[mcp_servers.modelpace]
command = "node"
args = ["/absolute/path/to/modelpace/bin/modelpace-mcp.mjs"]

[mcp_servers.modelpace.env]
MODELPACE_AUTO = "1"
```

Any other MCP client (JSON; `MODELPACE_AUTO` is the `--t3-auto` opt-in, omit it to keep quota access off):

```json
{
  "mcpServers": {
    "modelpace": {
      "command": "node",
      "args": ["/absolute/path/to/modelpace/bin/modelpace-mcp.mjs"],
      "env": {
        "MODELPACE_CONFIG": "/path/to/dispatch.config.json",
        "MODELPACE_SCORES": "/path/to/dispatch-scores.jsonl",
        "MODELPACE_AUTO": "1"
      }
    }
  }
}
```

After the npm release replace `node /absolute/path/.../modelpace-mcp.mjs` with `npx -y -p modelpace modelpace-mcp`: the package is `modelpace` and `modelpace-mcp` is its second binary, so plain `npx -y modelpace-mcp` would look for a different package. Config and ledger are optional (built-in policy and default ledger apply); drop `MODELPACE_AUTO` to keep quota access off.

Tools exposed:
- `dispatch_plan` — accepts `t3Auto` / `MODELPACE_AUTO=1` and `includeSpeed` (measures local Speed as a tie-breaker); returns `{ action, recommended: { target: { providerInstanceId, model, options }, executor, delegateReady }, waitUntil, nextCheckAt, reasons, candidates }`
- `dispatch_record` — validates and appends an acceptance record to JSONL
- `dispatch_scores` — returns ranked cells, Beta 90% intervals, median durations, and nominal costs
- `dispatch_speed` — returns the local speed ranking (`days`), the metrics map `plan` consumes, per-source scan counts and warnings

## Testing

```bash
node --test test/*.test.mjs
```

## License

[MIT](./LICENSE)
