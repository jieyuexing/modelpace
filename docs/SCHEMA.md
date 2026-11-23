# Schema reference

t3-dispatch reads three JSON shapes: the **config** (your policy), the **record** (one acceptance outcome per line in the ledger) and the **snapshot** (the quota state `plan` decides on). `t3-dispatch validate --config FILE` checks a config; every record is validated when it is written and read.

Working examples: [`examples/multi-account.config.json`](../examples/multi-account.config.json), [`examples/sample-snapshot.json`](../examples/sample-snapshot.json) and [`examples/multi-account.snapshot.json`](../examples/multi-account.snapshot.json).

## Config (`dispatch.config.json`, `schemaVersion: 2`)

Without `--config` (or `T3_DISPATCH_CONFIG`) the built-in default policy is used: the official T3 Code default instance ids `codex`, `claudeAgent` and `antigravity`, one instance per driver. `t3-dispatch init` prints it as a starting point.

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | `2` | Optional; any other value is rejected. |
| `tiers` | string[] | Permission/sensitivity tiers you can ask for with `--tier` (default `work`, `personal`, `public`). |
| `defaultTier` | string \| null | Tier used when the request has none; must be listed in `tiers`. |
| `taskToSlot` | object | Maps a task (`general`, `research`, `review`, `slice`, `long`) to a slot name. |
| `instances` | object | Per T3 provider-instance policy, keyed by instance id (see below). |
| `slots` | object | **Required**, at least one. `slots.<name>.candidates` is an ordered array of candidates (see below). |
| `pacing` | object | Even Pace and freshness thresholds (see below). |
| `scoring` | object | Acceptance-score settings (see below). |

### `instances.<instanceId>`

The key is the T3 provider instance id (official defaults equal the driver name, for example `codex`, `claudeAgent`, `antigravity`; extra accounts get ids you chose in T3 Code).

| Field | Type | Meaning |
| --- | --- | --- |
| `driver` | string | T3 driver kind. Used when the snapshot does not carry one. |
| `enabled` | boolean | `false` disables every candidate on this instance. |
| `tiers` | string[] | Tiers allowed on this instance; omit for all. |
| `tasks` | string[] | Tasks allowed on this instance; omit for all. |
| `shortWindowMaxUsedPercent` | 0..100 | Skip when a short (session) window is used beyond this. |
| `weeklyMinRemainingPercent` | 0..100 | Floor for the weekly window's effective remaining percent. |
| `scoreProvider` | string | Provider name used in the score identity. Defaults to the driver, then the instance id. |

### `slots.<name>.candidates[]`

Candidates are tried in `priority` order (default: array order). Each one targets one model on one instance.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Unique within the slot; defaults to `instanceId:model:index`. |
| `instanceId` | string | **Required.** Must match an instance id in the snapshot. |
| `model` | string | **Required.** Model slug passed to `delegate_task`. |
| `effort` | string | Effort label, part of the score identity (default `default`). |
| `options` | object | Passed through into `recommended.target.options`, for example `{ "reasoningEffort": "high" }`. |
| `pool` | string | Quota pool for drivers that split windows per model family (Antigravity: `gemini`, `carbon`, `argon`). |
| `priority` | number | Lower runs first among equally qualified candidates. |
| `tiers`, `tasks` | string[] | Restrict the candidate to these tiers / tasks. |
| `maxShortUsedPercent`, `minRemainingPercent` | 0..100 | Per-candidate overrides of the instance thresholds. |
| `scoreTier` / `serviceTier` | string | The **service tier** in the score identity (default `default`). Not the permission tier. |
| `allowRedeem` | boolean | `false` stops `plan` from suggesting a reset credit for this candidate. |
| `enabled` | boolean | `false` skips the candidate. |

### `pacing`

| Field | Default | Meaning |
| --- | --- | --- |
| `paceMarginPercent` | 10 | A long window may be this far behind Even Pace before it blocks (> 0). |
| `longTaskMinRemainingPercent` | 30 | Minimum effective remaining percent for `long` tasks. |
| `defaultMinRemainingPercent` | 20 | Minimum for every other task. |
| `shortWindowMaxUsedPercent` | 90 | Default short-window cap. |
| `recheckAfterMinutes` | 15 | Gap used for `nextCheckAt`. |
| `maxSnapshotAgeMinutes` | 15 | A snapshot (or instance `checkedAt`) older than this yields `refresh`. |
| `resetCredit.skipIfResetWithinHours` / `expiryWarnHours` | 6 / 72 | Reset-credit handling. |
| `expiringBoost` | see source | Prefer quota that resets soon; `null` disables it. |

### `scoring`

| Field | Default | Meaning |
| --- | --- | --- |
| `mode` | `demote` | `demote`, `strict` (drop) or `advisory` (warn) for candidates below the pass rate. |
| `minPassRate` | 0.85 | Lower bound of the pass rate to count as `qualified`. |
| `minSamples` | 5 | Records needed in a cell (identity × task) before it counts. |
| `speedTieBreakerMarginRatio` | 0.15 | Median durations within this ratio count as a tie. |
| `aliases` | `provider: { claudeAgent: claude }`, `tier: { "-": default }` | Maps spellings to one identity; `model` and `effort` aliases are allowed too. |
| `durationUnreadableProviders` | `[]` | Providers whose records may have `durationMin: null`. |
| `rejectRules`, `disabledProviders` | `[]` | Reject records matching `{ providerIn, providerNotIn, siteContains, modelIn, tierIn, reason }`. |
| `pricing` | `{ currency: "USD", ... }` | `monthlyPrice` per score provider, used for nominal cost per run. |

