/**
 * Phase 1 security tests: auth fail-closed, input caps, unknown-model 400, healthz scrub.
 * No network. Run: node scripts/test-security.mjs
 */
import worker from "../worker.js";

let suiteTimer = setTimeout(() => { console.error("SUITE TIMEOUT 30s"); process.exit(1); }, 30000);
if (suiteTimer.unref) suiteTimer.unref();

const TOKEN = "tok_mock_123456789";
const KEY = "sk-test-key-123";
const ENV = { FREEBUFF_TOKEN: TOKEN, FREEBUFF_API_KEY: KEY, FREEBUFF_DEBUG: "false" };
const AUTH = { "Content-Type": "application/json", Authorization: "Bearer " + KEY };

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: cond ? "" : (detail || "") });
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (cond ? "" : "  -> " + (detail || "")));
}

const authHdr = (h) => new Headers({ "Content-Type": "application/json", ...h });

// ---------- S1: auth fail-closed ----------
{
  const req = new Request("https://localhost/v1/models", { method: "GET", headers: authHdr({}) });
  const res = await worker.fetch(req, ENV);
  check("S1 no key -> 401", res.status === 401, "status=" + res.status);
}

{
  const req = new Request("https://localhost/v1/models", { method: "GET", headers: authHdr({ Authorization: "Bearer wrong-key" }) });
  const res = await worker.fetch(req, ENV);
  check("S1 wrong key -> 401", res.status === 401, "status=" + res.status);
}

{
  const req = new Request("https://localhost/v1/models", { method: "GET", headers: authHdr({ Authorization: "bearer " + KEY }) });
  const res = await worker.fetch(req, ENV);
  check("S1 lowercase 'bearer' accepted (case-insensitive)", res.status === 200, "status=" + res.status);
}

{
  const req = new Request("https://localhost/v1/models", { method: "GET", headers: authHdr({ "x-api-key": KEY }) });
  const res = await worker.fetch(req, ENV);
  check("S1 x-api-key header accepted", res.status === 200, "status=" + res.status);
}

// env with no key set at all -> fail closed
{
  const noKeyEnv = { FREEBUFF_TOKEN: TOKEN, FREEBUFF_API_KEY: "", FREEBUFF_DEBUG: "false" };
  const req = new Request("https://localhost/v1/models", { method: "GET", headers: authHdr({ Authorization: "Bearer whatever" }) });
  const res = await worker.fetch(req, noKeyEnv);
  check("S1 unset FREEBUFF_API_KEY -> 401 even with any key", res.status === 401, "status=" + res.status);
}

// ---------- S2: input caps ----------
const mkReq = (body, headers) => new Request("https://localhost/v1/chat/completions", { method: "POST", headers: authHdr({ ...AUTH, ...(headers || {}) }), body: JSON.stringify(body) });

