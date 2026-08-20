/**
 * Mock end-to-end tests for tool-calling fixes (B1-B7, R1-R3).
 * No real network: globalThis.fetch is monkeypatched; upstream endpoints are faked.
 * Run: node scripts/test-tools.mjs
 */
import worker from "../worker.js";

const P = "\uFF5C\uFF5CDSML\uFF5C\uFF5C"; // ｜｜DSML｜｜ 上游真实前缀
const TOKEN = "tok_mock_123456789";
const MODEL = "deepseek/deepseek-v4-flash";
const ENV = { FREEBUFF_TOKEN: TOKEN, FREEBUFF_API_KEY: "freebuff-default-key", FREEBUFF_DEBUG: "false" };
const AUTH = { "Content-Type": "application/json", Authorization: "Bearer freebuff-default-key" };

const sessionBody = JSON.stringify({
  status: "active",
  instanceId: "inst_mock_1",
  model: MODEL,
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  remainingMs: 3600_000,
});

let upstreamChatBodies = [];
let currentStream = []; // canned upstream SSE payloads

function makeStream(chunks) {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    start(controller) {
      while (i < chunks.length) controller.enqueue(enc.encode("data: " + JSON.stringify(chunks[i++]) + "\n\n"));
      controller.close();
    },
  });
}

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = (init.method || "GET").toUpperCase();
  if (u.includes("/api/v1/freebuff/session")) {
    if (method === "DELETE") return new Response("{}", { status: 200 });
    return new Response(sessionBody, { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (u.includes("/api/v1/agent-runs")) {
    if (method === "POST") {
      const body = JSON.parse(init.body || "{}");
      if (body.action === "FINISH") return new Response("{}", { status: 200 });
      return new Response(JSON.stringify({ runId: "run_mock_" + Math.random().toString(36).slice(2, 8) }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 200 });
  }
  if (u.includes("/steps")) return new Response("{}", { status: 200 });
  if (u.includes("/api/v1/chat/completions")) {
    upstreamChatBodies.push({ url: u, method, body: JSON.parse(init.body || "{}") });
    return new Response(makeStream(currentStream), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }
  throw new Error("mock: unexpected upstream URL " + u);
};

async function readSSE(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", events = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.startsWith("data:")) {
        const p = line.slice(5).trim();
        if (p === "" || p === "[DONE]") continue;
        try { events.push(JSON.parse(p)); } catch {}
      }
    }
  }
  return events;
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: cond ? "" : (detail || "") });
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (cond ? "" : "  -> " + (detail || "")));
}

const chunk = (delta, extra = {}) => ({ choices: [{ index: 0, delta, finish_reason: null, ...extra }] });

function nativeExecStream(command) {
  return [
    { id: "cmpl-1", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta: { role: "assistant", content: "Let me check the directory." }, finish_reason: null }] },
    chunk({ tool_calls: [{ index: 0, id: "call_abc", type: "function", function: { name: "exec_command", arguments: "" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command }) } }] }),
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ];
}

const execTools = [{ type: "custom", name: "exec", description: "Run shell commands", input_schema: { type: "object", properties: { command: { type: "string" } } } }];
const textOf = (cmd) => `text(await tools.exec_command({ cmd: ${JSON.stringify(cmd)} }));`;

async function responsesStreamTest(chunks, tools = execTools, input = [{ role: "user", content: "list files" }]) {
  currentStream = chunks;
  upstreamChatBodies = [];
  const req = new Request("https://localhost/v1/responses", {
    method: "POST", headers: AUTH,
    body: JSON.stringify({ model: MODEL, input, tools, stream: true }),
  });
  const res = await worker.fetch(req, ENV);
  check("responses stream status 200", res.status === 200, "status=" + res.status);
  return readSSE(res);
}

// ---------- T1: responses stream, native exec_command -> custom_tool_call "exec" ----------
{
  const events = await responsesStreamTest(nativeExecStream("dir /b"));
  const toolItems = events.filter((e) => e.type === "response.output_item.added" && e.item.type === "custom_tool_call");
  check("T1 exactly one custom_tool_call added", toolItems.length === 1, JSON.stringify(toolItems.map((t) => t.item.name)));
  check("T1 live-added name is exec", toolItems[0]?.item.name === "exec", toolItems[0]?.item.name);
  const done = events.filter((e) => e.type === "response.custom_tool_call_input.done");
  check("T1 input wrapped in text(...)", done[0]?.input === textOf("dir /b"), done[0]?.input);
  const completed = events.find((e) => e.type === "response.completed");
  const outTool = completed?.response?.output?.find((o) => o.type === "custom_tool_call");
  check("T1 completed output has sanitized input", outTool?.input === textOf("dir /b"), JSON.stringify(outTool));
  const contentEvents = events.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta);
  check("T1 content clean (no XML)", contentEvents.join("").includes("Let me check the directory.") && !contentEvents.join("").includes("<"), contentEvents.join(""));
  check("T1 no DSML leakage anywhere", !JSON.stringify(events).includes("DSML"));
}

// ---------- T2: real ｜｜DSML｜｜ XML tool call ----------
{
  const dsml = `<${P}tool_calls><${P}invoke name="exec_command"><${P}parameter name="cmd">npm test</${P}parameter></${P}invoke></${P}tool_calls>`;
  const events = await responsesStreamTest([
    chunk({ role: "assistant", content: "I'll run the tests.\n" + dsml }),
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ]);
  const done = events.filter((e) => e.type === "response.custom_tool_call_input.done");
  check("T2 DSML parsed to exec npm test", done[0]?.input === textOf("npm test"), done[0]?.input);
  const contentEvents = events.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta);
  const all = JSON.stringify(events);
  check("T2 no DSML/XML leakage", !all.includes("DSML") && !all.includes("<"), "");
  check("T2 text kept", contentEvents.join("").includes("I'll run the tests."), contentEvents.join(""));
}

// ---------- T3: antml: format ----------
{
  const events = await responsesStreamTest([
    chunk({ role: "assistant", content: '<antml:invoke name="exec_command"><antml:parameter name="cmd">npm test</antml:parameter></antml:invoke>' }),
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ]);
  const done = events.filter((e) => e.type === "response.custom_tool_call_input.done");
  check("T3 antml parsed to exec npm test", done[0]?.input === textOf("npm test"), done[0]?.input);
  check("T3 no antml leakage", !JSON.stringify(events).includes("antml"));
}

// ---------- T4: empty command -> echo fallback ----------
{
  const events = await responsesStreamTest([
    chunk({ role: "assistant", content: `<${P}invoke name="exec_command"><${P}parameter name="cmd"></${P}parameter></${P}invoke>` }),
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ]);
  const done = events.filter((e) => e.type === "response.custom_tool_call_input.done");
  check("T4 empty command falls back to echo", done[0]?.input === `text(await tools.exec_command({ cmd: "echo ''" }));`, done[0]?.input);
}

