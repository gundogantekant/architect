#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile, writeFile, rename, readdir, stat, mkdir, unlink as unlinkFile } from 'node:fs/promises';
import { createWriteStream, readFileSync, writeFileSync, appendFileSync, renameSync, existsSync } from 'node:fs';
import { join, resolve, extname, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import pty from 'node-pty';
import * as db from './db.mjs';
import { EventStream } from './event-stream.mjs';
import { getAdapter } from './adapters/index.mjs';

import { CLAUDE_BIN, ROOT, PORTFOLIO, LEGACY_PORTFOLIO, WORK, LOGS_DIR, ARCHITECT_KEY, port, VALID_WORK_ITEM_STATUSES, VALID_EPIC_STATUSES, VALID_PRIORITIES, SERVER_START_TIME, DASHCTL_PATH, PID_FILE, LOG_FILE, MIGRATIONS_DIR, TMUX_AVAILABLE, BACKUP_DIR } from './constants.mjs';
import { migrateLegacyPortfolio } from './portfolio-migration.mjs';
import { json, text, err, safe, readJson, listDirs, listFiles, parseBody, isPidAlive, tmuxSessionExists, captureTmuxScrollback, cleanTmuxCapture, termEventLogPath, generateSeedContent, sleep } from './utils.mjs';

import { dispatches, terminals, cliSessions, saveDispatchToDb, saveTerminalToDb, saveCliSessionToDb, archiveSession } from './state.mjs';
import { resolveProjectPath, resolveOrgPath, loadPortfolioContext, loadOrgContext, loadWorkItem, loadResumeContext, topoSort, loadEpicPlanSnippet, selectAgentsForDispatch, buildDispatchPrompt, buildResumePrompt, buildAutoImplementPrompt, buildRefinementPrompt, buildTaskCreationPrompt, buildProjectRefinementPrompt } from './prompt-builder.mjs';

import { wireTerminalHandlers, injectPrompt } from './pty-manager.mjs';
import { syncProjectsFromRegistry, broadcastDispatchLine, broadcastDispatchDone, tailLogFile, restoreSessions, extractStreamText, killProcess, killProcessGraceful, wireDispatchHandlers } from './dispatch-manager.mjs';
import { sweepOrphanedPromptFiles } from './prompt-file.mjs';
import { setupWebSocket } from './ws-router.mjs';

import staticRoutes from './routes/static.mjs';
import detachRoutes from './routes/detach.mjs';
import portfolioRoutes from './routes/portfolio.mjs';
import workItemRoutes from './routes/work-items.mjs';
import approvalRoutes from './routes/approvals.mjs';
import epicRoutes from './routes/epics.mjs';
import sessionRoutes from './routes/sessions.mjs';
import dispatchRoutes from './routes/dispatch.mjs';
import terminalRoutes from './routes/terminal.mjs';
import serverMgmtRoutes from './routes/server-mgmt.mjs';
import syncRoutes from './routes/sync.mjs';
import reposRoutes from './routes/repos.mjs';
import adrsRoutes from './routes/adrs.mjs';
import projectsRoutes from './routes/projects.mjs';
import costsRoutes from './routes/costs.mjs';
import assetsRoutes from './routes/assets.mjs';
import promptsRoutes from './routes/prompts.mjs';
import workItemAssetsRoutes from './routes/work-item-assets.mjs';
import testEndpointRoutes from './routes/test-endpoints.mjs';
import { attemptMerge, isMergeLocked } from './merge.mjs';

const TMP_DIR = join(ROOT, 'tmp');

let syncWarnings = [];

const deps = {
  db, json, text, err, safe, parseBody, readJson, listDirs, listFiles,
  PORTFOLIO, ROOT, WORK, LOGS_DIR, TMP_DIR, ARCHITECT_KEY, port,
  VALID_WORK_ITEM_STATUSES, VALID_EPIC_STATUSES, VALID_PRIORITIES,
  dispatches, terminals, cliSessions,
  wireTerminalHandlers, wireDispatchHandlers, injectPrompt,
  buildDispatchPrompt, buildResumePrompt, buildAutoImplementPrompt, buildRefinementPrompt, buildTaskCreationPrompt, buildProjectRefinementPrompt, resolveProjectPath, resolveOrgPath, loadPortfolioContext, loadOrgContext, loadWorkItem, loadResumeContext, selectAgentsForDispatch, loadEpicPlanSnippet,
  broadcastDispatchLine, broadcastDispatchDone, tailLogFile, killProcess, killProcessGraceful, extractStreamText, syncProjectsFromRegistry, getSyncWarnings: () => syncWarnings,
  saveDispatchToDb, saveTerminalToDb, saveCliSessionToDb, archiveSession,
  restoreSessions,
  termEventLogPath, generateSeedContent, sleep, isPidAlive, tmuxSessionExists, captureTmuxScrollback, cleanTmuxCapture,
  CLAUDE_BIN, TMUX_AVAILABLE, SERVER_START_TIME, DASHCTL_PATH, PID_FILE, LOG_FILE, MIGRATIONS_DIR,
  attemptMerge, isMergeLocked,
  EventStream, getAdapter, pty,
  spawn, execFileSync, readFile, writeFile, readFileSync, writeFileSync, appendFileSync, existsSync, createWriteStream,
  mkdir, stat, join, extname, dirname, homedir, rename, unlinkFile, renameSync, readdir,
  __dirname: import.meta.dirname,
};

const routes = [
  ...staticRoutes(deps),
  ...detachRoutes(deps),
  ...portfolioRoutes(deps),
  ...approvalRoutes(deps),
  ...workItemRoutes(deps),
  ...epicRoutes(deps),
  ...sessionRoutes(deps),
  ...dispatchRoutes(deps),
  ...terminalRoutes(deps),
  ...serverMgmtRoutes(deps),
  ...syncRoutes(deps),
  ...reposRoutes(deps),
  ...adrsRoutes(deps),
  ...projectsRoutes(deps),
  ...costsRoutes(deps),
  ...assetsRoutes(deps),
  ...promptsRoutes(deps),
  ...workItemAssetsRoutes(deps),
  ...(process.env.WORK_DIR ? testEndpointRoutes(deps) : []),
];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  for (const [pattern, method, handler] of routes) {
    const match = path.match(pattern);
    if (match && req.method === method) {
      try {
        await handler(match, req, res);
      } catch (e) {
        err(res, e.code === 'ENOENT' ? 'not found' : e.message, e.code === 'ENOENT' ? 404 : 500);
      }
      return;
    }
  }
  err(res, 'not found');
});

