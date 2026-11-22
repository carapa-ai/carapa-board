import path from 'node:path';
import { GROUPS_DIR } from '../../config.js';
import { groupDirFor } from '../../group-dir.js';
import { openTrustedDirSync, writeFileAtSync } from '../../lib/group-fs.js';
import { logger } from '../../logger.js';
import type { RegisteredGroup } from '../../types.js';
import { PROJECT_DIRS_FILE } from './reader-core.js';

let lastWritten: string | null = null;

/**
 * Write each project's folder (relative to GROUPS_DIR) to
 * `GROUPS_DIR/project-dirs.json`, so the transcripts skill, which has no
 * database, reads only the folders Board uses. Skipped when nothing changed or
 * no project is known (an empty list would hide every transcript).
 */
export function writeProjectDirsFile(groups: Iterable<RegisteredGroup>): void {
  const entries: Array<[string, string]> = [];
  for (const g of groups) {
    const rel = path.relative(GROUPS_DIR, groupDirFor(g.folder, g.parentId));
    entries.push([g.folder, rel.split(path.sep).join('/')]);
  }
  if (entries.length === 0) return;
  entries.sort(([a], [b]) => a.localeCompare(b));
  const text =
    JSON.stringify(
      { version: 1, projects: Object.fromEntries(entries) },
      null,
      2,
    ) + '\n';
  if (text === lastWritten) return;
  try {
    const root = openTrustedDirSync(GROUPS_DIR);
    if (!root) return;
    try {
      writeFileAtSync(root, PROJECT_DIRS_FILE, text);
      lastWritten = text;
    } finally {
      root.closeSync();
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'Failed to write project-dirs.json');
  }
}
