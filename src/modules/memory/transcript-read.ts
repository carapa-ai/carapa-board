import fs from 'fs';
import { logger } from '../../logger.js';

/** Upper bound on a transcript read into memory by a by-path caller. */
export const MAX_REFLECTOR_TRANSCRIPT_BYTES = 256 * 1024 * 1024;

/**
 * {@link readFromByteOffset} semantics over bytes already read: no offset or an
 * offset <= 0 yields the whole buffer; an offset at or beyond the end yields ''.
 */
export function sliceFromByteOffset(
  source: Buffer,
  byteOffset: number | undefined,
  filePath: string,
): string {
  if (!byteOffset || byteOffset <= 0) return source.toString('utf-8');
  if (byteOffset >= source.length) {
    if (byteOffset > source.length) {
      logger.warn(
        { filePath, byteOffset, size: source.length },
        'transcript shorter than reflection offset',
      );
    }
    return '';
  }
  return source.subarray(byteOffset).toString('utf-8');
}

/**
 * Read a transcript from `byteOffset` to EOF as UTF-8.
 *
 * Offsets are file sizes captured before a run; the file may have shrunk since
 * (partial-line truncation, recovery rewrite). An offset at or beyond the end
 * yields '' — never re-read from 0, which would re-observe old content.
 */
export function readFromByteOffset(
  filePath: string,
  byteOffset?: number,
): string {
  if (!byteOffset || byteOffset <= 0) {
    return fs.readFileSync(filePath, 'utf-8');
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (byteOffset >= size) {
      if (byteOffset > size) {
        logger.warn(
          { filePath, byteOffset, size },
          'transcript shorter than reflection offset',
        );
      }
      return '';
    }
    const buf = Buffer.alloc(size - byteOffset);
    fs.readSync(fd, buf, 0, buf.length, byteOffset);
    return buf.toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
}
