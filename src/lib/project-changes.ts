import { EventEmitter } from 'node:events';

/** Internal invalidation signal; carries no account or project data. */
export const projectChanges = new EventEmitter();

// Counts 'changed' emits. Registered first, so it is already current when any
// other listener runs. A permission set resolved from project data is stamped
// with the count read before it was resolved; a later count means a change may
// have landed that the set does not reflect.
let changeEpoch = 0;
projectChanges.on('changed', () => {
  changeEpoch++;
});

const resolvedAtEpoch = new WeakMap<object, number>();

export function getProjectChangeEpoch(): number {
  return changeEpoch;
}

/** Record that `permissions` was resolved from data read at `epoch`. */
export function stampResolvedEpoch<T extends object>(
  permissions: T,
  epoch: number,
): T {
  resolvedAtEpoch.set(permissions, epoch);
  return permissions;
}

/** True when a project change was emitted after `permissions` was resolved. */
export function isResolvedBeforeChange(
  permissions: object | undefined,
): boolean {
  if (!permissions) return false;
  const epoch = resolvedAtEpoch.get(permissions);
  return epoch !== undefined && epoch < changeEpoch;
}