{
  const big = "x".repeat(1024 * 1024 + 10);
  const res = await worker.fetch(mkReq({ model: "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: big }] }), ENV);
  check("S2 body > 1MiB -> 413", res.status === 413, "status=" + res.status);
}

{
  const messages = [];
  for (let i = 0; i < 300; i++) messages.push({ role: "user", content: "m" + i });
  const res = await worker.fetch(mkReq({ model: "deepseek/deepseek-v4-flash", messages }), ENV);
  check("S2 messages > 256 -> 400", res.status === 400, "status=" + res.status);
  const j = await res.json();
  check("S2 messages error message mentions limit", /messages exceeds limit/.test(j?.error?.message || ""), JSON.stringify(j).slice(0, 120));
}

{
  const tools = [];
  for (let i = 0; i < 40; i++) tools.push({ type: "function", function: { name: "t" + i, parameters: { type: "object", properties: {} } } });
  const res = await worker.fetch(mkReq({ model: "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "hi" }], tools }), ENV);
  check("S2 tools > 32 -> 400", res.status === 400, "status=" + res.status);
}

{
  const bigImg = "A".repeat(5 * 1024 * 1024 + 100);
  const res = await worker.fetch(mkReq({ model: "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64," + bigImg } }] }] }), ENV);
  // 5MiB+ base64 图片必然使整体请求体 > 1MiB → 先被 body cap(413) 拦截；两种拒绝方式都正确
  check("S2 oversized image rejected (400 or 413)", res.status === 400 || res.status === 413, "status=" + res.status);
}

{
  const res = await worker.fetch(mkReq({ model: "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] }), ENV);
  check("S2 normal small request passes caps (not 400/413)", res.status === 200 || res.status === 502, "status=" + res.status);
}

// invalid JSON -> 400
{
  const req = new Request("https://localhost/v1/chat/completions", { method: "POST", headers: authHdr(AUTH), body: "{oops" });
  const res = await worker.fetch(req, ENV);
  check("S2 invalid JSON -> 400", res.status === 400, "status=" + res.status);
}

// ---------- S3: unknown model -> 400 unsupported_model (no silent mimo fallback) ----------
{
  const res = await worker.fetch(mkReq({ model: "nonsense/model", messages: [{ role: "user", content: "hi" }] }), ENV);
  check("S3 unknown model -> 400", res.status === 400, "status=" + res.status);
  const j = await res.json();
  check("S3 error type unsupported_model", j?.error?.type === "unsupported_model", JSON.stringify(j).slice(0, 120));
}

// known model still resolves (200 or upstream 502 from mock-less fetch, but never 400 unsupported)
{
  const res = await worker.fetch(mkReq({ model: "mimo/mimo-v2.5", messages: [{ role: "user", content: "hi" }] }), ENV);
  check("S3 known model not 400", res.status !== 400, "status=" + res.status);
}

// ---------- S3-anth: Anthropic 路径未知模型 → 400（不再静默换成 mimo） ----------
const mkAnthReq = (path, body) => new Request("https://localhost" + path, { method: "POST", headers: authHdr(AUTH), body: JSON.stringify(body) });

{
  const res = await worker.fetch(mkAnthReq("/v1/messages", { model: "nonsense/model", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }), ENV);
  check("S3-anthropic unknown model -> 400", res.status === 400, "status=" + res.status);
  const j = await res.json();
  check("S3-anthropic unknown model message mentions not available", /not available/i.test(j?.error?.message || ""), JSON.stringify(j).slice(0, 120));
}

{
  const res = await worker.fetch(mkAnthReq("/v1/messages/count_tokens", { model: "nonsense/model", messages: [{ role: "user", content: "hi" }] }), ENV);
  check("S3-anthropic count_tokens unknown model -> 400", res.status === 400, "status=" + res.status);
}

{
  const res = await worker.fetch(mkAnthReq("/v1/messages", { model: "mimo/mimo-v2.5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }), ENV);
  check("S3-anthropic known model not 400", res.status !== 400, "status=" + res.status);
}

// ---------- S2-anth: count_tokens 补全请求结构上限（此前无任何 caps） ----------
{
  const messages = [];
  for (let i = 0; i < 300; i++) messages.push({ role: "user", content: "m" + i });
  const res = await worker.fetch(mkAnthReq("/v1/messages/count_tokens", { model: "mimo/mimo-v2.5", messages }), ENV);
  check("S2-anthropic count_tokens messages > 256 -> 400", res.status === 400, "status=" + res.status);
}

{
  const big = "x".repeat(1024 * 1024 + 10);
  const res = await worker.fetch(mkAnthReq("/v1/messages/count_tokens", { model: "mimo/mimo-v2.5", messages: [{ role: "user", content: big }] }), ENV);
  check("S2-anthropic count_tokens body > 1MiB -> 413", res.status === 413, "status=" + res.status);
}

// ---------- S4: healthz scrubs token prefixes ----------
{
  const req = new Request("https://localhost/healthz", { method: "GET" });
  const res = await worker.fetch(req, ENV);
  const j = await res.json();
  check("S4 healthz 200 unauth", res.status === 200, "status=" + res.status);
  const details = j?.account_details || [];
  check("S4 healthz token is stable index not prefix", details.every((d) => /^acct-\d+$/.test(d.token || "")), JSON.stringify(details).slice(0, 160));
  const raw = JSON.stringify(j);
  check("S4 healthz leaks no real token chars", !raw.includes(TOKEN.slice(0, 8)), "");
  check("S4 healthz has version", !!j.version, "version=" + j.version);
}

clearTimeout(suiteTimer);
const passed = results.filter((r) => r.ok).length;
console.log(`\n=== ${passed}/${results.length} passed ===`);
if (passed !== results.length) process.exit(1);