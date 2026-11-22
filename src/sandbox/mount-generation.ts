import { sha256Hex } from '../lib/hash.js';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { buildSandboxEnv } from './sandbox-env.js';
import { resolveEffectiveSandbox } from './effective-settings.js';
import type { RegisteredGroup } from '../types.js';

/**
 * Track whether a running sandbox still carries the bind-mount layout of an
 * older project-settings generation.
 *
 * Docker/gVisor cannot add or rebind mounts on a running container: the
 * EXTRA_MOUNT_* / LOCAL_REPO / WORKSPACE_PATH env the board sends to
 * CarapaBox only takes effect when the container is (re)created. Project
 * settings apply instantly to the API/UI, so the Files tab could otherwise
 * list a container that still mounts a *previous* host folder under the same
 * /workspace path — showing another project's file structure.
 *
 * Every board-orchestrated sandbox start records the mount fingerprint of the
 * env it sent (see SandboxClient.sandboxStart). Reading a configured extra
 * mount from a container whose recorded fingerprint no longer matches the
 * expected one is reported as `sandbox-stale` instead of serving possibly
 * foreign data.
 */

/** Env keys that fully determine the sandbox bind-mount layout. */
const MOUNT_ENV_KEYS = [
  'LOCAL_REPO',
  'WORKSPACE_PATH',
  'EXTRA_MOUNT_1',
  'EXTRA_MOUNT_1_NAME',
  'EXTRA_MOUNT_2',
  'EXTRA_MOUNT_2_NAME',
] as const;

const FINGERPRINT_DIR = path.join(DATA_DIR, 'sandbox-start-fingerprints');
const CACHE_TTL_MS = 5_000;

interface StartFingerprintRecord {
  fingerprint: string;
  /** True when the board started the stack without env (CarapaBox decides mounts). */
  external: boolean;
  at: string;
}

function fingerprintOf(env: Record<string, string> | undefined): string {
  const source = env ?? {};
  const parts = MOUNT_ENV_KEYS.filter((key) => source[key] !== undefined).map(
    (key) => `${key}=${source[key]}`,
  );
  return sha256Hex(parts.sort().join('\n'));
}

function recordPath(stack: string, instance: string): string {
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '-');
  return path.join(FINGERPRINT_DIR, `${safe(stack)}-${safe(instance)}.json`);
}

/** Best-effort: record the mount layout the board asked CarapaBox to start. */
export function recordSandboxStartFingerprint(
  stack: string,
  instance: string | undefined,
  env: Record<string, string> | undefined,
): void {
  if (!instance) return;
  try {
    const record: StartFingerprintRecord = {
      fingerprint: fingerprintOf(env),
      external: env === undefined,
      at: new Date().toISOString(),
    };
    fs.mkdirSync(FINGERPRINT_DIR, { recursive: true });
    fs.writeFileSync(
      recordPath(stack, instance),
      `${JSON.stringify(record)}\n`,
    );
    cache.delete(cacheKey(stack, instance));
  } catch (err) {
    logger.debug(
      { stack, instance, err: String(err) },
      'Could not record sandbox start fingerprint',
    );
  }
}

const cache = new Map<
  string,
  { record: StartFingerprintRecord | null; checkedAt: number }
>();

function cacheKey(stack: string, instance: string): string {
  return `${stack}-${instance}`;
}

function readRecord(
  stack: string,
  instance: string,
): StartFingerprintRecord | null {
  const key = cacheKey(stack, instance);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.checkedAt < CACHE_TTL_MS) return hit.record;
  let record: StartFingerprintRecord | null = null;
  try {
    const parsed = JSON.parse(
      fs.readFileSync(recordPath(stack, instance), 'utf8'),
    );
    if (
      parsed &&
      typeof parsed.fingerprint === 'string' &&
      typeof parsed.external === 'boolean'
    ) {
      record = parsed;
    }
  } catch {
    // Missing/unreadable record: the board never started this container, so
    // its mount layout is unknown — never claim staleness in that case.
  }
  cache.set(key, { record, checkedAt: Date.now() });
  return record;
}

/** Fingerprint of the mount layout the current settings produce. */
function expectedMountFingerprint(group: RegisteredGroup): string | undefined {
  try {
    const effective = resolveEffectiveSandbox(group);
    return fingerprintOf(buildSandboxEnv(effective.owner));
  } catch (err) {
    logger.debug(
      { group: group.folder, err: String(err) },
      'Could not compute expected mount fingerprint',
    );
    return undefined;
  }
}

/**
 * True when the group's running sandbox was started with a different mount
 * layout than the current settings (and the board knows that layout).
 * Groups without extra mounts, unknown start records, and external starts
 * never report staleness.
 */
export async function isMountConfigStale(
  group: RegisteredGroup,
): Promise<boolean> {
  try {
    const effective = resolveEffectiveSandbox(group);
    if (effective.extraMounts.length === 0) return false;
    const record = readRecord(effective.stack, effective.instance);
    if (!record || record.external) return false;
    const expected = expectedMountFingerprint(group);
    if (expected === undefined) return false;
    return record.fingerprint !== expected;
  } catch {
    return false;
  }
}
