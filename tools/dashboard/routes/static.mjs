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
  ];
}
