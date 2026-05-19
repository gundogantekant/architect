// Per-session prompt file under tmp/. The dispatcher streams this file into the child's
// stdin so backpressure handles the buffer-truncation risk that motivated W-1141. Prompts
// > 512KB skip the file and fall back to a direct stdin write (with drain handling). See
// routes/dispatch.mjs for the streaming site (W-1184 restored streaming after a regression
// that incorrectly used --append-system-prompt-file).
import { writeFile, unlink, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const PROMPT_FILE_MODE = 0o600;
const STDIN_FALLBACK_THRESHOLD = 512 * 1024;

export async function writePromptFile(promptText, sessionId, tmpDir) {
  if (promptText.length > STDIN_FALLBACK_THRESHOLD) return null;
  const filePath = join(tmpDir, `prompt-${sessionId}.txt`);
  await writeFile(filePath, promptText, { mode: PROMPT_FILE_MODE });
  return filePath;
}

export async function deletePromptFile(filePath) {
  if (!filePath) return;
  await unlink(filePath);
}

export async function sweepOrphanedPromptFiles(tmpDir, maxAgeMs = 3_600_000) {
  let entries;
  try {
    entries = await readdir(tmpDir);
  } catch {
    return;
  }
  const now = Date.now();
  await Promise.all(
    entries
      .filter(name => name.startsWith('prompt-') && name.endsWith('.txt'))
      .map(async name => {
        const filePath = join(tmpDir, name);
        try {
          const info = await stat(filePath);
          if (now - info.mtimeMs > maxAgeMs) {
            await unlink(filePath);
          }
        } catch {
          // file may have been deleted between readdir and stat
        }
      })
  );
}