// ---------- T5: non-stream chat keeps tool_calls + no DSML ----------
{
  currentStream = nativeExecStream("dir /b");
  upstreamChatBodies = [];
  const req = new Request("https://localhost/v1/chat/completions", {
    method: "POST", headers: AUTH,
    body: JSON.stringify({
      model: MODEL, stream: false,
      messages: [{ role: "user", content: "list files" }],
      tools: [{ type: "function", function: { name: "exec", parameters: { type: "object", properties: { command: { type: "string" } } } } }],
    }),
  });
  const res = await worker.fetch(req, ENV);
  const json = await res.json();
  const msg = json?.choices?.[0]?.message;
  check("T5 non-stream has tool_calls", Array.isArray(msg?.tool_calls) && msg.tool_calls.length === 1, JSON.stringify(msg));
  check("T5 tool name exec", msg?.tool_calls?.[0]?.function?.name === "exec", msg?.tool_calls?.[0]?.function?.name);
  check("T5 args wrapped", msg?.tool_calls?.[0]?.function?.arguments === textOf("dir /b"), msg?.tool_calls?.[0]?.function?.arguments);
  check("T5 content no XML", !String(msg?.content || "").includes("<"), msg?.content);
  check("T5 finish_reason tool_calls", json?.choices?.[0]?.finish_reason === "tool_calls", json?.choices?.[0]?.finish_reason);
}

// ---------- T6: chat stream sanitize (DSML content filtered, tool_calls emitted) ----------
{
  const dsml = `<${P}tool_calls><${P}invoke name="exec_command"><${P}parameter name="cmd">npm test</${P}parameter></${P}invoke></${P}tool_calls>`;
  currentStream = [
    { id: "cmpl-2", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta: { role: "assistant", content: "Running.\n" + dsml }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
  upstreamChatBodies = [];
  const req = new Request("https://localhost/v1/chat/completions", {
    method: "POST", headers: AUTH,
    body: JSON.stringify({
      model: MODEL, stream: true,
      messages: [{ role: "user", content: "run tests" }],
      tools: [{ type: "function", function: { name: "exec", parameters: { type: "object", properties: { command: { type: "string" } } } } }],
    }),
  });
  const res = await worker.fetch(req, ENV);
  const events = await readSSE(res);
  const all = JSON.stringify(events);
  check("T6 chat stream no DSML leak", !all.includes("DSML") && !all.includes("antml") && !all.includes("<"), "");
  const tcEvent = events.find((e) => e.choices?.[0]?.delta?.tool_calls);
  check("T6 tool_calls emitted", tcEvent?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments === textOf("npm test"), JSON.stringify(tcEvent?.choices?.[0]?.delta?.tool_calls));
  check("T6 finish_reason tool_calls", events.some((e) => e.choices?.[0]?.finish_reason === "tool_calls"));
}

// ---------- T7: B5 dedup native + XML duplicate ----------
{
  const dsml = `<${P}invoke name="exec_command"><${P}parameter name="cmd">dir /b</${P}parameter></${P}invoke>`;
  const events = await responsesStreamTest([
    chunk({ role: "assistant", content: "Running.\n" + dsml }),
    chunk({ tool_calls: [{ index: 0, id: "call_abc", type: "function", function: { name: "exec_command", arguments: "" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: "dir /b" }) } }] }),
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ]);
  const completed = events.find((e) => e.type === "response.completed");
  const toolOutputs = completed?.response?.output?.filter((o) => o.type === "custom_tool_call" || o.type === "function_call");
  check("T7 dedup: exactly one tool call", toolOutputs?.length === 1, JSON.stringify(toolOutputs));
  check("T7 dedup input correct", toolOutputs?.[0]?.input === textOf("dir /b"), JSON.stringify(toolOutputs?.[0]));
}

// ---------- T8: multi-turn responses (tool result roundtrip) ----------
{
  currentStream = [{ id: "cmpl-3", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta: { role: "assistant", content: "Done. 42 files." }, finish_reason: null }] }];
  upstreamChatBodies = [];
  const req = new Request("https://localhost/v1/responses", {
    method: "POST", headers: AUTH,
    body: JSON.stringify({
      model: MODEL, stream: false, tools: execTools,
      input: [
        { role: "user", content: "list files" },
        { type: "custom_tool_call", call_id: "call_12345", name: "exec", input: textOf("dir /b") },
        { type: "custom_tool_call_output", call_id: "call_12345", output: "42 files" },
        { role: "user", content: "how many?" },
      ],
    }),
  });
  const res = await worker.fetch(req, ENV);
  const json = await res.json();
  check("T8 multi-turn status 200", res.status === 200, "status=" + res.status);
  check("T8 output text present", json?.output?.[0]?.content?.[0]?.text?.includes("42"), JSON.stringify(json?.output?.[0]));
  const up = upstreamChatBodies[0]?.body;
  const upStr = JSON.stringify(up);
  check("T8 upstream got tool result", upStr.includes("42 files") && upStr.includes("exec"), upStr.slice(0, 300));
}

// ---------- T9: non-stream responses, native + XML dup -> sanitize + dedup ----------
{
  const dsml = `<${P}invoke name="exec_command"><${P}parameter name="cmd">dir /b</${P}parameter></${P}invoke>`;
  currentStream = [
    chunk({ role: "assistant", content: "Running.\n" + dsml }),
    chunk({ tool_calls: [{ index: 0, id: "call_abc", type: "function", function: { name: "exec_command", arguments: "" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: "dir /b" }) } }] }),
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
  upstreamChatBodies = [];
  const req = new Request("https://localhost/v1/responses", {
    method: "POST", headers: AUTH,
    body: JSON.stringify({ model: MODEL, input: [{ role: "user", content: "list files" }], tools: execTools, stream: false }),
  });
  const res = await worker.fetch(req, ENV);
  const json = await res.json();
  const toolOutputs = (json?.output || []).filter((o) => o.type === "custom_tool_call" || o.type === "function_call");
  check("T9 non-stream dedup: exactly one tool call", toolOutputs.length === 1, JSON.stringify(toolOutputs));
  check("T9 non-stream sanitized input", toolOutputs[0]?.input === textOf("dir /b"), JSON.stringify(toolOutputs[0]));
  check("T9 non-stream no XML leak", !JSON.stringify(json).includes("<"), "");
}

