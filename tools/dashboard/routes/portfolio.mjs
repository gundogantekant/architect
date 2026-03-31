export default function portfolioRoutes(deps) {
  const { json, text, err, safe, readJson, listDirs, listFiles, readFile, PORTFOLIO, resolveProjectPath, execFileSync, join } = deps;
  return [
    // Registry
    [/^\/api\/registry$/, 'GET', async (_m, _req, res) => {
      json(res, await readJson(join(PORTFOLIO, 'registry.json')));
    }],

    // List orgs
    [/^\/api\/orgs$/, 'GET', async (_m, _req, res) => {
      json(res, await listDirs(PORTFOLIO));
    }],

    // Org detail
    [/^\/api\/org\/([a-zA-Z0-9_-]+)$/, 'GET', async (m, _req, res) => {
      if (!safe(m[1])) return err(res, 'invalid org', 400);
      json(res, await readJson(join(PORTFOLIO, m[1], 'organization.json')));
    }],

    // Org projects
    [/^\/api\/org\/([a-zA-Z0-9_-]+)\/projects$/, 'GET', async (m, _req, res) => {
      if (!safe(m[1])) return err(res, 'invalid org', 400);
      json(res, await listDirs(join(PORTFOLIO, m[1])));
    }],

    // Project files
    [/^\/api\/project\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)$/, 'GET', async (m, _req, res) => {
      if (!safe(m[1]) || !safe(m[2])) return err(res, 'invalid path', 400);
      json(res, await listFiles(join(PORTFOLIO, m[1], m[2])));
    }],

    // Component JSON
    [/^\/api\/component\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/, 'GET', async (m, _req, res) => {
      if (!safe(m[1]) || !safe(m[2]) || !safe(m[3])) return err(res, 'invalid path', 400);
      const name = m[3].endsWith('.json') ? m[3] : m[3] + '.json';
      json(res, await readJson(join(PORTFOLIO, m[1], m[2], name)));
    }],

    // Doc (markdown)
    [/^\/api\/doc\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/, 'GET', async (m, _req, res) => {
      if (!safe(m[1]) || !safe(m[2]) || !safe(m[3])) return err(res, 'invalid path', 400);
      const content = await readFile(join(PORTFOLIO, m[1], m[2], m[3]), 'utf8');
      text(res, content, 'text/plain');
    }],

    // Open PRs for a project (runs gh CLI in the project directory)
    [/^\/api\/project\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)\/prs$/, 'GET', async (m, _req, res) => {
      const projectKey = `${m[1]}/${m[2]}/${m[3]}`;
      const projectPath = await resolveProjectPath(projectKey);
      if (!projectPath) return json(res, []);
      try {
        const result = execFileSync('gh', [
          'pr', 'list', '--json', 'number,title,url,headRefName,author', '--state', 'open',
        ], { cwd: projectPath, encoding: 'utf8', timeout: 15000 });
        json(res, JSON.parse(result));
      } catch {
        json(res, []);
      }
    }],
  ];
}
