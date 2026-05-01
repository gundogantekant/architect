#!/usr/bin/env node
/**
 * One-shot idempotent migration from SQLite work/architect.db to PostgreSQL.
 *
 * Usage:
 *   node scripts/migrate-sqlite-to-pg.mjs [--sqlite-path path] [--dry-run]
 *
 * Reads the SQLite database read-only and inserts all rows into PostgreSQL via
 * UPSERT. After migration, resequences sequences.next_val to MAX(id)+1 for
 * work_items and epics. Reports per-table row counts (SQLite vs PG) for
 * verification.
 */

import Database from 'better-sqlite3';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';

// Return TIMESTAMPTZ values as ISO strings to match db.mjs behaviour.
pg.types.setTypeParser(1114, (val) => val);
pg.types.setTypeParser(1184, (val) => val);

// ── CLI args ─────────────────────────────────────────────────────────────────

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SQLITE = join(ROOT, 'work', 'architect.db');

const args = process.argv.slice(2);
let sqlitePath = DEFAULT_SQLITE;
let dryRun = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--sqlite-path' && args[i + 1]) sqlitePath = args[++i];
  if (args[i] === '--dry-run') dryRun = true;
}

if (!existsSync(sqlitePath)) {
  console.error(`SQLite database not found: ${sqlitePath}`);
  process.exit(1);
}

// ── PG connection ─────────────────────────────────────────────────────────────

function buildPgConfig() {
  return {
    host: process.env.ARCHITECT_PG_HOST ?? '127.0.0.1',
    port: parseInt(process.env.ARCHITECT_PG_PORT ?? '5432', 10),
    database: process.env.ARCHITECT_PG_DB ?? 'architect',
    user: process.env.ARCHITECT_PG_USER ?? 'architect',
    password: process.env.ARCHITECT_PG_PASSWORD,
    connectionTimeoutMillis: 5000,
    statementTimeout: 30000,
  };
}

// ── Type helpers ──────────────────────────────────────────────────────────────

function toBool(val) {
  if (val === null || val === undefined) return null;
  return Boolean(val);
}

function toJsonb(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') return JSON.parse(val);
  return val;
}

// ── Table definitions (import order respects FK dependencies) ─────────────────

const TABLES = [
  { name: 'sequences',          pk: 'name',         importFn: migrateSequences },
  { name: 'projects',           pk: 'key',          importFn: migrateProjects },
  { name: 'preferences',        pk: 'key',          importFn: migratePreferences },
  { name: 'schema_migrations',  pk: 'version',      importFn: migrateSchemaMigrations },
  { name: 'epics',              pk: 'id',           importFn: migrateEpics },
  { name: 'work_items',         pk: 'id',           importFn: migrateWorkItems },
  { name: 'work_item_logs',     pk: 'id',           importFn: migrateWorkItemLogs },
  { name: 'work_item_approvals',pk: 'id',           importFn: migrateWorkItemApprovals },
  { name: 'epic_logs',          pk: 'id',           importFn: migrateEpicLogs },
  { name: 'dispatches',         pk: 'id',           importFn: migrateDispatches },
  { name: 'terminals',          pk: 'id',           importFn: migrateTerminals },
  { name: 'cli_sessions',       pk: 'id',           importFn: migrateCliSessions },
  { name: 'session_history',    pk: 'id',           importFn: migrateSessionHistory },
  { name: 'knowledge_syncs',    pk: 'id',           importFn: migrateKnowledgeSyncs },
  { name: 'change_log_entries', pk: 'id',           importFn: migrateChangeLogEntries },
];

// ── Per-table migrators ───────────────────────────────────────────────────────

async function migrateSequences(sqlite, pgClient) {
  const rows = sqlite.prepare('SELECT * FROM sequences').all();
  for (const row of rows) {
    await pgClient.query(
      `INSERT INTO sequences (name, next_val) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET next_val = EXCLUDED.next_val`,
      [row.name, row.next_val]
    );
  }
  return rows.length;
}

async function migrateProjects(sqlite, pgClient) {
  const rows = sqlite.prepare('SELECT * FROM projects').all();
  for (const row of rows) {
    await pgClient.query(
      `INSERT INTO projects (key, org, project, component, path, role, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (key) DO UPDATE SET
         org=EXCLUDED.org, project=EXCLUDED.project, component=EXCLUDED.component,
         path=EXCLUDED.path, role=EXCLUDED.role, synced_at=EXCLUDED.synced_at`,
      [row.key, row.org, row.project, row.component, row.path ?? '', row.role ?? '', row.synced_at]
    );
  }
  return rows.length;
}

