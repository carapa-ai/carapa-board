import type { SandboxExecResult } from '../lib/mcp-client.js';
import { isRecord } from '../lib/type-guards.js';

/** Interpret the shared CarapaBox sandbox_status text contract. */
export function isSandboxRunning(
  status: Pick<SandboxExecResult, 'stdout' | 'isError'>,
): boolean {
  return (
    !status.isError &&
    status.stdout.includes('"running"') &&
    !status.stdout.includes('not running') &&
    !status.stdout.includes('not found')
  );
}

/**
 * True only for a successful status listing in which every container is
 * stopped (an empty listing counts). A failed or unparseable status never
 * proves that a mount is released.
 */
export function isSandboxStopped(
  status: Pick<SandboxExecResult, 'stdout' | 'isError'>,
): boolean {
  if (status.isError) return false;
  try {
    const entries: unknown = JSON.parse(status.stdout);
    return (
      Array.isArray(entries) &&
      entries.every((entry) =>
        ['created', 'exited', 'dead'].includes(entry?.State),
      )
    );
  } catch {
    return false;
  }
}

/** Stack names whose Compose instance currently owns `instance` (sandbox_ps output). */
export function runningStackNamesForInstance(
  raw: string,
  instance: string,
): string[] {
  try {
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) return [];
    return [
      ...new Set(
        entries
          .filter(
            (entry: unknown) => isRecord(entry) && entry.instance === instance,
          )
          .map((entry: Record<string, unknown>) => entry.stack)
          .filter(
            (stack): stack is string =>
              typeof stack === 'string' && stack.length > 0,
          ),
      ),
    ];
  } catch {
    return [];
  }
}
