# modelpace — guide for coding agents

modelpace recommends which T3 Code provider instance and model should take a task, based on live quota (Even Pace), reset credits and past acceptance records. It only advises: you still call `delegate_task` yourself. Zero runtime dependencies, Node.js >= 22, MIT.

In this file `modelpace` means `node <checkout>/bin/modelpace.mjs` (from a clone) or `npx modelpace` (once published to npm). Field reference: [docs/SCHEMA.md](./docs/SCHEMA.md). Skill: [skills/modelpace/SKILL.md](./skills/modelpace/SKILL.md).

## Install

```bash
git clone https://github.com/jieyuexing/modelpace.git
cd modelpace
node ./bin/modelpace.mjs --version
```

Nothing to build, no dependencies. Check `node --version` is 22 or newer first.

## First run: validate, plan, record

These blocks run offline against files in this repository (`--now` pins the clock to the sample snapshot's time, otherwise it would be stale). They create demo files (`dispatch.config.json`, `dispatch-scores.jsonl`) in the current directory: do this in a scratch directory and delete them afterwards. The example record is fake; never record it into the user's real ledger (always pass `--scores` as below).

<!-- docs-test -->
```bash
modelpace init --out dispatch.config.json
modelpace validate --config dispatch.config.json
```

<!-- docs-test expect: Action: run -> codex / gpt-5.3-codex -->
```bash
modelpace plan --config dispatch.config.json --snapshot examples/sample-snapshot.json --now 2026-11-23T07:05:00Z --task slice
```

`Action: run` plus a `delegate_task target: {...}` line is a recommendation you can pass to `delegate_task`. Then, after you have independently verified the delegated result, record it. `examples/record.example.json` is a complete template; edit it, do not guess fields:

<!-- docs-test expect: Recorded codex/gpt-5.3-codex/high/default/local -->
```bash
modelpace record --json examples/record.example.json --scores dispatch-scores.jsonl
```

<!-- docs-test expect: codex/gpt-5.3-codex/high/default -->
```bash
modelpace scores --scores dispatch-scores.jsonl
```

Against the user's real T3 Code, replace `--snapshot ... --now ...` with `--t3-auto` (see Data and privacy first):

```bash
modelpace plan --t3-auto --task slice
```

Without `--config` the built-in policy is used (instances `codex`, `claudeAgent`, `antigravity`, the official T3 Code defaults). If the user has other instance ids or accounts, write a config from `modelpace init` or `examples/multi-account.config.json`.

## When to run what

| Situation | Command | MCP tool |
| --- | --- | --- |
| About to call `delegate_task` | `modelpace plan --t3-auto --task <general\|research\|review\|slice\|long> --format json` | `dispatch_plan` |
| A delegated result was independently verified (tests, diff, user acceptance) | `modelpace record --json FILE\|-` | `dispatch_record` |
| Asked why a model is (not) preferred | `modelpace scores` | `dispatch_scores` |
| Asked which model is fastest on this machine | `modelpace speed --days 30` | `dispatch_speed` |
| User wants a visual overview | `modelpace dashboard --t3-auto --out dashboard.html` (or `serve`) | none |
| Checking or creating a policy | `modelpace validate --config FILE`, `modelpace init` | none |

Never record a result on the sub-agent's own say-so. `plan` never changes anything outside the ledger, and only `record` writes to it.

## Reading a plan

`--format json` returns `{ action, recommended, waitUntil, redeemCandidate, nextCheckAt, reasons, candidates }`.

| `action` | Do this |
| --- | --- |
| `run` | Pass `recommended.target` (`{ providerInstanceId, model, options }`) to `delegate_task` unchanged. Keep `recommended.executor` for the record. |
| `wait` | Retry at `waitUntil`, or dispatch elsewhere. Only returned when you passed `--wait-minutes`. |
| `redeem` | Ask the user to redeem the reset credit in `redeemCandidate`, then plan again. |
| `refresh` | The usage snapshot is missing or stale. Re-run with `--t3-auto` / `--t3-origin`; when replaying a file, pass `--now` near its `observedAt`. |
| `pause` | Every candidate is blocked. Read `reasons`, retry at `nextCheckAt`, or tell the user. |

To record, copy `recommended.executor` (`provider`, `model`, `effort`, `tier`) into the record's `executor` and add `"site": "local"`. A candidate becomes `qualified` after 5 successful records with the same executor and task; until then it is `trial` and is never blocked.

## MCP server

Start command: `node <checkout>/bin/modelpace-mcp.mjs` (stdio; after an npm release: `npx -y -p modelpace modelpace-mcp`, because the package is `modelpace` and `modelpace-mcp` is only its second binary). Optional environment: `MODELPACE_AUTO=1`, `MODELPACE_CONFIG`, `MODELPACE_SCORES`, `MODELPACE_ORIGIN`, `MODELPACE_TOKEN`, `MODELPACE_SNAPSHOT`.

Register it with the client the user runs (use absolute paths):

```bash
# Claude Code
claude mcp add modelpace -- node /abs/path/modelpace/bin/modelpace-mcp.mjs
# Codex CLI
codex mcp add modelpace -- node /abs/path/modelpace/bin/modelpace-mcp.mjs
```

These leave quota access off (`dispatch_plan` then needs `snapshotPath` or `t3Origin`). Only after the user agrees to `--t3-auto`, add the variable: `claude mcp add modelpace -e MODELPACE_AUTO=1 -- node ...` or `codex mcp add modelpace --env MODELPACE_AUTO=1 -- node ...`.

Codex `~/.codex/config.toml` equivalent (the `env` table is the `--t3-auto` opt-in; leave it out until the user agrees):

```toml
[mcp_servers.modelpace]
command = "node"
args = ["/abs/path/modelpace/bin/modelpace-mcp.mjs"]

[mcp_servers.modelpace.env]
MODELPACE_AUTO = "1"
```

Any other MCP client: `{ "mcpServers": { "modelpace": { "command": "node", "args": ["/abs/path/modelpace/bin/modelpace-mcp.mjs"] } } }` (add `"env": { "MODELPACE_AUTO": "1" }` with the user's agreement).

Inside T3 Code there is no separate MCP setting for this: T3 Code starts Claude and Codex itself, and per the T3 Code source it loads Claude's user, project and local settings and Codex's `config.toml` (unless a provider instance is given its own home directory), so the registrations above are picked up. This was read from the source, not run; if the tools do not appear in a T3 Code session, check that instance's home setting.

| Tool | Arguments (all optional unless marked) | Returns |
| --- | --- | --- |
| `dispatch_plan` | `task`, `tier`, `slot`, `waitMinutes`, `claudeModel`, `configPath`, `scoresPath`, `t3Auto`, `t3Origin`, `snapshotPath`, `snapshot`, `budgetPath`, `includeSpeed`, `speedMetrics`, `days` | The plan object above |
| `dispatch_record` | `record` (required), `scoresPath`, `configPath` | `{ file, identity, task }` |
| `dispatch_scores` | `scoresPath`, `configPath` | Cells with pass rate, 90% interval, median duration, cost; ranking per task |
| `dispatch_speed` | `days`, `scoresPath`, `configPath` | `{ days, ranking, metrics, sources, warnings }` |

Failures come back as a tool result with `isError: true` and a message that says what to change.

## Data and privacy

- Network: only the T3 origin you give (`--t3-origin`) or the local T3 Code server found by `--t3-auto`. No telemetry.
- `--t3-auto` (or `MODELPACE_AUTO=1`) runs the local T3 CLI: `t3 auth session issue --scope orchestration:read --ttl 2m --label modelpace`, reads `server.getConfig`, then revokes the session. The token can only read orchestration state, not open terminals or write files, and lives at most 2 minutes. It is on only when you pass the flag or variable; ask the user before first use, or avoid it with `--snapshot FILE` or `--t3-origin URL` plus `MODELPACE_TOKEN`. Each `plan` issues one session; `serve --t3-auto` issues one every 15 seconds.
- Local files read: the config, snapshot and budget files you pass; the ledger; and, only for `speed`, `dashboard`, `serve`, `plan --speed-scan` and `includeSpeed`, session logs for timestamps, model names and token counts (`~/.claude/projects`, `~/.codex/sessions`, the OpenCode database, `~/.gemini/antigravity`; override with `MODELPACE_CLAUDE_DIR`, `MODELPACE_CODEX_DIR`, `MODELPACE_OPENCODE_DB`, `MODELPACE_ANTIGRAVITY_PATHS`).
- Local files written: the ledger (default `$XDG_DATA_HOME/modelpace/scores.jsonl`, i.e. `~/.local/share/modelpace/scores.jsonl`; `%LOCALAPPDATA%\modelpace\scores.jsonl` on Windows; mode 0600) and the speed cache (`~/.cache/modelpace/speed-cache.json`). Missing directories are created with mode 0700; existing ones are left alone.
- Credential files are never read. Prefer `MODELPACE_TOKEN` or `--t3-token-cmd` over `--t3-token`, which shows in the process list.

## Troubleshooting

| Message or symptom | Cause and fix |
| --- | --- |
| `Action: refresh` with `Snapshot is stale (age 133.5m)` | A saved snapshot is older than 15 minutes. Use `--t3-auto`, or add `--now <time near observedAt>` when replaying. |
| `Blocked <candidate> (unknown): Instance not found in snapshot.` | The config's `instanceId` does not exist in T3. Compare with the `instances` keys of the snapshot (`modelpace plan --format json` lists candidates), fix the config or use the built-in policy. |
| `plan needs a usage source: ...` | No quota source given. Add `--t3-auto`, `--t3-origin URL` with a token, or `--snapshot FILE`. |
| `Local T3 Code CLI not found (set MODELPACE_T3_BIN, or put t3 on PATH)` | `--t3-auto` cannot find the `t3` CLI. Set `MODELPACE_T3_BIN` to its path or add it to `PATH`. |
| `No running local T3 Code server found (start T3 Code, or pass an origin)` | T3 Code is not running (or `T3CODE_HOME` differs). Start it, or pass `--t3-origin`. |
| `Failed to issue a temporary T3 session via the local T3 CLI` | The `t3 auth session issue` call failed. Run it by hand to see why; an older T3 CLI may not support `--scope`. |
| `Failed to obtain WebSocket ticket` | The origin or token was rejected. Check the URL and that the token is current. |
| `Invalid dispatch record: missing record.<field>` | Records need all fifteen fields. Start from `examples/record.example.json`. |
| Candidate stays `trial` after recording | The record's `executor` differs from the plan's identity. Compare `recommended.scoreIdentity` with the identity printed by `scores`; copy `recommended.executor` exactly. |
| `Unknown dispatch slot "x"` / `Invalid tier "x"` | The name is not in the config. The message lists the valid values; omit `--slot` / `--tier` to use defaults. |
| `Cannot read FILE: ENOENT` | Wrong path. `modelpace init --out FILE` creates a config. |

## Developing this repository

- Pure Node.js ESM, zero runtime dependencies: only `node:*` built-ins, global `fetch` and `WebSocket`.
- Tests: `node --test test/*.test.mjs` (Node 22 or newer). A new behavior needs a test that fails without it. Commands in this file and in the READMEs that are preceded by `<!-- docs-test -->` are executed by `test/docs-commands.test.mjs`, so keep them runnable.
- Docs and CLI help are in English; `README.zh-CN.md` mirrors the README.
- Never commit credentials, tokens, personal paths or data from a real ledger or session logs.
