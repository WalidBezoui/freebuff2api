/**
 * Replay REAL captured Codex v0.147 payloads through the local worker with a mocked upstream.
 * Asserts the responses→chat translation is faithful:
 *   - additional_tools (tool schemas) merged into upstream tools as exec_command
 *   - reasoning.effort -> reasoning_effort
 *   - developer role -> system with Buffy prefix, no empty developer residue
 *   - multi-turn custom_tool_call / custom_tool_call_output roundtrip (call_id, args, output)
 *   - client-visible exec wrapper identical to the real captured response
 * Run: node scripts/test-codex-replay.mjs
 */
import { readFileSync } from "node:fs";
import worker from "../worker.js";

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
let currentStream = [];

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
    { id: "cmpl-1", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    chunk({ tool_calls: [{ index: 0, id: "call_abc", type: "function", function: { name: "exec_command", arguments: "" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command }) } }] }),
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ];
}

const loadCapture = (name) => {
  // 优先使用提交进仓库的脱敏 fixtures（CI/新克隆可直接运行）；本地新抓包优先走 scratch
  const candidates = [
    new URL("../test/fixtures/codex-captures/" + name + ".json", import.meta.url),
    new URL("../scratch/codex-captures/" + name + ".json", import.meta.url),
  ];
  for (const p of candidates) {
    try {
      const w = JSON.parse(readFileSync(p, "utf8"));
      return { url: w.url, body: JSON.parse(w.bodyRaw) };
    } catch {}
  }
  console.error("无法读取真实抓包 " + candidates[0].pathname + "（需先通过 scratch/capture-proxy.mjs 抓取 Codex 请求）");
  process.exit(2);
};

const turn1 = loadCapture("002");
const turn2 = loadCapture("003");
const textOf = (cmd) => `text(await tools.exec_command({ cmd: ${JSON.stringify(cmd)} }));`;

async function replay(body, streamChunks) {
  currentStream = streamChunks;
  upstreamChatBodies = [];
  const req = new Request("https://localhost" + turn1.url, {
    method: "POST", headers: AUTH,
    body: JSON.stringify({ ...body, model: MODEL }),
  });
  const res = await worker.fetch(req, ENV);
  const status = res.status;
  const events = await readSSE(res);
  return { status, events, upstream: upstreamChatBodies[0]?.body };
}

// ---------- R1: turn 1 (first request) upstream translation ----------
const r1 = await replay(turn1.body, nativeExecStream("echo captured-roundtrip"));
{
  const up = r1.upstream;
  check("R1 status 200", r1.status === 200, "status=" + r1.status);
  check("R1 upstream has exec_command tool", Array.isArray(up?.tools) && up.tools.some((t) => t.function?.name === "exec_command"), JSON.stringify(up?.tools?.map((t) => t.function?.name)));
  const execTool = up?.tools?.find((t) => t.function?.name === "exec_command");
  check("R1 exec_command schema has cmd+command", execTool?.function?.parameters?.properties?.cmd && execTool?.function?.parameters?.properties?.command, JSON.stringify(execTool?.function?.parameters));
  check("R1 end_turn signature appended", up?.tools?.some((t) => t.function?.name === "end_turn"), JSON.stringify(up?.tools?.map((t) => t.function?.name)));
  check("R1 reasoning.effort mapped to reasoning_effort", up?.reasoning_effort === "high", String(up?.reasoning_effort));
  // 注：Codex 请求 effort=xhigh，deepseek-v4-flash 官方 efforts 表 [low,high,max] → clamp-down 到 high（设计行为）
  check("R1 nested reasoning object not forwarded", !("reasoning" in (up || {})), "reasoning in payload");
  check("R1 no _clientTools leak", !("_clientTools" in (up || {})), "client tools leaked");
  for (const k of ["include", "prompt_cache_key", "client_metadata", "text"]) {
    check("R1 dropped field: " + k, !(k in (up || {})), "found " + k);
  }
  const msgs = up?.messages || [];
  check("R1 6 messages (5 system + 1 user)", msgs.length === 6, "count=" + msgs.length);
  check("R1 developer converted to system", msgs.every((m) => m.role !== "developer"), msgs.map((m) => m.role).join(","));
  const firstSysText = Array.isArray(msgs[0]?.content) ? msgs[0].content.map((p) => p.text || "").join("") : String(msgs[0]?.content || "");
  check("R1 first system message has Buffy prefix", firstSysText.startsWith("You are Buffy, the strategic coding assistant."), firstSysText.slice(0, 60));
  check("R1 no empty-content developer residue", !msgs.some((m) => typeof m.content === "string" && m.content === "" && m.role === "system"), "empty residue found");
  const userMsg = msgs[msgs.length - 1];
  const userText = Array.isArray(userMsg?.content) ? userMsg.content.map((p) => p.text).join("") : String(userMsg?.content || "");
  check("R1 user instruction preserved", userText.includes("Use the exec tool to run the command: echo captured-roundtrip"), userText.slice(0, 120));
}