// ---------- T10: parallel native tool calls (two indexes) ----------
{
  currentStream = [
    chunk({ tool_calls: [
      { index: 0, id: "call_a", type: "function", function: { name: "exec_command", arguments: JSON.stringify({ command: "dir /b" }) } },
      { index: 1, id: "call_b", type: "function", function: { name: "exec_command", arguments: JSON.stringify({ command: "dir /a" }) } },
    ] }),
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
  upstreamChatBodies = [];
  const req = new Request("https://localhost/v1/responses", {
    method: "POST", headers: AUTH,
    body: JSON.stringify({ model: MODEL, input: [{ role: "user", content: "list" }], tools: execTools, stream: true }),
  });
  const res = await worker.fetch(req, ENV);
  const events = await readSSE(res);
  const completed = events.find((e) => e.type === "response.completed");
  const tools = (completed?.response?.output || []).filter((o) => o.type === "custom_tool_call");
  check("T10 two parallel calls", tools.length === 2, JSON.stringify(tools.map((t) => t.input)));
  check("T10 both sanitized", tools.every((t) => t.input === textOf(t.input.includes("dir /b") ? "dir /b" : "dir /a")), JSON.stringify(tools));
}

// ---------- T11: apply_patch + web_search XML mapping ----------
{
  const patch = "--- a.txt\n+++ b.txt\n@@ -1 +1 @@\n-old\n+new\n";
  const dsml = `<${P}invoke name="apply_patch"><${P}parameter name="patch">${patch}</${P}parameter></${P}invoke><${P}invoke name="web_search"><${P}parameter name="query">nodejs 22</${P}parameter></${P}invoke>`;
  const clientTools = [
    { type: "function", function: { name: "apply_patch", description: "Apply a patch", parameters: { type: "object", properties: { patch: { type: "string" } } } } },
    { type: "function", function: { name: "web_search", description: "Search the web", parameters: { type: "object", properties: { query: { type: "string" } } } } },
  ];
  currentStream = [chunk({ role: "assistant", content: "Let me patch.\n" + dsml }), { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }];
  upstreamChatBodies = [];
  const req = new Request("https://localhost/v1/responses", {
    method: "POST", headers: AUTH,
    body: JSON.stringify({ model: MODEL, input: [{ role: "user", content: "patch and search" }], tools: clientTools, stream: true }),
  });
  const res = await worker.fetch(req, ENV);
  const events = await readSSE(res);
  const completed = events.find((e) => e.type === "response.completed");
  const out = completed?.response?.output || [];
  const patchCall = out.find((o) => o.type === "function_call" && o.name === "apply_patch");
  const searchCall = out.find((o) => o.type === "function_call" && o.name === "web_search");
  check("T11 apply_patch mapped", !!patchCall && patchCall.arguments.includes("--- a.txt"), JSON.stringify(patchCall));
  check("T11 web_search mapped", !!searchCall && searchCall.arguments.includes("nodejs 22"), JSON.stringify(searchCall));
  check("T11 no XML leak", !JSON.stringify(events).includes("<"), "");
}

// ---------- T12: byte-chunked DSML (streaming boundary robustness) ----------
{
  const dsml = `<${P}tool_calls><${P}invoke name="exec_command"><${P}parameter name="cmd">npm test</${P}parameter></${P}invoke></${P}tool_calls>`;
  const full = "data: " + JSON.stringify(chunk({ role: "assistant", content: "hi\n" + dsml })) + "\n\n" +
    "data: " + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) + "\n\n";
  const enc = new TextEncoder();
  const bytes = enc.encode(full);
  currentStream = [];
  globalThis.__mockRawStream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.subarray(i, i + 3));
      controller.close();
    },
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("/api/v1/freebuff/session")) return new Response(sessionBody, { status: 200, headers: { "Content-Type": "application/json" } });
    if (u.includes("/api/v1/agent-runs") || u.includes("/steps")) return new Response("{}", { status: 200 });
    if (u.includes("/api/v1/chat/completions")) return new Response(globalThis.__mockRawStream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    throw new Error("mock2: unexpected URL " + u);
  };
  try {
    const req = new Request("https://localhost/v1/responses", {
      method: "POST", headers: AUTH,
      body: JSON.stringify({ model: MODEL, input: [{ role: "user", content: "run tests" }], tools: execTools, stream: true }),
    });
    const res = await worker.fetch(req, ENV);
    const events = await readSSE(res);
    const completed = events.find((e) => e.type === "response.completed");
    const out = completed?.response?.output || [];
    const call = out.find((o) => o.type === "custom_tool_call");
    check("T12 byte-chunked DSML parsed", call?.input === textOf("npm test"), JSON.stringify(call));
    check("T12 no XML leak", !JSON.stringify(events).includes("<"), "");
  } finally {
    globalThis.fetch = origFetch;
  }
}

// ---------- T13: upstream never sends finish_reason ----------
{
  currentStream = [
    { id: "cmpl-9", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta: { role: "assistant", content: "plain text answer" }, finish_reason: null }] },
  ];
  upstreamChatBodies = [];
  const req = new Request("https://localhost/v1/responses", {
    method: "POST", headers: AUTH,
    body: JSON.stringify({ model: MODEL, input: [{ role: "user", content: "hi" }], stream: true }),
  });
  const res = await worker.fetch(req, ENV);
  const events = await readSSE(res);
  const completed = events.find((e) => e.type === "response.completed");
  const text = (completed?.response?.output || []).map((o) => o.content?.[0]?.text || "").join("");
  check("T13 completed despite no finish_reason", completed?.response?.status === "completed" && text.includes("plain text"), text.slice(0, 100));
}

