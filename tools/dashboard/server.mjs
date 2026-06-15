#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile, writeFile, rename, readdir, stat, mkdir, unlink as unlinkFile } from 'node:fs/promises';
import { createWriteStream, readFileSync, writeFileSync, appendFileSync, renameSync, existsSync } from 'node:fs';
import { join, resolve, extname, dirname } from 'node:path';
import { homedir, networkInterfaces } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import pty from 'node-pty';
import * as db from './db.mjs';
import { buildPrefixCache } from './portfolio-config.mjs';
import { EventStream } from './event-stream.mjs';
import { getAdapter } from './adapters/index.mjs';

import { CLAUDE_BIN, ROOT, PORTFOLIO, LEGACY_PORTFOLIO, WORK, LOGS_DIR, ARCHITECT_KEY, port, VALID_WORK_ITEM_STATUSES, VALID_EPIC_STATUSES, VALID_PRIORITIES, SERVER_START_TIME, DASHCTL_PATH, PID_FILE, LOG_FILE, MIGRATIONS_DIR, TMUX_AVAILABLE, BACKUP_DIR, DEFAULT_HOST, resolveAccessConfig } from './constants.mjs';
import { migrateLegacyPortfolio } from './portfolio-migration.mjs';
import { json, text, err, safe, readJson, listDirs, listFiles, parseBody, isPidAlive, tmuxSessionExists, captureTmuxScrollback, cleanTmuxCapture, tmuxCapturePane, tmuxPasteStdin, tmuxClearInput, tmuxSendEnter, termEventLogPath, generateSeedContent, sleep } from './utils.mjs';

import { dispatches, terminals, cliSessions, saveDispatchToDb, saveTerminalToDb, saveCliSessionToDb, archiveSession } from './state.mjs';
import { resolveProjectPath, resolveOrgPath, loadPortfolioContext, loadOrgContext, loadWorkItem, loadResumeContext, topoSort, loadEpicPlanSnippet, selectAgentsForDispatch, buildDispatchPrompt, buildResumePrompt, buildAutoImplementPrompt, buildRefinementPrompt, buildTaskCreationPrompt, buildProjectRefinementPrompt } from './prompt-builder.mjs';

import { wireTerminalHandlers, injectPrompt, injectIntoTerminal, terminalEvents } from './pty-manager.mjs';
import { startTelegramBridge } from './telegram/bridge.mjs';
import { createTelegramClient } from './telegram/client.mjs';
import { createQuestionDetector } from './telegram/detector.mjs';
import { startInjection } from './injection/index.mjs';
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
import gitRoutes from './routes/git.mjs';
import testEndpointRoutes from './routes/test-endpoints.mjs';
import * as blocklist from './lib/blocklist.mjs';
import { evaluateRequest } from './lib/access-guard.mjs';
import accessRoutes from './routes/access.mjs';
import telegramRoutes from './routes/telegram.mjs';
import { attemptMerge, isMergeLocked } from './merge.mjs';

const TMP_DIR = join(ROOT, 'tmp');

function normalizeIp(ip) {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

// IPv4 addresses assigned to this host's non-internal interfaces. Used both for the
// startup no-auth warning (which LAN IP to surface) and for the access guard (a request
// whose Host header names one of our own LAN IPs is legitimate).
function serverLanIpv4s() {
  const ips = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) ips.push(addr.address);
    }
  }
  return ips;
}

const SERVER_LAN_IPS = serverLanIpv4s();
const ACCESS_CONFIG = resolveAccessConfig();

// Test-only hook: the access guard exempts loopback as the recovery path, which makes the
// Host/Origin denial branches unreachable from a loopback test client. When running under
// NODE_ENV=test, a spec may set ARCHITECT_GUARD_DISABLE_LOOPBACK_EXEMPT=1 to treat the
// loopback test client as remote so those branches can be exercised. Never active in prod.
const GUARD_DISABLE_LOOPBACK_EXEMPT =
  process.env.NODE_ENV === 'test' && process.env.ARCHITECT_GUARD_DISABLE_LOOPBACK_EXEMPT === '1';
const guardIsLoopback = GUARD_DISABLE_LOOPBACK_EXEMPT ? () => false : blocklist.isLoopback;
const LAN_EXPOSED = DEFAULT_HOST !== '127.0.0.1' && DEFAULT_HOST !== 'localhost' && DEFAULT_HOST !== '::1';
const LAN_URL = LAN_EXPOSED ? `http://${SERVER_LAN_IPS[0] || DEFAULT_HOST}:${port}` : null;

