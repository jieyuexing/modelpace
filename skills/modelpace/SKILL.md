---
name: modelpace
description: Choose which T3 Code provider instance and model should take a delegated task, using live quota pacing and past acceptance records, and record the verified outcome afterwards. Use before calling delegate_task when more than one provider/model could take the work or quota may be tight, and after independently verifying a delegated result. Triggers on requests such as "which model should run this", "dispatch this task", "check my quota before delegating", "record this result", "which model passes more often".
license: MIT
compatibility: Needs Node.js 22+ and the modelpace CLI or its MCP server (dispatch_plan, dispatch_record, dispatch_scores, dispatch_speed). Live quota needs a running T3 Code; replaying a saved snapshot works offline.
---

# modelpace

`modelpace` recommends a `delegate_task` target; it never starts work itself. `modelpace` below is `node <checkout>/bin/modelpace.mjs` or `npx modelpace`; each CLI command has an MCP tool of the same purpose (`dispatch_plan`, `dispatch_record`, `dispatch_scores`, `dispatch_speed`). Full setup, privacy notes and troubleshooting: [AGENTS.md](../../AGENTS.md). Field reference: [docs/SCHEMA.md](../../docs/SCHEMA.md).

## 1. Plan before dispatching

```bash
modelpace plan --t3-auto --task slice --format json
```

- `--task`: `general` | `research` | `review` | `slice` (bounded implementation piece) | `long` (large or hard work). It selects the slot through the config.
- Optional: `--tier T` (permission tier from the config; omit to skip tier gating), `--wait-minutes N` (willing to wait for a reset), `--speed-scan` (break ties by measured tok/s).
- `--t3-auto` issues a 2-minute `orchestration:read` session on the local T3 Code and revokes it. If the user has not agreed to that, use `--snapshot FILE` or `--t3-origin URL` instead.
- Without `--config` the built-in policy for the official instances `codex`, `claudeAgent`, `antigravity` is used.

Act on `action`:

| `action` | What to do |
| --- | --- |
| `run` | Pass `recommended.target` (`{ providerInstanceId, model, options }`) to `delegate_task` unchanged. Keep `recommended.executor` for step 2. |
| `wait` | Retry at `waitUntil` or dispatch elsewhere. |
| `redeem` | Ask the user to redeem the credit in `redeemCandidate`, then plan again. |
| `refresh` | Quota data is missing or stale: re-run with `--t3-auto` or `--t3-origin`; when replaying a file add `--now` close to its `observedAt`. |
| `pause` | Every candidate is blocked: read `reasons`, retry at `nextCheckAt`, or tell the user. |

## 2. Record after independent verification

Record only after you verified the delegated result yourself (tests, diff, or the user's explicit acceptance), never on the sub-agent's own report.

The `executor` in the record must be the identity the plan used, otherwise the record never counts. Copy `provider`, `model`, `effort` and `tier` from `recommended.executor` and add your own `site` label. Do not use the `--tier` permission tier here: the record's `tier` is the candidate's service tier (`default` unless the config sets `scoreTier`/`serviceTier`).

```json
{
  "date": "2026-11-23",
  "taskId": "task-123",
  "title": "Add retry to the sync job",
  "task": "slice",
  "executor": {
    "provider": "codex",
    "model": "gpt-5.3-codex",
    "effort": "high",
    "tier": "default",
    "site": "local"
  },
  "scorer": "orchestrator",
  "accepted": true,
  "firstPass": true,
  "reworkRounds": 0,
  "scopeViolation": false,
  "falseReport": false,
  "stoppedOnDenial": null,
  "durationMin": 4.2,
  "quotaDelta": 3,
  "note": "Verified with unit tests."
}
```

Save it as `record.json` (the same content ships as `examples/record.example.json`) and run:

```bash
modelpace record --json record.json
```

All fifteen fields are required; a rejected record names the missing or wrong field. Judge honestly: `accepted` is whether the result was accepted after your verification, `firstPass` means no rework, `falseReport` means the executor claimed success that verification contradicted.

A candidate becomes `qualified` after 5 successful records for the same executor and task (success: accepted, no false report, no scope violation, at most one rework round). Until then it is `trial` and still eligible.

## 3. Review rankings and speed

```bash
modelpace scores
modelpace speed --days 30
```

`scores` shows pass rate with a 90% interval, sample count, median duration and cost per executor and task. `speed` ranks models by tok/s measured from local session logs; rows marked `lowSample` (fewer than 20 long requests) are not used as tie-breakers. For a visual overview run `modelpace dashboard --t3-auto --out dashboard.html` and render the file with `html_render`.
