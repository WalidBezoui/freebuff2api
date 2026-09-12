// P10 漂移检查：worker.js 读取的所有 env.* 键必须经 buildWorkerEnv 透传，
// 否则 Vercel Dashboard / .env 的配置会被入口静默丢弃。
// Run: node scripts/check-env.mjs （已接入 npm test）
import { readFileSync } from "node:fs";
import { buildWorkerEnv, workerEnvKeys } from "../load-env.mjs";

const workerSrc = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const used = new Set();
// (?<!\.) 排除 ".env.example" 这类文件名提及（要的是 env.X 读取，不是文件引用）
for (const m of workerSrc.matchAll(/(?<!\.)\benv\.([A-Za-z0-9_]+)/g)) used.add(m[1]);
for (const m of workerSrc.matchAll(/\bprocess\.env\.([A-Za-z0-9_]+)/g)) used.add(m[1]);
// 入口层自用键（server.mjs 日志等）：允许透传但不要求 worker 读取
const ENTRYPOINT_KEYS = new Set(["RELAY_KEY"]);

// 用哨兵值验证每个键都被透传（非硬编码默认值）
const probe = {};
for (const k of used) probe[k] = "sentinel_" + k;
const built = buildWorkerEnv(probe);

const results = [];
const check = (name, cond, detail) => {
  results.push(cond);
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (cond ? "" : "  -> " + (detail || "")));
};

for (const k of [...used].sort()) {
  check("env." + k + " forwarded", built[k] === "sentinel_" + k, "got=" + JSON.stringify(built[k]));
}
// 键表无冗余：列出的每个键 worker 确实在用（入口层自用键除外，防幽灵配置误导用户）
for (const k of workerEnvKeys()) {
  if (ENTRYPOINT_KEYS.has(k)) continue;
  check("key " + k + " actually read by worker", used.has(k), "not found in worker.js");
}
// 两个入口必须走共享 helper（禁止手写白名单回潮）
for (const f of ["api/index.js", "scripts/server.mjs"]) {
  const text = readFileSync(new URL("../" + f, import.meta.url), "utf8");
  check(f + " uses buildWorkerEnv", text.includes("buildWorkerEnv"), "hand-rolled env whitelist?");
}

const failed = results.filter((r) => !r).length;
console.log("\n=== check-env: " + (results.length - failed) + "/" + results.length + " passed ===");
process.exit(failed ? 1 : 0);