// ---------- T14: apply_patch emitted as RAW patch text for freeform clients (Codex) ----------
{
  const patch = "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n";
  const dsml = `<${P}invoke name="apply_patch"><${P}parameter name="patch">${patch}</${P}parameter></${P}invoke>`;
  currentStream = [chunk({ role: "assistant", content: "Patching.\n" + dsml }), { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }];
  upstreamChatBodies = [];
  const req = new Request("https://localhost/v1/responses", {
    method: "POST", headers: AUTH,
    body: JSON.stringify({
      model: MODEL, stream: true,
      input: [
        { type: "additional_tools", role: "developer", tools: [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", description: "exec tool" }] }] },
        { type: "message", role: "user", content: "patch it" },
      ],
    }),
  });
  const res = await worker.fetch(req, ENV);
  const events = await readSSE(res);
  const completed = events.find((e) => e.type === "response.completed");
  const patchCall = (completed?.response?.output || []).find((o) => o.type === "function_call" && o.name === "apply_patch");
  check("T14 apply_patch raw text (no JSON wrapper)", !!patchCall && patchCall.arguments === patch.trim(), JSON.stringify(patchCall));
  check("T14 no XML leak", !JSON.stringify(events).includes("<"), "");
}

// ---------- T15: undecared tool (web_search) dropped for freeform clients ----------
{
  const dsml = `<${P}invoke name="web_search"><${P}parameter name="query">nodejs 22</${P}parameter></${P}invoke>`;
  currentStream = [chunk({ role: "assistant", content: "Searching.\n" + dsml }), { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }];
  upstreamChatBodies = [];
  const req = new Request("https://localhost/v1/responses", {
    method: "POST", headers: AUTH,
    body: JSON.stringify({
      model: MODEL, stream: true,
      input: [
        { type: "additional_tools", role: "developer", tools: [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", description: "exec tool" }] }] },
        { type: "message", role: "user", content: "search" },
      ],
    }),
  });
  const res = await worker.fetch(req, ENV);
  const events = await readSSE(res);
  const completed = events.find((e) => e.type === "response.completed");
  const out = completed?.response?.output || [];
  check("T15 web_search dropped for undeclaring client", !out.some((o) => o.type === "function_call" && o.name === "web_search"), JSON.stringify(out));
  check("T15 still completed with message", completed?.response?.status === "completed" && out.some((o) => o.type === "message"), JSON.stringify(out));
}

// ---------- T16: bare-body apply_patch (no <parameter> wrapper) keeps patch content ----------
{
  const patch = "--- a.txt\n+++ b.txt\n@@ -1 +1 @@\n-old\n+new\n";
  const dsml = `<${P}invoke name="apply_patch">${patch}</${P}invoke>`;
  currentStream = [chunk({ role: "assistant", content: dsml }), { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }];
  upstreamChatBodies = [];
  const req = new Request("https://localhost/v1/responses", {
    method: "POST", headers: AUTH,
    body: JSON.stringify({
      model: MODEL, stream: true,
      input: [
        { type: "additional_tools", role: "developer", tools: [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", description: "exec tool" }] }] },
        { type: "message", role: "user", content: "patch it" },
      ],
    }),
  });
  const res = await worker.fetch(req, ENV);
  const events = await readSSE(res);
  const completed = events.find((e) => e.type === "response.completed");
  const patchCall = (completed?.response?.output || []).find((o) => o.type === "function_call" && o.name === "apply_patch");
  check("T16 bare-body patch preserved", !!patchCall && patchCall.arguments.includes("--- a.txt"), JSON.stringify(patchCall));
  check("T16 no empty patch", !!patchCall && patchCall.arguments !== '{"patch":""}', JSON.stringify(patchCall));
}

// 保留 data:[DONE] 顺序的原始 SSE 读取器（用于终止符顺序断言）
async function readRawSSE(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", raw = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const p = line.slice(5).trim();
      if (p === "") continue;
      if (p === "[DONE]") { raw.push("[DONE]"); continue; }
      try { raw.push(JSON.parse(p)); } catch { raw.push(p); }
    }
  }
  return raw;
}

// ---------- T17: chat stream [DONE] 必须最后发送（tool_calls/finish/usage 在终止符之前） ----------
{
  currentStream = nativeExecStream("dir /b");
  upstreamChatBodies = [];
  const req = new Request("https://localhost/v1/chat/completions", {
    method: "POST", headers: AUTH,
    body: JSON.stringify({
      model: MODEL, stream: true,
      messages: [{ role: "user", content: "list files" }],
      tools: [{ type: "function", function: { name: "exec", parameters: { type: "object", properties: { command: { type: "string" } } } } }],
    }),
  });
  const res = await worker.fetch(req, ENV);
  const raw = await readRawSSE(res);
  const doneIdx = raw.lastIndexOf("[DONE]");
  check("T17 exactly one [DONE]", raw.filter((x) => x === "[DONE]").length === 1, JSON.stringify(raw.map((x) => typeof x === "string" ? x : "obj")));
  const tcIdx = raw.findIndex((e) => e && e.choices?.[0]?.delta?.tool_calls);
  const finIdx = raw.findIndex((e) => e && e.choices?.[0]?.finish_reason);
  const usageIdx = raw.findIndex((e) => e && e.usage);
  check("T17 tool_calls before [DONE]", tcIdx >= 0 && tcIdx < doneIdx, "tc=" + tcIdx + " done=" + doneIdx);
  check("T17 finish before [DONE]", finIdx >= 0 && finIdx < doneIdx, "fin=" + finIdx + " done=" + doneIdx);
  check("T17 usage before [DONE]", usageIdx >= 0 && usageIdx < doneIdx, "usage=" + usageIdx + " done=" + doneIdx);
  check("T17 finish_reason tool_calls", raw[finIdx]?.choices?.[0]?.finish_reason === "tool_calls", JSON.stringify(raw[finIdx]));
  check("T17 tool_calls args wrapped", raw[tcIdx]?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments === textOf("dir /b"), JSON.stringify(raw[tcIdx]));
}

// ---------- T18: 上游流中途 {error} → chat 流不再合成假完成 ----------
{
  currentStream = [
    chunk({ role: "assistant", content: "partial" }),
    { error: { message: "account quota exhausted", type: "quota_error" } },
  ];
  upstreamChatBodies = [];
  const req = new Request("https://localhost/v1/chat/completions", {
    method: "POST", headers: AUTH,
    body: JSON.stringify({
      model: MODEL, stream: true,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "exec", parameters: { type: "object", properties: {} } } }],
    }),
  });
  const res = await worker.fetch(req, ENV);
  const raw = await readRawSSE(res);
  const errEvent = raw.find((e) => e && e.error);
  check("T18 error chunk forwarded", !!errEvent && String(errEvent.error?.message).includes("quota exhausted"), JSON.stringify(raw.slice(-2)));
  check("T18 no fake finish/tool_calls after error", !raw.some((e) => e && e.choices?.[0]?.finish_reason === "tool_calls"), "");
}

// ---------- T19: exec 结果 JSON（chunk_id/output…）→ 只把 .output 回传上游 ----------
{
  const execResult = JSON.stringify({ chunk_id: "chk_1", exit_code: 0, original_token_count: 42, output: "42 files", session_id: "s1", wall_time_seconds: 1.2 });
  currentStream = [{ id: "cmpl-19", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null }] }];
  upstreamChatBodies = [];
  const req = new Request("https://localhost/v1/responses", {
    method: "POST", headers: AUTH,
    body: JSON.stringify({
      model: MODEL, stream: false, tools: execTools,
      input: [
        { role: "user", content: "count files" },
        { type: "custom_tool_call", call_id: "call_19", name: "exec", input: textOf("dir /b") },
        { type: "custom_tool_call_output", call_id: "call_19", output: [execResult] },
        { role: "user", content: "how many?" },
      ],
    }),
  });
  const res = await worker.fetch(req, ENV);
  await res.json();
  const upStr = JSON.stringify(upstreamChatBodies[0]?.body);
  check("T19 upstream gets clean output", upStr.includes("42 files"), upStr.slice(0, 400));
  check("T19 upstream gets no chunk_id noise", !upStr.includes("chunk_id") && !upStr.includes("wall_time_seconds"), upStr.slice(0, 400));
}

