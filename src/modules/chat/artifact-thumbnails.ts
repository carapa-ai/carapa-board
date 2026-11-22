import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import {
  ensurePinnedImageThumbnail,
  isImageFilePath,
  MAX_THUMBNAIL_SOURCE_BYTES,
} from '../../lib/file-thumbnail.js';
import type { PinnedDir } from '../../lib/group-fs.js';

const ARTIFACT_THUMBNAIL_MAX_SIZE = 256;

/** Return the persistent thumbnail path for an artifact-relative path. */
export function artifactThumbnailPath(
  artifactsRoot: string,
  relPath: string,
): string {
  const segments = relPath
    .split('/')
    .map((segment) => path.basename(segment))
    .filter(
      (segment) => Boolean(segment) && segment !== '.' && segment !== '..',
    );
  // Keep this directory non-hidden: Express sendFile intentionally refuses
  // dotfiles, even when the file exists and fsp.access() succeeds.
  return path.join(artifactsRoot, 'thumbnails', ...segments) + '.jpg';
}

/**
 * Create or refresh a small JPEG thumbnail of an opened artifact (see
 * openArtifactFile) in the pinned `thumbDir`. The output is written atomically
 * so concurrent browser requests never observe a partial image. Existing
 * thumbnails are reused until the source artifact changes.
 */
export async function ensureArtifactThumbnail(
  source: { handle: FileHandle; stat: Stats; name: string },
  thumbDir: PinnedDir,
  mimetype?: string | null,
): Promise<boolean> {
  if (mimetype ? !mimetype.startsWith('image/') : !isImageFilePath(source.name))
    return false;

  return ensurePinnedImageThumbnail(
    source,
    thumbDir,
    `${source.name}.jpg`,
    ARTIFACT_THUMBNAIL_MAX_SIZE,
    MAX_THUMBNAIL_SOURCE_BYTES,
  );
}
