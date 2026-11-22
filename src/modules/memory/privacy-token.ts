import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../config.js';

let cachedKey: Buffer | undefined;

function privacyTokenKey(): Buffer {
  if (cachedKey) return cachedKey;
  const configured = process.env.CARAPA_BOARD_ENCRYPTION_KEY;
  if (configured) {
    cachedKey = Buffer.from(
      configured,
      /^[0-9a-f]{64}$/i.test(configured) ? 'hex' : 'utf8',
    );
    return cachedKey;
  }
  const keyPath = path.join(DATA_DIR, '.privacy-erasure-key');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(keyPath)) {
    fs.writeFileSync(keyPath, randomBytes(32).toString('hex'), {
      mode: 0o600,
      flag: 'wx',
    });
  }
  cachedKey = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'hex');
  return cachedKey;
}

/** Non-reversible matching tokens suitable for durable erasure retries. */
export function protectedTargetTokens(value: string): string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .split(/\s+/)
        .filter((word) => word.length > 2)
        .map((word) =>
          createHmac('sha256', privacyTokenKey()).update(word).digest('hex'),
        ),
    ),
  ];
}
