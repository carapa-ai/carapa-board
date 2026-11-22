import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { sha256Hex } from '../lib/hash.js';
import { logger } from '../logger.js';

function getPgliteVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    let dir = path.dirname(require.resolve('@electric-sql/pglite'));
    for (let i = 0; i < 6; i++) {
      const pkgPath = path.join(dir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
          name?: unknown;
          version?: unknown;
        };
        if (
          pkg.name === '@electric-sql/pglite' &&
          typeof pkg.version === 'string'
        ) {
          return pkg.version;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* fallback below */
  }
  return 'unknown';
}

function computeMigrationTemplateKey(
  migrationsFolder: string,
  pgliteVersion = getPgliteVersion(),
): string | null {
  try {
    const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');
    const journalRaw = fs.readFileSync(journalPath, 'utf8');
    const journal = JSON.parse(journalRaw) as {
      entries?: Array<{ tag?: unknown }>;
    };
    if (!Array.isArray(journal.entries)) return null;

    const parts: string[] = [
      `pglite:${pgliteVersion}`,
      `journal:${sha256Hex(journalRaw)}`,
    ];
    for (const entry of journal.entries) {
      if (typeof entry?.tag !== 'string' || !entry.tag) return null;
      const sqlRaw = fs.readFileSync(
        path.join(migrationsFolder, `${entry.tag}.sql`),
      );
      parts.push(`${entry.tag}:${sha256Hex(sqlRaw)}`);
    }
    return sha256Hex(parts.join('\n'));
  } catch {
    return null;
  }
}

export function getTemplateCachePath(migrationsFolder: string): string | null {
  const key = computeMigrationTemplateKey(migrationsFolder);
  if (!key) return null;
  return path.join(os.tmpdir(), `carapa-board-pglite-template-${key}.tar.gz`);
}

export function readPgliteTemplateBlob(templatePath: string): Blob | null {
  try {
    const bytes = fs.readFileSync(templatePath);
    if (bytes.length === 0) return null;
    return new Blob([Uint8Array.from(bytes)]);
  } catch {
    return null;
  }
}

export async function writePgliteTemplate(
  pg: PGlite,
  templatePath: string,
): Promise<void> {
  const tmpPath = `${templatePath}.tmp.${process.pid}.${randomUUID()}`;
  try {
    const dump = await pg.dumpDataDir('gzip');
    const bytes = new Uint8Array(await dump.arrayBuffer());
    fs.writeFileSync(tmpPath, bytes);
    fs.renameSync(tmpPath, templatePath);
  } catch (err) {
    logger.debug(
      { err, templatePath },
      'Failed to write cached PGlite test template',
    );
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* best effort */
    }
  }
}
