# Claude Code Guidelines

Refer to [AGENTS.md](./AGENTS.md) for full architecture context, quota rules, and testing standards.

## Quick Summary for Claude
- Run offline tests with `npm test` (200+ tests, 0 quota used; don't trust a fixed count — rerun the suite).
- DO NOT run `scripts/test-live.mjs` repeatedly (burns daily upstream session creation limit); it refuses to run unless `ALLOW_LIVE=1` AND `FREEBUFF_API_KEY` are set.
- Inside an active session, `deepseek/deepseek-v4-flash` has unlimited turns.
- Preserves Claude tool names (`Bash`, `Write`, etc.) via `preserveToolNames: true`.
- Tool outputs are capped at 32 KB by default (`FREEBUFF_MAX_TOOL_OUTPUT`, 0 = unlimited) to keep long sessions in-context.