// ---------- T20: extractExecCommandText 带引号 key 与对象入参 ----------
{
  const dsml = `<${P}invoke name="exec_command"><${P}parameter name="cmd">npm test</${P}parameter></${P}invoke>`;
  currentStream = [chunk({ role: "assistant", content: dsml }), { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }];
  upstreamChatBodies = [];
  const req = new Request("https://localhost/v1/responses", {
    method: "POST", headers: AUTH,
    body: JSON.stringify({
      model: MODEL, stream: false, tools: execTools,
      input: [
        { type: "custom_tool_call", call_id: "call_q1", name: "exec", input: 'text(await tools.exec_command({ "cmd": "ls -la" }));' },
        { type: "custom_tool_call_output", call_id: "call_q1", output: "" },
        { type: "custom_tool_call", call_id: "call_q2", name: "exec", input: { cmd: "pwd" } },
        { type: "custom_tool_call_output", call_id: "call_q2", output: "" },
        { role: "user", content: "go" },
      ],
    }),
  });
  const res = await worker.fetch(req, ENV);
  await res.json();
  const upStr = JSON.stringify(upstreamChatBodies[0]?.body);
  check("T20 quoted-key cmd extracted", upStr.includes("ls -la"), upStr.slice(0, 400));
  check("T20 object input cmd extracted", upStr.includes("pwd"), upStr.slice(0, 400));
}

// ---------- T21: <function_calls> 容器内的 invoke 必须被提取（不再被容器剥离吞掉） ----------
{
  const dsml = `<${P}function_calls><${P}invoke name="exec_command"><${P}parameter name="cmd">npm test</${P}parameter></${P}invoke></${P}function_calls>`;
  const events = await responsesStreamTest([
    chunk({ role: "assistant", content: "Running.\n" + dsml }),
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ]);
  const done = events.filter((e) => e.type === "response.custom_tool_call_input.done");
  check("T21 invoke inside function_calls extracted", done[0]?.input === textOf("npm test"), done[0]?.input);
  check("T21 no XML leak", !JSON.stringify(events).includes("<"), "");
}

// ---------- T22: 非流式 responses 空流 → 502 错误（审计 2.7：不再假装空成功） ----------
{
  currentStream = [];
  upstreamChatBodies = [];
  const req = new Request("https://localhost/v1/responses", {
    method: "POST", headers: AUTH,
    body: JSON.stringify({ model: MODEL, input: [{ role: "user", content: "hi" }], stream: false }),
  });
  const res = await worker.fetch(req, ENV);
  const json = await res.json();
  check("T22 empty stream rejected", res.status === 502 && json?.error?.message, res.status + " " + JSON.stringify(json?.error));
}

// ---------- T23: 相同 (name,args) 的两个并行 native 调用都保留（live-added 项不可去重移除） ----------
{
  currentStream = [
    chunk({ tool_calls: [
      { index: 0, id: "call_a", type: "function", function: { name: "exec_command", arguments: JSON.stringify({ command: "dir /b" }) } },
      { index: 1, id: "call_b", type: "function", function: { name: "exec_command", arguments: JSON.stringify({ command: "dir /b" }) } },
    ] }),
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
  upstreamChatBodies = [];
  const req = new Request("https://localhost/v1/responses", {
    method: "POST", headers: AUTH,
    body: JSON.stringify({ model: MODEL, input: [{ role: "user", content: "list" }], tools: execTools, stream: true }),
  });
  const res = await worker.fetch(req, ENV);
  const events = await readSSE(res);
  const completed = events.find((e) => e.type === "response.completed");
  const tools = (completed?.response?.output || []).filter((o) => o.type === "custom_tool_call");
  check("T23 both parallel same-cmd calls kept (no orphan)", tools.length === 2, JSON.stringify(tools.map((t) => t.input)));
  const doneEvents = events.filter((e) => e.type === "response.output_item.done" && e.item?.type === "custom_tool_call");
  check("T23 both calls got .done", doneEvents.length === 2, JSON.stringify(doneEvents.map((e) => e.item?.id)));
}

// ---------- T24: 名称晚到的首 delta：先挂起，名称到达后才决定 added/drop ----------
{
  const events = await responsesStreamTest([
    chunk({ tool_calls: [{ index: 0, id: "call_x", type: "function", function: { arguments: "" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { name: "exec_command", arguments: JSON.stringify({ command: "dir /b" }) } }] }),
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ]);
  const added = events.filter((e) => e.type === "response.output_item.added" && e.item?.type === "custom_tool_call");
  check("T24 name-less first delta still added (name arrives later)", added.length === 1 && added[0].item.name === "exec", JSON.stringify(added));
  const completed = events.find((e) => e.type === "response.completed");
  const tool = (completed?.response?.output || []).find((o) => o.type === "custom_tool_call");
  check("T24 completed input correct", tool?.input === textOf("dir /b"), JSON.stringify(tool));
}
{
  // 变体：名称晚到但属于未声明工具（web_search）→ 不 added、最终丢弃
  const events = await responsesStreamTest([
    chunk({ tool_calls: [{ index: 0, id: "call_y", type: "function", function: { arguments: "" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { name: "web_search", arguments: JSON.stringify({ query: "x" }) } }] }),
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ]);
  const added = events.filter((e) => e.type === "response.output_item.added" && e.item?.type === "function_call");
  check("T24 undeclared late-named call never added", added.length === 0, JSON.stringify(added));
  const completed = events.find((e) => e.type === "response.completed");
  check("T24 completed without web_search", !(completed?.response?.output || []).some((o) => o.name === "web_search"), JSON.stringify(completed?.response?.output));
}

// ---------- T25: 尾块 usage（choices 空）不再被非流式聚合器丢弃 ----------
{
  currentStream = [
    chunk({ role: "assistant", content: "plain" }),
    { id: "cmpl-u", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } },
  ];
  upstreamChatBodies = [];
  const req = new Request("https://localhost/v1/chat/completions", {
    method: "POST", headers: AUTH,
    body: JSON.stringify({ model: MODEL, stream: false, messages: [{ role: "user", content: "hi" }] }),
  });
  const res = await worker.fetch(req, ENV);
  const json = await res.json();
  check("T25 trailing usage captured (chat non-stream)", json?.usage?.total_tokens === 7, JSON.stringify(json?.usage));
}
{
  currentStream = [
    chunk({ role: "assistant", content: "plain" }),
    { id: "cmpl-u2", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } },
  ];
  upstreamChatBodies = [];
  const req = new Request("https://localhost/v1/responses", {
    method: "POST", headers: AUTH,
    body: JSON.stringify({ model: MODEL, input: [{ role: "user", content: "hi" }], stream: false }),
  });
  const res = await worker.fetch(req, ENV);
  const json = await res.json();
  check("T25 trailing usage captured (responses non-stream)", json?.usage?.total_tokens === 7, JSON.stringify(json?.usage));
}

// ---------- T26: Anthropic 流式：保留 Claude 声明的工具名（Bash），stop_reason=tool_use ----------
{
  currentStream = [
    chunk({ role: "assistant", content: "Running" }),
    chunk({ tool_calls: [{ index: 0, id: "call_bash", type: "function", function: { name: "Bash", arguments: JSON.stringify({ command: "ls" }) } }] }),
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ];
  upstreamChatBodies = [];
  const req = new Request("https://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer freebuff-default-key", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL, stream: true, max_tokens: 100,
      messages: [{ role: "user", content: "list files" }],
      tools: [{ name: "Bash", description: "Run a shell command", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
    }),
  });
  const res = await worker.fetch(req, ENV);
  const raw = await readRawSSE(res);
  const starts = raw.filter((e) => e && e.type === "content_block_start");
  const toolBlock = starts.find((e) => e.content_block?.type === "tool_use");
  check("T26 tool_use block emitted", !!toolBlock && toolBlock.content_block.name === "Bash", JSON.stringify(toolBlock));
  check("T26 no Codex exec rename", !JSON.stringify(raw).includes('"exec"'), JSON.stringify(raw).slice(0, 300));
  const delta = raw.find((e) => e && e.type === "message_delta");
  check("T26 stop_reason tool_use", delta?.delta?.stop_reason === "tool_use", JSON.stringify(delta));
  check("T26 message_stop present", raw.some((e) => e && e.type === "message_stop"), "");
}