// ---------- R2: turn 1 client-visible output matches the real captured response ----------
{
  const tools = r1.events.filter((e) => e.type === "response.output_item.added" && e.item.type === "custom_tool_call");
  check("R2 exactly one custom_tool_call added", tools.length === 1, JSON.stringify(tools.map((t) => t.item.name)));
  check("R2 added name is exec", tools[0]?.item.name === "exec", tools[0]?.item.name);
  const done = r1.events.filter((e) => e.type === "response.custom_tool_call_input.done");
  // v0.148 移除 tools.shell_command，改用 tools.exec_command({ cmd })，见 execApiFromClient。
  check("R2 input uses exec_command({cmd}) (v0.148 API)", done[0]?.input === textOf("echo captured-roundtrip"), done[0]?.input);
  const completed = r1.events.find((e) => e.type === "response.completed");
  const outTool = completed?.response?.output?.find((o) => o.type === "custom_tool_call");
  check("R2 completed output sanitized", outTool?.input === textOf("echo captured-roundtrip"), JSON.stringify(outTool));
  check("R2 no XML/DSML leak", !JSON.stringify(r1.events).includes("<") && !JSON.stringify(r1.events).includes("DSML"), "");
}

// ---------- R3: turn 2 (multi-turn) upstream translation ----------
const r3 = await replay(turn2.body, [
  chunk({ role: "assistant", content: "The command output was:\n\n```\ncaptured-roundtrip\n```" }),
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } },
]);
{
  const up = r3.upstream;
  check("R3 status 200", r3.status === 200, "status=" + r3.status);
  check("R3 upstream still has exec_command tool", Array.isArray(up?.tools) && up.tools.some((t) => t.function?.name === "exec_command"), JSON.stringify(up?.tools?.map((t) => t.function?.name)));
  const msgs = up?.messages || [];
  const last = msgs[msgs.length - 1];
  const prev = msgs[msgs.length - 2];
  check("R3 last message is tool result", last?.role === "tool" && last?.tool_call_id === "call_imd71vwc", JSON.stringify(last));
  const lastText = String(last?.content || "");
  check("R3 tool result has real stdout", lastText.includes("captured-roundtrip"), lastText.slice(0, 120));
  check("R3 tool result meta stripped (no Script completed)", !lastText.startsWith("Script completed"), lastText.slice(0, 40));
  check("R3 prev message is assistant tool_calls", prev?.role === "assistant" && Array.isArray(prev?.tool_calls), JSON.stringify(prev));
  const fn = prev?.tool_calls?.[0]?.function;
  check("R3 assistant call name exec_command", fn?.name === "exec_command", fn?.name);
  let args = {};
  try { args = JSON.parse(fn?.arguments || "{}"); } catch {}
  check("R3 call args cmd preserved", args.cmd === "echo captured-roundtrip", JSON.stringify(args));
  check("R3 no empty developer residue", !msgs.some((m) => typeof m.content === "string" && m.content === "" && m.role === "system"), "empty residue");
}

// ---------- R4: turn 2 client-visible text output matches real capture ----------
{
  const textDeltas = r3.events.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join("");
  check("R4 text output streamed", textDeltas.includes("captured-roundtrip"), textDeltas);
  check("R4 no XML/DSML leak", !JSON.stringify(r3.events).includes("<") && !JSON.stringify(r3.events).includes("DSML"), "");
  const completed = r3.events.find((e) => e.type === "response.completed");
  const outMsg = completed?.response?.output?.find((o) => o.type === "message");
  check("R4 completed output has message", outMsg?.content?.[0]?.type === "output_text", JSON.stringify(outMsg));
}

