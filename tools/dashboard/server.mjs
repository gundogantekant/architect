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

import { CLAUDE_BIN, ROOT, PORTFOLIO, WORK, LOGS_DIR, ARCHITECT_KEY, port, VALID_WORK_ITEM_STATUSES, VALID_EPIC_STATUSES, VALID_PRIORITIES, SERVER_START_TIME, DASHCTL_PATH, PID_FILE, LOG_FILE, MIGRATIONS_DIR, TMUX_AVAILABLE, BACKUP_DIR } from './constants.mjs';
import { json, text, err, safe, readJson, listDirs, listFiles, parseBody, isPidAlive, tmuxSessionExists, captureTmuxScrollback, cleanTmuxCapture, termEventLogPath, generateSeedContent, sleep } from './utils.mjs';

import { dispatches, terminals, cliSessions, saveDispatchToDb, saveTerminalToDb, saveCliSessionToDb, archiveSession } from './state.mjs';
import { resolveProjectPath, resolveOrgPath, loadPortfolioContext, loadOrgContext, loadWorkItem, topoSort, loadEpicPlanSnippet, selectAgentsForDispatch, buildDispatchPrompt } from './prompt-builder.mjs';

import { wireTerminalHandlers, injectPrompt } from './pty-manager.mjs';
import { syncProjectsFromRegistry, broadcastDispatchLine, broadcastDispatchDone, tailLogFile, restoreSessions, extractStreamText, killProcess, killProcessGraceful, wireDispatchHandlers } from './dispatch-manager.mjs';
import { setupWebSocket } from './ws-router.mjs';

import staticRoutes from './routes/static.mjs';
import portfolioRoutes from './routes/portfolio.mjs';
import workItemRoutes from './routes/work-items.mjs';
import epicRoutes from './routes/epics.mjs';
import sessionRoutes from './routes/sessions.mjs';
import dispatchRoutes from './routes/dispatch.mjs';
import terminalRoutes from './routes/terminal.mjs';
import serverMgmtRoutes from './routes/server-mgmt.mjs';
import testEndpointRoutes from './routes/test-endpoints.mjs';

const deps = {
  db, json, text, err, safe, parseBody, readJson, listDirs, listFiles,
  PORTFOLIO, ROOT, WORK, LOGS_DIR, ARCHITECT_KEY, port,
  VALID_WORK_ITEM_STATUSES, VALID_EPIC_STATUSES, VALID_PRIORITIES,
  dispatches, terminals, cliSessions,
  wireTerminalHandlers, wireDispatchHandlers, injectPrompt,
  buildDispatchPrompt, resolveProjectPath, resolveOrgPath, loadPortfolioContext, loadOrgContext, loadWorkItem, selectAgentsForDispatch, loadEpicPlanSnippet,
  broadcastDispatchLine, broadcastDispatchDone, tailLogFile, killProcess, killProcessGraceful, extractStreamText, syncProjectsFromRegistry,
  saveDispatchToDb, saveTerminalToDb, saveCliSessionToDb, archiveSession,
  restoreSessions,
  termEventLogPath, generateSeedContent, sleep, isPidAlive, tmuxSessionExists, captureTmuxScrollback, cleanTmuxCapture,
  CLAUDE_BIN, TMUX_AVAILABLE, SERVER_START_TIME, DASHCTL_PATH, PID_FILE, LOG_FILE, MIGRATIONS_DIR,
  EventStream, getAdapter, pty,
  spawn, execFileSync, readFile, writeFile, readFileSync, writeFileSync, appendFileSync, existsSync, createWriteStream,
  mkdir, stat, join, extname, dirname, homedir, rename, unlinkFile, renameSync, readdir,
  __dirname: import.meta.dirname,
};

const routes = [
  ...staticRoutes(deps),
  ...portfolioRoutes(deps),
  ...workItemRoutes(deps),
  ...epicRoutes(deps),
  ...sessionRoutes(deps),
  ...dispatchRoutes(deps),
  ...terminalRoutes(deps),
  ...serverMgmtRoutes(deps),
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
setInterval(() => {
  const now = Date.now();

  // Terminals: check PID/tmux liveness for running without ptyProcess
  for (const [, terminal] of terminals) {
    if (terminal.status === 'running' && !terminal.ptyProcess && !terminal._skipAutoCleanup) {
      const tmuxAlive = terminal.tmux_session && TMUX_AVAILABLE && tmuxSessionExists(terminal.tmux_session);
      const pidAlive = terminal.pid && isPidAlive(terminal.pid);
      if (!tmuxAlive && !pidAlive) {
        terminal.status = 'interrupted';
        terminal.exited_at = new Date().toISOString();
        saveTerminalToDb(terminal);
        archiveSession(terminal, 'terminal');
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
        saveDispatchToDb(dispatch);
        archiveSession(dispatch, 'dispatch');
        broadcastDispatchDone(dispatch);
      }
    }
  }

  // CLI sessions: check PID liveness for running
  for (const [, cli] of cliSessions) {
    if (cli.status === 'running' && !isPidAlive(cli.pid)) {
      cli.status = 'exited';
      cli.exited_at = new Date().toISOString();
      saveCliSessionToDb(cli);
      archiveSession(cli, 'cli');
    }
  }

  // Sessions persist until explicitly dismissed by the user — no auto-cleanup
}, 60 * 1000);

function shutdownFlush() {
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
      saveDispatchToDb(d);
      archiveSession(d, 'dispatch');
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
      saveTerminalToDb(t);
      archiveSession(t, 'terminal');
    }
  }

  db.closeDatabase();
}
process.on('SIGTERM', () => { shutdownFlush(); process.exit(0); });
process.on('SIGINT', () => { shutdownFlush(); process.exit(0); });

async function main() {
  // Phase 0: Backup database
  db.backupDatabase(WORK, BACKUP_DIR);

  // Phase 1: Database
  try {
    await db.initDatabaseAsync(WORK, MIGRATIONS_DIR);
    console.log('Database ready:', join(WORK, 'architect.db'));
  } catch (e) {
    console.error('Database initialization failed:', e.message);
    process.exit(1);
  }

  // Phase 2: Ensure logs directory
  await mkdir(LOGS_DIR, { recursive: true });

  // Phase 2.5: Sync projects from portfolio registry
  syncProjectsFromRegistry();

  // Phase 3: Restore sessions
  restoreSessions(wireTerminalHandlers);

  // Phase 3.5: Warn about orphaned worktrees
  try {
    const orphans = db.getDb().prepare(
      "SELECT COUNT(*) as cnt FROM dispatches WHERE worktree_path IS NOT NULL AND status != 'running'"
    ).get();
    if (orphans?.cnt > 10) {
      console.warn(`[worktree] ${orphans.cnt} orphaned dispatch worktrees detected — consider running /worktree cleanup`);
    }
  } catch {}

  // Phase 4: Start server
  server.listen(port, '127.0.0.1', () => {
    console.log(`Dashboard: http://127.0.0.1:${port}`);
  });
}

main().catch(e => {
  console.error('Server startup failed:', e);
  process.exit(1);
});
