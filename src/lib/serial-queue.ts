// Work sharing a key runs one at a time: decision notes per conversation (so
// the outcome reflects the proposals still open after the latest note), the
// hash-check/write section per target item (so a second proposal for the same
// item sees the first one's change and becomes stale), and merge approvals per
// task.
const serialQueues = new Map<string, Promise<unknown>>();

export function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
  const run = (serialQueues.get(key) ?? Promise.resolve()).then(work, work);
  const tail = run.catch(() => {});
  serialQueues.set(key, tail);
  void tail.then(() => {
    if (serialQueues.get(key) === tail) serialQueues.delete(key);
  });
  return run;
}
