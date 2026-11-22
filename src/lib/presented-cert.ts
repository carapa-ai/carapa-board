import { sha256Hex } from './hash.js';
import { isIP } from 'node:net';
import tls from 'node:tls';

export interface PresentedCertificate {
  /** SHA-256 over the DER of the leaf certificate, 64 lowercase hex chars. */
  certSha256: string;
  /** Whether this process's CA store accepts the chain and host name. */
  trusted: boolean;
}

/**
 * The leaf certificate an https origin presents to the board, read with a
 * TLS handshake only (no request is sent). This is what a client sees at that
 * address, including a reverse proxy in front of the board. Null when the
 * address cannot be reached in time.
 */
export function readPresentedCertificate(
  origin: URL,
  timeoutMs = 5000,
): Promise<PresentedCertificate | null> {
  const host = origin.hostname.replace(/^\[(.*)\]$/, '$1');
  const port = Number(origin.port) || 443;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: PresentedCertificate | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    const socket = tls.connect(
      {
        host,
        port,
        servername: isIP(host) ? undefined : host,
        rejectUnauthorized: false,
      },
      () => {
        const raw = socket.getPeerCertificate()?.raw;
        finish(
          raw
            ? {
                certSha256: sha256Hex(raw),
                trusted: socket.authorized,
              }
            : null,
        );
      },
    );
    socket.setTimeout(timeoutMs, () => finish(null));
    socket.on('error', () => finish(null));
  });
}
