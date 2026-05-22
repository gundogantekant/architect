import pg from 'pg';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdirSync, createWriteStream } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';

// Return TIMESTAMPTZ values as ISO strings instead of Date objects.
// OID 1114 = TIMESTAMP WITHOUT TIME ZONE, OID 1184 = TIMESTAMP WITH TIME ZONE.
pg.types.setTypeParser(1114, (val) => val);
pg.types.setTypeParser(1184, (val) => val);

// Return INT8/BIGSERIAL (OID 20) as JavaScript numbers. These are auto-increment IDs
// that will never exceed Number.MAX_SAFE_INTEGER in this system.
pg.types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));

// Return NUMERIC (OID 1700) as JavaScript numbers. SUM(bigint) returns NUMERIC in PG.
// All numeric aggregates in this system (session counts, durations, costs) fit safely in float64.
pg.types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));

// Serialize JS arrays/objects to JSON strings for JSONB columns.
// pg sends JS arrays as PostgreSQL array literals ({}) which PG parses as empty objects,
// not empty arrays. Passing a JSON string bypasses that coercion.
function jsonb(val, fallback = null) {
  if (val === null || val === undefined) return fallback !== null ? JSON.stringify(fallback) : null;
  if (typeof val === 'string') return val;
  return JSON.stringify(val);
}

let pool = null;

function buildPoolConfig() {
  return {
    host: process.env.ARCHITECT_PG_HOST ?? '127.0.0.1',
    port: parseInt(process.env.ARCHITECT_PG_PORT ?? '3778', 10),
    database: process.env.ARCHITECT_PG_DB ?? 'architect',
    user: process.env.ARCHITECT_PG_USER ?? 'architect',
    password: process.env.ARCHITECT_PG_PASSWORD ?? 'architect',
    max: parseInt(process.env.PG_POOL_MAX ?? '10', 10),
    idleTimeoutMillis: parseInt(process.env.PG_POOL_IDLE_TIMEOUT_MS ?? '30000', 10),
    connectionTimeoutMillis: parseInt(process.env.PG_CONNECTION_TIMEOUT_MS ?? '5000', 10),
    statementTimeoutMs: parseInt(process.env.PG_STATEMENT_TIMEOUT_MS ?? '30000', 10),
  };
}

