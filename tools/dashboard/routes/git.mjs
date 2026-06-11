import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const execFileAsync = promisify(execFile);
const HOME = homedir();
const SAFE_ROOTS = [HOME, '/Volumes'];

function isSafePath(resolvedPath) {
  return SAFE_ROOTS.some(root => resolvedPath === root || resolvedPath.startsWith(root + '/'));
}

const RECENT_COMMITS_LIMIT = 10;

export default function gitRoutes(deps) {
  const { json, err, resolveProjectPath } = deps;

  return [
    [/^\/api\/git-log\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)$/, 'GET', async (m, _req, res) => {
      const projectKey = `${m[1]}/${m[2]}/${m[3]}`;

      const projectPath = await resolveProjectPath(projectKey);
      if (!projectPath) return json(res, { commits: [], unavailable: true });

      const resolved = resolve(projectPath);
      if (!isSafePath(resolved)) return err(res, 'forbidden', 403);

      try {
        const { stdout } = await execFileAsync(
          'git',
          ['log', '--format=%h%x1f%an%x1f%aI%x1f%B%x00', `-${RECENT_COMMITS_LIMIT}`],
          { cwd: resolved, encoding: 'utf8', timeout: 5000 }
        );

        const commits = stdout
          .split('\x00')
          .map(r => r.trim())
          .filter(Boolean)
          .map(record => {
            const parts = record.split('\x1f');
            const hash = parts[0];
            const author = parts[1];
            const date = parts[2];
            const message = parts.slice(3).join('\x1f').trim();
            return { hash, message, author, date };
          });

        json(res, { commits });
      } catch (e) {
        if (e.killed || e.code === 'ETIMEDOUT' || e.code === 'ENOENT' || e.code === 128) {
          return json(res, { commits: [], unavailable: true });
        }
        console.error('[git-log] unexpected error for', projectKey, ':', e.message);
        json(res, { commits: [], error: 'unexpected' }, 500);
      }
    }],
  ];
}