// ---------- T27: Anthropic XML 路径：invoke name="Bash" 保留原名 ----------
{
  const dsml = `<${P}invoke name="Bash"><${P}parameter name="command">ls</${P}parameter></${P}invoke>`;
  currentStream = [chunk({ role: "assistant", content: "Running\n" + dsml }), { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }];
  upstreamChatBodies = [];
  const req = new Request("https://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer freebuff-default-key", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL, stream: true, max_tokens: 100,
      messages: [{ role: "user", content: "list files" }],
      tools: [{ name: "Bash", description: "Run a shell command", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
    }),
  });
  const res = await worker.fetch(req, ENV);
  const raw = await readRawSSE(res);
  const toolBlock = raw.find((e) => e && e.type === "content_block_start" && e.content_block?.type === "tool_use");
  check("T27 XML Bash preserved", !!toolBlock && toolBlock.content_block.name === "Bash", JSON.stringify(toolBlock));
  check("T27 no XML leak", !JSON.stringify(raw).includes("DSML") && !JSON.stringify(raw).includes("<"), "");
  const delta = raw.find((e) => e && e.type === "message_delta");
  check("T27 stop_reason tool_use", delta?.delta?.stop_reason === "tool_use", JSON.stringify(delta));
}

// ---------- T28: stop:[] 视同未设置，必须补 cb_easp ----------
{
  currentStream = [{ id: "cmpl-28", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }];
  upstreamChatBodies = [];
  const req = new Request("https://localhost/v1/chat/completions", {
    method: "POST", headers: AUTH,
    body: JSON.stringify({ model: MODEL, stream: false, stop: [], messages: [{ role: "user", content: "hi" }] }),
  });
  const res = await worker.fetch(req, ENV);
  await res.json();
  const up = upstreamChatBodies[0]?.body;
  check("T28 stop:[] -> cb_easp injected", Array.isArray(up?.stop) && up.stop[0] === '"cb_easp"', JSON.stringify(up?.stop));
}

// ---------- T29: system 数组内容无 text part → 索引 0 插入 BUFFY 前缀 ----------
{
  currentStream = [{ id: "cmpl-29", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }];
  upstreamChatBodies = [];
  const req = new Request("https://localhost/v1/chat/completions", {
    method: "POST", headers: AUTH,
    body: JSON.stringify({
      model: MODEL, stream: false,
      messages: [
        { role: "system", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] },
        { role: "user", content: "hi" },
      ],
    }),
  });
  const res = await worker.fetch(req, ENV);
  await res.json();
  const msgs = upstreamChatBodies[0]?.body?.messages;
  const sys = msgs?.find((m) => m.role === "system");
  check("T29 BUFFY text part inserted at index 0", Array.isArray(sys?.content) && sys.content[0]?.type === "text" && String(sys.content[0].text).startsWith("You are Buffy"), JSON.stringify(sys?.content));
}

// ---------- T30: 鉴权——未配置 key 拒绝；错误 key 拒绝；正确 key 放行 ----------
{
  const req = new Request("https://localhost/v1/models", { method: "GET" });
  const resNoKey = await worker.fetch(req, { FREEBUFF_TOKEN: TOKEN });
  check("T30 unset API key -> 401", resNoKey.status === 401, "status=" + resNoKey.status);
  const resWrong = await worker.fetch(new Request("https://localhost/v1/models", { method: "GET", headers: { Authorization: "Bearer wrong" } }), { FREEBUFF_TOKEN: TOKEN, FREEBUFF_API_KEY: "real-key" });
  check("T30 wrong key -> 401", resWrong.status === 401, "status=" + resWrong.status);
  const resOk = await worker.fetch(new Request("https://localhost/v1/models", { method: "GET", headers: { Authorization: "Bearer real-key" } }), { FREEBUFF_TOKEN: TOKEN, FREEBUFF_API_KEY: "real-key" });
  check("T30 correct key -> 200", resOk.status === 200, "status=" + resOk.status);
}

// ---------- T31: reasoning_content → 规范 reasoning item（M4：response.reasoning_summary_text.delta） ----------
{
  const events = await responsesStreamTest([
    chunk({ role: "assistant", content: "Let me think", reasoning_content: "analyzing the request..." }),
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]);
  const reasoningDeltas = events.filter((e) => e.type === "response.reasoning_summary_text.delta");
  check("T31 reasoning_summary_text.delta emitted", reasoningDeltas.some((e) => String(e.delta).includes("analyzing")), JSON.stringify(reasoningDeltas));
  const reasoningAdded = events.filter((e) => e.type === "response.output_item.added" && e.item?.type === "reasoning");
  check("T31 reasoning item added", reasoningAdded.length === 1 && Array.isArray(reasoningAdded[0].item?.summary), JSON.stringify(reasoningAdded));
  const reasoningDone = events.filter((e) => e.type === "response.output_item.done" && e.item?.type === "reasoning");
  check("T31 reasoning item done with text", reasoningDone.length === 1 && reasoningDone[0].item?.summary?.[0]?.text?.includes("analyzing"), JSON.stringify(reasoningDone));
  const completed = events.find((e) => e.type === "response.completed");
  check("T31 reasoning in completed output", completed?.response?.output?.some((o) => o.type === "reasoning" && o.summary?.[0]?.text?.includes("analyzing")), JSON.stringify(completed?.response?.output));
}

