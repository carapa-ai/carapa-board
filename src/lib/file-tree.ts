/**
 * File-tree helpers — recursive filesystem walks for the "Files" sidebar tab.
 *
 * Used by the group-folder files endpoint to enumerate a project's local
 * working directory while skipping noisy/large directories. The working
 * directory is agent-writable, so every walk goes through pinned directory
 * descriptors (see group-fs.ts): a directory swapped for a link is never entered.
 */
import {
  GroupFsError,
  lstatAt,
  openDirAt,
  readdirAt,
  type PinnedDir,
} from './group-fs.js';

/** Directory names skipped when walking a group folder (noisy or large). */
export const GROUP_FILES_IGNORE = new Set<string>([
  'logs',
  'node_modules',
  '.git',
]);

/**
 * Recursively walk the pinned `dir`, returning file paths relative to it
 * (POSIX separators), sorted alphabetically. Directories in `ignore` are
 * skipped. Directories that cannot be read or entered (including links) are
 * left out. The caller closes `dir`.
 */
export async function walkFilesAt(
  dir: PinnedDir,
  ignore: Set<string> = GROUP_FILES_IGNORE,
): Promise<string[]> {
  const out: string[] = [];

  async function walk(current: PinnedDir, rel: string): Promise<void> {
    const entries = await readdirAt(current, undefined, {
      withFileTypes: true,
    }).catch(() => null);
    if (!entries) return;
    for (const entry of entries) {
      if (entry.isDirectory() && ignore.has(entry.name)) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const sub = await openDirAt(current, entry.name).catch(() => null);
        if (!sub) continue;
        try {
          await walk(sub, relPath);
        } finally {
          await sub.close();
        }
      } else if (entry.isFile()) {
        out.push(relPath);
      }
    }
  }

  await walk(dir, '');
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

export interface DirectoryEntry {
  kind: 'directory' | 'file';
  name: string;
  path: string;
  /** Byte size; present on file entries once sized by `addFileSizes`. */
  sizeBytes?: number;
  /** ISO mtime; only present when listed with `sort: 'modified'`. */
  modifiedAt?: string;
}

/**
 * Sets `sizeBytes` on file entries that do not have one yet. `entry.path` is
 * relative to the pinned `dir`; links are never followed. Entries that
 * vanish, are not regular files or cannot be stat'ed stay unsized.
 */
export async function addFileSizesAt(
  dir: PinnedDir,
  entries: DirectoryEntry[],
): Promise<void> {
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.kind !== 'file' || entry.sizeBytes !== undefined) return;
      try {
        const stat = await lstatAt(dir, entry.path);
        if (stat?.isFile()) entry.sizeBytes = stat.size;
      } catch {
        // Entry vanished or is unreadable: list it without a size.
      }
    }),
  );
}

export interface ListDirectoryOptions {
  sort?: 'name' | 'modified';
  order?: 'asc' | 'desc';
}

/**
 * Read one directory level below the pinned `dir` without recursively walking
 * its children. Throws `Path escapes root` for a `..` segment or a link or
 * file on the way, and an ENOENT error when the directory is missing.
 */
export async function listDirectoryAt(
  dir: PinnedDir,
  relativePath: string,
  limit: number,
  cursor?: string,
  ignore: Set<string> = GROUP_FILES_IGNORE,
  { sort = 'name', order = 'asc' }: ListDirectoryOptions = {},
): Promise<{ entries: DirectoryEntry[]; nextCursor?: string }> {
  const segments = relativePath.split(/[\\/]+/).filter((s) => s && s !== '.');
  let directory: PinnedDir | null = dir;
  if (segments.length > 0) {
    try {
      directory = await openDirAt(dir, segments.join('/'));
    } catch (err) {
      if (
        err instanceof GroupFsError &&
        ['invalid_path', 'symlink', 'not_directory'].includes(err.code)
      ) {
        throw new Error('Path escapes root');
      }
      throw err;
    }
  }
  if (!directory) {
    throw Object.assign(new Error('Directory not found'), { code: 'ENOENT' });
  }
  try {
    return await listPinnedLevel(
      dir,
      directory,
      relativePath,
      limit,
      cursor,
      ignore,
      { sort, order },
    );
  } finally {
    if (directory !== dir) await directory.close();
  }
}

async function listPinnedLevel(
  root: PinnedDir,
  directory: PinnedDir,
  relativePath: string,
  limit: number,
  cursor: string | undefined,
  ignore: Set<string>,
  { sort, order }: Required<ListDirectoryOptions>,
): Promise<{ entries: DirectoryEntry[]; nextCursor?: string }> {
  const children = (await readdirAt(directory, undefined, {
    withFileTypes: true,
  }))!;
  const listed: (DirectoryEntry & { mtimeMs?: number })[] = children
    .filter(
      (entry) =>
        !ignore.has(entry.name) && (entry.isDirectory() || entry.isFile()),
    )
    .map((entry) => ({
      kind: entry.isDirectory() ? ('directory' as const) : ('file' as const),
      name: entry.name,
      path: relativePath ? `${relativePath}/${entry.name}` : entry.name,
    }));
  if (sort === 'modified') {
    await Promise.all(
      listed.map(async (entry) => {
        try {
          const stat = await lstatAt(directory, entry.name);
          if (!stat) return;
          entry.mtimeMs = stat.mtimeMs;
          entry.modifiedAt = stat.mtime.toISOString();
          if (entry.kind === 'file') entry.sizeBytes = stat.size;
        } catch {
          // Entry vanished or is unreadable: sort it as oldest, without a timestamp.
        }
      }),
    );
  }
  const direction = order === 'desc' ? -1 : 1;
  const entries = listed
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      if (sort === 'modified') {
        const diff = (a.mtimeMs ?? 0) - (b.mtimeMs ?? 0);
        if (diff !== 0) return diff * direction;
      }
      return a.name.localeCompare(b.name) * (sort === 'name' ? direction : 1);
    })
    .map(({ mtimeMs: _mtimeMs, ...entry }) => entry);
  const start = cursor ? Number(cursor) : 0;
  if (!Number.isSafeInteger(start) || start < 0)
    throw new Error('Invalid cursor');
  const page = entries.slice(start, start + limit);
  await addFileSizesAt(root, page);
  return {
    entries: page,
    nextCursor:
      start + limit < entries.length ? String(start + limit) : undefined,
  };
}
