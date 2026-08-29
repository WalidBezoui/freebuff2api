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
1. **Session Creation Quota**: Free-tier Codebuff accounts get a base entitlement of **6 new session creations per Pacific day** (README §额度; resets at `00:00 Pacific Time` / `07:00 UTC` / 北京 15:00). A single burst limiter additionally caps rapid creation (`429 Rate Limited (recentCount: 1.2 > limit: 1)`) — do not fire several `POST /session` in a row.
2. **Quota Debits on Creation**: quota is consumed per **session creation**, not per turn — one session is valid ~1 hour and supports unlimited turns inside it. Reuse cached sessions (`sessCache`) to avoid burning daily creation quota.
3. **US IP vs. Account Tier**:
   - The US egress IP (via Vercel in Washington D.C.) bypasses the geographic block (`country_not_allowed`).
   - The US IP does **not** grant paid Pro status to free accounts; the daily creation quota still applies.
4. **Multi-Account Pooling**:
   - The proxy supports pooling multiple accounts via `FREEBUFF_TOKEN` (comma- or newline-separated).
   - `worker.js` automatically rotates and load-balances across available tokens, and cooldowns/quarantines exhausted accounts.
5. **Upstream Override**: set `CODEBUFF_API` env to point all upstream calls at a relay instead of the default `https://www.codebuff.com` (resolved per-request in `fetch()`).

---

## 2. Testing Guidelines for AI Agents (CRITICAL)

### Rule 1: Always Run Offline Mock Tests (`npm test`)
- Run `npm test` (`node --check worker.js` + `scripts/check-fixtures.mjs` + `scripts/test-tools.mjs` + `scripts/test-codex-replay.mjs` + `scripts/test-security.mjs` + fixture pre-check).
- `npm test` runs **200+ tests completely offline** against local mock fixtures in a few seconds. Count grows as tests are added — never treat the number as fixed; run the suite, don't count it.
- It tests tool parsing, DSML extraction, V8 isolate wrapping, error propagation, Claude Code compatibility, all 11 committed Codex capture fixtures, auth fail-closed, input caps, and body/healthz scrubbing without consuming any upstream quota.

### Rule 2: DO NOT Spam `npm run test:live` / `scripts/test-live.mjs`
- `scripts/test-live.mjs` tests multiple different models in rapid succession against the live upstream.
- Firing multiple `POST /session` creation calls in seconds burns the daily session creation quota on active accounts and triggers `429 Rate Limited (recentCount: 1.2 > limit: 1)`.
- Only run live tests when explicitly requested by the user, and prefer single-command smoke tests with `deepseek/deepseek-v4-flash`.
- `test-live.mjs` refuses to run unless `ALLOW_LIVE=1` **and** `FREEBUFF_API_KEY` are set (CI sets `ALLOW_LIVE=0`, so CI can never hit the live upstream).

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
   - Mid-stream upstream errors must emit `response.failed` and an error chunk, never faking a successful `completed` response. This also applies to the **non-sanitize** chat path (error chunk must precede `[DONE]`).
6. **Input Caps (`readJsonBody`/`bodyCapsViolation`)**:
   - Body ≤10MiB (else `413`), messages/input ≤4096 (else `400`), tools ≤128, image payload ≤10MiB (else `400`).
   - Caps must NEVER be set to low artificial numbers (e.g. 256 messages) which break long agent trajectories, multi-step tool sessions, and Codex compaction. Overrides available via env: `FREEBUFF_MAX_BODY_BYTES`, `FREEBUFF_MAX_MESSAGES`, `FREEBUFF_MAX_TOOLS`.
7. **Session Hygiene**:
   - `createSession` dedups in-flight creations per isolate (`pendingSessions`); never DELETE another model's active session on GET-reuse (supersede naturally instead).
   - Session recovery (empty stream / stale 428-409-502) must also invalidate `runCache` — run_id is bound to the session.
   - Non-stream empty 200 responses throw `EmptyUpstreamStreamError` → same-model session recreate + one retry (never a fake empty success).
8. **StreamingXmlFilter (F1/F2)**:
   - F1: literal-comparison char class must **not** include `/` (`/\s|\d|[=+\-*]/`), else `</tag>` leaks as text.
   - F2: suppression is a **name-aware stack** (`suppressStack`), not a depth counter — mismatched closing tags must not shift state.
9. **Responses Reasoning (`reasoning_item`)**:
   - Reasoning is a real `reasoning` output item; the spec event is `response.reasoning_summary_text.delta` (not `response.reasoning_summary.delta`), with `output_item.added`/`content_part.added` before it and `.done`/`content_part.done`/`output_item.done` at the end.

---

## 4. Client Authentication & Diagnostic Invariants

1. **401 Unauthorized Diagnosis (Local Proxy vs. Upstream)**:
   - Any error with `401 Unauthorized: Invalid API key — ensure client sends Authorization: Bearer <FREEBUFF_API_KEY>...` is generated **locally by `worker.js` auth gate**, NOT upstream Codebuff.
   - Codebuff never receives rejected 401 requests. A 401 error is an authentication misconfiguration between the client (Codex/Claude) and the proxy, **never** an upstream account ban or detection.
2. **Codex CLI Configuration (`~/.codex/config.toml`)**:
   - For custom providers with `wire_api = "responses"`, specify `env_key = "FREEBUFF_API_KEY"`.
   - Ensure `$env:FREEBUFF_API_KEY` is set in the environment so Codex attaches the bearer token.
3. **Batch Launcher Invariant**:
   - All batch files (`4-Launch-Codex.bat`, `5-Launch-Codex-GUI.bat`, `6-Launch-Claude-Code.bat`) must include:
     `if "%FREEBUFF_API_KEY%"=="" set FREEBUFF_API_KEY=freebuff-default-key`
     to guarantee that double-clicking launcher scripts always passes authentication.
