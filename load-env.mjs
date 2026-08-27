// 轻量 .env 加载器（仅本地/容器运行需要；Vercel 环境变量来自 Dashboard）。
// 不覆盖已存在的环境变量；解析失败静默忽略。
// 修复：正确处理值中含 =、引号内空格/逗号、转义引号；Windows OneDrive 路径兼容。
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function stripOuterQuotes(v) {
  if (v.length < 2) return v;
  const first = v[0], last = v[v.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    const inner = v.slice(1, -1);
    // 反转义：先占位 \\ 避免与 \" 冲突
    return inner.replace(/\\\\/g, "\x00").replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\x00/g, "\\").replace(/\\n/g, "\n");
  }
  return v;
}

export function loadDotEnv(env = process.env) {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const f of [resolve(here, ".env"), resolve(here, ".env.local")]) {
      if (!existsSync(f)) continue;
      const text = readFileSync(f, "utf-8");
      for (const raw of text.split(/\r?\n/)) {
        // 保留行首缩进剥离后，值内空格不丢失（仅剥离键周围空白）
        const trimmed = raw.trim();
        if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
        // 去除行尾注释：按字符扫描，精确判断引号内 #（修复 M1：首次出现不在引号外时不误判）
        let line = trimmed;
        let inSingle = false, inDouble = false, esc = false, cutAt = -1;
        for (let i = 0; i < line.length - 1; i++) {
          const ch = line[i], nxt = line[i + 1];
          if (esc) { esc = false; continue; }
          if (ch === "\\") { esc = true; continue; }
          if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
          if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
          if (!inSingle && !inDouble && ch === " " && nxt === "#") { cutAt = i; break; }
        }
        if (cutAt > 0) line = line.slice(0, cutAt).trimEnd();
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const k = line.slice(0, eq).trim();
        if (!k || /[^A-Za-z0-9_]/.test(k)) continue;
        let v = line.slice(eq + 1).trim();
        v = stripOuterQuotes(v);
        if (k && !(k in env)) env[k] = v;
      }
    }
  } catch {}
  return env;
}