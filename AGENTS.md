# AGENTS.md — Development & Architecture Rules for AI Agents

This document contains critical architectural context, upstream quota constraints, and development guidelines for all AI agents working on `freebuff2api`.

---

## 1. Upstream Architecture & Session Entitlement Model

`freebuff2api` is a reverse proxy bridging OpenAI Codex CLI, OpenAI-compatible tools, and Anthropic Claude Code to Codebuff's upstream API.

### What is a "Session"?
- A **Session** (`POST /api/v1/freebuff/session`) is an upstream container allocated on Codebuff's cloud.
- **Inside an active session**, `deepseek/deepseek-v4-flash` has **unlimited messages and turns**.
- The proxy caches active sessions in `sessCache` (`${token}:${sessionModel}`) to reuse them across turns.

### Upstream Quotas & Limits
1. **Account Creation Quota**: Free-tier Codebuff accounts have a base entitlement of **1 new session creation per 24 hours** (Pacific Day, resets at `00:00 Pacific Time` / `07:00 UTC`).
2. **US IP vs. Account Tier**:
   - The US egress IP (via Vercel in Washington D.C.) bypasses the geographic block (`country_not_allowed`).
   - The US IP does **not** grant paid Pro status to free accounts. The 1-session/day creation rule still applies to free accounts.
3. **Multi-Account Pooling**:
   - The proxy supports pooling multiple accounts via `FREEBUFF_TOKEN` (comma- or newline-separated).
   - `worker.js` automatically rotates and load-balances across available tokens.

---

## 2. Testing Guidelines for AI Agents (CRITICAL)

### Rule 1: Always Run Offline Mock Tests (`npm test`)
- Run `npm test` (`scripts/test-tools.mjs` + `scripts/test-codex-replay.mjs`).
- `npm test` runs **131 tests completely offline** against local mock fixtures in <2 seconds.
- It tests tool parsing, DSML extraction, V8 isolate wrapping, error propagation, Claude Code compatibility, and auth without consuming any upstream quota.

### Rule 2: DO NOT Spam `npm run test:live` / `scripts/test-live.mjs`
- `scripts/test-live.mjs` tests multiple different models in rapid succession against the live upstream.
- Firing multiple `POST /session` creation calls in seconds burns the daily session creation quota on active accounts and triggers `429 Rate Limited (recentCount: 1.2 > limit: 1)`.
- Only run live tests when explicitly requested by the user, and prefer single-command smoke tests with `deepseek/deepseek-v4-flash`.

---

## 3. Wire Protocol & Implementation Invariants

1. **Codex Custom Tools (`exec` in V8 Isolate)**:
   - Codex CLI v0.147+ executes JavaScript inside an internal V8 isolate.
   - All shell executions must be wrapped in `text(...)`:
     `text(await tools.exec_command({ cmd: "..." }));`
   - If not wrapped in `text(...)`, successful commands (exit 0) silently discard output, while failed commands (exit 1) throw and surface errors.
2. **Tool Output Extraction (`extractToolOutputText`)**:
   - Tool results from clients can arrive as strings, objects (`stdout`, `stderr`, `formatted_output`), or arrays of parts.
   - Always use `extractToolOutputText` to extract clean human-readable stdout/stderr.
3. **Anthropic Claude Code (`preserveToolNames`)**:
   - Anthropic clients declare tools like `Bash`, `Write`, etc.
   - When handling `/v1/messages` (Claude Code), pass `{ preserveToolNames: true }` so client tool names are not rewritten to Codex `exec`.
4. **Strict Authentication Gate**:
   - `getApiKey` strictly validates `Authorization: Bearer <key>` against `FREEBUFF_API_KEY`.
   - Do not re-introduce fallback default key backdoors that accept unauthenticated requests.
5. **Streaming Ordering & Error Handling**:
   - `[DONE]` must always be emitted **last** after all synthesized tool calls, finish reasons, and usage metrics.
   - Mid-stream upstream errors must emit `response.failed` and an error chunk, never faking a successful `completed` response.