// ---------- R5: exec API derived from a v0.148-style exec description (exec_command only) ----------
{
  const body = {
    model: MODEL, stream: true,
    input: [
      {
        type: "additional_tools", role: "developer",
        tools: [{
          type: "namespace", name: "functions", tools: [
            { type: "custom", name: "exec", description: "All nested tools are available on the global `tools` object, for example `await tools.exec_command(...)`.\n\nexec tool declaration:\n```ts\ndeclare const tools: { exec_command(args: { cmd: string; }): Promise<{ output: string }>; };\n```" },
          ],
        }],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] },
    ],
  };
  const { events } = await replay(body, nativeExecStream("dir /b"));
  const done = events.filter((e) => e.type === "response.custom_tool_call_input.done");
  check("R5 v0.148 desc -> exec_command({cmd}) wrapper", done[0]?.input === `text(await tools.exec_command({ cmd: "dir /b" }));`, done[0]?.input);
}

// ---------- R6: exec API derived from a shell_command-only description (legacy v0.147-style) ----------
{
  const body = {
    model: MODEL, stream: true,
    input: [
      {
        type: "additional_tools", role: "developer",
        tools: [{
          type: "namespace", name: "functions", tools: [
            { type: "custom", name: "exec", description: "All nested tools are available on the global `tools` object.\n\n### shell_command\nRuns a Powershell command.\n\ndeclare const tools: { shell_command(args: { command: string; }): Promise<string>; };" },
          ],
        }],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "run tests" }] },
    ],
  };
  const { events } = await replay(body, nativeExecStream("npm test"));
  const done = events.filter((e) => e.type === "response.custom_tool_call_input.done");
  check("R6 shell_command-only desc -> shell_command({command}) wrapper", done[0]?.input === `text(await tools.shell_command({ command: "npm test" }));`, done[0]?.input);
}

// ---------- R7: parser handles v0.148 custom_tool_call input (exec_command({cmd})) ----------
{
  const body = {
    model: MODEL, stream: true,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "re-run" }] },
      { type: "custom_tool_call", call_id: "call_v148_1", name: "exec", input: 'const res = await tools.exec_command({ cmd: "echo v148-capture" });\ntext(JSON.stringify(res));' },
      { type: "custom_tool_call_output", call_id: "call_v148_1", output: [{ type: "input_text", text: '{"exit_code":0,"output":"v148-capture\\r\\n"}' }] },
    ],
  };
  const { upstream } = await replay(body, nativeExecStream("echo v148-capture"));
  const msgs = upstream?.messages || [];
  const prev = msgs[msgs.length - 2];
  const fn = prev?.tool_calls?.[0]?.function;
  let args = {};
  try { args = JSON.parse(fn?.arguments || "{}"); } catch {}
  check("R7 v0.148 input cmd extracted", args.cmd === "echo v148-capture", JSON.stringify(args));
  check("R7 v0.148 tool result kept", String(msgs[msgs.length - 1]?.content).includes("v148-capture"), String(msgs[msgs.length - 1]?.content).slice(0, 80));
}

// ---------- R8: parser still handles legacy shell_command({command}) input ----------
{
  const body = {
    model: MODEL, stream: true,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "run tests" }] },
      { type: "custom_tool_call", call_id: "call_v147_1", name: "exec", input: `text(await tools.shell_command({ command: "npm test" }));` },
      { type: "custom_tool_call_output", call_id: "call_v147_1", output: [{ type: "input_text", text: "ok" }] },
    ],
  };
  const { upstream } = await replay(body, nativeExecStream("npm test"));
  const msgs = upstream?.messages || [];
  const prev = msgs[msgs.length - 2];
  const fn = prev?.tool_calls?.[0]?.function;
  let args = {};
  try { args = JSON.parse(fn?.arguments || "{}"); } catch {}
  check("R8 legacy input cmd extracted", args.cmd === "npm test", JSON.stringify(args));
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n=== ${passed}/${results.length} passed ===`);
process.exit(passed === results.length ? 0 : 1);