## Record (one JSON object per ledger line)

The ledger is JSONL at `--scores FILE`, `T3_DISPATCH_SCORES`, or by default `$XDG_DATA_HOME/t3-dispatch/scores.jsonl` (`~/.local/share/t3-dispatch/scores.jsonl`; `%LOCALAPPDATA%\t3-dispatch\scores.jsonl` on Windows). All fifteen fields are required and unknown fields are rejected.

| Field | Type | Meaning |
| --- | --- | --- |
| `date` | `YYYY-MM-DD` | Calendar date of the work. |
| `taskId` | string \| null | Your id for the task. |
| `title` | string | Short summary. |
| `task` | enum | `general`, `research`, `review`, `slice` or `long`. |
| `executor` | object | Who did it; see below. |
| `scorer` | string | Who judged it (for example `orchestrator`, `user`). |
| `accepted` | boolean | Whether the result was accepted after independent verification. |
| `firstPass` | boolean | Accepted without rework. |
| `reworkRounds` | integer ≥ 0 | Rework rounds before acceptance. |
| `scopeViolation` | boolean | The executor touched things outside its brief. |
| `falseReport` | boolean | The executor reported success that verification contradicted. |
| `stoppedOnDenial` | boolean \| null | `true`/`false` when a permission denial happened; `null` when none. |
| `durationMin` | number \| null | Wall minutes; `null` only for providers in `durationUnreadableProviders`. |
| `quotaDelta` | number \| null | Percentage points of quota the run consumed. |
| `note` | string | Free text, may be empty. |

A record counts as a **success** when `accepted`, no `falseReport`, no `scopeViolation`, `stoppedOnDenial` is not `false`, and `reworkRounds <= 1`.

### `executor` and the score identity

`executor` has five required string tokens (no whitespace, no `/`): `provider`, `model`, `effort`, `tier`, `site`. The first four form the **score identity** `provider/model/effort/tier`, after `scoring.aliases` are applied. `site` is a free label (for example `local`) used by `rejectRules`.

`plan` computes the same identity for every candidate and looks up the cell for the requested task:

- `provider` = the instance's `scoreProvider`, else its driver, else the instance id;
- `model`, `effort` = the candidate's `model` and `effort`;
- `tier` = the candidate's `scoreTier`, else `serviceTier`, else `default` (this is not the `--tier` permission tier).

`decision.recommended.executor` carries exactly these four values: copy them into the record and add a `site`.

```json
{
  "date": "2026-11-23",
  "taskId": "task-123",
  "title": "Add retry to the sync job",
  "task": "slice",
  "executor": { "provider": "codex", "model": "gpt-5.3-codex", "effort": "high", "tier": "default", "site": "local" },
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

## Snapshot (`schemaVersion: 2`)

`plan --snapshot FILE|-` accepts this shape, a raw T3 `server.getConfig` response, or what `--t3-auto` / `--t3-origin` fetch live (which are converted to this shape). Timestamps are ISO 8601 strings.

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | `2` | Required for this shape. |
| `observedAt` | timestamp | When the snapshot was taken. |
| `source` | string | Free label (`json`, `t3-rpc`, ...). |
| `instances` | object | Keyed by instance id (the ids your config's candidates refer to). |

### `instances.<instanceId>`

| Field | Meaning |
| --- | --- |
| `instanceId`, `driver`, `displayName` | Identity; `driver` defaults to the key. |
| `enabled`, `status` | `enabled: false` and the statuses `disabled`, `unavailable` and `not_applicable` block the candidate; `ready` is the normal state. |
| `plan` | Subscription plan label. |
| `checkedAt` | When this provider's usage was last read; compared with `pacing.maxSnapshotAgeMinutes`. |
| `models` | Optional list of model slugs. |
| `windows[]` | Quota windows (below). |
| `resetCredits` | `{ known, availableCount, nextExpiresAt, cards[] }`; a card has `creditId`, `resetType` (`claudeSession`, `claudeWeekly`, `claudeFable`, `claudeFull`, `codexRateLimits`, `custom`), `status`, `resetsLeft`, `coversWindowIds`, `coversWindowPrefixes`, `expiresAt`. |
| `budget` | Pay-as-you-go balance `{ spent, budget, balance, isAvailable, currency, month, resetsAt }`, or `null`. |

### `windows[]`

| Field | Meaning |
| --- | --- |
| `id`, `kind`, `label` | `kind` is `session` (short window) or `weekly` (long window). |
| `usedPercent` / `remainingPercent` | One of them is enough; they must add up to 100 (±1). |
| `resetsAt` | When the window resets. |
| `windowDurationMins` | Window length; with `resetsAt` it gives the Even Pace line. |
| `pool` | Model-family pool (`gemini`, `carbon`, `argon`, ...) or `null`. |
| `modelIds`, `providerIds` | Optional restriction of the window to models/providers, or `null`. |
