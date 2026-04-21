import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { backupDatabase } from '../db.mjs';

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'backup-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('backupDatabase', () => {
  it('creates a timestamped backup of the database', () => {
    const workDir = join(tmpDir, 'work');
    const backupDir = join(tmpDir, 'backups');
    mkdirSync(workDir, { recursive: true });

    const srcDb = new Database(join(workDir, 'architect.db'));
    srcDb.exec('CREATE TABLE test_data (id INTEGER PRIMARY KEY, value TEXT)');
    srcDb.exec("INSERT INTO test_data VALUES (1, 'hello')");
    srcDb.close();

    const dest = backupDatabase(workDir, backupDir);

    assert.ok(dest, 'should return the backup path');
    assert.match(dest, /architect-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.db$/);

    const files = readdirSync(backupDir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^architect-.*\.db$/);

    const backupDb = new Database(dest, { readonly: true });
    const row = backupDb.prepare('SELECT value FROM test_data WHERE id = 1').get();
    backupDb.close();
    assert.equal(row.value, 'hello');
  });

  it('flushes WAL before copying', () => {
    const workDir = join(tmpDir, 'work');
    const backupDir = join(tmpDir, 'backups');
    mkdirSync(workDir, { recursive: true });

    const srcDb = new Database(join(workDir, 'architect.db'));
    srcDb.pragma('journal_mode = WAL');
    srcDb.exec('CREATE TABLE wal_test (id INTEGER PRIMARY KEY, val TEXT)');
    srcDb.exec("INSERT INTO wal_test VALUES (1, 'wal-data')");
    srcDb.close();

    const dest = backupDatabase(workDir, backupDir);

    const backupDb = new Database(dest, { readonly: true });
    const row = backupDb.prepare('SELECT val FROM wal_test WHERE id = 1').get();
    backupDb.close();
    assert.equal(row.val, 'wal-data');
  });

  it('returns null and does not error when no database exists', () => {
    const workDir = join(tmpDir, 'empty');
    const backupDir = join(tmpDir, 'backups');
    mkdirSync(workDir, { recursive: true });

    const result = backupDatabase(workDir, backupDir);
    assert.equal(result, null);
    assert.throws(() => readdirSync(backupDir), { code: 'ENOENT' });
  });

  it('creates the backup directory if it does not exist', () => {
    const workDir = join(tmpDir, 'work');
    const backupDir = join(tmpDir, 'nested', 'deep', 'backups');
    mkdirSync(workDir, { recursive: true });

    const srcDb = new Database(join(workDir, 'architect.db'));
    srcDb.exec('CREATE TABLE t (id INTEGER)');
    srcDb.close();

    const dest = backupDatabase(workDir, backupDir);
    assert.ok(dest);
    assert.equal(readdirSync(backupDir).length, 1);
  });
});
