// Required Notice: Copyright Regun Software SRL (https://carapa.ai)

/** Thrown when a response body is larger than the caller's byte cap. */
export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`response body exceeds the ${maxBytes} byte limit`);
    this.name = 'BodyTooLargeError';
  }
}

/**
 * Read a response body into a Buffer, stopping as soon as more than `maxBytes`
 * arrive. The count is taken on the stream the runtime hands out, i.e. after
 * content-encoding decompression, so a small compressed body that inflates past
 * the cap is rejected too.
 */
export async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new BodyTooLargeError(maxBytes);
  }
  if (!res.body) return Buffer.alloc(0);

  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
