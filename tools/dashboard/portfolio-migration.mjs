import { existsSync, mkdirSync, renameSync, cpSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

export function migrateLegacyPortfolio({ legacyPath, targetPath }) {
  if (!existsSync(legacyPath)) return false;
  if (existsSync(targetPath)) return false;
  try {
    mkdirSync(dirname(targetPath), { recursive: true });
    renameSync(legacyPath, targetPath);
    console.log(`[portfolio] Migrated ${legacyPath} → ${targetPath}`);
    return true;
  } catch (err) {
    if (err.code === 'EXDEV') {
      try {
        cpSync(legacyPath, targetPath, { recursive: true });
        rmSync(legacyPath, { recursive: true, force: true });
        console.log(`[portfolio] Migrated (cross-device copy) ${legacyPath} → ${targetPath}`);
        return true;
      } catch (copyErr) {
        console.error(`[portfolio] Migration failed: ${copyErr.message}. Move ${legacyPath} to ${targetPath} manually.`);
        return false;
      }
    }
    console.error(`[portfolio] Migration failed: ${err.message}. Move ${legacyPath} to ${targetPath} manually.`);
    return false;
  }
}
