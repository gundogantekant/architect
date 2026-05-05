export default function detachRoutes(deps) {
  const {
    db, json, err, safe, parseBody,
    PORTFOLIO, dispatches, killProcessGraceful,
    readFile, writeFile, rename, unlinkFile, mkdir,
    join, execFileSync,
  } = deps;

  return [
    [/^\/api\/portfolio\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/, 'DELETE', async (m, req, res) => {
      const [, org, project, component] = m;
      if (!safe(org) || !safe(project) || !safe(component)) return err(res, 'invalid path segment', 400);

      const portfolioKey = `${org}/${project}/${component}`;
      const entryPath = join(PORTFOLIO, org, project, component + '.json');

      let entry;
      try {
        entry = JSON.parse(await readFile(entryPath, 'utf8'));
      } catch (e) {
        if (e.code === 'ENOENT') return err(res, 'portfolio entry not found', 404);
        throw e;
      }

      const body = await parseBody(req).catch(() => ({}));
      const opts = {
        cancel_work_items: body.cancel_work_items !== false,
        archive_work_items: body.archive_work_items !== false,
        remove_claude_md: body.remove_claude_md !== false,
        unlink_repo_sync: body.unlink_repo_sync !== false,
        kill_active_dispatches: body.kill_active_dispatches !== false,
        remove_worktrees: body.remove_worktrees === true,
      };

      const runningDispatches = [...dispatches.values()].filter(
        d => d.project_key === portfolioKey && d.status === 'running'
      );

      if (!opts.kill_active_dispatches && runningDispatches.length > 0) {
        return err(res, `${runningDispatches.length} active dispatch(es) running; set kill_active_dispatches: true or kill them first`, 409);
      }

      const steps = {
        portfolio_json_removed: false,
        registry_entry_removed: false,
        project_row_deleted: false,
        work_items_cancelled: { count: 0, ids: [] },
        work_items_archived: { count: 0 },
        claude_md_removed: opts.remove_claude_md ? false : null,
        repo_sync_unlinked: null,
        dispatches_killed: { count: 0, ids: [] },
        worktrees_removed: { count: 0, paths: [] },
      };
      const errors = [];

      // Kill running dispatches
      if (opts.kill_active_dispatches) {
        for (const d of runningDispatches) {
          if (d.process) {
            try { killProcessGraceful(d.process); } catch {}
          }
          steps.dispatches_killed.count++;
          steps.dispatches_killed.ids.push(d.id);
        }
      }

      // Remove worktrees
      if (opts.remove_worktrees) {
        const allDispatches = await db.getDispatchesByProjectKey(portfolioKey).catch(() => []);
        for (const d of allDispatches) {
          if (!d.worktree_path) continue;
          try {
            execFileSync('git', ['worktree', 'remove', '--force', d.worktree_path], { stdio: 'ignore' });
            steps.worktrees_removed.count++;
            steps.worktrees_removed.paths.push(d.worktree_path);
          } catch (e) {
            errors.push(`worktreeRemove(${d.worktree_path}): ${e.message}`);
          }
        }
      }

      // DB transaction: cancel work items, archive done work items, unlink repo sync
      try {
        if (opts.cancel_work_items) {
          const cancelled = await db.cancelWorkItemsByProjectKey(portfolioKey);
          steps.work_items_cancelled = { count: cancelled.length, ids: cancelled };
        }
        if (opts.archive_work_items) {
          const archived = await db.archiveWorkItemsByProjectKey(portfolioKey);
          steps.work_items_archived = { count: archived.length };
        }
        if (opts.unlink_repo_sync) {
          const repoRows = await db.getRepoSyncConfigsByGithubOrg(org).catch(() => []);
          const linked = repoRows.find(r => r.portfolio_key === portfolioKey);
          if (linked) {
            await db.unlinkRepoByPortfolioKey(portfolioKey);
            steps.repo_sync_unlinked = { repo: linked.github_repo_name };
          }
        }
      } catch (e) {
        errors.push(`dbTransaction: ${e.message}`);
      }

      // Delete project row
      try {
        await db.deleteProjectRow(portfolioKey);
        steps.project_row_deleted = true;
      } catch (e) {
        errors.push(`deleteProjectRow: ${e.message}`);
      }

      // Remove CLAUDE.md
      if (opts.remove_claude_md && entry.path) {
        try {
          await unlinkFile(join(entry.path, 'CLAUDE.md'));
          steps.claude_md_removed = true;
        } catch (e) {
          if (e.code === 'ENOENT') {
            steps.claude_md_removed = true;
          } else {
            errors.push(`claudeMdRemove: ${e.message}`);
            steps.claude_md_removed = false;
          }
        }
      }

      // Delete portfolio JSON
      try {
        await unlinkFile(entryPath);
        steps.portfolio_json_removed = true;
      } catch (e) {
        errors.push(`portfolioJsonRemove: ${e.message}`);
      }

      // Atomic registry update: read → delete key → write to tmp → rename
      try {
        const regPath = join(PORTFOLIO, 'registry.json');
        let registry = {};
        try { registry = JSON.parse(await readFile(regPath, 'utf8')); } catch {}
        const pathKey = Object.keys(registry).find(k => registry[k] === portfolioKey);
        if (pathKey) {
          delete registry[pathKey];
          const tmpPath = regPath + '.tmp';
          await writeFile(tmpPath, JSON.stringify(registry, null, 2));
          await rename(tmpPath, regPath);
          steps.registry_entry_removed = true;
        } else {
          steps.registry_entry_removed = true;
        }
      } catch (e) {
        errors.push(`registryUpdate: ${e.message}`);
      }

      json(res, { portfolio_key: portfolioKey, steps, errors });
    }],
  ];
}
