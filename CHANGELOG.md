# Changelog

## Unreleased

- `record` and MCP `dispatch_record` accept optional `executedModel` (`string | null`, e.g. from `task_status`). On write, non-empty `executedModel` and `executor.model` are normalized via `scoring.aliases.model`; mismatches still append the record and return a warning (in CLI text output, CLI `record --format json`, and `dispatch_record` `warnings[]`) advising to set `executor.model` to the model that actually ran.
- Documented multi-lane dispatch usage (`plan` per lane, log actual `provider`/`model`/`effort`, `record` per verified lane with `executedModel`) and unattended quota stop lines (`weeklyMinRemainingPercent`, `defaultMinRemainingPercent`, `longTaskMinRemainingPercent`, stop on `pause`, user-decided paid credits) across `SKILL.md`, `AGENTS.md`, `README.md`, `README.zh-CN.md`, and `docs/SCHEMA.md`.
- `plan` ranks qualified candidates by duration bands anchored at the fastest median, so the recommendation no longer depends on the order candidates are listed in the config. Before, near-tie durations were compared pair by pair (10 vs 11 vs 12 minutes: each neighbour a tie, the ends not), which together with the speed tie-breaker formed a cycle.
- `plan` only suggests redeeming a reset credit (`redeem`, or running below the floor as `credit_low`) when the usable credits cover every blocking window. Before, a credit that covered one of two exhausted windows was suggested, and redeeming it left the candidate blocked.
- MCP `dispatch_scores` no longer returns the raw ledger records next to the summary. With a few hundred records the result grew past what an MCP client accepts in one tool result; `modelpace scores --format json` still prints them.
- The dashboard no longer shows instances that are disabled in the policy (`enabled: false`) or in the snapshot: their quota cards, pool entries and decision-audit rows are hidden, matching `plan`, which already skips them.
- Test fix: the MCP subprocess tests now kill the server in `finally`, so a failing assertion no longer leaves `node --test test/cli-mcp.test.mjs` hanging.

## 0.1.0

First public release (renamed from `t3-dispatch` to `modelpace`).

- `plan`: quota-gated dispatch recommendation with Even Pace, reset credits and quality × speed ranking; `--now ISO` replays a saved snapshot at a fixed instant.
- Built-in default policy for official T3 Code instance ids (`codex`, `claudeAgent`, `antigravity`); multi-account setups live in `examples/multi-account.config.json`.
- `record` / `scores`: JSONL acceptance ledger with Beta posterior pass rates; `plan` returns a ready-to-copy `recommended.executor`. Default ledger: `$XDG_DATA_HOME/modelpace/scores.jsonl`.
- `speed` / `dashboard` / `serve`: local Speed leaderboard from session logs and a self-contained HTML dashboard.
- `--t3-auto`: reads quota from the local T3 Code through a 2-minute `orchestration:read` session that is always revoked.
- Zero-dependency MCP server (`modelpace-mcp`) with `dispatch_plan`, `dispatch_record`, `dispatch_scores`, `dispatch_speed`.
- Agent entry points: `AGENTS.md` (install, validate/plan/record loop, MCP setup for Claude Code and Codex, privacy, troubleshooting), `llms.txt`, an Agent Skills `SKILL.md`, `examples/record.example.json`, MCP tool descriptions written for agents, and fix hints in CLI errors and `plan` reasons. Commands marked `<!-- docs-test -->` in the docs are executed by the tests.
- Experimental Agent Plugins package in `plugin/` (repository only, not in the npm package).
