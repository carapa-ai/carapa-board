/**
 * Managed-service builds currently running for the deploy stage. A pending
 * restart-when-idle waits for them so the sandbox restarts onto the new
 * images rather than the old ones. In memory only, like pending restarts.
 */
const activeBuilds = new Map<string, number>();

/**
 * Count `service` as building until the returned function is called. Use it
 * for the window before the build call starts (debounce, merge, stage
 * updates) so a restart requested in that window waits too. The release is
 * idempotent.
 */
export function holdServiceBuild(service: string): () => void {
  activeBuilds.set(service, (activeBuilds.get(service) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (activeBuilds.get(service) ?? 1) - 1;
    if (remaining > 0) activeBuilds.set(service, remaining);
    else activeBuilds.delete(service);
  };
}

/** Count `service` as building until `build` settles. */
export async function trackServiceBuild<T>(
  service: string,
  build: () => Promise<T>,
): Promise<T> {
  const release = holdServiceBuild(service);
  try {
    return await build();
  } finally {
    release();
  }
}

/** Number of service builds in progress. */
export function countActiveServiceBuilds(): number {
  let count = 0;
  for (const builds of activeBuilds.values()) count += builds;
  return count;
}
