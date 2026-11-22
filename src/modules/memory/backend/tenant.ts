import type { Memory } from '../types.js';
import type { MemoryRecallScope, MemoryScope } from './types.js';

export function assertMemoryScope(
  scope: MemoryScope,
  group_folder: string,
): void {
  if (scope.group_folder !== group_folder) {
    throw new Error(
      `Memory scope violation: expected group "${group_folder}", got "${scope.group_folder}"`,
    );
  }
}

/** Belt-and-suspenders filter after backend recall (PG or external). */
export function filterMemoriesByRecallScope(
  memories: Memory[],
  scope: MemoryRecallScope,
): Memory[] {
  if (scope.groupFolders.length === 0) {
    return memories;
  }
  const allowed = new Set(scope.groupFolders);
  return memories.filter((m) => allowed.has(m.group_folder));
}
