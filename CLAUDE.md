# Claude Code Guidelines

Refer to [AGENTS.md](./AGENTS.md) for full architecture context, quota rules, and testing standards.

## Quick Summary for Claude
- Run offline tests with `npm test` (131 tests, 0 quota used).
- DO NOT run `scripts/test-live.mjs` repeatedly (burns daily upstream session creation limit).
- Inside an active session, `deepseek/deepseek-v4-flash` has unlimited turns.
- Preserves Claude tool names (`Bash`, `Write`, etc.) via `preserveToolNames: true`.
