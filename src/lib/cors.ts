import type { CorsOptions } from 'cors';

/**
 * Origins allowed when CORS_ORIGIN is unset: the Android app's WebView
 * (androidScheme `http`, see ui/capacitor.config.ts; `https` for custom
 * builds) and the iOS Capacitor scheme. The web UI is served by the Board
 * itself and needs no CORS header.
 */
export const DEFAULT_CORS_ORIGINS = [
  'http://localhost',
  'https://localhost',
  'capacitor://localhost',
];

/** True when CORS_ORIGIN explicitly allows every origin. */
export function isWildcardCorsOrigin(value: string | undefined): boolean {
  return value?.trim() === '*';
}

/**
 * Build the `cors` options for the CORS_ORIGIN setting. Unset or empty means
 * same-origin plus the first-party app origins; `*` reflects any origin; any
 * other value is a comma-separated allow-list.
 */
export function buildCorsOptions(value: string | undefined): CorsOptions {
  const trimmed = value?.trim();
  let origin: CorsOptions['origin'];
  if (!trimmed) origin = DEFAULT_CORS_ORIGINS;
  else if (trimmed === '*') origin = true;
  else
    origin = trimmed
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return {
    origin,
    credentials: true,
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Cookie',
      'X-Carapa-Signature',
      'X-Carapa-Device-ID',
      'X-Carapa-Timestamp',
    ],
  };
}
