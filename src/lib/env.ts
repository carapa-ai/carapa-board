import fs from 'node:fs';
import path from 'node:path';

/** Parse the normalized true/false values supported by boolean env flags. */
export function parseBooleanEnv(
  value: string | undefined,
  defaultValue = false,
): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '0' || normalized === 'false') return false;
  return defaultValue;
}

/** Create a reader that preserves the secret directory captured at creation. */
export function createSecretReader(
  secretsDir = process.env.SECRETS_DIR || '/run/secrets',
): (envName: string, secretName?: string) => string {
  return (envName, secretName) => {
    const fileName = secretName || envName.toLowerCase();
    try {
      const value = fs
        .readFileSync(path.join(secretsDir, fileName), 'utf8')
        .trim();
      if (value) return value;
    } catch {
      /* fall back to the environment */
    }
    return process.env[envName] || '';
  };
}
