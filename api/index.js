import worker from '../worker.js';
import { loadDotEnv } from '../load-env.mjs';

loadDotEnv();

export default async function handler(req, res) {
  const handlerFunc = worker.default ? worker.default.fetch : worker.fetch;

  const env = {
    FREEBUFF_TOKEN: process.env.FREEBUFF_TOKEN || '',
    // 不设默认密钥：未配置时所有请求 fail-closed（worker.getApiKey 返回 null → 401）。
    FREEBUFF_API_KEY: (process.env.FREEBUFF_API_KEY || '').trim(),
    FREEBUFF_DEBUG: process.env.FREEBUFF_DEBUG || 'false',
    CODEBUFF_API: process.env.CODEBUFF_API || '',
    RELAY_KEY: process.env.RELAY_KEY || '',
    FREEBUFF_MAX_TOOL_OUTPUT: process.env.FREEBUFF_MAX_TOOL_OUTPUT || '',
  };

  const abortCtrl = new AbortController();
  const onClose = () => { try { abortCtrl.abort(new Error("client disconnect")); } catch {} };
  // Vercel Node req 是可读流，支持 close 事件
  if (req && typeof req.on === "function") req.on("close", onClose);
  let body;
  try {
    const chunks = [];
    let total = 0;
    const MAX_BODY = 1024 * 1024;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_BODY) {
        if (!res.headersSent) res.status(413).json({ error: { message: "Request body too large (limit " + MAX_BODY + " bytes)", type: "invalid_request_error" } });
        else res.end();
        try { req.destroy(); } catch {}
        return;
      }
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  } catch (e) {
    if (!res.headersSent) res.status(400).json({ error: { message: "Invalid request body", type: "parse_error" } });
    else res.end();
    return;
  }

  const host = req.headers.host || 'localhost';
  const url = `https://${host}${req.url}`;
  const request = new Request(url, {
    method: req.method,
    headers: new Headers(req.headers),
    body: body.length > 0 ? body : null,
    signal: abortCtrl.signal,
  });

  try {
    const response = await handlerFunc(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          if (abortCtrl.signal.aborted) { try { await reader.cancel(abortCtrl.signal.reason); } catch {} break; }
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            if (abortCtrl.signal.aborted) break;
            const ok = res.write(Buffer.from(value));
            if (!ok) {
              await Promise.race([
                new Promise((r) => res.once("drain", r)),
                new Promise((r) => {
                  const onAbort = () => r();
                  abortCtrl.signal.addEventListener("abort", onAbort, { once: true });
                  res.once("close", onAbort);
                }),
              ]);
              if (abortCtrl.signal.aborted) break;
            }
          }
        }
      } catch (e) {
        try { await reader.cancel(e).catch(() => {}); } catch {}
      }
    }
    res.end();
  } catch (err) {
    if (abortCtrl.signal.aborted) { try { res.end(); } catch {} return; }
    console.error('Vercel handler error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message || 'Internal Error' } });
    } else {
      res.end();
    }
  } finally {
    if (req && typeof req.off === "function") req.off("close", onClose);
  }
}
