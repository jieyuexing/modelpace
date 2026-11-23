# Changelog

## 0.1.0

First public release.

- `plan`: quota-gated dispatch recommendation with Even Pace, reset credits and quality × speed ranking; `--now ISO` replays a saved snapshot at a fixed instant.
- Built-in default policy for official T3 Code instance ids (`codex`, `claudeAgent`, `antigravity`); multi-account setups live in `examples/multi-account.config.json`.
- `record` / `scores`: JSONL acceptance ledger with Beta posterior pass rates; `plan` returns a ready-to-copy `recommended.executor`. Default ledger: `$XDG_DATA_HOME/t3-dispatch/scores.jsonl`.
- `speed` / `dashboard` / `serve`: local Speed leaderboard from session logs and a self-contained HTML dashboard.
- `--t3-auto`: reads quota from the local T3 Code through a 2-minute `orchestration:read` session that is always revoked.
- Zero-dependency MCP server (`t3-dispatch-mcp`) with `dispatch_plan`, `dispatch_record`, `dispatch_scores`, `dispatch_speed`.
- Agent entry points: `AGENTS.md` (install, validate/plan/record loop, MCP setup for Claude Code and Codex, privacy, troubleshooting), `llms.txt`, an Agent Skills `SKILL.md`, `examples/record.example.json`, MCP tool descriptions written for agents, and fix hints in CLI errors and `plan` reasons. Commands marked `<!-- docs-test -->` in the docs are executed by the tests.
- Experimental Agent Plugins package in `plugin/` (repository only, not in the npm package).