let syncWarnings = [];
let telegramHandle = null;

const deps = {
  db, json, text, err, safe, parseBody, readJson, listDirs, listFiles,
  PORTFOLIO, ROOT, WORK, LOGS_DIR, TMP_DIR, ARCHITECT_KEY, port,
  VALID_WORK_ITEM_STATUSES, VALID_EPIC_STATUSES, VALID_PRIORITIES,
  dispatches, terminals, cliSessions,
  wireTerminalHandlers, wireDispatchHandlers, injectPrompt, startInjection,
  tmuxCapturePane, tmuxPasteStdin, tmuxClearInput, tmuxSendEnter,
  buildDispatchPrompt, buildResumePrompt, buildAutoImplementPrompt, buildRefinementPrompt, buildTaskCreationPrompt, buildProjectRefinementPrompt, resolveProjectPath, resolveOrgPath, loadPortfolioContext, loadOrgContext, loadWorkItem, loadResumeContext, selectAgentsForDispatch, loadEpicPlanSnippet,
  broadcastDispatchLine, broadcastDispatchDone, tailLogFile, killProcess, killProcessGraceful, extractStreamText, syncProjectsFromRegistry, getSyncWarnings: () => syncWarnings,
  saveDispatchToDb, saveTerminalToDb, saveCliSessionToDb, archiveSession,
  restoreSessions,
  termEventLogPath, generateSeedContent, sleep, isPidAlive, tmuxSessionExists, captureTmuxScrollback, cleanTmuxCapture,
  CLAUDE_BIN, TMUX_AVAILABLE, SERVER_START_TIME, DASHCTL_PATH, PID_FILE, LOG_FILE, MIGRATIONS_DIR,
  bindHost: DEFAULT_HOST, lanExposed: LAN_EXPOSED, lanUrl: LAN_URL,
  attemptMerge, isMergeLocked,
  blocklist,
  EventStream, getAdapter, pty,
  spawn, execFileSync, readFile, writeFile, readFileSync, writeFileSync, appendFileSync, existsSync, createWriteStream,
  mkdir, stat, join, extname, dirname, homedir, rename, unlinkFile, renameSync, readdir,
  __dirname: import.meta.dirname,
  buildPrefixCache,
  getTelegramHandle: () => telegramHandle,
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
  ...gitRoutes(deps),
  ...(process.env.WORK_DIR ? testEndpointRoutes(deps) : []),
  ...accessRoutes(deps),
  ...telegramRoutes(deps),
];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  // Access-control identity MUST come from the socket peer (req.socket.remoteAddress),
  // never from X-Forwarded-For or any client-supplied header: this server binds directly,
  // so the socket peer is trustworthy while forwarded headers are spoofable. If a trusted
  // reverse proxy is ever introduced, add an explicit trusted-proxy allowlist before using
  // forwarded headers — otherwise any LAN client could forge 127.0.0.1 and bypass this.
  const clientIp = normalizeIp(req.socket.remoteAddress ?? '');
  // Defence-in-depth access guard: loopback exemption (guaranteed recovery path),
  // Host-header validation (DNS-rebinding), optional IP allow-list, blocklist deny-list,
  // and same-origin enforcement for mutating methods (CSRF). The guard is pure — the
  // stateful blocklist lookups are injected here. See lib/access-guard.mjs.
  const verdict = evaluateRequest(
    {
      clientIp,
      host: req.headers.host,
      origin: req.headers.origin || req.headers.referer,
      method: req.method,
      path,
    },
    {
      allowedHosts: ACCESS_CONFIG.allowedHosts,
      allowIps: ACCESS_CONFIG.allowIps,
      serverLanIps: SERVER_LAN_IPS,
      isBlocked: blocklist.isBlocked,
      isLoopback: guardIsLoopback,
      normalizeIp,
    },
  );
  if (!verdict.allow) {
    res.writeHead(verdict.status || 403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden', reason: verdict.reason }));
    return;
  }

  res.on('finish', () => {
    db.logAccess(clientIp, path, req.method, res.statusCode)
      .catch(e => console.warn('[access_log] write failed:', e.message));
  });

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

// WebSocket access guard: validate Origin (and client IP) on the upgrade BEFORE the
// ws-router handler runs. Registered first so a rejected upgrade destroys the socket; the
// ws-router handler bails out on an already-destroyed socket. Loopback clients are exempt
// (same recovery guarantee as the HTTP guard).
server.on('upgrade', (req, socket) => {
  const clientIp = normalizeIp(req.socket.remoteAddress ?? '');
  if (blocklist.isLoopback(clientIp)) return;
  const verdict = evaluateRequest(
    {
      clientIp,
      host: req.headers.host,
      // Treat an upgrade as a mutating action so the Origin is enforced when present.
      origin: req.headers.origin || req.headers.referer,
      method: 'POST',
      path: req.url,
    },
    {
      allowedHosts: ACCESS_CONFIG.allowedHosts,
      allowIps: ACCESS_CONFIG.allowIps,
      serverLanIps: SERVER_LAN_IPS,
      isBlocked: blocklist.isBlocked,
      isLoopback: guardIsLoopback,
      normalizeIp,
    },
  );
  if (!verdict.allow) {
    try { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); } catch {}
    socket.destroy();
  }
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

  try { telegramHandle?.stop(); } catch {}

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

async function readTelegramConfig() {
  const enabled = (await db.getPreference('telegram_enabled')) === 'true';
  const trigger = (await db.getPreference('telegram_trigger')) || 'questions';
  const rawAllowlist = await db.getPreference('telegram_allowlist');
  const defaultChat = await db.getPreference('telegram_default_chat_id');
  let allowlist = [];
  if (rawAllowlist) {
    try { allowlist = JSON.parse(rawAllowlist); } catch { allowlist = []; }
  }
  return {
    enabled,
    trigger,
    allowlist: Array.isArray(allowlist) ? allowlist.map(Number) : [],
    default_chat_id: defaultChat ? Number(defaultChat) : null,
  };
}

async function startTelegramBridgeIfConfigured() {
  const token = process.env.ARCHITECT_TELEGRAM_BOT_TOKEN;
  const config = await readTelegramConfig();
  if (!token || !config.enabled) return;
  const client = createTelegramClient(token, {});
  telegramHandle = startTelegramBridge({
    client,
    terminals,
    injectIntoTerminal,
    terminalEvents,
    makeDetector: ({ onNeedsInput, onCleared }) =>
      createQuestionDetector({ tmuxCapturePane, onNeedsInput, onCleared }),
    db,
    config,
  });
}

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

  try {
    await blocklist.load(db.getPool());
    console.log('IP blocklist loaded');
  } catch (e) {
    console.error(`Fatal: failed to load IP blocklist: ${e.message}`);
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
  const prefixMap = await buildPrefixCache(PORTFOLIO);
  db.configurePrefixMap(prefixMap);
  const syncResult = await syncProjectsFromRegistry();
  syncWarnings = syncResult.skippedEntries || [];

  // Phase 3: Restore sessions
  restoreSessions(wireTerminalHandlers, deps);

  // Phase 3.4: Start Telegram bridge if a token is present and the feature is enabled.
  // Routes are always registered (status returns running:false when no bridge is active).
  await startTelegramBridgeIfConfigured();

  // Phase 3.5: Warn about orphaned worktrees
  try {
    const cnt = await db.countOrphanedWorktrees();
    if (cnt > 10) {
      console.warn(`[worktree] ${cnt} orphaned dispatch worktrees detected — consider running /worktree cleanup`);
    }
  } catch {}

  // Phase 4: Start server (PG is healthy — ordering enforced by initDatabaseAsync above)
  server.listen(port, DEFAULT_HOST, () => {
    console.log(`Dashboard: http://${DEFAULT_HOST}:${port}`);
    if (LAN_EXPOSED) {
      const lanIp = SERVER_LAN_IPS[0] || DEFAULT_HOST;
      console.warn('');
      console.warn('============================================================');
      console.warn('  WARNING: Dashboard is bound to the LAN with NO authentication.');
      console.warn(`  Reachable at: http://${lanIp}:${port}  (bind ${DEFAULT_HOST})`);
      console.warn('  Dispatch + terminal = remote code execution, NO authentication.');
      console.warn('  Expose only on a trusted LAN. To restrict to loopback, set');
      console.warn('  ARCHITECT_LOOPBACK_ONLY=1 (or DASHCTL_LOOPBACK_ONLY=1 via dashctl).');
      console.warn('============================================================');
      console.warn('');
    }
  });
}

main().catch(e => {
  console.error('Server startup failed:', e);
  process.exit(1);
});
