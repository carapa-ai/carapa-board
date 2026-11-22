import { type FSWatcher, watch } from 'node:fs';

/**
 * Observe real IPC writes; subscribe before the initial read. The watcher is the
 * fast path. A slow re-check backs it up because Bun's watcher can drop an event
 * after earlier tests in the same process, which would otherwise time out.
 * It also carries the wait alone when the host has no inotify instances left.
 */
export async function waitForFileState<T>(
  directory: string,
  read: () => T | undefined,
  timeoutMs = 5_000,
): Promise<T> {
  const result = Promise.withResolvers<T>();
  const check = () => {
    try {
      const value = read();
      if (value !== undefined) result.resolve(value);
    } catch (error) {
      result.reject(error);
    }
  };
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(directory, check);
    watcher.on('error', result.reject);
  } catch {
    // EMFILE: out of inotify instances; the re-check below still observes.
  }
  const recheck = setInterval(check, 250);
  const timer = setTimeout(
    () => result.reject(new Error(`Timed out observing ${directory}`)),
    timeoutMs,
  );
  try {
    check();
    return await result.promise;
  } finally {
    clearTimeout(timer);
    clearInterval(recheck);
    watcher?.close();
  }
}