// ---------- T32: responsesBase 回显原请求参数 ----------
{
  currentStream = [{ id: "cmpl-32", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }];
  upstreamChatBodies = [];
  const req = new Request("https://localhost/v1/responses", {
    method: "POST", headers: AUTH,
    body: JSON.stringify({ model: MODEL, stream: true, instructions: "be concise", temperature: 0.5, input: [{ role: "user", content: "hi" }] }),
  });
  const res = await worker.fetch(req, ENV);
  const events = await readSSE(res);
  const created = events.find((e) => e.type === "response.created");
  check("T32 instructions echoed", created?.response?.instructions === "be concise", JSON.stringify(created?.response?.instructions));
  check("T32 temperature echoed", created?.response?.temperature === 0.5, JSON.stringify(created?.response?.temperature));
}

// ---------- T33: responses 流中途 {error} → response.failed（不合成假 completed） ----------
{
  currentStream = [
    chunk({ role: "assistant", content: "partial" }),
    { error: { message: "upstream boom", type: "api_error" } },
  ];
  upstreamChatBodies = [];
  const req = new Request("https://localhost/v1/responses", {
    method: "POST", headers: AUTH,
    body: JSON.stringify({ model: MODEL, input: [{ role: "user", content: "hi" }], stream: true }),
  });
  const res = await worker.fetch(req, ENV);
  const events = await readSSE(res);
  const failed = events.find((e) => e.type === "response.failed");
  check("T33 response.failed emitted", !!failed && String(failed.response?.error?.message).includes("boom"), JSON.stringify(failed));
  check("T33 no fake completed", !events.some((e) => e.type === "response.completed"), "");
}

// ---------- T34: chat 非流式中途 {error} → 502（不返回假完成） ----------
{
  currentStream = [
    chunk({ role: "assistant", content: "partial" }),
    { error: { message: "upstream boom", type: "api_error" } },
  ];
  upstreamChatBodies = [];
  const req = new Request("https://localhost/v1/chat/completions", {
    method: "POST", headers: AUTH,
    body: JSON.stringify({ model: MODEL, stream: false, messages: [{ role: "user", content: "hi" }] }),
  });
  const res = await worker.fetch(req, ENV);
  const json = await res.json();
  check("T34 non-stream upstream error -> 502", res.status === 502 && String(json?.error?.message).includes("boom"), res.status + " " + JSON.stringify(json).slice(0, 200));
}

// ---------- T35: Anthropic thinking 顶部预算（MAX_THINKING_TOKENS=32000）→ effort max ----------
{
  currentStream = [{ id: "cmpl-35", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }];
  upstreamChatBodies = [];
  const req = new Request("https://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer freebuff-default-key", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, stream: true, max_tokens: 100, thinking: { type: "enabled", budget_tokens: 32000 }, messages: [{ role: "user", content: "hi" }] }),
  });
  const res = await worker.fetch(req, ENV);
  await readRawSSE(res);
  check("T35 budget 32000 -> reasoning_effort max", upstreamChatBodies[0]?.body?.reasoning_effort === "max", JSON.stringify(upstreamChatBodies[0]?.body?.reasoning_effort));
}

// ---------- T36: Anthropic 显式 effort 字段原样透传 ----------
{
  currentStream = [{ id: "cmpl-36", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }];
  upstreamChatBodies = [];
  const req = new Request("https://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer freebuff-default-key", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, stream: true, max_tokens: 100, effort: "max", messages: [{ role: "user", content: "hi" }] }),
  });
  const res = await worker.fetch(req, ENV);
  await readRawSSE(res);
  check("T36 explicit effort max passthrough", upstreamChatBodies[0]?.body?.reasoning_effort === "max", JSON.stringify(upstreamChatBodies[0]?.body?.reasoning_effort));
}

// ---------- T37: anthropic tool_result 内容拍平为字符串（OpenAI tool 消息 content 必须为 string） ----------
{
  currentStream = [{ id: "cmpl-37", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: "stop" }] }];
  upstreamChatBodies = [];
  const req = new Request("https://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer freebuff-default-key", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL, stream: true, max_tokens: 100,
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "ls ok" }] }] }],
    }),
  });
  const res = await worker.fetch(req, ENV);
  await readRawSSE(res);
  const toolMsg = upstreamChatBodies[0]?.body?.messages?.find((m) => m.role === "tool");
  check("T37 tool message content is string", typeof toolMsg?.content === "string" && toolMsg.content === "ls ok", JSON.stringify(toolMsg));
  check("T37 tool_call_id preserved", toolMsg?.tool_call_id === "tu_1", JSON.stringify(toolMsg?.tool_call_id));
}

// ---------- T38: 非 sanitize 流中途上游错误必须转发（不得假装成功 [DONE]） ----------
{
  currentStream = [
    { id: "cmpl-38", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null }] },
    { error: { message: "mid-stream boom", type: "api_error" } },
  ];
  upstreamChatBodies = [];
  const req = new Request("https://localhost/v1/chat/completions", {
    method: "POST", headers: AUTH,
    body: JSON.stringify({ model: MODEL, stream: true, tools: [{ type: "function", function: { name: "web_search" } }], messages: [{ role: "user", content: "hi" }] }),
  });
  const res = await worker.fetch(req, ENV);
  const raw = await readRawSSE(res);
  const errorEvt = raw.find((e) => e && typeof e === "object" && e.error);
  check("T38 non-sanitize error forwarded", !!errorEvt && String(errorEvt.error?.message).includes("boom"), JSON.stringify(raw).slice(0, 300));
  const doneIdx = raw.indexOf("[DONE]");
  const errIdx = raw.indexOf(errorEvt);
  check("T38 error before [DONE]", errIdx >= 0 && doneIdx >= 0 && errIdx < doneIdx, "err=" + errIdx + " done=" + doneIdx);
}

// ---------- T39: anthropic 流 M2 修复——工具增量在 id/name 到达前缓冲，多工具交错不乱序 ----------
{
  currentStream = [
    chunk({ tool_calls: [{ index: 0, function: { arguments: "{\"cm" } }] }),
    chunk({ tool_calls: [{ index: 1, function: { arguments: "{\"pa" } }] }),
    chunk({ tool_calls: [{ index: 0, id: "call_x", function: { name: "exec_command", arguments: "d\": \"dir\"}" } }] }),
    chunk({ tool_calls: [{ index: 1, id: "call_y", function: { name: "exec_command", arguments: "th\": \".\"}" } }] }),
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
  upstreamChatBodies = [];
  const req = new Request("https://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer freebuff-default-key", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, stream: true, max_tokens: 100, tools: [{ name: "web_search", input_schema: { type: "object", properties: {} } }], messages: [{ role: "user", content: "hi" }] }),
  });
  const res = await worker.fetch(req, ENV);
  const raw = await readRawSSE(res);
  const starts = raw.filter((e) => e.type === "content_block_start" && e.content_block?.type === "tool_use");
  check("T39 both tool blocks opened", starts.length === 2, JSON.stringify(starts));
  check("T39 real id used (no synthesized)", starts[0]?.content_block?.id === "call_x" && starts[1]?.content_block?.id === "call_y" && !JSON.stringify(starts).includes("toolu_"), JSON.stringify(starts.map((s) => s.content_block?.id)));
  const argsByBlock = {};
  for (const e of raw.filter((e2) => e2.type === "content_block_delta" && e2.delta?.type === "input_json_delta")) {
    argsByBlock[e.index] = (argsByBlock[e.index] || "") + e.delta.partial_json;
  }
  check("T39 args reassembled in order", argsByBlock[0] === "{\"cmd\": \"dir\"}" && argsByBlock[1] === "{\"path\": \".\"}", JSON.stringify(argsByBlock));
  check("T39 message_stop present", raw.some((e) => e.type === "message_stop"), "");
}

