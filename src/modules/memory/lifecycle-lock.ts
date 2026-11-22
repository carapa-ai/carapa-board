import { AsyncLocalStorage } from 'node:async_hooks';

const groupTails = new Map<string, Promise<void>>();
// Folders whose lock the current async chain already holds. Code under a
// group's lock may call helpers that take the same lock (e.g. the vector-store
// write, which must also be serialized with an objective move when called on
// its own); those nested calls run directly instead of waiting on themselves.
const heldFolders = new AsyncLocalStorage<ReadonlySet<string>>();

/** Serialize content-bearing writes and privacy erasure within one group. */
export async function withMemoryLifecycleLock<T>(
  group_folder: string,
  operation: () => Promise<T>,
): Promise<T> {
  const held = heldFolders.getStore();
  if (held?.has(group_folder)) return operation();

  const prior = groupTails.get(group_folder) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  groupTails.set(group_folder, current);
  await prior;
  try {
    return await heldFolders.run(
      new Set([...(held ?? []), group_folder]),
      operation,
    );
  } finally {
    release();
    if (groupTails.get(group_folder) === current)
      groupTails.delete(group_folder);
  }
}
