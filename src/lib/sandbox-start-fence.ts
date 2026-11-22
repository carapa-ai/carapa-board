/**
 * Admission barrier for sandbox starts. `SandboxClient.sandboxStart` is the
 * only place a sandbox is started, so fencing an instance name there stops
 * every run type (chat, task, cron, shell, file access) from reviving it.
 *
 * Used while a personal main is archived: the old instance must not come back
 * up with bind mounts into storage that is being moved, and must not be reused
 * by a re-created user before the move is complete.
 */
const fenced = new Map<string, number>();
const starting = new Map<string, Set<Promise<unknown>>>();

/** Fence `instances` (counted, so fences nest). Returns the release function. */
export function fenceSandboxInstances(
  instances: readonly string[],
): () => void {
  const held = [...new Set(instances.filter(Boolean))];
  for (const instance of held)
    fenced.set(instance, (fenced.get(instance) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const instance of held) {
      const count = (fenced.get(instance) ?? 1) - 1;
      if (count > 0) fenced.set(instance, count);
      else fenced.delete(instance);
    }
  };
}

export function isSandboxInstanceFenced(instance: string | undefined): boolean {
  return !!instance && fenced.has(instance);
}

/** Record a start so a fence can wait for it. */
export function trackSandboxStart<T>(
  instance: string | undefined,
  start: Promise<T>,
): Promise<T> {
  if (!instance) return start;
  const set = starting.get(instance) ?? new Set();
  starting.set(instance, set);
  set.add(start);
  const done = () => {
    set.delete(start);
    if (set.size === 0 && starting.get(instance) === set)
      starting.delete(instance);
  };
  start.then(done, done);
  return start;
}

/** Wait until every start of `instances` accepted before the fence has settled. */
export async function settleSandboxStarts(
  instances: readonly string[],
): Promise<void> {
  const pending = instances.flatMap((instance) => [
    ...(starting.get(instance) ?? []),
  ]);
  await Promise.allSettled(pending);
}
