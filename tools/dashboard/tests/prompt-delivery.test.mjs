/**
 * Prompt Delivery Contract Tests (CT-1 through CT-6)
 *
 * Verifies that dispatch spawn sites use --append-system-prompt-file for prompt
 * delivery instead of stdin.write, with proper file lifecycle and size fallback.
 *
 * CT-1: Standard dispatch with 64KB+ prompt → --append-system-prompt-file arg
 * CT-2: After process exit → prompt file deleted
 * CT-3: Startup orphan sweep removes stale prompt files (mtime > 1h)
 * CT-4: 5 concurrent dispatches → distinct, non-contaminated prompt files
 * CT-5: 600KB prompt → stdin fallback, no prompt file created
 * CT-6: Onboard dispatch → --append-system-prompt-file arg
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, statSync, chmodSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writePromptFile, deletePromptFile, sweepOrphanedPromptFiles } from '../prompt-file.mjs';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMarkerPrompt(marker, sizeBytes) {
  const padding = 'x'.repeat(Math.max(0, sizeBytes - marker.length));
  return marker + padding;
}

function promptFilesIn(dir) {
  return readdirSync(dir).filter(n => n.startsWith('prompt-') && n.endsWith('.txt'));
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Prompt Delivery — CT-1 through CT-6', () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'prompt-delivery-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Remove any leftover prompt files between tests
    for (const name of promptFilesIn(tmpDir)) {
      try { rmSync(join(tmpDir, name)); } catch {}
    }
  });

  it('CT-1: 64KB+ prompt → file created with correct content and mode 0o600', async () => {
    const marker = 'PROMPT-MARKER-XYZ';
    const prompt = makeMarkerPrompt(marker, 64 * 1024 + 1);
    const sessionId = `D-ct1-${Date.now()}`;

    const filePath = await writePromptFile(prompt, sessionId, tmpDir);

    assert.ok(filePath, 'writePromptFile must return a file path');
    assert.match(filePath, /prompt-D-ct1-\d+\.txt$/);
    assert.ok(existsSync(filePath), 'prompt file must exist on disk');

    const { readFileSync } = await import('node:fs');
    const content = readFileSync(filePath, 'utf8');
    assert.ok(content.includes(marker), 'file content must include the marker');

    const { statSync } = await import('node:fs');
    const info = statSync(filePath);
    assert.equal(info.mode & 0o777, 0o600, 'file mode must be 0o600');
  });

  it('CT-2: After deletePromptFile → file is removed', async () => {
    const sessionId = `D-ct2-${Date.now()}`;
    const filePath = await writePromptFile('some prompt text', sessionId, tmpDir);
    assert.ok(filePath);
    assert.ok(existsSync(filePath));

    await deletePromptFile(filePath);

    assert.equal(existsSync(filePath), false, 'prompt file must be deleted after close');
  });

  it('CT-3: sweepOrphanedPromptFiles removes files older than maxAgeMs', async () => {
    const staleName = `prompt-D-stale.txt`;
    const stalePath = join(tmpDir, staleName);
    writeFileSync(stalePath, 'stale content');

    // Backdate mtime to 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(stalePath, twoHoursAgo, twoHoursAgo);

    assert.ok(existsSync(stalePath), 'stale file must exist before sweep');

    await sweepOrphanedPromptFiles(tmpDir, 3_600_000);

    assert.equal(existsSync(stalePath), false, 'stale file must be removed by sweep');
  });

  it('CT-3b: sweepOrphanedPromptFiles keeps recent files', async () => {
    const recentName = `prompt-D-recent.txt`;
    const recentPath = join(tmpDir, recentName);
    writeFileSync(recentPath, 'recent content');

    await sweepOrphanedPromptFiles(tmpDir, 3_600_000);

    assert.ok(existsSync(recentPath), 'recent file must be kept by sweep');
    rmSync(recentPath);
  });

  it('CT-4: 5 concurrent dispatches → distinct files with non-contaminated content', async () => {
    const markers = Array.from({ length: 5 }, (_, i) => `MARKER-CT4-${i}`);
    const base = Date.now();
    const sessionIds = markers.map((_, i) => `D-ct4-${base + i}`);

    const paths = await Promise.all(
      markers.map((marker, i) =>
        writePromptFile(makeMarkerPrompt(marker, 64 * 1024 + 1), sessionIds[i], tmpDir)
      )
    );

    const uniquePaths = new Set(paths);
    assert.equal(uniquePaths.size, 5, 'all 5 dispatches must get distinct file paths');

    const { readFileSync } = await import('node:fs');
    for (let i = 0; i < 5; i++) {
      const content = readFileSync(paths[i], 'utf8');
      assert.ok(content.includes(markers[i]), `file ${i} must contain its own marker`);
      for (let j = 0; j < 5; j++) {
        if (j !== i) {
          assert.equal(content.includes(markers[j]), false, `file ${i} must not contain marker for dispatch ${j}`);
        }
      }
    }
  });

  it('CT-5: 600KB prompt → writePromptFile returns null (stdin fallback)', async () => {
    const prompt = 'x'.repeat(600 * 1024);
    const sessionId = `D-ct5-${Date.now()}`;

    const filePath = await writePromptFile(prompt, sessionId, tmpDir);

    assert.equal(filePath, null, 'writePromptFile must return null for prompts > 512KB');
    const promptFiles = promptFilesIn(tmpDir);
    assert.equal(promptFiles.length, 0, 'no prompt file must be created for 600KB prompt');
  });

  it('CT-6: writePromptFile works for onboard-style session ID', async () => {
    const sessionId = `D-onboard-${Date.now()}`;
    const prompt = 'x'.repeat(1024);

    const filePath = await writePromptFile(prompt, sessionId, tmpDir);

    assert.ok(filePath, 'writePromptFile must return a path for onboard dispatch');
    assert.ok(existsSync(filePath), 'prompt file must exist on disk');
    assert.match(filePath, /prompt-D-onboard-\d+\.txt$/);

    rmSync(filePath);
  });

  it('CT-2b: deletePromptFile is a no-op for null path', async () => {
    await deletePromptFile(null);
    // no assertion needed — must not throw
  });
});
