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

const failed = results.filter((r) => !r.ok);
console.log("\n=== " + (results.length - failed.length) + "/" + results.length + " passed ===");
process.exit(failed.length ? 1 : 0);