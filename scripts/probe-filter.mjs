import { readFileSync } from "node:fs";

let src = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const start = src.indexOf("class StreamingXmlFilter");
const end = src.indexOf("function getVisibleCleanText", start);
const cls = src.slice(start, end);
const SUPPRESSED_TAG_NAMES = new Set(["tool_calls","tool_call","invoke","parameter","commentary","thought","thinking","function_calls","tool_response","exec_command","exec","bash","cmd","command","read_file","write_file","apply_patch","patch","read","shell_command","run_command","terminal"]);
const STRIP_TAGS = new Set(["attempt_completion","result"]);
const factory = new Function("SUPPRESSED_TAG_NAMES", "STRIP_TAGS", cls + "; return StreamingXmlFilter;");
const StreamingXmlFilter = factory(SUPPRESSED_TAG_NAMES, STRIP_TAGS);

const cases = [
  ["F1 closing leak", "<attempt_completion><result>42 files</result></attempt_completion>", "42 files"],
  ["F1 stray invoke close", "answer</invoke>rest", "answerrest"],
  ["F1 chunk-split closing part1", "<attempt_completion><result>hi", "hi"],
  ["F2 mismatched close", "pre<invoke><parameter name=\"cmd\">x</invoke>post", "pre"],
  ["F2 nested proper", "a<invoke><parameter name=\"cmd\">x</parameter></invoke>b", "ab"],
  ["F2 self-closing", "a<invoke/>b", "ab"],
  ["literal comparison", "x < 5 y", "x < 5 y"],
  ["literal <=", "if (a <= b) c", "if (a <= b) c"],
  ["chunk-boundary tag", "<attempt_completion><re" + "sult>hi</result></attempt_completion>", "hi"],
];

let pass = 0;
for (const [name, input, expect] of cases) {
  const f = new StreamingXmlFilter();
  let out = "";
  for (const ch of input) out += f.feed(ch);
  out += f.flush();
  const ok = out === expect;
  if (ok) pass++;
  console.log((ok ? "PASS" : "FAIL") + "  " + name + "  got=" + JSON.stringify(out) + " want=" + JSON.stringify(expect));
}
console.log(`\n${pass}/${cases.length} filter probes passed`);
process.exit(pass === cases.length ? 0 : 1);