setupWebSocket(server);

// --- Auto-cleanup stale sessions ---
setInterval(async () => {
  // Terminals: check PID/tmux liveness for running without ptyProcess
  for (const [, terminal] of terminals) {
    if (terminal.status === 'running' && !terminal.ptyProcess && !terminal._skipAutoCleanup) {
      const tmuxAlive = terminal.tmux_session && TMUX_AVAILABLE && tmuxSessionExists(terminal.tmux_session);
      const pidAlive = terminal.pid && isPidAlive(terminal.pid);
      if (!tmuxAlive && !pidAlive) {
        terminal.status = 'interrupted';
        terminal.exited_at = new Date().toISOString();
        saveTerminalToDb(terminal).catch(e => console.error('[cleanup] saveTerminalToDb:', e.message));
        archiveSession(terminal, 'terminal').catch(e => console.error('[cleanup] archiveSession:', e.message));
        const intMsg = JSON.stringify({ type: 'exit', code: -1 });
        if (terminal.eventStream) {
          for (const [, sub] of terminal.eventStream.subscribers) {
            try { sub.ws.send(intMsg); sub.ws.close(); } catch {}
          }
          terminal.eventStream.subscribers.clear();
        }
      }
    }
  }

  // Dispatches: check PID liveness for running without process handle
  for (const [, dispatch] of dispatches) {
    if (dispatch.status === 'running' && !dispatch.process && dispatch.pid) {
      if (!isPidAlive(dispatch.pid)) {
        dispatch.status = 'interrupted';
        dispatch.completed_at = new Date().toISOString();
        if (dispatch._tailInterval) { clearInterval(dispatch._tailInterval); dispatch._tailInterval = null; }
        if (dispatch.logStream) { dispatch.logStream.end(); dispatch.logStream = null; }
        saveDispatchToDb(dispatch).catch(e => console.error('[cleanup] saveDispatchToDb:', e.message));
        archiveSession(dispatch, 'dispatch').catch(e => console.error('[cleanup] archiveSession:', e.message));
        broadcastDispatchDone(dispatch);
      }
    }
  }

  // CLI sessions: check PID liveness for running
  for (const [, cli] of cliSessions) {
    if (cli.status === 'running' && !isPidAlive(cli.pid)) {
      cli.status = 'exited';
      cli.exited_at = new Date().toISOString();
      saveCliSessionToDb(cli).catch(e => console.error('[cleanup] saveCliSessionToDb:', e.message));
      archiveSession(cli, 'cli').catch(e => console.error('[cleanup] archiveSession:', e.message));
    }
  }

  // Sessions persist until explicitly dismissed by the user — no auto-cleanup
}, 60 * 1000);

