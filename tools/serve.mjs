// A static file server for local use. Blackbar is plain files, but ES modules
// and pdf.js's worker will not load over file://, so opening index.html
// directly does not work — this is the smallest thing that does.
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const port = Number(process.env.PORT || 8017);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

createServer((req, res) => {
  const requested = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const path = join(root, normalize(requested === '/' ? '/index.html' : requested));

  // Refuse anything that escaped the project directory.
  if (!path.startsWith(root)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    if (!statSync(path).isFile()) throw new Error('not a file');
  } catch {
    res.writeHead(404).end('not found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': TYPES[extname(path)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  createReadStream(path).pipe(res);
}).listen(port, () => {
  console.log('Blackbar is at http://localhost:' + port);
});
