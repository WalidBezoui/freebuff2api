/**
 * CI 前置校验：确认 test/fixtures/codex-captures/*.json 都能被 loadCapture 解析。
 * 防止 BOM/坏 JSON 溜进仓库后，test-codex-replay.mjs 在 CI（无 scratch 目录）静默 exit(2)。
 * Run: node scripts/check-fixtures.mjs
 */
import { readFileSync, readdirSync } from "node:fs";

const dir = new URL("../test/fixtures/codex-captures/", import.meta.url);
const files = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).sort();
let ok = 0;
const bad = [];
for (const f of files) {
  try {
    const outer = readFileSync(new URL(f, dir), "utf8").replace(/^\uFEFF/, "");
    const w = JSON.parse(outer);
    JSON.parse(String(w.bodyRaw).replace(/^\uFEFF/, ""));
    if (!w.url) throw new Error("missing url");
    ok++;
  } catch (e) {
    bad.push(f + " (" + e.message.slice(0, 60) + ")");
  }
}
if (bad.length) {
  console.error("FIXTURE CHECK FAILED (" + bad.length + "/" + files.length + "):\n  " + bad.join("\n  "));
  process.exit(1);
}
console.log("fixture check ok: " + ok + "/" + files.length + " parse");