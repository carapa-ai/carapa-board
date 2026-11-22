import { Capacitor, CapacitorHttp } from '@capacitor/core';

// Android TLS failures as reported by native requests (Conscrypt / OkHttp).
const CERTIFICATE_FAILURE =
  /CertPathValidatorException|SSLHandshakeException|SSLPeerUnverifiedException|Trust anchor for certification path|Hostname \S+ not verified/;

const UNTRUSTED_SERVER_MESSAGE =
  "The app does not trust this server's certificate. On the board, open Account → Connect the Android app and open its setup link on this phone again.";

/** A user-facing explanation when `message` is a TLS certificate failure, else null. */
export function untrustedServerMessage(message: string): string | null {
  return CERTIFICATE_FAILURE.test(message) ? UNTRUSTED_SERVER_MESSAGE : null;
}

/**
 * A failed WebView fetch only says "Failed to fetch". On Android, repeat a
 * cheap request natively to learn whether the server's certificate was the
 * cause; returns the explanation for that case, else null.
 */
export async function diagnoseUntrustedServer(
  baseUrl: string,
): Promise<string | null> {
  if (Capacitor.getPlatform() !== 'android') return null;
  try {
    await CapacitorHttp.request({
      url: `${baseUrl}/health`,
      method: 'GET',
      connectTimeout: 5000,
      readTimeout: 5000,
    });
    return null;
  } catch (error) {
    return untrustedServerMessage(
      error instanceof Error ? error.message : String(error),
    );
  }
}
