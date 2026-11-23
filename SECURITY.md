# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's "Report a vulnerability" button on the repository's Security tab (private vulnerability reporting), not in a public issue. Include the version, a description and, if possible, a reproduction. You can expect an acknowledgement within a week.

## What t3-dispatch touches

- It connects only to the T3 Code origin you configure (or the local server found by `--t3-auto`); there is no telemetry.
- `--t3-auto` asks the local T3 CLI for a 2-minute session limited to `orchestration:read` and revokes it afterwards. It never reads credential or auth cache files.
- It reads session logs of local agent tools for timestamps, model names and token counts, and writes only the speed cache and the acceptance ledger (mode 0600).
- Prefer `T3_DISPATCH_TOKEN` or `--t3-token-cmd` over `--t3-token`, which is visible in the process list.

## Supported versions

Only the latest release receives fixes.
