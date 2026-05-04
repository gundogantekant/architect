const MIME_TYPES = {
  '.mjs': 'application/javascript',
  '.js': 'application/javascript',
  '.css': 'text/css',
};

export default function staticRoutes(deps) {
  const { readFile, stat, join, __dirname } = deps;
  return [
    // Static: index.html (ETag + no-cache to force Chrome revalidation)
    [/^\/$/, 'GET', async (_m, _req, res) => {
      const htmlPath = join(__dirname, 'index.html');
      const html = await readFile(htmlPath, 'utf8');
      const mtime = (await stat(htmlPath)).mtimeMs;
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-cache, must-revalidate',
        'ETag': `"${mtime.toString(36)}"`,
      });
      res.end(html);
    }],

    // Static: /styles/ files (dashboard CSS, no-cache + ETag)
    [/^\/styles\/([a-zA-Z0-9._-]+\.css)$/, 'GET', async (m, req, res) => {
      const filename = m[1];
      const filePath = join(__dirname, 'styles', filename);
      try {
        const [content, fileStat] = await Promise.all([readFile(filePath), stat(filePath)]);
        const etag = `"${fileStat.mtimeMs}"`;
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304); res.end(); return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/css',
          'Cache-Control': 'no-cache, must-revalidate',
          'ETag': etag,
        });
        res.end(content);
      } catch {
        res.writeHead(404); res.end('Not found');
      }
    }],

    // Static: /vendor/ files (xterm.js bundles, immutable cache)
    [/^\/vendor\/([a-zA-Z0-9._-]+)$/, 'GET', async (m, _req, res) => {
      const filename = m[1];
      const ext = filename.substring(filename.lastIndexOf('.'));
      const mime = MIME_TYPES[ext];
      if (!mime) { res.writeHead(404); res.end('Not found'); return; }
      const filePath = join(__dirname, 'vendor', filename);
      try {
        const content = await readFile(filePath);
        const mtime = (await stat(filePath)).mtimeMs;
        res.writeHead(200, {
          'Content-Type': mime,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'ETag': `"${mtime.toString(36)}"`,
        });
        res.end(content);
      } catch {
        res.writeHead(404); res.end('Not found');
      }
    }],

    // Static: /js/ ES6 modules (no-cache + ETag + 304, consistent with /styles/)
    [/^\/js\/([a-zA-Z0-9._-]+\.mjs)$/, 'GET', async (m, req, res) => {
      const filename = m[1];
      const filePath = join(__dirname, 'js', filename);
      try {
        const [content, fileStat] = await Promise.all([readFile(filePath), stat(filePath)]);
        const etag = `"${fileStat.mtimeMs}"`;
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304); res.end(); return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/javascript',
          'Cache-Control': 'no-cache, must-revalidate',
          'ETag': etag,
        });
        res.end(content);
      } catch {
        res.writeHead(404); res.end('Not found');
      }
    }],
  ];
}