async function shutdownFlush() {
  const now = new Date().toISOString();

  // Dispatches: leave alive processes as running, mark dead ones as interrupted
  for (const [, d] of dispatches) {
    if (d.status !== 'running') continue;
    if (d.pid && isPidAlive(d.pid)) {
      // Process survives — close our handles but leave DB status as running
      if (d.logStream) { d.logStream.end(); d.logStream = null; }
      if (d._tailInterval) { clearInterval(d._tailInterval); d._tailInterval = null; }
    } else {
      d.status = 'interrupted';
      d.completed_at = now;
      saveDispatchToDb(d).catch(e => console.error('[shutdown] saveDispatchToDb failed:', e.message));
      archiveSession(d, 'dispatch').catch(e => console.error('[shutdown] archiveSession failed:', e.message));
    }
  }

  // Terminals: leave alive tmux/PID sessions as running
  for (const [, t] of terminals) {
    if (t.status !== 'running') continue;
    const tmuxAlive = t.tmux_session && TMUX_AVAILABLE && tmuxSessionExists(t.tmux_session);
    const pidAlive = t.pid && isPidAlive(t.pid);
    if (tmuxAlive || pidAlive) {
      // Will be reconnected on restart
    } else {
      t.status = 'interrupted';
      t.exited_at = now;
      saveTerminalToDb(t).catch(e => console.error('[shutdown] saveTerminalToDb failed:', e.message));
      archiveSession(t, 'terminal').catch(e => console.error('[shutdown] archiveSession failed:', e.message));
    }
  }

  await Promise.race([
    db.closeDatabase(),
    new Promise(resolve => setTimeout(resolve, 5000)),
  ]);
}
process.on('SIGTERM', async () => {
  server.close();
  // Flush exit_type = 'interrupted' for all running dispatches that do not have a live PID.
  // Dispatches with live PIDs will be marked by the close handler when they eventually exit.
  // Budget: 3000ms via Promise.allSettled (non-blocking — partial flush is acceptable).
  await Promise.allSettled(
    [...dispatches.values()]
      .filter(d => d.status === 'running' && !(d.pid && isPidAlive(d.pid)))
      .map(d => db.updateDispatchExitType(d.id, 'interrupted').catch(() => {}))
  );
  shutdownFlush().finally(() => process.exit(0));
});
process.on('SIGINT', () => { server.close(); shutdownFlush().finally(() => process.exit(0)); });

async function main() {
  // Phase 0: Backup database (best-effort — do not block startup on failure)
  db.backupDatabase(WORK, BACKUP_DIR).catch(e => console.warn('[backup] pg_dump skipped:', e.message));

  // Phase 1: Database — PostgreSQL health gate + migrations
  try {
    await db.initDatabaseAsync(WORK, MIGRATIONS_DIR);
    console.log('PostgreSQL database ready');
  } catch (e) {
    const connectionCodes = new Set(['ECONNREFUSED', 'ETIMEDOUT', '28P01', '3D000', '57P03']);
    if (connectionCodes.has(e.code) || /not reachable|ECONNREFUSED|ETIMEDOUT/i.test(e.message)) {
      console.error(`PostgreSQL unreachable. Ensure Docker is running: docker compose up -d\nDetails: ${e.message}`);
    } else {
      console.error(`Database initialization failed: ${e.message}`);
    }
    process.exit(1);
  }

  // Data quality: log work items missing e2e_test_criteria that may fail stricter contract validation
  const stale = await db.query(
    `SELECT id, title FROM work_items
     WHERE status IN ('open', 'ready', 'in-progress')
       AND (contract->>'e2e_test_criteria' IS NULL
            OR contract->>'e2e_test_criteria' = '[]'
            OR contract->>'e2e_test_criteria' = 'null')`
  );
  if (stale.rows.length > 0) {
    console.warn(`[contract-quality] ${stale.rows.length} active work item(s) have no e2e_test_criteria and may fail the updated contract validation gate:`);
    for (const row of stale.rows) console.warn(`  ${row.id}: ${row.title}`);
  }

  // Phase 2: Ensure logs directory, tmp directory, and work/assets directory
  await mkdir(LOGS_DIR, { recursive: true });
  await mkdir(TMP_DIR, { recursive: true });
  await mkdir(join(WORK, 'assets'), { recursive: true });

  // On startup, sweep tmp/prompt-*.txt files older than 1 hour
  sweepOrphanedPromptFiles(TMP_DIR).catch(e => console.error('[startup] prompt file sweep:', e.message));

  // Phase 2.5: Sync projects from portfolio registry
  migrateLegacyPortfolio({ legacyPath: LEGACY_PORTFOLIO, targetPath: PORTFOLIO });
  const syncResult = await syncProjectsFromRegistry();
  syncWarnings = syncResult.skippedEntries || [];

  // Phase 3: Restore sessions
  restoreSessions(wireTerminalHandlers, deps);

  // Phase 3.5: Warn about orphaned worktrees
  try {
    const cnt = await db.countOrphanedWorktrees();
    if (cnt > 10) {
      console.warn(`[worktree] ${cnt} orphaned dispatch worktrees detected — consider running /worktree cleanup`);
    }
  } catch {}

  // Phase 4: Start server (PG is healthy — ordering enforced by initDatabaseAsync above)
  server.listen(port, '127.0.0.1', () => {
    console.log(`Dashboard: http://127.0.0.1:${port}`);
  });
}

main().catch(e => {
  console.error('Server startup failed:', e);
  process.exit(1);
});
