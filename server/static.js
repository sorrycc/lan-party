/* Static file handler: serves everything under `root` (path-traversal safe) plus a few aliased files
   that live outside it, such as three.js and cannon-es from node_modules. `mounts` maps a URL prefix to a
   directory outside `root` the same way (three's addons), just as safe against path traversal. */
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export function createStaticHandler({ root, aliases = {}, mounts = {} }) {
  const rootAbs = path.resolve(root);
  const within = (dir, rel) => { const abs = path.resolve(dir), file = path.resolve(abs, rel); return file.startsWith(abs + path.sep) ? file : null; };
  const reply = (res, code, body, type = 'text/plain; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-cache' }); res.end(body); };
  return (req, res) => {
    let url;
    try { url = decodeURIComponent(req.url.split('?')[0]); } catch { return reply(res, 400, 'bad request'); }
    if (url === '/') url = '/index.html';
    if (url === '/favicon.ico') { res.writeHead(204); return res.end(); }
    let file = aliases[url];
    const mount = file ? null : Object.keys(mounts).find(prefix => url.startsWith(prefix));
    if (mount) { file = within(mounts[mount], url.slice(mount.length)); if (!file) return reply(res, 404, 'not found'); }
    if (!file) {
      file = path.resolve(rootAbs, '.' + url);
      if (file !== rootAbs && !file.startsWith(rootAbs + path.sep)) return reply(res, 404, 'not found');
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        if (aliases[url] && err.code === 'ENOENT') return reply(res, 500, `${path.basename(file)} missing - run: npm install`);
        return reply(res, 404, 'not found');
      }
      reply(res, 200, data, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    });
  };
}