async function migratePreferences(sqlite, pgClient) {
  const rows = sqlite.prepare('SELECT * FROM preferences').all();
  for (const row of rows) {
    await pgClient.query(
      `INSERT INTO preferences (key, value) VALUES ($1,$2)
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
      [row.key, row.value]
    );
  }
  return rows.length;
}

async function migrateSchemaMigrations(sqlite, pgClient) {
  const rows = sqlite.prepare('SELECT * FROM schema_migrations').all();
  const { rows: existing } = await pgClient.query('SELECT version FROM schema_migrations');
  const existingVersions = new Set(existing.map(r => r.version));
  let inserted = 0;
  for (const row of rows) {
    if (existingVersions.has(row.version)) continue;
    await pgClient.query(
      `INSERT INTO schema_migrations (version, applied_at) VALUES ($1,$2)
       ON CONFLICT (version) DO NOTHING`,
      [row.version, row.applied_at]
    );
    inserted++;
  }
  return rows.length;
}

async function migrateEpics(sqlite, pgClient) {
  const rows = sqlite.prepare('SELECT * FROM epics').all();
  for (const row of rows) {
    await pgClient.query(
      `INSERT INTO epics (id, title, status, priority, description, acceptance_criteria,
         target_date, tags, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         title=EXCLUDED.title, status=EXCLUDED.status, priority=EXCLUDED.priority,
         description=EXCLUDED.description, acceptance_criteria=EXCLUDED.acceptance_criteria,
         target_date=EXCLUDED.target_date, tags=EXCLUDED.tags,
         created_at=EXCLUDED.created_at, updated_at=EXCLUDED.updated_at`,
      [
        row.id, row.title, row.status, row.priority, row.description ?? '',
        row.acceptance_criteria ?? '', row.target_date ?? null,
        toJsonb(row.tags) ?? [],
        row.created_at, row.updated_at,
      ]
    );
  }
  return rows.length;
}

async function migrateWorkItems(sqlite, pgClient) {
  const rows = sqlite.prepare('SELECT * FROM work_items').all();
  for (const row of rows) {
    await pgClient.query(
      `INSERT INTO work_items (
         id, project_key, title, status, priority, description, epic_id,
         tags, depends_on, created_at, updated_at,
         input_needed, input_needed_from, input_needed_reason, input_needed_at,
         approval_active, approval_mode, approval_requested_at, approval_resolved_at,
         released_at, released_version
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (id) DO UPDATE SET
         project_key=EXCLUDED.project_key, title=EXCLUDED.title, status=EXCLUDED.status,
         priority=EXCLUDED.priority, description=EXCLUDED.description, epic_id=EXCLUDED.epic_id,
         tags=EXCLUDED.tags, depends_on=EXCLUDED.depends_on, updated_at=EXCLUDED.updated_at,
         input_needed=EXCLUDED.input_needed, input_needed_from=EXCLUDED.input_needed_from,
         input_needed_reason=EXCLUDED.input_needed_reason, input_needed_at=EXCLUDED.input_needed_at,
         approval_active=EXCLUDED.approval_active, approval_mode=EXCLUDED.approval_mode,
         approval_requested_at=EXCLUDED.approval_requested_at,
         approval_resolved_at=EXCLUDED.approval_resolved_at,
         released_at=EXCLUDED.released_at, released_version=EXCLUDED.released_version`,
      [
        row.id, row.project_key, row.title, row.status, row.priority,
        row.description ?? '', row.epic_id ?? null,
        toJsonb(row.tags) ?? [], toJsonb(row.depends_on) ?? [],
        row.created_at, row.updated_at,
        toBool(row.input_needed), row.input_needed_from ?? null,
        row.input_needed_reason ?? null, row.input_needed_at ?? null,
        toBool(row.approval_active), row.approval_mode ?? 'all',
        row.approval_requested_at ?? null, row.approval_resolved_at ?? null,
        row.released_at ?? null, row.released_version ?? null,
      ]
    );
  }
  return rows.length;
}

async function migrateWorkItemLogs(sqlite, pgClient) {
  const rows = sqlite.prepare('SELECT * FROM work_item_logs').all();
  for (const row of rows) {
    await pgClient.query(
      `INSERT INTO work_item_logs (id, work_item_id, logged_at, summary)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET
         work_item_id=EXCLUDED.work_item_id, logged_at=EXCLUDED.logged_at,
         summary=EXCLUDED.summary`,
      [row.id, row.work_item_id, row.logged_at, row.summary]
    );
  }
  return rows.length;
}

async function migrateWorkItemApprovals(sqlite, pgClient) {
  const rows = sqlite.prepare('SELECT * FROM work_item_approvals').all();
  for (const row of rows) {
    await pgClient.query(
      `INSERT INTO work_item_approvals
         (id, work_item_id, identity, status, sort_order, blocking_work_item_id,
          decided_at, reason, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         work_item_id=EXCLUDED.work_item_id, identity=EXCLUDED.identity,
         status=EXCLUDED.status, sort_order=EXCLUDED.sort_order,
         blocking_work_item_id=EXCLUDED.blocking_work_item_id,
         decided_at=EXCLUDED.decided_at, reason=EXCLUDED.reason,
         created_at=EXCLUDED.created_at`,
      [
        row.id, row.work_item_id, row.identity, row.status ?? 'pending',
        row.sort_order ?? 0, row.blocking_work_item_id ?? null,
        row.decided_at ?? null, row.reason ?? null,
        row.created_at ?? new Date().toISOString(),
      ]
    );
  }
  return rows.length;
}

async function migrateEpicLogs(sqlite, pgClient) {
  const rows = sqlite.prepare('SELECT * FROM epic_logs').all();
  for (const row of rows) {
    await pgClient.query(
      `INSERT INTO epic_logs (id, epic_id, logged_at, summary)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET
         epic_id=EXCLUDED.epic_id, logged_at=EXCLUDED.logged_at,
         summary=EXCLUDED.summary`,
      [row.id, row.epic_id, row.logged_at, row.summary]
    );
  }
  return rows.length;
}

async function migrateDispatches(sqlite, pgClient) {
  const rows = sqlite.prepare('SELECT * FROM dispatches').all();
  for (const row of rows) {
    await pgClient.query(
      `INSERT INTO dispatches (
         id, work_item_id, epic_id, org_key, project_key, project_path, title,
         permission_mode, skip_permissions, status, started_at, completed_at,
         cost_usd, pid, claude_session_id, worktree_path, worktree_branch,
         source_branch, dispatch_mode, completion_sha, completion_summary, merge_result
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       ON CONFLICT (id) DO UPDATE SET
         work_item_id=EXCLUDED.work_item_id, epic_id=EXCLUDED.epic_id,
         org_key=EXCLUDED.org_key, project_key=EXCLUDED.project_key,
         project_path=EXCLUDED.project_path, title=EXCLUDED.title,
         permission_mode=EXCLUDED.permission_mode, skip_permissions=EXCLUDED.skip_permissions,
         status=EXCLUDED.status, started_at=EXCLUDED.started_at,
         completed_at=EXCLUDED.completed_at, cost_usd=EXCLUDED.cost_usd,
         pid=EXCLUDED.pid, claude_session_id=EXCLUDED.claude_session_id,
         worktree_path=EXCLUDED.worktree_path, worktree_branch=EXCLUDED.worktree_branch,
         source_branch=EXCLUDED.source_branch, dispatch_mode=EXCLUDED.dispatch_mode,
         completion_sha=EXCLUDED.completion_sha, completion_summary=EXCLUDED.completion_summary,
         merge_result=EXCLUDED.merge_result`,
      [
        row.id, row.work_item_id ?? null, row.epic_id ?? null,
        row.org_key ?? null, row.project_key, row.project_path ?? '',
        row.title ?? '', row.permission_mode ?? 'acceptEdits',
        toBool(row.skip_permissions) ?? false, row.status,
        row.started_at, row.completed_at ?? null,
        row.cost_usd ?? null, row.pid ?? null,
        row.claude_session_id ?? null, row.worktree_path ?? null,
        row.worktree_branch ?? null, row.source_branch ?? null,
        row.dispatch_mode ?? 'standard', row.completion_sha ?? null,
        row.completion_summary ?? null, row.merge_result ?? null,
      ]
    );
  }
  return rows.length;
}

async function migrateTerminals(sqlite, pgClient) {
  const rows = sqlite.prepare('SELECT * FROM terminals').all();
  for (const row of rows) {
    await pgClient.query(
      `INSERT INTO terminals (
         id, type, work_item_id, epic_id, org_key, project_key, project_path,
         title, permission_mode, skip_permissions, status, started_at, exited_at,
         pid, tmux_session, claude_session_id, agent_type, head_seq
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (id) DO UPDATE SET
         type=EXCLUDED.type, work_item_id=EXCLUDED.work_item_id,
         epic_id=EXCLUDED.epic_id, org_key=EXCLUDED.org_key,
         project_key=EXCLUDED.project_key, project_path=EXCLUDED.project_path,
         title=EXCLUDED.title, permission_mode=EXCLUDED.permission_mode,
         skip_permissions=EXCLUDED.skip_permissions, status=EXCLUDED.status,
         started_at=EXCLUDED.started_at, exited_at=EXCLUDED.exited_at,
         pid=EXCLUDED.pid, tmux_session=EXCLUDED.tmux_session,
         claude_session_id=EXCLUDED.claude_session_id, agent_type=EXCLUDED.agent_type,
         head_seq=EXCLUDED.head_seq`,
      [
        row.id, row.type ?? 'claude', row.work_item_id ?? null,
        row.epic_id ?? null, row.org_key ?? null, row.project_key ?? '',
        row.project_path ?? '', row.title ?? '',
        row.permission_mode ?? 'acceptEdits',
        toBool(row.skip_permissions) ?? false, row.status,
        row.started_at, row.exited_at ?? null,
        row.pid ?? null, row.tmux_session ?? null,
        row.claude_session_id ?? null, row.agent_type ?? 'claude',
        row.head_seq ?? 0,
      ]
    );
  }
  return rows.length;
}

async function migrateCliSessions(sqlite, pgClient) {
  const rows = sqlite.prepare('SELECT * FROM cli_sessions').all();
  for (const row of rows) {
    await pgClient.query(
      `INSERT INTO cli_sessions (id, project_key, work_item_id, epic_id, title, pid, status, registered_at, exited_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         project_key=EXCLUDED.project_key, work_item_id=EXCLUDED.work_item_id,
         epic_id=EXCLUDED.epic_id, title=EXCLUDED.title, pid=EXCLUDED.pid,
         status=EXCLUDED.status, registered_at=EXCLUDED.registered_at,
         exited_at=EXCLUDED.exited_at`,
      [
        row.id, row.project_key, row.work_item_id ?? null,
        row.epic_id ?? null, row.title, row.pid, row.status,
        row.registered_at, row.exited_at ?? null,
      ]
    );
  }
  return rows.length;
}

async function migrateSessionHistory(sqlite, pgClient) {
  const rows = sqlite.prepare('SELECT * FROM session_history').all();
  for (const row of rows) {
    await pgClient.query(
      `INSERT INTO session_history (
         id, type, project_key, work_item_id, epic_id, title, status,
         permission_mode, started_at, ended_at, duration_seconds, cost_usd
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET
         type=EXCLUDED.type, project_key=EXCLUDED.project_key,
         work_item_id=EXCLUDED.work_item_id, epic_id=EXCLUDED.epic_id,
         title=EXCLUDED.title, status=EXCLUDED.status,
         permission_mode=EXCLUDED.permission_mode, started_at=EXCLUDED.started_at,
         ended_at=EXCLUDED.ended_at, duration_seconds=EXCLUDED.duration_seconds,
         cost_usd=EXCLUDED.cost_usd`,
      [
        row.id, row.type, row.project_key, row.work_item_id ?? null,
        row.epic_id ?? null, row.title ?? '', row.status,
        row.permission_mode ?? null, row.started_at, row.ended_at,
        row.duration_seconds ?? 0, row.cost_usd ?? null,
      ]
    );
  }
  return rows.length;
}

async function migrateKnowledgeSyncs(sqlite, pgClient) {
  const rows = sqlite.prepare('SELECT * FROM knowledge_syncs').all();
  for (const row of rows) {
    await pgClient.query(
      `INSERT INTO knowledge_syncs (
         id, project_key, trigger, status, started_at, synced_at,
         commit_from, commit_to, commits_scanned, significant_count,
         summary_json, error
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET
         project_key=EXCLUDED.project_key, trigger=EXCLUDED.trigger,
         status=EXCLUDED.status, started_at=EXCLUDED.started_at,
         synced_at=EXCLUDED.synced_at, commit_from=EXCLUDED.commit_from,
         commit_to=EXCLUDED.commit_to, commits_scanned=EXCLUDED.commits_scanned,
         significant_count=EXCLUDED.significant_count, summary_json=EXCLUDED.summary_json,
         error=EXCLUDED.error`,
      [
        row.id, row.project_key, row.trigger, row.status,
        row.started_at, row.synced_at ?? null,
        row.commit_from ?? null, row.commit_to ?? null,
        row.commits_scanned ?? 0, row.significant_count ?? 0,
        toJsonb(row.summary_json) ?? [],
        row.error ?? null,
      ]
    );
  }
  return rows.length;
}

async function migrateChangeLogEntries(sqlite, pgClient) {
  const rows = sqlite.prepare('SELECT * FROM change_log_entries').all();
  for (const row of rows) {
    await pgClient.query(
      `INSERT INTO change_log_entries (
         id, project_key, commit_hash, commit_message, author, committed_at,
         affected_files, classification, ai_summary, detected_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         project_key=EXCLUDED.project_key, commit_hash=EXCLUDED.commit_hash,
         commit_message=EXCLUDED.commit_message, author=EXCLUDED.author,
         committed_at=EXCLUDED.committed_at, affected_files=EXCLUDED.affected_files,
         classification=EXCLUDED.classification, ai_summary=EXCLUDED.ai_summary,
         detected_at=EXCLUDED.detected_at`,
      [
        row.id, row.project_key, row.commit_hash, row.commit_message,
        row.author ?? '', row.committed_at,
        toJsonb(row.affected_files) ?? [],
        row.classification, row.ai_summary ?? null, row.detected_at,
      ]
    );
  }
  return rows.length;
}

// ── Table existence helper ────────────────────────────────────────────────────

function sqliteTableExists(sqlite, name) {
  const row = sqlite.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
  ).get(name);
  return Boolean(row);
}

// ── Sequence resequencing ─────────────────────────────────────────────────────

async function resequenceIds(pgClient) {
  await pgClient.query(`
    UPDATE sequences
    SET next_val = COALESCE(
      (SELECT MAX(CAST(SUBSTRING(id FROM 3) AS INTEGER)) FROM work_items), 0
    ) + 1
    WHERE name = 'work_item'
  `);
  await pgClient.query(`
    UPDATE sequences
    SET next_val = COALESCE(
      (SELECT MAX(CAST(SUBSTRING(id FROM 3) AS INTEGER)) FROM epics), 0
    ) + 1
    WHERE name = 'epic'
  `);
}

// ── Row count verification ────────────────────────────────────────────────────

async function verifyRowCounts(sqlite, pgClient, tableNames) {
  let allMatch = true;
  for (const name of tableNames) {
    if (!sqliteTableExists(sqlite, name)) {
      console.log(`  (skipped) ${name}: not present in SQLite`);
      continue;
    }
    const sqliteCount = sqlite.prepare(`SELECT COUNT(*) as c FROM "${name}"`).get().c;
    const pgResult = await pgClient.query(`SELECT COUNT(*) AS c FROM "${name}"`);
    const pgCount = parseInt(pgResult.rows[0].c, 10);
    const ok = sqliteCount === pgCount;
    if (ok) {
      console.log(`  ✓ ${name}: SQLite=${sqliteCount}, PG=${pgCount}`);
    } else {
      console.warn(`  ⚠ ${name}: SQLite=${sqliteCount}, PG=${pgCount} (mismatch — may have diverged)`);
      allMatch = false;
    }
  }
  return allMatch;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`SQLite → PostgreSQL migration`);
  console.log(`  SQLite: ${sqlitePath}`);
  if (dryRun) console.log(`  Mode:   dry-run (no writes)`);
  console.log('');

  const sqlite = new Database(sqlitePath, { readonly: true });
  const pgConfig = buildPgConfig();
  const pgClient = new pg.Client(pgConfig);

  try {
    await pgClient.connect();
    console.log(`Connected to PostgreSQL: ${pgConfig.host}:${pgConfig.port}/${pgConfig.database}`);
    console.log('');

    if (dryRun) {
      console.log('Dry-run: reading SQLite tables only.');
      for (const { name } of TABLES) {
        if (!sqliteTableExists(sqlite, name)) {
          console.log(`  (skipped) ${name}: not present in SQLite`);
          continue;
        }
        const count = sqlite.prepare(`SELECT COUNT(*) as c FROM "${name}"`).get().c;
        console.log(`  ${name}: ${count} rows`);
      }
      return;
    }

    for (const { name, importFn } of TABLES) {
      if (!sqliteTableExists(sqlite, name)) {
        console.log(`Skipping ${name} (not present in SQLite)`);
        continue;
      }
      process.stdout.write(`Migrating ${name}... `);
      const count = await importFn(sqlite, pgClient);
      console.log(`${count} rows`);
    }

    console.log('\nResequencing ID sequences...');
    await resequenceIds(pgClient);

    console.log('\nRow count verification:');
    await verifyRowCounts(sqlite, pgClient, TABLES.map(t => t.name));

    console.log('\nMigration complete.');
  } finally {
    sqlite.close();
    await pgClient.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
