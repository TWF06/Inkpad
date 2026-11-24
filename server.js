// Tiny zero-dependency static server: `node server.js` → http://localhost:5173
// For local use and testing. To publish, upload the files listed in README ("Publish") to a static HTTPS host.
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = Number(process.env.PORT) || 5173;
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};
// only the app itself is served: not server code, package files, docs or editor settings
const PUBLIC = ['index.html', 'styles.css', 'icon.svg', 'manifest.webmanifest', 'sw.js', 'src', 'vendor'];

http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end('Bad request'); }
  if (p === '/') p = '/index.html';
  const file = path.resolve(root, '.' + path.posix.normalize(p));
  const rel = path.relative(root, file);
  if (p.includes('\0') || rel.startsWith('..') || path.isAbsolute(rel) || !PUBLIC.includes(rel.split(path.sep)[0])) {
    res.writeHead(404); return res.end('Not found');
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}).listen(port, () => console.log(`Inkpad running at http://localhost:${port}`));
