import { InFlightCoalescer } from '../lib/in-flight-coalescer.js';
import { runtimeChanges } from '../lib/runtime-changes.js';

type Result = { stdout: string; isError: boolean };
type Observation = {
  read: () => Promise<Result>;
  checkedAt: number;
  signature?: string;
};

/** Ignore elapsed uptime, preserving lifecycle, health, ports and image changes. */
function stableState(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) {
    return value
      .map((entry) => stableState(entry))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .filter(
          ([key]) => !['RunningFor', 'runningFor', 'uptime'].includes(key),
        )
        .map(([key, entry]) => [key, stableState(entry, key)]),
    );
  }
  // Docker prints these as comma-joined lists in a different order on every
  // call. Treating that reordering as a change made each status read emit
  // `sandbox_state_changed`, which made the UI refetch, in a ~1/s loop.
  if (
    typeof value === 'string' &&
    ['mounts', 'networks'].includes(key.toLowerCase())
  ) {
    return value.split(',').sort().join(',');
  }
  if (typeof value === 'string' && key.toLowerCase() === 'status') {
    return value
      .replace(/^Up\s+[^()]+/i, 'Up ')
      .replace(/^(Exited|Restarting)\s+(\([^)]*\)).*$/i, '$1 $2')
      .trim();
  }
  return value;
}

/** Share existing reads and reconcile only snapshots that have gone stale. */
export class SandboxStateObserver {
  private observations = new Map<string, Observation>();
  private inFlight = new InFlightCoalescer();

  read(
    key: string,
    load: () => Promise<Result>,
    watch = false,
  ): Promise<Result> {
    if (watch && !this.observations.has(key)) {
      this.observations.set(key, { read: load, checkedAt: 0 });
    }
    const observe = (signature: string) => {
      const entry = this.observations.get(key);
      if (!entry) return;
      const changed =
        entry.signature !== undefined && entry.signature !== signature;
      entry.signature = signature;
      if (changed) runtimeChanges.emit('sandbox');
    };
    return this.inFlight.run(key, async () => {
      try {
        const result = await load();
        let state: unknown = result.stdout.trim();
        if (!result.isError) {
          try {
            state = stableState(JSON.parse(result.stdout));
          } catch {}
        }
        observe(result.isError ? 'error' : JSON.stringify(state));
        return result;
      } catch (error) {
        observe('error');
        throw error;
      } finally {
        const entry = this.observations.get(key);
        if (entry) entry.checkedAt = Date.now();
      }
    });
  }

  start(hasClients: () => boolean): () => void {
    let running = false;
    let hadClients = false;
    const timer = setInterval(async () => {
      if (!hasClients()) {
        if (hadClients) this.observations.clear();
        hadClients = false;
        return;
      }
      hadClients = true;
      if (running) return;
      running = true;
      try {
        // The service watcher normally supplies fresh reads. This fallback
        // also works when its restart/token-sweep behavior is disabled.
        await Promise.allSettled(
          [...this.observations]
            .filter(([, entry]) => Date.now() - entry.checkedAt >= 15_000)
            .map(([key, entry]) => this.read(key, entry.read)),
        );
      } finally {
        running = false;
      }
    }, 15_000);
    timer.unref();
    return () => clearInterval(timer);
  }
}
