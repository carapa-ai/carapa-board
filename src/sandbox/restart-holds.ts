/**
 * Restart holds: flags a process inside a sandbox sets so the board does not
 * restart that sandbox automatically until the process has finished.
 *
 * Holds are managed in the sandbox with the CarapaBot `restart-hold` command
 * (`restart-hold run NAME CMD...`, `set`, `clear`, `status`); the board reads
 * them with `restart-hold status`. A hold with a PID ends when that process
 * exits; one without lasts until cleared. They live in the container's `/tmp`,
 * so stopping the sandbox drops them with the processes they protected.
 * Holds delay idle and automatic restarts only; an immediate restart a user
 * asks for still runs.
 */
import { getSandboxClient } from '../lib/mcp-client.js';

const HOLD_CHECK_TIMEOUT_S = 5;

/**
 * Active restart holds in a running sandbox, or null when they could not be
 * read (sandbox unreachable, or a stack without the `restart-hold` command).
 */
export async function countSandboxRestartHolds(
  stack: string,
  service: string | undefined,
  instance: string,
): Promise<number | null> {
  if (!service) return null;
  try {
    const result = await getSandboxClient().sandboxExec(
      stack,
      service,
      'restart-hold status',
      { instance, timeout: HOLD_CHECK_TIMEOUT_S },
    );
    const marker = /restart_holds=(\d+)/.exec(result.stdout || '');
    return marker ? Number(marker[1]) : null;
  } catch {
    return null;
  }
}