export async function waitForPostgres(config, { maxAttempts = 10, baseDelayMs = 1000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const probe = new pg.Client({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      connectionTimeoutMillis: config.connectionTimeoutMillis,
    });
    try {
      await probe.connect();
      await probe.query('SELECT 1');
      await probe.end();
      return;
    } catch (err) {
      lastError = err;
      await probe.end().catch(() => {});

      // Non-retryable: wrong credentials or DB doesn't exist yet via pg_hba.
      // ECONNREFUSED means postgres isn't up yet — keep retrying.
      if (err.code === '28P01') throw new Error(`PostgreSQL auth failed (28P01): check ARCHITECT_PG_USER/PASSWORD`);
      if (err.code === '3D000') throw new Error(`PostgreSQL database not found (3D000): check ARCHITECT_PG_DB="${config.database}"`);

      if (attempt < maxAttempts) {
        const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), 10000);
        console.log(JSON.stringify({ type: 'pg_wait', attempt, maxAttempts, delayMs: delay, code: err.code, timestamp: new Date().toISOString() }));
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw new Error(`PostgreSQL not reachable after ${maxAttempts} attempts: ${lastError?.message}`);
}

export async function initDatabaseAsync(workDir, migrationsDir) {
  const config = buildPoolConfig();
  await waitForPostgres(config);

  pool = new pg.Pool({
    ...config,
    options: `-c statement_timeout=${config.statementTimeoutMs} -c idle_in_transaction_session_timeout=${config.statementTimeoutMs}`,
  });

  pool.on('error', (err) => {
    console.error(JSON.stringify({ type: 'pg_pool_error', message: err.message, code: err.code, timestamp: new Date().toISOString() }));
  });

  await runMigrations(migrationsDir);

  if (process.env.ARCHITECT_SKIP_SCHEMA_ASSERT !== '1') {
    await assertSchema();
  }
}

export async function runMigrations(migrationsDir) {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL,
        notes TEXT
      )
    `);

    const { rows: appliedRows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(appliedRows.map((r) => r.version));

    const allFiles = await readdir(migrationsDir);
    const migrationFiles = allFiles
      .filter((f) => /^\d{3}-.+\.mjs$/.test(f))
      .sort();

    assertNoDuplicateVersions(migrationFiles);

    for (const file of migrationFiles) {
      const version = parseInt(file.slice(0, 3), 10);
      if (applied.has(version)) {
        console.log(`Skipping migration ${file} (version ${version} already applied).`);
        continue;
      }

      console.log(`Applying migration ${file}...`);
      const migration = await import(pathToFileURL(resolve(migrationsDir, file)).href);

      if (migration.noTransaction) {
        await migration.up(client);
        await client.query('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, NOW()) ON CONFLICT (version) DO NOTHING', [version]);
      } else {
        await client.query('BEGIN');
        try {
          await migration.up(client);
          await client.query('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, NOW()) ON CONFLICT (version) DO NOTHING', [version]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }
      console.log(`Migration ${file} applied.`);
    }
  } finally {
    client.release();
  }
}

function assertNoDuplicateVersions(files) {
  const seen = new Map();
  for (const file of files) {
    const v = parseInt(file.slice(0, 3), 10);
    if (seen.has(v)) {
      const nextFree = Math.max(...seen.keys()) + 1;
      throw new Error(
        `Duplicate migration version ${v}: "${seen.get(v)}" and "${file}". ` +
        `Rename one to ${String(nextFree).padStart(3, '0')}-<name>.mjs.`
      );
    }
    seen.set(v, file);
  }
}

export async function assertSchema() {
  const expected = {
    work_items: [
      'id', 'project_key', 'title', 'status', 'priority', 'description', 'epic_id',
      'tags', 'depends_on', 'created_at', 'updated_at', 'input_needed', 'input_needed_from',
      'input_needed_reason', 'input_needed_at', 'approval_active', 'approval_mode',
      'approval_requested_at', 'approval_resolved_at', 'released_at', 'released_version',
      'done_at',
    ],
    work_item_approvals: ['id', 'work_item_id', 'identity', 'status', 'sort_order', 'blocking_work_item_id', 'decided_at', 'reason', 'created_at'],
    work_item_logs: ['id', 'work_item_id', 'logged_at', 'summary'],
    epics: ['id', 'title', 'status', 'priority', 'description', 'acceptance_criteria', 'target_date', 'tags', 'created_at', 'updated_at'],
    epic_logs: ['id', 'epic_id', 'logged_at', 'summary'],
    dispatches: ['id', 'work_item_id', 'epic_id', 'org_key', 'project_key', 'project_path', 'title', 'permission_mode', 'skip_permissions', 'status', 'started_at', 'completed_at', 'cost_usd', 'pid', 'claude_session_id', 'worktree_path', 'worktree_branch', 'source_branch', 'dispatch_mode', 'completion_sha', 'completion_summary', 'completion_summary_error', 'dry_run', 'merge_result', 'pipeline_stage', 'plan_gate_passed', 'plan_gate_passed_at', 'code_gate_passed', 'code_gate_passed_at', 'contract_satisfied', 'contract_satisfied_at', 'agent_phase', 'agent_phase_history', 'timeout_at', 'contract', 'exit_type', 'deleted_at'],
    terminals: ['id', 'type', 'work_item_id', 'epic_id', 'org_key', 'project_key', 'project_path', 'title', 'permission_mode', 'skip_permissions', 'status', 'started_at', 'exited_at', 'pid', 'tmux_session', 'claude_session_id', 'agent_type', 'head_seq', 'deleted_at'],
    cli_sessions: ['id', 'project_key', 'work_item_id', 'epic_id', 'title', 'pid', 'status', 'registered_at', 'exited_at'],
    preferences: ['key', 'value'],
    projects: ['key', 'org', 'project', 'component', 'path', 'role', 'synced_at'],
    session_history: ['id', 'type', 'project_key', 'work_item_id', 'epic_id', 'title', 'status', 'permission_mode', 'started_at', 'ended_at', 'duration_seconds', 'cost_usd'],
    knowledge_syncs: ['id', 'project_key', 'trigger', 'status', 'started_at', 'synced_at', 'commit_from', 'commit_to', 'commits_scanned', 'significant_count', 'summary_json', 'error', 'sync_source'],
    change_log_entries: ['id', 'project_key', 'commit_hash', 'commit_message', 'author', 'committed_at', 'affected_files', 'classification', 'ai_summary', 'detected_at'],
    schema_migrations: ['version', 'applied_at', 'notes'],
    repo_sync_config: ['github_repo_name', 'github_org', 'default_branch', 'local_path', 'portfolio_key', 'sync_enabled', 'last_github_updated_at', 'created_at', 'updated_at'],
    adrs: ['id', 'org_key', 'title', 'type', 'repos', 'sync_run_id', 'detail_path', 'created_at'],
    dispatch_costs: ['id', 'model', 'agent_role', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cost_usd_breakdown', 'recorded_at'],
    model_pricing: ['model_id', 'input_cost_per_mtok', 'output_cost_per_mtok', 'cache_read_cost_per_mtok', 'cache_write_cost_per_mtok', 'updated_at'],
    dispatch_prompts: ['id', 'dispatch_id', 'work_item_id', 'project_key', 'prompt_text', 'char_count', 'truncated', 'created_at'],
  };

  const missing = [];
  for (const [table, cols] of Object.entries(expected)) {
    const result = await pool.query(
      'SELECT column_name FROM information_schema.columns WHERE table_name = $1',
      [table]
    );
    if (!result.rows.length) {
      missing.push(`table ${table}`);
      continue;
    }
    const present = new Set(result.rows.map(r => r.column_name));
    for (const c of cols) {
      if (!present.has(c)) missing.push(`${table}.${c}`);
    }
  }

  if (missing.length) {
    throw new Error(
      `Schema drift detected. Missing: ${missing.join(', ')}. ` +
      `Check for skipped migrations in tmp/dashboard.log. ` +
      `To bypass in emergency: ARCHITECT_SKIP_SCHEMA_ASSERT=1 dashctl start`
    );
  }

  // Log whether the approval trigger is present
  const triggerCheck = await pool.query(
    `SELECT tgname FROM pg_trigger WHERE tgrelid = 'work_items'::regclass AND tgname = 'trg_approval_active_requires_pending'`
  );
  if (triggerCheck.rows.length === 0) {
    console.warn('[db] schema warning: trg_approval_active_requires_pending trigger not found on work_items');
  }

  // Verify CHECK constraints exist on tables that declare them.
  // Query actual constraint names so we don't hardcode DB-generated suffixes.
  const checkConstraintsResult = await pool.query(`
    SELECT conrelid::regclass::text AS table_name, conname
    FROM pg_constraint
    WHERE contype = 'c'
      AND conrelid = ANY(ARRAY[
        'work_items'::regclass,
        'work_item_approvals'::regclass,
        'knowledge_syncs'::regclass,
        'change_log_entries'::regclass,
        'adrs'::regclass
      ]::oid[])
  `);
  const checksByTable = {};
  for (const row of checkConstraintsResult.rows) {
    if (!checksByTable[row.table_name]) checksByTable[row.table_name] = [];
    checksByTable[row.table_name].push(row.conname);
  }

  // work_items must have CHECK constraints covering status and priority.
  const workItemChecks = checksByTable['work_items'] ?? [];
  if (!workItemChecks.some(n => n.includes('status'))) {
    console.warn('[db] schema warning: no CHECK constraint covering status found on work_items');
  }
  if (!workItemChecks.some(n => n.includes('priority'))) {
    console.warn('[db] schema warning: no CHECK constraint covering priority found on work_items');
  }

  // work_item_approvals must have a CHECK constraint covering status.
  const approvalChecks = checksByTable['work_item_approvals'] ?? [];
  if (!approvalChecks.some(n => n.includes('status'))) {
    console.warn('[db] schema warning: no CHECK constraint covering status found on work_item_approvals');
  }

  // knowledge_syncs must have CHECK constraints covering status and sync_source.
  const syncChecks = checksByTable['knowledge_syncs'] ?? [];
  if (!syncChecks.some(n => n.includes('status'))) {
    console.warn('[db] schema warning: no CHECK constraint covering status found on knowledge_syncs');
  }
  if (!syncChecks.some(n => n.includes('sync_source'))) {
    console.warn('[db] schema warning: no CHECK constraint covering sync_source found on knowledge_syncs');
  }

  // adrs must have a CHECK constraint covering type.
  const adrChecks = checksByTable['adrs'] ?? [];
  if (!adrChecks.some(n => n.includes('type'))) {
    console.warn('[db] schema warning: no CHECK constraint covering type found on adrs');
  }

  // change_log_entries must have a CHECK constraint covering classification.
  const changeLogChecks = checksByTable['change_log_entries'] ?? [];
  if (!changeLogChecks.some(n => n.includes('classification'))) {
    console.warn('[db] schema warning: no CHECK constraint covering classification found on change_log_entries');
  }
}

export async function closeDatabase() {
  return pool?.end();
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// --- Backup ---

export async function backupDatabase(workDir, backupDir) {
  const config = buildPoolConfig();
  const container = process.env.ARCHITECT_PG_CONTAINER ?? 'architect-postgres';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = join(backupDir, `architect-${timestamp}.dump`);
  const tmpDest = dest + '.tmp';

  mkdirSync(backupDir, { recursive: true });

  try {
    await new Promise((resolve, reject) => {
      const child = spawn('docker', [
        'exec', container,
        'pg_dump', '-U', config.user, '-Fc', config.database,
      ]);
      const out = createWriteStream(tmpDest);
      let stderr = '';
      child.stdout.pipe(out);
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (err) => { out.destroy(); reject(new Error(`Docker not available: ${err.message}`)); });
      child.on('close', (code) => {
        if (code !== 0) {
          if (stderr.includes('No such container')) {
            reject(new Error(`Container '${container}' not found. Set ARCHITECT_PG_CONTAINER env var.`));
          } else {
            reject(new Error(`pg_dump failed (exit ${code}): ${stderr.trim()}`));
          }
        } else {
          out.end(() => resolve());
        }
      });
    });
  } catch (err) {
    await unlink(tmpDest).catch(() => {});
    throw err;
  }

  await rename(tmpDest, dest);
  console.log(`Database backup: ${dest}`);
  return dest;
}

// --- Sequences (atomic UPDATE…RETURNING prevents races) ---

async function nextId(name) {
  const result = await pool.query(
    'UPDATE sequences SET next_val = next_val + 1 WHERE name = $1 RETURNING next_val - 1 AS val',
    [name]
  );
  if (result.rows.length > 0) return Number(result.rows[0].val);

  // Sequences row missing — insert and atomically retrieve the allocated ID.
  const fallback = await pool.query(
    `INSERT INTO sequences (name, next_val) VALUES ($1, 2)
     ON CONFLICT (name) DO UPDATE SET next_val = sequences.next_val + 1
     RETURNING next_val - 1 AS val`,
    [name]
  );
  return Number(fallback.rows[0].val);
}

export async function nextWorkItemId() {
  const val = await nextId('work_item');
  return `W-${String(val).padStart(3, '0')}`;
}

export async function nextEpicId() {
  const val = await nextId('epic');
  return `E-${String(val).padStart(3, '0')}`;
}

export async function peekNextIds() {
  const result = await pool.query('SELECT name, next_val FROM sequences WHERE name = ANY($1)', [['work_item', 'epic']]);
  const map = {};
  for (const row of result.rows) map[row.name] = row.next_val;
  return {
    next_work_item_id: `W-${String(map.work_item ?? 1).padStart(3, '0')}`,
    next_epic_id: `E-${String(map.epic ?? 1).padStart(3, '0')}`,
  };
}

// --- Work Items ---

export async function getWorkItem(id) {
  const row = await pool.query('SELECT * FROM work_items WHERE id = $1', [id]).then(r => r.rows[0] ?? null);
  if (!row) return null;
  const approvals = await pool.query(
    'SELECT * FROM work_item_approvals WHERE work_item_id = $1 ORDER BY sort_order, id',
    [id]
  ).then(r => r.rows);
  return hydrateWorkItem(row, approvals);
}

export async function getWorkItemsByProject(projectKey) {
  const rows = await pool.query('SELECT * FROM work_items WHERE project_key = $1', [projectKey]).then(r => r.rows);
  return hydrateWorkItemsBatch(rows);
}

export async function getWorkItemsByEpic(epicId) {
  const rows = await pool.query('SELECT * FROM work_items WHERE epic_id = $1', [epicId]).then(r => r.rows);
  return hydrateWorkItemsBatch(rows);
}

export async function getAllWorkItems() {
  const rows = await pool.query('SELECT * FROM work_items').then(r => r.rows);
  return hydrateWorkItemsBatch(rows);
}

export async function searchWorkItems(keywords, projectKey) {
  let rows;
  if (projectKey) {
    rows = await pool.query(
      "SELECT * FROM work_items WHERE project_key = $1 AND status NOT IN ('done','cancelled','archived')",
      [projectKey]
    ).then(r => r.rows);
  } else {
    rows = await pool.query(
      "SELECT * FROM work_items WHERE status NOT IN ('done','cancelled','archived')"
    ).then(r => r.rows);
  }

  const escapedPatterns = keywords.map(kw => '%' + kw.replace(/[%_]/g, '\\$&') + '%');

  const scoredItems = rows
    .map(row => {
      const haystack = ((row.title || '') + ' ' + (row.description || '')).toLowerCase();
      const score = escapedPatterns.filter(pat => {
        const literal = pat.slice(1, -1).replace(/\\([%_])/g, '$1');
        return haystack.includes(literal);
      }).length;
      return { row, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  return scoredItems.map(({ row }) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    description: row.description,
    project_key: row.project_key,
    epic_id: row.epic_id || '',
    tags: row.tags ?? [],
    depends_on: row.depends_on ?? [],
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

export async function createWorkItem({ project_key, title, status, priority, description, tags, epic_id }) {
  const id = await nextWorkItemId();
  const now = new Date().toISOString();
  await pool.query(`
    INSERT INTO work_items (id, project_key, title, status, priority, description, epic_id, tags, depends_on, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  `, [id, project_key, title, status || 'draft', priority || 'medium', description || '', epic_id || null, jsonb(tags, []), jsonb([]), now, now]);

  await addWorkItemLog(id, 'Created');

  return getWorkItem(id);
}

export async function updateWorkItem(id, fields) {
  const allowed = [
    'title', 'status', 'priority', 'description', 'tags', 'depends_on', 'epic_id',
    'input_needed', 'input_needed_from', 'input_needed_reason', 'input_needed_at',
    'approval_active', 'approval_mode', 'approval_requested_at', 'approval_resolved_at',
    'released_at', 'released_version',
  ];
  const sets = [];
  const values = [];
  let paramIdx = 1;

  const WORK_ITEM_JSONB = new Set(['tags', 'depends_on']);
  for (const key of allowed) {
    if (key in fields) {
      sets.push(`${key} = $${paramIdx++}`);
      values.push(WORK_ITEM_JSONB.has(key) ? jsonb(fields[key], []) : fields[key]);
    }
  }

  if (sets.length === 0) return getWorkItem(id);
  sets.push(`updated_at = $${paramIdx++}`);
  values.push(new Date().toISOString());
  values.push(id);
  await pool.query(`UPDATE work_items SET ${sets.join(', ')} WHERE id = $${paramIdx}`, values);
  if (fields.status === 'done') {
    await pool.query(
      `UPDATE work_items SET done_at = NOW() WHERE id = $1 AND done_at IS NULL`,
      [id]
    );
  }
  return getWorkItem(id);
}

export async function updateWorkItemRefinement(id, { description, status }) {
  await pool.query(
    `UPDATE work_items SET description = $1, status = $2, updated_at = NOW() WHERE id = $3`,
    [description, status, id]
  );
}

export async function setInputNeeded(workItemId, active, source) {
  if (active) {
    // Don't overwrite if already set by a non-bridge source (e.g. 'user')
    const current = await pool.query(
      'SELECT input_needed, input_needed_from FROM work_items WHERE id=$1',
      [workItemId]
    );
    if (current.rows[0]?.input_needed && current.rows[0]?.input_needed_from !== 'agent_phase_bridge') return;
    const now = new Date().toISOString();
    await pool.query(
      `UPDATE work_items SET input_needed=$1, input_needed_from=$2, input_needed_at=$3 WHERE id=$4`,
      [true, source, now, workItemId]
    );
  } else {
    const remaining = await pool.query(
      `SELECT COUNT(*) FROM dispatches WHERE work_item_id=$1 AND agent_phase='waiting_for_input' AND status IN ('running','pending')`,
      [workItemId]
    );
    if (parseInt(remaining.rows[0].count, 10) > 0) return;
    const current = await pool.query(
      `SELECT input_needed_from FROM work_items WHERE id=$1`,
      [workItemId]
    );
    if (!current.rows[0] || current.rows[0].input_needed_from !== 'agent_phase_bridge') return;
    await pool.query(
      `UPDATE work_items SET input_needed=false, input_needed_from=NULL, input_needed_reason=NULL, input_needed_at=NULL WHERE id=$1`,
      [workItemId]
    );
  }
}

export async function getWorkItemInputNeeded(workItemId) {
  if (!workItemId) return false;
  const r = await pool.query('SELECT input_needed FROM work_items WHERE id=$1', [workItemId]);
  return r.rows[0]?.input_needed ?? false;
}

// --- Work Item Approvals ---

export async function getWorkItemApprovals(workItemId) {
  const rows = await pool.query(
    'SELECT * FROM work_item_approvals WHERE work_item_id = $1 ORDER BY sort_order, id',
    [workItemId]
  ).then(r => r.rows);
  return rows.map(hydrateApproval);
}

export async function addWorkItemApproval({ workItemId, identity, sort_order, blocking_work_item_id }) {
  const now = new Date().toISOString();
  const result = await pool.query(`
    INSERT INTO work_item_approvals (work_item_id, identity, status, sort_order, blocking_work_item_id, created_at)
    VALUES ($1, $2, 'pending', $3, $4, $5)
    RETURNING id
  `, [workItemId, identity, sort_order ?? 0, blocking_work_item_id || null, now]);
  const newId = result.rows[0].id;
  await activateApprovalFlag(workItemId);
  return getApprovalById(newId);
}

export async function getApprovalById(approvalId) {
  const row = await pool.query('SELECT * FROM work_item_approvals WHERE id = $1', [approvalId]).then(r => r.rows[0] ?? null);
  return row ? hydrateApproval(row) : null;
}

export async function updateWorkItemApproval(approvalId, { status, reason }) {
  const now = new Date().toISOString();
  const sets = [];
  const values = [];
  let paramIdx = 1;

  if (status !== undefined) {
    sets.push(`status = $${paramIdx++}`);
    values.push(status);
    sets.push(`decided_at = $${paramIdx++}`);
    values.push(now);
  }
  if (reason !== undefined) {
    sets.push(`reason = $${paramIdx++}`);
    values.push(reason);
  }
  if (sets.length === 0) return getApprovalById(approvalId);

  values.push(approvalId);
  await pool.query(`UPDATE work_item_approvals SET ${sets.join(', ')} WHERE id = $${paramIdx}`, values);
  const updated = await getApprovalById(approvalId);
  if (updated) await resolveApprovalIfComplete(updated.work_item_id);
  return updated;
}

async function activateApprovalFlag(workItemId) {
  const now = new Date().toISOString();
  const row = await pool.query('SELECT approval_active FROM work_items WHERE id = $1', [workItemId]).then(r => r.rows[0] ?? null);
  if (!row || row.approval_active === true) return;
  await pool.query(
    `UPDATE work_items SET approval_active = TRUE, approval_requested_at = COALESCE(approval_requested_at, $1), approval_resolved_at = NULL, updated_at = $2 WHERE id = $3`,
    [now, now, workItemId]
  );
}

export async function resolveApprovalIfComplete(workItemId) {
  const wi = await pool.query('SELECT approval_mode, approval_active FROM work_items WHERE id = $1', [workItemId]).then(r => r.rows[0] ?? null);
  if (!wi || wi.approval_active !== true) return;
  const approvers = await pool.query('SELECT * FROM work_item_approvals WHERE work_item_id = $1', [workItemId]).then(r => r.rows);
  if (approvers.length === 0) return;
  const mode = wi.approval_mode || 'all';
  let resolved = false;
  if (mode === 'any') {
    resolved = approvers.some(a => a.status === 'approved');
  } else if (mode === 'all' || mode === 'sequential') {
    resolved = approvers.every(a => a.status === 'approved');
  }
  if (resolved) {
    const now = new Date().toISOString();
    await pool.query(
      `UPDATE work_items SET approval_active = FALSE, approval_resolved_at = $1, updated_at = $2 WHERE id = $3`,
      [now, now, workItemId]
    );
  }
}

export async function getPendingApprovalsForIdentity(identity) {
  return pool.query(`
    SELECT wia.*, wi.project_key, wi.title
    FROM work_item_approvals wia
    JOIN work_items wi ON wi.id = wia.work_item_id
    WHERE wia.identity = $1 AND wia.status = 'pending'
  `, [identity]).then(r => r.rows);
}

export async function resolveBlockedApprovals(blockingItemId) {
  const pending = await pool.query(`
    SELECT id, work_item_id FROM work_item_approvals
    WHERE blocking_work_item_id = $1 AND status = 'pending'
  `, [blockingItemId]).then(r => r.rows);
  const now = new Date().toISOString();
  for (const row of pending) {
    await pool.query(
      `UPDATE work_item_approvals SET status = 'approved', decided_at = $1, reason = COALESCE(reason, $2) WHERE id = $3`,
      [now, `auto-approved by blocker ${blockingItemId}=done`, row.id]
    );
    await resolveApprovalIfComplete(row.work_item_id);
  }
}

export async function getActiveApproverForSequential(workItemId) {
  const row = await pool.query(`
    SELECT id FROM work_item_approvals
    WHERE work_item_id = $1 AND status = 'pending'
    ORDER BY sort_order ASC, id ASC LIMIT 1
  `, [workItemId]).then(r => r.rows[0] ?? null);
  return row ? row.id : null;
}

export async function deleteWorkItem(id) {
  const item = await getWorkItem(id);
  if (!item) return null;
  const now = new Date().toISOString();
  await pool.query("UPDATE work_items SET status = 'cancelled', updated_at = $1 WHERE id = $2", [now, id]);
  return getWorkItem(id);
}

export async function archiveWorkItem(id) {
  const item = await getWorkItem(id);
  if (!item) return null;
  if (item.status !== 'done' && item.status !== 'cancelled') return null;
  const now = new Date().toISOString();
  await pool.query("UPDATE work_items SET status = 'archived', updated_at = $1 WHERE id = $2", [now, id]);
  await addWorkItemLog(id, 'Archived');
  return getWorkItem(id);
}

export async function addWorkItemLog(workItemId, summary) {
  const now = new Date().toISOString();
  await pool.query('INSERT INTO work_item_logs (work_item_id, logged_at, summary) VALUES ($1, $2, $3)', [workItemId, now, summary]);
  await pool.query('UPDATE work_items SET updated_at = $1 WHERE id = $2', [now, workItemId]);
}

export async function getWorkItemLogs(workItemId) {
  return pool.query('SELECT * FROM work_item_logs WHERE work_item_id = $1 ORDER BY id', [workItemId]).then(r => r.rows);
}

// --- Dependencies ---

export async function addDependency(itemId, targetId) {
  const item = await getWorkItem(itemId);
  if (!item) throw new Error('Work item not found');

  const target = await getWorkItem(targetId);
  if (!target) throw new Error(`Target ${targetId} not found`);

  if (item.depends_on.includes(targetId)) return item;

  if (await detectCycle(itemId, targetId)) {
    throw new Error(`Circular dependency: ${itemId} → ${targetId} would create a cycle`);
  }

  const deps = [...item.depends_on, targetId];
  return updateWorkItem(itemId, { depends_on: deps });
}

export async function removeDependency(itemId, targetId) {
  const item = await getWorkItem(itemId);
  if (!item) throw new Error('Work item not found');
  const deps = item.depends_on.filter(d => d !== targetId);
  return updateWorkItem(itemId, { depends_on: deps });
}

async function detectCycle(itemId, targetId) {
  const visited = new Set();
  const stack = [targetId];
  while (stack.length) {
    const current = stack.pop();
    if (current === itemId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const row = await pool.query('SELECT depends_on FROM work_items WHERE id = $1', [current]).then(r => r.rows[0] ?? null);
    if (row) {
      const deps = row.depends_on ?? [];
      for (const dep of deps) stack.push(dep);
    }
  }
  return false;
}

// --- Epics ---

export async function listEpics() {
  const rows = await pool.query('SELECT * FROM epics').then(r => r.rows);
  return rows.map(hydrateEpic);
}

export async function getEpic(id) {
  const row = await pool.query('SELECT * FROM epics WHERE id = $1', [id]).then(r => r.rows[0] ?? null);
  if (!row) return null;
  return hydrateEpic(row);
}

export async function createEpic({ title, priority, description, acceptance_criteria, target_date, tags }) {
  const id = await nextEpicId();
  const now = new Date().toISOString();
  await pool.query(`
    INSERT INTO epics (id, title, status, priority, description, acceptance_criteria, target_date, tags, created_at, updated_at)
    VALUES ($1, $2, 'draft', $3, $4, $5, $6, $7, $8, $9)
  `, [id, title, priority || 'medium', description || '', acceptance_criteria || '', target_date || null, jsonb(tags, []), now, now]);

  await addEpicLog(id, 'Created');
  return getEpic(id);
}

export async function updateEpic(id, fields) {
  const allowed = ['title', 'status', 'priority', 'description', 'acceptance_criteria', 'target_date', 'tags'];
  const sets = [];
  const values = [];
  let paramIdx = 1;

  for (const key of allowed) {
    if (key in fields) {
      sets.push(`${key} = $${paramIdx++}`);
      values.push(key === 'tags' ? jsonb(fields[key], []) : fields[key]);
    }
  }

  if (sets.length === 0) return getEpic(id);
  sets.push(`updated_at = $${paramIdx++}`);
  values.push(new Date().toISOString());
  values.push(id);
  await pool.query(`UPDATE epics SET ${sets.join(', ')} WHERE id = $${paramIdx}`, values);
  return getEpic(id);
}

export async function deleteEpic(id) {
  const epic = await getEpic(id);
  if (!epic) return null;
  await pool.query('UPDATE work_items SET epic_id = NULL WHERE epic_id = $1', [id]);
  const now = new Date().toISOString();
  await pool.query("UPDATE epics SET status = 'cancelled', updated_at = $1 WHERE id = $2", [now, id]);
  return getEpic(id);
}

export async function archiveEpic(id) {
  const epic = await getEpic(id);
  if (!epic) return null;
  if (epic.status !== 'done' && epic.status !== 'cancelled') return null;
  const now = new Date().toISOString();
  await pool.query("UPDATE epics SET status = 'archived', updated_at = $1 WHERE id = $2", [now, id]);
  await addEpicLog(id, 'Archived');
  return getEpic(id);
}

export async function addEpicLog(epicId, summary) {
  const now = new Date().toISOString();
  await pool.query('INSERT INTO epic_logs (epic_id, logged_at, summary) VALUES ($1, $2, $3)', [epicId, now, summary]);
  await pool.query('UPDATE epics SET updated_at = $1 WHERE id = $2', [now, epicId]);
}

export async function getEpicLogs(epicId) {
  return pool.query('SELECT * FROM epic_logs WHERE epic_id = $1 ORDER BY id', [epicId]).then(r => r.rows);
}

export async function linkItemsToEpic(epicId, workItemIds) {
  const epic = await getEpic(epicId);
  if (!epic) throw new Error('Epic not found');

  let linked = 0;
  const now = new Date().toISOString();

  for (const wid of workItemIds) {
    const item = await getWorkItem(wid);
    if (!item) continue;
    if (item.epic_id && item.epic_id !== epicId) continue;
    const result = await pool.query(
      "UPDATE work_items SET epic_id = $1, updated_at = $2 WHERE id = $3 AND (epic_id IS NULL OR epic_id = $4 OR epic_id = '')",
      [epicId, now, wid, epicId]
    );
    if (result.rowCount > 0) linked++;
  }

  await pool.query('UPDATE epics SET updated_at = $1 WHERE id = $2', [now, epicId]);
  return linked;
}

export async function unlinkItemFromEpic(epicId, workItemId) {
  const now = new Date().toISOString();
  await pool.query('UPDATE work_items SET epic_id = NULL, updated_at = $1 WHERE id = $2 AND epic_id = $3', [now, workItemId, epicId]);
  await pool.query('UPDATE epics SET updated_at = $1 WHERE id = $2', [now, epicId]);
}

export async function getEpicWorkItemIds(epicId) {
  return pool.query('SELECT id FROM work_items WHERE epic_id = $1', [epicId]).then(r => r.rows.map(r => r.id));
}

export async function getEpicProjectKeys(epicId) {
  return pool.query('SELECT DISTINCT project_key FROM work_items WHERE epic_id = $1', [epicId]).then(r => r.rows.map(r => r.project_key).sort());
}

// --- Sessions: Dispatches ---

export async function saveDispatch(d) {
  await pool.query(`
    INSERT INTO dispatches (id, work_item_id, epic_id, project_key, project_path, title, permission_mode, skip_permissions, status, started_at, completed_at, cost_usd, pid, claude_session_id, worktree_path, worktree_branch, source_branch, dispatch_mode, pipeline_stage, agent_phase, agent_phase_history, timeout_at, contract, exit_type, dry_run)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
    ON CONFLICT (id) DO UPDATE SET
      work_item_id = EXCLUDED.work_item_id,
      epic_id = EXCLUDED.epic_id,
      project_key = EXCLUDED.project_key,
      project_path = EXCLUDED.project_path,
      title = EXCLUDED.title,
      permission_mode = EXCLUDED.permission_mode,
      skip_permissions = EXCLUDED.skip_permissions,
      status = EXCLUDED.status,
      started_at = EXCLUDED.started_at,
      completed_at = EXCLUDED.completed_at,
      cost_usd = EXCLUDED.cost_usd,
      pid = EXCLUDED.pid,
      claude_session_id = EXCLUDED.claude_session_id,
      worktree_path = EXCLUDED.worktree_path,
      worktree_branch = EXCLUDED.worktree_branch,
      source_branch = EXCLUDED.source_branch,
      dispatch_mode = EXCLUDED.dispatch_mode,
      pipeline_stage = EXCLUDED.pipeline_stage,
      agent_phase = EXCLUDED.agent_phase,
      agent_phase_history = EXCLUDED.agent_phase_history,
      timeout_at = EXCLUDED.timeout_at,
      contract = EXCLUDED.contract,
      exit_type = EXCLUDED.exit_type,
      dry_run = EXCLUDED.dry_run
  `, [
    d.id, d.work_item_id || null, d.epic_id || null, d.project_key, d.project_path || '',
    d.title || '', d.permission_mode || 'acceptEdits', d.skip_permissions ?? false,
    d.status, d.started_at, d.completed_at || null, d.cost_usd || null, d.pid || null,
    d.claude_session_id || null, d.worktree_path || null, d.worktree_branch || null,
    d.source_branch || null, d.dispatch_mode || 'standard', d.pipeline_stage || null,
    d.agent_phase ?? null, jsonb(d.agent_phase_history, []), d.timeout_at || null,
    d.contract !== undefined ? jsonb(d.contract) : null,
    d.exit_type || null,
    d.dry_run ?? false,
  ]);
}

export async function updateAgentPhase(id, phase, historyEntry) {
  const res = await pool.query(
    'SELECT agent_phase_history FROM dispatches WHERE id = $1',
    [id]
  );
  if (!res.rows.length) return;

  const existing = res.rows[0].agent_phase_history || [];
  const updated = [...existing, historyEntry].slice(-50);

  await pool.query(
    `UPDATE dispatches
     SET agent_phase = $2, agent_phase_history = $3
     WHERE id = $1`,
    [id, phase, JSON.stringify(updated)]
  );
}

export async function updatePipelineStage(id, stage) {
  await pool.query('UPDATE dispatches SET pipeline_stage = $1 WHERE id = $2', [stage, id]);
}

export async function deleteDispatch(id) {
  await pool.query('UPDATE dispatches SET deleted_at = NOW() WHERE id = $1', [id]);
}

export async function getPersistedDispatches() {
  // Exclude terminal statuses to prevent unbounded memory growth on restart.
  // 'dismissed' and 'superseded' are user-acknowledged terminal states;
  // 'completed', 'failed', and 'killed' are normal end states loaded separately
  // only when the user has them in active view. Interrupted sessions are kept
  // so the recovery banner can be surfaced.
  return pool.query(
    `SELECT * FROM dispatches WHERE deleted_at IS NULL AND status NOT IN ('dismissed', 'superseded', 'completed', 'failed', 'killed')`
  ).then(r => r.rows);
}

export async function getPersistedDispatchesAll() {
  return pool.query('SELECT * FROM dispatches WHERE deleted_at IS NULL').then(r => r.rows);
}

export async function getDeletedDispatches() {
  return pool.query('SELECT * FROM dispatches WHERE deleted_at IS NOT NULL').then(r => r.rows);
}

// --- Sessions: Terminals ---

export async function saveTerminal(t) {
  await pool.query(`
    INSERT INTO terminals (id, type, work_item_id, epic_id, project_key, project_path, org_key, title, permission_mode, skip_permissions, status, started_at, exited_at, pid, tmux_session, claude_session_id, agent_type, head_seq)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
    ON CONFLICT (id) DO UPDATE SET
      type = EXCLUDED.type,
      work_item_id = EXCLUDED.work_item_id,
      epic_id = EXCLUDED.epic_id,
      project_key = EXCLUDED.project_key,
      project_path = EXCLUDED.project_path,
      org_key = EXCLUDED.org_key,
      title = EXCLUDED.title,
      permission_mode = EXCLUDED.permission_mode,
      skip_permissions = EXCLUDED.skip_permissions,
      status = EXCLUDED.status,
      started_at = EXCLUDED.started_at,
      exited_at = EXCLUDED.exited_at,
      pid = EXCLUDED.pid,
      tmux_session = EXCLUDED.tmux_session,
      claude_session_id = EXCLUDED.claude_session_id,
      agent_type = EXCLUDED.agent_type,
      head_seq = EXCLUDED.head_seq
  `, [
    t.id, t.type || 'claude', t.work_item_id || null, t.epic_id || null,
    t.project_key || '', t.project_path || '', t.org_key || null, t.title || '',
    t.permission_mode || 'acceptEdits', t.skip_permissions ?? false,
    t.status, t.started_at, t.exited_at || null, t.pid || null,
    t.tmux_session || null, t.claude_session_id || null,
    t.agent_type || 'claude', t.head_seq || 0,
  ]);
}

export async function updateTerminalClaudeSessionId(id, sessionId) {
  await pool.query('UPDATE terminals SET claude_session_id = $1 WHERE id = $2', [sessionId, id]);
}

export async function deleteTerminal(id) {
  await pool.query('UPDATE terminals SET deleted_at = NOW() WHERE id = $1', [id]);
}

export async function getPersistedTerminals() {
  return pool.query('SELECT * FROM terminals WHERE deleted_at IS NULL').then(r => r.rows);
}

export async function getDeletedTerminals() {
  return pool.query('SELECT * FROM terminals WHERE deleted_at IS NOT NULL').then(r => r.rows);
}

// --- Sessions: CLI ---

export async function saveCliSession(c) {
  await pool.query(`
    INSERT INTO cli_sessions (id, project_key, work_item_id, epic_id, title, pid, status, registered_at, exited_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (id) DO UPDATE SET
      project_key = EXCLUDED.project_key,
      work_item_id = EXCLUDED.work_item_id,
      epic_id = EXCLUDED.epic_id,
      title = EXCLUDED.title,
      pid = EXCLUDED.pid,
      status = EXCLUDED.status,
      registered_at = EXCLUDED.registered_at,
      exited_at = EXCLUDED.exited_at
  `, [c.id, c.project_key, c.work_item_id || null, c.epic_id || null, c.title, c.pid, c.status, c.registered_at, c.exited_at || null]);
}

export async function deleteCliSession(id) {
  await pool.query('DELETE FROM cli_sessions WHERE id = $1', [id]);
}

export async function getPersistedCliSessions() {
  return pool.query('SELECT * FROM cli_sessions').then(r => r.rows);
}

// --- Lightweight title-only lookups ---

export async function getWorkItemTitle(id) {
  return pool.query('SELECT title FROM work_items WHERE id = $1', [id]).then(r => r.rows[0]?.title ?? null);
}

export async function getEpicTitle(id) {
  return pool.query('SELECT title FROM epics WHERE id = $1', [id]).then(r => r.rows[0]?.title ?? null);
}

// --- Session status updates ---

export async function updateDispatchStatus(id, status, completed_at) {
  await pool.query('UPDATE dispatches SET status = $1, completed_at = $2 WHERE id = $3', [status, completed_at || null, id]);
}

// exit_type values: 'graceful', 'killed', 'interrupted', 'unknown'
export async function updateDispatchExitType(id, exitType) {
  await pool.query('UPDATE dispatches SET exit_type = $1 WHERE id = $2', [exitType, id]);
}

export async function updateDispatchMergeResult(id, { status, completed_at, completion_sha, completion_summary, completion_summary_error, merge_result } = {}) {
  const fields = [];
  const values = [];
  let paramIdx = 1;

  if (status !== undefined) { fields.push(`status = $${paramIdx++}`); values.push(status); }
  if (completed_at !== undefined) { fields.push(`completed_at = $${paramIdx++}`); values.push(completed_at); }
  if (completion_sha !== undefined) { fields.push(`completion_sha = $${paramIdx++}`); values.push(completion_sha); }
  if (completion_summary !== undefined) { fields.push(`completion_summary = $${paramIdx++}`); values.push(completion_summary); }
  if (completion_summary_error !== undefined) { fields.push(`completion_summary_error = $${paramIdx++}`); values.push(completion_summary_error); }
  if (merge_result !== undefined) { fields.push(`merge_result = $${paramIdx++}`); values.push(merge_result); }

  if (!fields.length) return;
  values.push(id);
  await pool.query(`UPDATE dispatches SET ${fields.join(', ')} WHERE id = $${paramIdx}`, values);
}

export async function linkDispatchToWorkItem(dispatchId, workItemId) {
  await pool.query(
    `UPDATE dispatches SET work_item_id = $1 WHERE id = $2`,
    [workItemId, dispatchId]
  );
}

export async function updateTerminalStatus(id, status, exited_at) {
  await pool.query('UPDATE terminals SET status = $1, exited_at = $2 WHERE id = $3', [status, exited_at || null, id]);
}

export async function markRunningAsInterrupted() {
  const now = new Date().toISOString();
  await pool.query("UPDATE dispatches SET status = 'interrupted', completed_at = $1 WHERE status = 'running' AND pid IS NULL", [now]);
  await pool.query("UPDATE terminals SET status = 'interrupted', exited_at = $1 WHERE status = 'running' AND pid IS NULL", [now]);
}

// --- Preferences ---

export async function getPreference(key) {
  const row = await pool.query('SELECT value FROM preferences WHERE key = $1', [key]).then(r => r.rows[0] ?? null);
  return row ? row.value : null;
}

export async function setPreference(key, value) {
  await pool.query(
    'INSERT INTO preferences (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, value]
  );
}

export async function getAllPreferences() {
  const rows = await pool.query('SELECT * FROM preferences').then(r => r.rows);
  const prefs = {};
  for (const row of rows) prefs[row.key] = row.value;
  return prefs;
}

// --- Backlog reconstruction (legacy shape for API compat) ---

export async function getBacklog(orgFilter, includeArchived = false, dateFilter = {}) {
  const archivedClause = includeArchived ? '' : " AND status != 'archived'";
  const params = [];
  let where = `1=1${archivedClause}`;

  if (orgFilter) {
    params.push(orgFilter.toLowerCase() + '/%');
    where = `project_key LIKE $${params.length}${archivedClause}`;
  }
  if (dateFilter.from) {
    params.push(dateFilter.from);
    where += ` AND created_at >= $${params.length}::timestamptz`;
  }
  if (dateFilter.to) {
    params.push(dateFilter.to);
    where += ` AND created_at < ($${params.length}::date + INTERVAL '1 day')`;
  }

  const rows = await pool.query(`SELECT * FROM work_items WHERE ${where}`, params).then(r => r.rows);

  const hydratedItems = await hydrateWorkItemsBatch(rows);
  const statsMap = await getAllWorkItemStats();

  // Group by project_key
  const projects = {};
  for (const item of hydratedItems) {
    const logs = await getWorkItemLogs(item.id);
    item.session_log = logs.map(l => ({ date: l.logged_at, summary: l.summary }));
    const stats = statsMap.get(item.id);
    if (stats) {
      item.total_time_seconds = stats.total_time_seconds;
      item.total_cost_usd = stats.total_cost_usd;
      item.session_count = stats.session_count;
      item.last_session_at = stats.last_session_at;
    }
    if (!projects[item.project_key]) projects[item.project_key] = { items: [] };
    projects[item.project_key].items.push(item);
  }

  const epicList = await listEpics();
  const epics = await Promise.all(epicList.map(async epic => {
    epic.work_item_ids = await getEpicWorkItemIds(epic.id);
    epic.project_keys = await getEpicProjectKeys(epic.id);
    const epicLogs = await getEpicLogs(epic.id);
    epic.session_log = epicLogs.map(l => ({ date: l.logged_at, summary: l.summary }));
    return epic;
  }));

  const seqRows = await pool.query('SELECT name, next_val FROM sequences WHERE name = ANY($1)', [['work_item', 'epic']]).then(r => r.rows);
  const seqMap = {};
  for (const r of seqRows) seqMap[r.name] = r.next_val;

  return {
    next_id: seqMap.work_item || 1,
    next_epic_id: seqMap.epic || 1,
    projects,
    epics,
  };
}

export async function backdateWorkItem(id, createdAt) {
  await pool.query(
    `UPDATE work_items SET created_at = $1::timestamptz WHERE id = $2`,
    [createdAt, id]
  );
}

export async function purgeAllWorkItemsForTest() {
  if (!process.env.WORK_DIR) {
    throw new Error('purgeAllWorkItemsForTest refused: not in test mode');
  }
  await withTransaction(async (client) => {
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query('DELETE FROM epic_logs');
    await client.query('DELETE FROM work_items');
    await client.query('DELETE FROM epics');
    await client.query('DELETE FROM dispatches');
  });
}

// --- Single work item with full details ---

export async function getWorkItemFull(id) {
  const item = await getWorkItem(id);
  if (!item) return null;
  const logs = await getWorkItemLogs(id);
  item.session_log = logs.map(l => ({ date: l.logged_at, summary: l.summary }));
  const stats = await getWorkItemStats(id);
  if (stats) {
    item.total_time_seconds = stats.total_time_seconds;
    item.total_cost_usd = stats.total_cost_usd;
    item.session_count = stats.session_count;
    item.last_session_at = stats.last_session_at;
  }
  return item;
}

// --- Epic with resolved items ---

export async function getEpicFull(id) {
  const epic = await getEpic(id);
  if (!epic) return null;
  epic.work_item_ids = await getEpicWorkItemIds(id);
  epic.project_keys = await getEpicProjectKeys(id);
  const epicLogs = await getEpicLogs(id);
  epic.session_log = epicLogs.map(l => ({ date: l.logged_at, summary: l.summary }));

  const epicItemRows = await pool.query('SELECT * FROM work_items WHERE epic_id = $1', [id]).then(r => r.rows);
  const resolved = await hydrateWorkItemsBatch(epicItemRows);
  for (const item of resolved) {
    const logs = await getWorkItemLogs(item.id);
    item.session_log = logs.map(l => ({ date: l.logged_at, summary: l.summary }));
  }
  epic.resolved_items = resolved;
  const done = resolved.filter(i => i.status === 'done').length;
  epic.progress = { done, total: resolved.length };
  return epic;
}

// --- Hydration helpers ---

// Pure function — no DB calls inside. Callers provide pre-fetched approvals.
function hydrateWorkItem(row, approvals = []) {
  return {
    id: row.id,
    project_key: row.project_key,
    title: row.title,
    status: row.status,
    priority: row.priority,
    description: row.description,
    epic_id: row.epic_id || '',
    tags: row.tags ?? [],
    depends_on: row.depends_on ?? [],
    created_at: row.created_at,
    updated_at: row.updated_at,
    done_at: row.done_at || null,
    input_needed: !!row.input_needed,
    input_needed_from: row.input_needed_from || '',
    input_needed_reason: row.input_needed_reason || '',
    input_needed_at: row.input_needed_at || '',
    approval: {
      active: !!row.approval_active,
      mode: row.approval_mode || 'all',
      requested_at: row.approval_requested_at || '',
      resolved_at: row.approval_resolved_at || '',
      approvers: approvals.map(hydrateApproval),
    },
    released_at: row.released_at || '',
    released_version: row.released_version || '',
  };
}

// Batch-hydrate work items, fetching approvals in a single query to avoid N+1.
async function hydrateWorkItemsBatch(rows) {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const approvalRows = await pool.query(
    'SELECT * FROM work_item_approvals WHERE work_item_id = ANY($1) ORDER BY sort_order, id',
    [ids]
  ).then(r => r.rows);
  const approvalsByItemId = groupBy(approvalRows, 'work_item_id');
  return rows.map(row => hydrateWorkItem(row, approvalsByItemId.get(row.id) ?? []));
}

function hydrateApproval(row) {
  return {
    id: row.id,
    work_item_id: row.work_item_id,
    identity: row.identity,
    status: row.status,
    sort_order: row.sort_order,
    blocking_work_item_id: row.blocking_work_item_id || '',
    decided_at: row.decided_at || '',
    reason: row.reason || '',
    created_at: row.created_at,
  };
}

function hydrateEpic(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    description: row.description,
    acceptance_criteria: row.acceptance_criteria,
    target_date: row.target_date || '',
    tags: row.tags ?? [],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function groupBy(items, key) {
  const map = new Map();
  for (const item of items) {
    const k = item[key];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

// --- Projects ---

export async function upsertProject({ key, org, project, component, path, role }) {
  const now = new Date().toISOString();
  await pool.query(`
    INSERT INTO projects (key, org, project, component, path, role, synced_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (key) DO UPDATE SET
      org = EXCLUDED.org, project = EXCLUDED.project, component = EXCLUDED.component,
      path = EXCLUDED.path, role = EXCLUDED.role, synced_at = EXCLUDED.synced_at
  `, [key, org, project, component, path || '', role || '', now]);
}

export async function ensureProject(key, client = null) {
  const query = client ? client.query.bind(client) : pool.query.bind(pool);
  const existing = await query('SELECT key FROM projects WHERE key = $1', [key]).then(r => r.rows[0] ?? null);
  if (existing) return;
  const parts = key.split('/');
  const now = new Date().toISOString();
  await query(
    `INSERT INTO projects (key, org, project, component, path, role, synced_at) VALUES ($1, $2, $3, $4, '', '', $5) ON CONFLICT DO NOTHING`,
    [key, parts[0] || key, parts[1] || '', parts[2] || '', now]
  );
}

export async function getAllProjects() {
  return pool.query('SELECT * FROM projects ORDER BY org, project, component').then(r => r.rows);
}

export async function getProject(key) {
  return pool.query('SELECT * FROM projects WHERE key = $1', [key]).then(r => r.rows[0] ?? null);
}

// --- Session History ---

export async function recordSessionHistory({ id, type, project_key, work_item_id, epic_id, title, status, permission_mode, started_at, ended_at, cost_usd }) {
  const start = new Date(started_at).getTime();
  const end = new Date(ended_at).getTime();
  const duration_seconds = Math.max(0, (end - start) / 1000);
  if (isNaN(duration_seconds)) {
    console.warn(`recordSessionHistory(${id}): NaN duration from ${started_at} → ${ended_at}`);
    return;
  }

  await withTransaction(async (client) => {
    await ensureProject(project_key, client);
    await client.query(`
      INSERT INTO session_history (id, type, project_key, work_item_id, epic_id, title, status, permission_mode, started_at, ended_at, duration_seconds, cost_usd)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        cost_usd = COALESCE(EXCLUDED.cost_usd, session_history.cost_usd)
    `, [id, type, project_key, work_item_id || null, epic_id || null, title || '', status, permission_mode || null, started_at, ended_at, duration_seconds, cost_usd || null]);
  });
}

export async function getSessionHistory({ project_key, epic_id, work_item_id, limit, offset } = {}) {
  let sql = 'SELECT * FROM session_history WHERE 1=1';
  const params = [];
  let paramIdx = 1;

  if (project_key) { sql += ` AND project_key = $${paramIdx++}`; params.push(project_key); }
  if (epic_id) { sql += ` AND epic_id = $${paramIdx++}`; params.push(epic_id); }
  if (work_item_id) { sql += ` AND work_item_id = $${paramIdx++}`; params.push(work_item_id); }
  sql += ' ORDER BY ended_at DESC';
  if (limit) { sql += ` LIMIT $${paramIdx++}`; params.push(limit); }
  if (offset) { sql += ` OFFSET $${paramIdx++}`; params.push(offset); }

  return pool.query(sql, params).then(r => r.rows);
}

export async function getTimeReport(todayStart) {
  const today = await pool.query(`
    SELECT sh.project_key, p.org, p.project, p.component,
      COUNT(*) AS sessions, COALESCE(SUM(sh.duration_seconds), 0) AS time_seconds, COALESCE(SUM(sh.cost_usd), 0) AS cost_usd
    FROM session_history sh JOIN projects p ON sh.project_key = p.key
    WHERE sh.ended_at >= $1 GROUP BY sh.project_key, p.org, p.project, p.component ORDER BY time_seconds DESC
  `, [todayStart]).then(r => r.rows);

  const overall = await pool.query(`
    SELECT ps.project_key, p.org, p.project, p.component,
      ps.session_count AS sessions, ps.total_time_seconds AS time_seconds, ps.total_cost_usd AS cost_usd
    FROM project_stats ps JOIN projects p ON ps.project_key = p.key
    ORDER BY time_seconds DESC
  `).then(r => r.rows);

  return { today, overall };
}

export async function getTimeReportDaily(days = 14) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  return pool.query(`
    SELECT sh.project_key, p.org, p.project, p.component,
      (sh.ended_at::timestamptz)::date AS day,
      COALESCE(SUM(sh.duration_seconds), 0) AS time_seconds,
      COALESCE(SUM(sh.cost_usd), 0) AS cost_usd
    FROM session_history sh JOIN projects p ON sh.project_key = p.key
    WHERE sh.ended_at >= $1
    GROUP BY sh.project_key, p.org, p.project, p.component, day
    ORDER BY day ASC, time_seconds DESC
  `, [since]).then(r => r.rows);
}

export async function getTimeReportMonthly(months = 6) {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  d.setDate(1); d.setHours(0, 0, 0, 0);
  return pool.query(`
    SELECT sh.project_key, p.org, p.project, p.component,
      TO_CHAR(sh.ended_at::timestamptz, 'YYYY-MM') AS month,
      COALESCE(SUM(sh.duration_seconds), 0) AS time_seconds,
      COALESCE(SUM(sh.cost_usd), 0) AS cost_usd
    FROM session_history sh JOIN projects p ON sh.project_key = p.key
    WHERE sh.ended_at >= $1
    GROUP BY sh.project_key, p.org, p.project, p.component, month
    ORDER BY month ASC, time_seconds DESC
  `, [d.toISOString()]).then(r => r.rows);
}

// --- Time report: org-level grouping ---

export async function getTimeReportByOrg(todayStart) {
  const today = await pool.query(`
    SELECT p.org, p.org AS project_key,
      COUNT(*) AS sessions, COALESCE(SUM(sh.duration_seconds), 0) AS time_seconds, COALESCE(SUM(sh.cost_usd), 0) AS cost_usd
    FROM session_history sh JOIN projects p ON sh.project_key = p.key
    WHERE sh.ended_at >= $1 GROUP BY p.org ORDER BY time_seconds DESC
  `, [todayStart]).then(r => r.rows);

  const overall = await pool.query(`
    SELECT p.org, p.org AS project_key,
      SUM(ps.session_count) AS sessions, SUM(ps.total_time_seconds) AS time_seconds, SUM(ps.total_cost_usd) AS cost_usd
    FROM project_stats ps JOIN projects p ON ps.project_key = p.key
    GROUP BY p.org ORDER BY time_seconds DESC
  `).then(r => r.rows);

  return { today, overall };
}

export async function getTimeReportDailyByOrg(days = 14) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  return pool.query(`
    SELECT p.org, p.org AS project_key,
      (sh.ended_at::timestamptz)::date AS day,
      COALESCE(SUM(sh.duration_seconds), 0) AS time_seconds,
      COALESCE(SUM(sh.cost_usd), 0) AS cost_usd
    FROM session_history sh JOIN projects p ON sh.project_key = p.key
    WHERE sh.ended_at >= $1
    GROUP BY p.org, day
    ORDER BY day ASC, time_seconds DESC
  `, [since]).then(r => r.rows);
}

export async function getTimeReportMonthlyByOrg(months = 6) {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  d.setDate(1); d.setHours(0, 0, 0, 0);
  return pool.query(`
    SELECT p.org, p.org AS project_key,
      TO_CHAR(sh.ended_at::timestamptz, 'YYYY-MM') AS month,
      COALESCE(SUM(sh.duration_seconds), 0) AS time_seconds,
      COALESCE(SUM(sh.cost_usd), 0) AS cost_usd
    FROM session_history sh JOIN projects p ON sh.project_key = p.key
    WHERE sh.ended_at >= $1
    GROUP BY p.org, month
    ORDER BY month ASC, time_seconds DESC
  `, [d.toISOString()]).then(r => r.rows);
}

export async function getProjectStats(key) {
  return pool.query('SELECT * FROM project_stats WHERE project_key = $1', [key]).then(r => r.rows[0] ?? null);
}

export async function getEpicStats(epicId) {
  return pool.query('SELECT * FROM epic_stats WHERE epic_id = $1', [epicId]).then(r => r.rows[0] ?? null);
}

export async function getWorkItemStats(workItemId) {
  return pool.query('SELECT * FROM work_item_stats WHERE work_item_id = $1', [workItemId]).then(r => r.rows[0] ?? null);
}

export async function getAllWorkItemStats() {
  const rows = await pool.query('SELECT * FROM work_item_stats').then(r => r.rows);
  const map = new Map();
  for (const r of rows) map.set(r.work_item_id, r);
  return map;
}

export async function hardDeleteAllTestData() {
  if (!process.env.WORK_DIR) {
    throw new Error('hardDeleteAllTestData refused: not in test mode (WORK_DIR not set)');
  }
  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  await withTransaction(async (client) => {
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query('DELETE FROM epic_logs WHERE logged_at > $1', [cutoff]);
    await client.query('DELETE FROM work_items WHERE created_at > $1', [cutoff]);
    await client.query('DELETE FROM epics WHERE created_at > $1', [cutoff]);
    await client.query('DELETE FROM session_history WHERE ended_at > $1', [cutoff]);
  });
}

// --- Knowledge Sync functions (for sync.mjs routes) ---

export async function getSyncStatusByProject() {
  return pool.query(`
    SELECT project_key,
      MAX(synced_at) AS last_synced_at,
      SUM(CASE WHEN status = 'completed' THEN significant_count ELSE 0 END) AS total_significant
    FROM knowledge_syncs
    WHERE status = 'completed'
    GROUP BY project_key
  `).then(r => r.rows);
}

export async function createKnowledgeSync(projectKey, trigger) {
  const startedAt = new Date().toISOString();
  const result = await pool.query(`
    INSERT INTO knowledge_syncs (project_key, trigger, status, started_at)
    VALUES ($1, $2, 'pending', $3)
    RETURNING id
  `, [projectKey, trigger, startedAt]);
  return result.rows[0].id;
}

export async function updateKnowledgeSyncStatus(id, fields) {
  const allowed = ['status', 'synced_at', 'commit_from', 'commit_to', 'commits_scanned', 'significant_count', 'summary_json', 'error'];
  const fieldKeys = Object.keys(fields).filter(k => allowed.includes(k));
  if (!fieldKeys.length) return;
  const sets = [];
  const values = [];
  let paramIdx = 1;
  for (const key of fieldKeys) {
    sets.push(`${key} = $${paramIdx++}`);
    values.push(key === 'summary_json' ? jsonb(fields[key], []) : fields[key]);
  }
  values.push(id);
  await pool.query(`UPDATE knowledge_syncs SET ${sets.join(', ')} WHERE id = $${paramIdx}`, values);
}

export async function getSignificantChangeLogEntries(limit = 50) {
  return pool.query(`
    SELECT id, project_key, commit_hash, commit_message, author,
           committed_at, classification, ai_summary, affected_files
    FROM change_log_entries
    WHERE classification IN ('architectural', 'dependency')
    ORDER BY committed_at DESC
    LIMIT $1
  `, [limit]).then(r => r.rows);
}

export async function getKnowledgeSyncHistory(projectKey, limit = 20) {
  return pool.query(`
    SELECT id, project_key, trigger, status, started_at, synced_at,
           commits_scanned, significant_count, error
    FROM knowledge_syncs
    WHERE project_key = $1
    ORDER BY started_at DESC
    LIMIT $2
  `, [projectKey, limit]).then(r => r.rows);
}

export async function countOrphanedWorktrees() {
  const result = await pool.query(
    "SELECT COUNT(*) AS cnt FROM dispatches WHERE worktree_path IS NOT NULL AND status != 'running'"
  );
  return parseInt(result.rows[0]?.cnt ?? 0, 10);
}

export async function addChangeLogEntries(entries) {
  if (!entries.length) return 0;
  const now = new Date().toISOString();
  return withTransaction(async (client) => {
    let inserted = 0;
    for (const e of entries) {
      const result = await client.query(`
        INSERT INTO change_log_entries
          (project_key, commit_hash, commit_message, author, committed_at, affected_files, classification, ai_summary, detected_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT DO NOTHING
      `, [
        e.project_key, e.commit_hash, e.commit_message, e.author || '',
        e.committed_at, jsonb(e.affected_files, []),
        e.classification, e.ai_summary || null, now,
      ]);
      inserted += result.rowCount;
    }
    return inserted;
  });
}

export async function pruneChangeLogEntries(projectKey) {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  await pool.query('DELETE FROM change_log_entries WHERE project_key = $1 AND committed_at < $2', [projectKey, cutoff]);
  const countRow = await pool.query('SELECT COUNT(*) AS n FROM change_log_entries WHERE project_key = $1', [projectKey]).then(r => r.rows[0]);
  if (Number(countRow.n) > 100) {
    await pool.query(`
      DELETE FROM change_log_entries WHERE project_key = $1 AND id NOT IN (
        SELECT id FROM change_log_entries WHERE project_key = $1 ORDER BY committed_at DESC LIMIT 100
      )
    `, [projectKey]);
  }
}

export async function getChangeLogEntries(projectKey, since) {
  const params = since ? [projectKey, since] : [projectKey];
  const sinceClause = since ? 'AND committed_at > $2' : '';
  return pool.query(`
    SELECT id, project_key, commit_hash, commit_message, author, committed_at,
           classification, ai_summary, affected_files
    FROM change_log_entries
    WHERE project_key = $1 ${sinceClause}
    ORDER BY committed_at DESC
    LIMIT 10
  `, params).then(r => r.rows);
}

// --- Repo Sync Config functions ---

export async function getRepoSyncConfigs() {
  return pool.query(
    'SELECT * FROM repo_sync_config ORDER BY github_repo_name'
  ).then(r => r.rows);
}

export async function getEnabledRepos() {
  return pool.query(
    'SELECT * FROM repo_sync_config WHERE sync_enabled = TRUE AND local_path IS NOT NULL ORDER BY github_repo_name'
  ).then(r => r.rows);
}

export async function upsertRepoSyncConfig(row) {
  const now = new Date().toISOString();
  await pool.query(`
    INSERT INTO repo_sync_config
      (github_repo_name, github_org, default_branch, local_path, portfolio_key, sync_enabled, last_github_updated_at, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (github_repo_name) DO UPDATE SET
      github_org             = EXCLUDED.github_org,
      default_branch         = EXCLUDED.default_branch,
      local_path             = COALESCE(EXCLUDED.local_path, repo_sync_config.local_path),
      portfolio_key          = COALESCE(EXCLUDED.portfolio_key, repo_sync_config.portfolio_key),
      last_github_updated_at = COALESCE(EXCLUDED.last_github_updated_at, repo_sync_config.last_github_updated_at),
      updated_at             = $9
  `, [
    row.github_repo_name,
    row.github_org ?? 'NeuronicPBM',
    row.default_branch ?? 'main',
    row.local_path ?? null,
    row.portfolio_key ?? null,
    row.sync_enabled ?? false,
    row.last_github_updated_at ?? null,
    row.created_at ?? now,
    now,
  ]);
}

export async function setRepoSyncEnabled(name, enabled) {
  await pool.query(
    'UPDATE repo_sync_config SET sync_enabled = $2, updated_at = NOW() WHERE github_repo_name = $1',
    [name, enabled]
  );
}

// --- ADR functions ---

export async function getAdrs(orgKey, limit = 50) {
  return pool.query(
    'SELECT * FROM adrs WHERE org_key = $1 ORDER BY created_at DESC LIMIT $2',
    [orgKey, limit]
  ).then(r => r.rows);
}

export async function getAdr(id) {
  return pool.query('SELECT * FROM adrs WHERE id = $1', [id]).then(r => r.rows[0] ?? null);
}

export async function createAdr(adr) {
  const now = new Date().toISOString();
  await pool.query(`
    INSERT INTO adrs (id, org_key, title, type, repos, sync_run_id, detail_path, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (id) DO NOTHING
  `, [
    adr.id,
    adr.org_key,
    adr.title,
    adr.type,
    JSON.stringify(adr.repos ?? []),
    adr.sync_run_id ?? null,
    adr.detail_path,
    adr.created_at ?? now,
  ]);
}

// --- Test-support query (for test-endpoints.mjs explain-query route) ---

export async function explainApproverPendingQuery(identity) {
  // Disable seq scan so the planner is forced to consider the index even on tiny tables.
  // This is a test-only function; the hint is session-scoped and cleared on client release.
  const client = await pool.connect();
  try {
    await client.query('SET enable_seqscan = off');
    const result = await client.query(
      `EXPLAIN SELECT * FROM work_item_approvals WHERE identity = $1 AND status = 'pending'`,
      [identity]
    );
    return result.rows.map(r => ({ detail: r['QUERY PLAN'] }));
  } finally {
    client.release();
  }
}

// --- Org Repo Management ---

export async function getRepoSyncConfigsByGithubOrg(githubOrg) {
  const r = await pool.query(
    'SELECT * FROM repo_sync_config WHERE github_org = $1 ORDER BY github_repo_name',
    [githubOrg]
  );
  return r.rows;
}

export async function setRepoPortfolioKey(repoName, portfolioKey) {
  await pool.query(
    'UPDATE repo_sync_config SET portfolio_key = $2, updated_at = now() WHERE github_repo_name = $1',
    [repoName, portfolioKey]
  );
}

export async function getProjectAvgDispatchCost(projectKey) {
  const r = await pool.query(
    `SELECT AVG(cost_usd) AS avg_cost, COUNT(*) AS count
     FROM session_history
     WHERE project_key = $1
       AND type = 'dispatch'
       AND cost_usd IS NOT NULL
       AND ended_at > NOW() - INTERVAL '30 days'`,
    [projectKey]
  );
  const row = r.rows[0];
  return {
    avg_cost: row.avg_cost ? parseFloat(row.avg_cost) : 0,
    count: parseInt(row.count, 10),
  };
}

export async function getDispatchesByProjectKey(projectKey) {
  const r = await pool.query(
    'SELECT * FROM dispatches WHERE project_key = $1',
    [projectKey]
  );
  return r.rows;
}

export async function cancelWorkItemsByProjectKey(projectKey) {
  const r = await pool.query(
    `UPDATE work_items SET status = 'cancelled', updated_at = now()
     WHERE project_key = $1 AND status NOT IN ('done','cancelled','archived')
     RETURNING id`,
    [projectKey]
  );
  return r.rows.map(row => row.id);
}

export async function archiveWorkItemsByProjectKey(projectKey) {
  const r = await pool.query(
    `UPDATE work_items SET status = 'archived', updated_at = now()
     WHERE project_key = $1 AND status IN ('done','cancelled')
     RETURNING id`,
    [projectKey]
  );
  return r.rows;
}

export async function deleteProjectRow(projectKey) {
  await pool.query('DELETE FROM session_history WHERE project_key = $1', [projectKey]);
  await pool.query('DELETE FROM projects WHERE key = $1', [projectKey]);
}

export async function unlinkRepoByPortfolioKey(portfolioKey) {
  await pool.query(
    'UPDATE repo_sync_config SET portfolio_key = NULL WHERE portfolio_key = $1',
    [portfolioKey]
  );
}

// --- Cost tracking ---

export async function insertDispatchCost({ id, model, agentRole, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }) {
  const pricing = await pool.query('SELECT * FROM model_pricing WHERE model_id = $1', [model]);
  if (!pricing.rows[0]) return;
  const p = pricing.rows[0];
  const cost =
    (inputTokens || 0) * p.input_cost_per_mtok / 1_000_000 +
    (outputTokens || 0) * p.output_cost_per_mtok / 1_000_000 +
    (cacheReadTokens || 0) * p.cache_read_cost_per_mtok / 1_000_000 +
    (cacheWriteTokens || 0) * p.cache_write_cost_per_mtok / 1_000_000;
  await pool.query(
    `INSERT INTO dispatch_costs
       (id, model, agent_role, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd_breakdown)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, model, agentRole || null, inputTokens || 0, outputTokens || 0, cacheReadTokens || 0, cacheWriteTokens || 0, cost]
  );
  return cost;
}

export async function getCostByWorkItem(workItemId) {
  const r = await pool.query(
    `SELECT
       COALESCE(SUM(dc.cost_usd_breakdown), 0) AS total_cost_usd,
       COALESCE(SUM(dc.input_tokens + dc.output_tokens + dc.cache_read_tokens + dc.cache_write_tokens), 0) AS total_tokens,
       COUNT(DISTINCT dc.id) AS sessions
     FROM dispatch_costs dc
     JOIN dispatches d ON d.id = dc.id
     WHERE d.work_item_id = $1`,
    [workItemId]
  );
  const row = r.rows[0];
  return {
    total_cost_usd: parseFloat(row.total_cost_usd),
    total_tokens: parseInt(row.total_tokens, 10),
    sessions: parseInt(row.sessions, 10),
  };
}

export async function getCostByProject(projectKey) {
  const r = await pool.query(
    `SELECT
       COALESCE(SUM(dc.cost_usd_breakdown), 0) AS total_cost_usd,
       COALESCE(SUM(dc.input_tokens + dc.output_tokens + dc.cache_read_tokens + dc.cache_write_tokens), 0) AS total_tokens,
       COUNT(DISTINCT dc.id) AS sessions
     FROM dispatch_costs dc
     JOIN dispatches d ON d.id = dc.id
     WHERE d.project_key = $1`,
    [projectKey]
  );
  const row = r.rows[0];
  return {
    total_cost_usd: parseFloat(row.total_cost_usd),
    total_tokens: parseInt(row.total_tokens, 10),
    sessions: parseInt(row.sessions, 10),
  };
}

export async function getCostByEpic(epicId) {
  const r = await pool.query(
    `SELECT
       COALESCE(SUM(dc.cost_usd_breakdown), 0) AS total_cost_usd,
       COALESCE(SUM(dc.input_tokens + dc.output_tokens + dc.cache_read_tokens + dc.cache_write_tokens), 0) AS total_tokens,
       COUNT(DISTINCT dc.id) AS sessions
     FROM dispatch_costs dc
     JOIN dispatches d ON d.id = dc.id
     WHERE d.epic_id = $1`,
    [epicId]
  );
  const row = r.rows[0];
  return {
    total_cost_usd: parseFloat(row.total_cost_usd),
    total_tokens: parseInt(row.total_tokens, 10),
    sessions: parseInt(row.sessions, 10),
  };
}

export async function getDispatchCostRows(dispatchId) {
  const r = await pool.query(
    'SELECT * FROM dispatch_costs WHERE id = $1',
    [dispatchId]
  );
  return r.rows;
}

// --- Prompt capture ---

export async function insertPromptRecord({ dispatch_id, work_item_id, project_key, prompt_text, char_count, truncated }) {
  await pool.query(
    `INSERT INTO dispatch_prompts (dispatch_id, work_item_id, project_key, prompt_text, char_count, truncated)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [dispatch_id || null, work_item_id || null, project_key || null, prompt_text, char_count, truncated]
  );
}

export async function getPromptsByWorkItem(workItemId) {
  const r = await pool.query(
    `SELECT dispatch_id, created_at, char_count, truncated, prompt_text
     FROM dispatch_prompts
     WHERE work_item_id = $1
     ORDER BY created_at DESC`,
    [workItemId]
  );
  return r.rows;
}

// --- Cost summary ---

function buildBreakdownQuery(groupBy) {
  if (groupBy === 'model') {
    return { labelExpr: 'dc.model', joinClause: '' };
  }
  if (groupBy === 'agent_role') {
    return { labelExpr: 'dc.agent_role', joinClause: '' };
  }
  if (groupBy === 'project_key') {
    return {
      labelExpr: 'd.project_key',
      joinClause: 'JOIN dispatches d ON d.id = dc.id',
    };
  }
  if (groupBy === 'epic_id') {
    return {
      labelExpr: 'd.epic_id',
      joinClause: 'JOIN dispatches d ON d.id = dc.id',
    };
  }
  return { labelExpr: 'dc.model', joinClause: '' };
}

function trendByDay(rows) {
  const byDay = new Map();
  for (const r of rows) {
    const day = (r.recorded_at || '').slice(0, 10);
    if (!day) continue;
    const entry = byDay.get(day) || { period: day, cost_usd: 0, sessions: 0 };
    entry.cost_usd += typeof r.cost_usd_breakdown === 'number' ? r.cost_usd_breakdown : parseFloat(r.cost_usd_breakdown || 0);
    entry.sessions += 1;
    byDay.set(day, entry);
  }
  return [...byDay.values()]
    .sort((a, b) => a.period.localeCompare(b.period))
    .map(e => ({ period: e.period, cost_usd: parseFloat(e.cost_usd.toFixed(4)), sessions: e.sessions }));
}

export async function getCostSummary({ from, to, groupBy = 'model' } = {}) {
  const defaultFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const defaultTo = new Date().toISOString().slice(0, 10);
  const fromDate = from || defaultFrom;
  const toDate = to || defaultTo;

  const totalsJoin = (groupBy === 'project_key' || groupBy === 'epic_id')
    ? 'JOIN dispatches d ON d.id = dc.id'
    : '';
  const totalsResult = await pool.query(
    `SELECT
       COALESCE(SUM(dc.cost_usd_breakdown), 0)                                                   AS total_cost_usd,
       COALESCE(SUM(dc.input_tokens + dc.output_tokens + dc.cache_read_tokens + dc.cache_write_tokens), 0) AS total_tokens,
       COUNT(*)                                                                                   AS sessions
     FROM dispatch_costs dc
     ${totalsJoin}
     WHERE dc.recorded_at >= $1 AND dc.recorded_at < ($2::date + INTERVAL '1 day')`,
    [fromDate, toDate]
  );
  const totals = totalsResult.rows[0];

  const { labelExpr, joinClause } = buildBreakdownQuery(groupBy);
  const breakdownResult = await pool.query(
    `SELECT
       COALESCE(${labelExpr}::text, '(unknown)')                                                  AS label,
       COALESCE(SUM(dc.cost_usd_breakdown), 0)                                                   AS cost_usd,
       COALESCE(SUM(dc.input_tokens + dc.output_tokens + dc.cache_read_tokens + dc.cache_write_tokens), 0) AS tokens,
       COUNT(*)                                                                                   AS sessions
     FROM dispatch_costs dc
     ${joinClause}
     WHERE dc.recorded_at >= $1 AND dc.recorded_at < ($2::date + INTERVAL '1 day')
     GROUP BY ${labelExpr}
     ORDER BY cost_usd DESC`,
    [fromDate, toDate]
  );

  const rawResult = await pool.query(
    `SELECT dc.recorded_at, dc.cost_usd_breakdown
     FROM dispatch_costs dc
     WHERE dc.recorded_at >= $1 AND dc.recorded_at < ($2::date + INTERVAL '1 day')`,
    [fromDate, toDate]
  );

  return {
    total_cost_usd: parseFloat(totals.total_cost_usd),
    total_tokens: parseInt(totals.total_tokens, 10),
    sessions: parseInt(totals.sessions, 10),
    period: { from: fromDate, to: toDate },
    breakdown: breakdownResult.rows.map(r => ({
      label: r.label,
      cost_usd: parseFloat(r.cost_usd),
      tokens: parseInt(r.tokens, 10),
      sessions: parseInt(r.sessions, 10),
    })),
    trend: trendByDay(rawResult.rows),
  };
}
