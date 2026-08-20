// 轻量 .env 加载器（仅本地/容器运行需要；Vercel 环境变量来自 Dashboard）。
// 不覆盖已存在的环境变量；解析失败静默忽略。
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export function loadDotEnv(env = process.env) {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const f of [resolve(here, ".env"), resolve(here, ".env.local")]) {
      if (!existsSync(f)) continue;
      const text = readFileSync(f, "utf-8");
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith("#") || t.startsWith(";")) continue;
        const eq = t.indexOf("=");
        if (eq <= 0) continue;
        const k = t.slice(0, eq).trim();
        let v = t.slice(eq + 1).trim();
        if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
        else if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
        if (k && !(k in env)) env[k] = v;
      }
    }
  } catch {}
  return env;
}