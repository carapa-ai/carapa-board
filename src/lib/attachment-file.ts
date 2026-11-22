import fs from 'node:fs';
import fsp from 'node:fs/promises';

/**
 * Read a validated attachment without following a symlink at the leaf. A file
 * swapped for a link after `resolveUploadedAttachmentPath` fails here instead
 * of being read. Parent directories are not pinned (residual race).
 */
export async function readAttachmentFile(filePath: string): Promise<Buffer> {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  const handle = await fsp.open(filePath, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error('Attachment is not a regular file');
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
