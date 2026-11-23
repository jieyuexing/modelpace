# Contributing

Issues and pull requests are welcome.

- Node.js 22 or newer. The project has no runtime dependencies and should stay that way: use `node:*` built-ins, global `fetch` and `WebSocket`.
- Run the tests with `node --test test/*.test.mjs`. New behavior needs a test that fails without the change.
- Runnable commands in `AGENTS.md` and the READMEs are marked with `<!-- docs-test -->` (optionally `expect: TEXT`) right above the fenced `bash` block; `test/docs-commands.test.mjs` runs them against a fixture directory, so update the docs and the code together.
- Keep changes small and the code simple. Public documentation and CLI help are in English; `README.zh-CN.md` mirrors the README.
- Do not commit credentials, tokens, personal paths or data from your own ledger or session logs.
