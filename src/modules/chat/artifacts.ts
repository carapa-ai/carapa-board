/**
 * Topic-scoped artifact storage — the filesystem is the source of truth.
 *
 * An artifact is any file written under `groups/<folder>/artifacts/<topic>/<file>`.
 * The tree is conversation-agnostic and intentionally reusable across
 * conversations: an agent writes a deliverable once and any conversation can
 * reference it. There is no artifact table and no `register_artifact` tool —
 * the agent just writes files to `/workspace/<folder>/artifacts/<topic>/<file>`
 * (the group dir is already bind-mounted into the sandbox) and the UI lists
 * this tree through the Files explorer's Artifacts section.
 *
 * An optional `<file>.meta.json` sidecar carries `caption` / `source_url` /
 * `source` for the rare case that needs them (e.g. a web download); it is not
 * required for agent-generated files.
 */
import type { Response } from 'express';
import fs from 'fs';
import path from 'path';
import { getGroupDir } from '../../group-dir.js';
import {
  detectMimetypeForHandle,
  setRawFileHeaders,
} from '../../lib/file-content.js';
import {
  GroupFsError,
  type GroupFsErrorCode,
  lstatAt,
  openFileAt,
  openGroupDir,
  openGroupDirSync,
  type PinnedDir,
  removeAt,
  sendPinnedFile,
  writeFileAt,
} from '../../lib/group-fs.js';
import { logger } from '../../logger.js';
import { artifactThumbnailPath } from './artifact-thumbnails.js';

export type ArtifactSource = 'agent' | 'web' | 'uploaded' | 'unknown';

const SAFE_SEG = /[^a-zA-Z0-9._-]/g;

/** Absolute on-disk root for a group's artifact tree. */
export function groupArtifactsDir(group_folder: string): string {
  return path.join(getGroupDir(group_folder), 'artifacts');
}

/** Group-fs failures that mean "this path is not a usable artifact", not an I/O problem. */
const REFUSAL_CODES: ReadonlySet<GroupFsErrorCode> = new Set([
  'not_found',
  'symlink',
  'not_directory',
  'not_regular_file',
  'invalid_path',
]);

const isRefusal = (err: unknown): boolean =>
  err instanceof GroupFsError && REFUSAL_CODES.has(err.code);

const nullOnRefusal = (err: unknown): null => {
  if (isRefusal(err)) return null;
  throw err;
};

/**
 * Pin a group's `artifacts` directory without following any link (agents can
 * write the group dir, so a symlinked `artifacts` must never become the base).
 * Null when it is missing or refused (symlink, not a directory); with `create`
 * a missing root is created. Caller closes the result. Unsupported platforms
 * and I/O errors throw a GroupFsError.
 */
export async function openArtifactsRoot(
  group_folder: string,
  opts: { create?: boolean } = {},
): Promise<PinnedDir | null> {
  try {
    return await openGroupDir(group_folder, 'artifacts', opts);
  } catch (err) {
    return nullOnRefusal(err);
  }
}

/** Sync twin of {@link openArtifactsRoot}. */
export function openArtifactsRootSync(
  group_folder: string,
  opts: { create?: boolean } = {},
): PinnedDir | null {
  try {
    return openGroupDirSync(group_folder, 'artifacts', opts);
  } catch (err) {
    return nullOnRefusal(err);
  }
}

/**
 * Open the regular file `segments` below a group's artifacts root, every
 * directory pinned with O_NOFOLLOW. `name` is the logical file name. Null when
 * the file is missing or any refusal applies (symlinked root, topic or leaf,
 * invalid segment, not a regular file). A file above `maxBytes` throws
 * GroupFsError('too_large'). The caller closes `handle`.
 */
export async function openArtifactFile(
  group_folder: string,
  segments: string[],
  opts: { maxBytes?: number } = {},
): Promise<{
  handle: fs.promises.FileHandle;
  stat: fs.Stats;
  name: string;
} | null> {
  const root = await openArtifactsRoot(group_folder);
  if (!root) return null;
  try {
    const opened = await openFileAt(root, segments.join('/')).catch(
      nullOnRefusal,
    );
    if (!opened) return null;
    if (opts.maxBytes !== undefined && opened.stat.size > opts.maxBytes) {
      await opened.handle.close().catch(() => {});
      throw new GroupFsError(
        'too_large',
        `File exceeds ${opts.maxBytes} bytes (${opened.stat.size})`,
      );
    }
    return { ...opened, name: segments[segments.length - 1] };
  } finally {
    await root.close();
  }
}

/**
 * Read a whole artifact (see {@link openArtifactFile}). Null when missing or
 * refused; a file above `maxBytes` throws GroupFsError('too_large').
 */
