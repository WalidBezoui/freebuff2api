import worker from '../worker.js';

export default async function handler(req, res) {
  const handlerFunc = worker.default ? worker.default.fetch : worker.fetch;

  const env = {
    FREEBUFF_TOKEN: process.env.FREEBUFF_TOKEN || '',
    FREEBUFF_API_KEY: process.env.FREEBUFF_API_KEY || 'freebuff-default-key',
    FREEBUFF_DEBUG: process.env.FREEBUFF_DEBUG || 'false',
    CODEBUFF_API: process.env.CODEBUFF_API || '',
    RELAY_KEY: process.env.RELAY_KEY || '',
  };

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  const host = req.headers.host || 'localhost';
  const url = `https://${host}${req.url}`;
  const request = new Request(url, {
    method: req.method,
    headers: new Headers(req.headers),
    body: body.length > 0 ? body : null,
  });

  try {
    const response = await handlerFunc(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) res.write(Buffer.from(value));
      }
    }
    res.end();
  } catch (err) {
    console.error('Vercel handler error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message || 'Internal Error' } });
    } else {
      res.end();
    }
  }
}
