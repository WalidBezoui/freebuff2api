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
const textOf = (cmd) => `text(await tools.shell_command({ command: ${JSON.stringify(cmd)} }));`;

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
  check("T4 empty command falls back to echo", done[0]?.input === `text(await tools.shell_command({ command: "echo ''" }));`, done[0]?.input);
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

const failed = results.filter((r) => !r.ok);
console.log("\n=== " + (results.length - failed.length) + "/" + results.length + " passed ===");
process.exit(failed.length ? 1 : 0);