export async function readArtifactFile(
  group_folder: string,
  segments: string[],
  maxBytes: number,
): Promise<Buffer | null> {
  const opened = await openArtifactFile(group_folder, segments, { maxBytes });
  if (!opened) return null;
  try {
    // One byte more than the cap detects a file that grew after the stat.
    const buffer = Buffer.allocUnsafe(Math.min(opened.stat.size, maxBytes) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await opened.handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes)
      throw new GroupFsError('too_large', `File exceeds ${maxBytes} bytes`);
    return buffer.subarray(0, length);
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

/**
 * Send an artifact opened with {@link openArtifactFile}, taking ownership of
 * its handle. Artifacts include content written from outside (mail
 * attachments, web pages): active content is sandboxed and downloaded, never
 * run with the board session. Pass `mimetype` when already detected.
 */
export async function sendArtifactFile(
  res: Response,
  opened: { handle: fs.promises.FileHandle; name: string },
  mimetype?: string,
): Promise<void> {
  let handedOff = false;
  try {
    const detected =
      mimetype ?? (await detectMimetypeForHandle(opened.handle, opened.name));
    setRawFileHeaders(res, detected, opened.name);
    handedOff = true;
    sendPinnedFile(res, opened);
  } finally {
    if (!handedOff) await opened.handle.close().catch(() => {});
  }
}

/** Browser-loadable URL for an artifact given its sanitized relPath. */
export function artifactUrl(group_folder: string, relPath: string): string {
  const segs = relPath.split('/').map(encodeURIComponent);
  return `/artifacts/${encodeURIComponent(group_folder)}/${segs.join('/')}`;
}

/** Sanitize a single path segment (basename-style) for safe disk/URL use. */
function sanitizeSegment(seg: string): string {
  const basename = path.basename(seg);
  return basename === '.' || basename === '..'
    ? '_'
    : basename.replace(SAFE_SEG, '_') || '_';
}

/**
 * Sanitize a multi-segment relPath (e.g. "meetings/conv-123.md") segment by
 * segment and return the posix relPath. Rejects traversal: each segment is
 * basename-cleaned, so `..` becomes `_`.
 */
function sanitizeRelPath(relPath: string): string {
  return relPath
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(sanitizeSegment)
    .join('/');
}

function safeExplorerPath(value: string): string | null {
  if (!value) return '';
  if (
    /[\u0000-\u001f\u007f-\u009f]/.test(value) ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    return null;
  return value;
}

/**
 * Write bytes to `artifacts/<relPath>` (creating topic dirs as needed) and
 * overwrite if the file already exists — that is the intended "reuse" semantic.
 * Every directory is pinned without following links and the file is replaced
 * atomically, so a swapped topic dir can neither redirect the write nor have a
 * planted link written through. Returns the sanitized relPath + browser URL.
 */
export async function writeArtifactFile(
  group_folder: string,
  relPath: string,
  buffer: Buffer,
  opts?: {
    mimetype?: string | null;
    caption?: string | null;
    source?: ArtifactSource;
    source_url?: string | null;
  },
): Promise<{ relPath: string; url: string }> {
  const safeRel = sanitizeRelPath(relPath);
  const escapes = () => new Error('Artifact path escapes artifacts directory');
  const root = await openArtifactsRoot(group_folder, { create: true });
  if (!root) throw escapes();
  try {
    try {
      await writeFileAt(root, safeRel, buffer, { mkdirs: true });
    } catch (err) {
      throw isRefusal(err) ? escapes() : err;
    }

    if (
      opts &&
      (opts.caption != null || opts.source_url != null || opts.source)
    ) {
      const sidecar = {
        ...(opts.caption != null ? { caption: opts.caption } : {}),
        ...(opts.source_url != null ? { source_url: opts.source_url } : {}),
        ...(opts.source ? { source: opts.source } : {}),
      };
      try {
        await writeFileAt(
          root,
          `${safeRel}.meta.json`,
          Buffer.from(JSON.stringify(sidecar)),
          { mkdirs: true },
        );
      } catch (err) {
        logger.warn(
          { err, sidecar: `${safeRel}.meta.json` },
          'Failed to write artifact sidecar',
        );
      }
    }
  } finally {
    await root.close();
  }

  logger.info(
    { group_folder, relPath: safeRel, bytes: buffer.length },
    'Wrote artifact file',
  );
  return { relPath: safeRel, url: artifactUrl(group_folder, safeRel) };
}

/** Delete an artifact by relPath plus its best-effort sidecar and thumbnail. */
export async function deleteArtifactByPath(
  group_folder: string,
  relPath: string,
): Promise<boolean> {
  const validatedRelPath = safeExplorerPath(relPath);
  if (!validatedRelPath) return false;
  const root = await openArtifactsRoot(group_folder);
  if (!root) return false;
  try {
    const targetStat = await lstatAt(root, validatedRelPath).catch(
      nullOnRefusal,
    );
    if (!targetStat?.isFile()) return false;
    try {
      if (!(await removeAt(root, validatedRelPath))) return false;
    } catch {
      return false;
    }
    await removeAt(root, `${validatedRelPath}.meta.json`).catch(() => {});
    try {
      // An empty root makes artifactThumbnailPath return the root-relative path.
      const thumbnailRel = artifactThumbnailPath('', relPath);
      const thumbnailStat = await lstatAt(root, thumbnailRel);
      if (thumbnailStat?.isFile()) await removeAt(root, thumbnailRel);
    } catch {
      /* thumbnail may not exist */
    }
    return true;
  } finally {
    await root.close();
  }
}