// ---------- T40: StreamingXmlFilter F1/F2 回归（拆分块 + 不匹配闭合标签） ----------
{
  const cases = [
    ["F1 closing leak", "<attempt_completion><result>42 files</result></attempt_completion>", "42 files"],
    ["F1 stray invoke close", "answer</invoke>rest", "answerrest"],
    ["F1 chunk-split closing part1", "<attempt_completion><result>hi", "hi"],
    ["F2 mismatched close", "pre<invoke><parameter name=\"cmd\">x</invoke>post", "pre"],
    ["F2 nested proper", "a<invoke><parameter name=\"cmd\">x</parameter></invoke>b", "ab"],
    ["F2 self-closing", "a<invoke/>b", "ab"],
    ["F2 unclosed at end", "a<invoke><parameter name=\"cmd\">x", "a"],
  ];
  for (const [name, input, expect] of cases) {
    currentStream = [];
    upstreamChatBodies = [];
    const req = new Request("https://localhost/v1/chat/completions", {
      method: "POST", headers: AUTH,
      body: JSON.stringify({ model: MODEL, stream: false, messages: [{ role: "user", content: "hi" }] }),
    });
    // 走 sanitize=true 路径（无工具）验证最终文本
    // 通过上游直接吐该文本（XML 会被 worker 过滤）
    const chunks = [];
    for (let i = 0; i < input.length; i++) chunks.push(chunk({ role: "assistant", content: input[i] }));
    currentStream = [...chunks, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }];
    const res2 = await worker.fetch(req, ENV);
    const json = await res2.json();
    const msgText = json?.choices?.[0]?.message?.content || "";
    check("T40 " + name + " -> " + JSON.stringify(expect), msgText === expect, JSON.stringify(msgText));
  }
}

// ---------- T41: 工具输出上限（Codex /v1/responses 路径，FREEBUFF_MAX_TOOL_OUTPUT=100） ----------
{
  currentStream = [{ id: "cmpl", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }];
  upstreamChatBodies = [];
  const big = "Z".repeat(5000);
  const req = new Request("https://localhost/v1/responses", {
    method: "POST", headers: AUTH,
    body: JSON.stringify({
      model: MODEL, stream: false,
      input: [
        { role: "user", content: "run ls" },
        { type: "function_call", call_id: "call_1", name: "exec", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: big },
      ],
    }),
  });
  await worker.fetch(req, { ...ENV, FREEBUFF_MAX_TOOL_OUTPUT: "100" });
  const up = upstreamChatBodies[upstreamChatBodies.length - 1];
  const toolMsg = (up?.body?.messages || []).find((m) => m.role === "tool");
  const t41detail = JSON.stringify({ nBodies: upstreamChatBodies.length, upExists: !!up, roles: (up?.body?.messages || []).map((m) => m.role), toolLen: toolMsg?.content?.length });
  check("T41 Codex tool output capped (marker present)", !!toolMsg && toolMsg.content.includes("truncated by freebuff2api"), t41detail);
  check("T41 Codex tool output length capped", !!toolMsg && toolMsg.content.length < 5000 && toolMsg.content.length > 100, "len=" + (toolMsg?.content?.length));
}

// ---------- T42: FREEBUFF_MAX_TOOL_OUTPUT=0 关闭截断 ----------
{
  currentStream = [{ id: "cmpl", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }];
  upstreamChatBodies = [];
  const big = "Z".repeat(5000);
  const req = new Request("https://localhost/v1/responses", {
    method: "POST", headers: AUTH,
    body: JSON.stringify({
      model: MODEL, stream: false,
      input: [
        { role: "user", content: "run ls" },
        { type: "function_call", call_id: "call_1", name: "exec", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: big },
      ],
    }),
  });
  await worker.fetch(req, { ...ENV, FREEBUFF_MAX_TOOL_OUTPUT: "0" });
  const up = upstreamChatBodies[upstreamChatBodies.length - 1];
  const toolMsg = (up?.body?.messages || []).find((m) => m.role === "tool");
  check("T42 FREEBUFF_MAX_TOOL_OUTPUT=0 -> uncapped", !!toolMsg && toolMsg.content === big, "len=" + (toolMsg?.content?.length));
}

// ---------- T43: /v1/models 附带 context_window / supports_reasoning ----------
{
  const req = new Request("https://localhost/v1/models", { method: "GET", headers: AUTH });
  const res = await worker.fetch(req, ENV);
  const j = await res.json();
  const m = (j?.data || []).find((x) => x.id === MODEL);
  check("T43 /v1/models has context_window", !!m && m.context_window === 131072, JSON.stringify(m).slice(0, 120));
  check("T43 /v1/models has supports_reasoning", !!m && m.supports_reasoning === true, JSON.stringify(m).slice(0, 120));
}

// ---------- T44: 工具输出上限（Anthropic /v1/messages 路径 tool_result） ----------
{
  currentStream = [{ id: "cmpl", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }];
  upstreamChatBodies = [];
  const big = "Q".repeat(5000);
  const req = new Request("https://localhost/v1/messages", {
    method: "POST", headers: AUTH,
    body: JSON.stringify({
      model: MODEL, max_tokens: 64,
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: big }] }],
    }),
  });
  await worker.fetch(req, { ...ENV, FREEBUFF_MAX_TOOL_OUTPUT: "100" });
  const up = upstreamChatBodies[upstreamChatBodies.length - 1];
  const toolMsg = (up?.body?.messages || []).find((m) => m.role === "tool");
  check("T44 Anthropic tool_result capped (marker present)", !!toolMsg && toolMsg.content.includes("truncated by freebuff2api"), JSON.stringify(toolMsg).slice(0, 120));
}

const failed = results.filter((r) => !r.ok);
console.log("\n=== " + (results.length - failed.length) + "/" + results.length + " passed ===");
process.exit(failed.length ? 1 : 0);