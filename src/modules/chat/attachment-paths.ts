/**
 * Containment for chat attachment file paths.
 *
 * `ChatMessageAttachment.path` arrives in a client-supplied request body, and
 * the board later reads that file into transcription and model prompts. Only
 * files the upload endpoint stored in the project's own upload directory may
 * be read back.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../config.js';
import { effectiveProjectUploadDir } from '../../sandbox/effective-settings.js';
import type { RegisteredGroup } from '../../types.js';

/** Shape of `${Date.now()}-${uuid8}-${safeName}` from the upload endpoint. */
const STORED_UPLOAD_NAME = /^\d+-[0-9a-f]{8}-[A-Za-z0-9._-]+$/;

/**
 * Return the resolved path when `rawPath` names a regular file that the upload
 * endpoint stored for `group`; otherwise null. The directory comparison is
 * lexical on purpose: the upload directory is agent-writable IPC, so a
 * realpath of it would only follow whatever the agent placed there.
 */
export function resolveUploadedAttachmentPath(
  group: RegisteredGroup,
  rawPath: string,
): string | null {
  if (!path.isAbsolute(rawPath)) return null;
  const resolved = path.resolve(rawPath);
  if (
    path.dirname(resolved) !==
    path.resolve(effectiveProjectUploadDir(group, DATA_DIR))
  ) {
    return null;
  }
  if (!STORED_UPLOAD_NAME.test(path.basename(resolved))) return null;
  try {
    return fs.lstatSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}
