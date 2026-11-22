import { createHash, type BinaryLike } from 'crypto';

/** Hex-encoded SHA-256 digest of a string or binary value. */
export function sha256Hex(value: BinaryLike): string {
  return createHash('sha256').update(value).digest('hex');
}
