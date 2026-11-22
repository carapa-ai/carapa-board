/**
 * Per-group concurrency semaphore for sandbox slot management.
 *
 * Allows up to `maxSlots` concurrent executions per group.
 * Tracks which slot indices are free so each run uses a distinct sandbox instance.
 * Waiters are served FIFO.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

interface GroupSemaphore {
  maxSlots: number;
  active: number;
  /** Slot indices currently available (not held by any run). */
  freeSlots: number[];
  /** Slot indices currently held by a run, including slots above maxSlots after a reduction. */
  heldSlots: Set<number>;
  waitQueue: SlotWaiter[];
}

interface SlotWaiter {
  grant: (slotIndex: number) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

function grantWaiter(waiter: SlotWaiter, slotIndex: number): void {
  if (waiter.signal && waiter.onAbort) {
    waiter.signal.removeEventListener('abort', waiter.onAbort);
  }
  waiter.grant(slotIndex);
}

// ─── State ──────────────────────────────────────────────────────────────────

const groupSemaphores = new Map<string, GroupSemaphore>();

// ─── Semaphore operations ───────────────────────────────────────────────────

function getOrCreateSemaphore(
  group_folder: string,
  maxSlots: number,
): GroupSemaphore {
  let sem = groupSemaphores.get(group_folder);
  if (!sem) {
    const freeSlots = Array.from({ length: maxSlots }, (_, i) => i);
    sem = {
      maxSlots,
      active: 0,
      freeSlots,
      heldSlots: new Set(),
      waitQueue: [],
    };
    groupSemaphores.set(group_folder, sem);
  }
  // Update slot pool when maxSlots changes
  if (sem.maxSlots !== maxSlots) {
    const prevMax = sem.maxSlots;
    sem.maxSlots = maxSlots;
    if (maxSlots > prevMax) {
      // Add newly available slot indices
      for (let i = prevMax; i < maxSlots; i++) {
        if (!sem.heldSlots.has(i) && !sem.freeSlots.includes(i)) {
          sem.freeSlots.push(i);
        }
      }
      // Wake up any tasks that were waiting before the limit increased.
      // Without this, they'd remain stuck until a currently-held slot is released,
      // and any newly-arriving task would jump ahead of them.
      while (
        sem.active < sem.maxSlots &&
        sem.waitQueue.length > 0 &&
        sem.freeSlots.length > 0
      ) {
        const next = sem.waitQueue.shift()!;
        const nextSlot = sem.freeSlots.shift()!;
        grantWaiter(next, nextSlot);
      }
    } else {
      // Remove slot indices that are no longer valid from the free list.
      // Held slots >= maxSlots will be discarded on release.
      sem.freeSlots = sem.freeSlots.filter((s) => s < maxSlots);
    }
  }
  return sem;
}

function releaseGroupSlot(
  sem: GroupSemaphore,
  slotIndex: number,
  occupiesNormalCapacity: boolean,
): void {
  if (occupiesNormalCapacity) sem.active--;
  sem.heldSlots.delete(slotIndex);
  // Return the slot to the free pool only if it is still within the current limit
  if (slotIndex < sem.maxSlots && !sem.freeSlots.includes(slotIndex)) {
    sem.freeSlots.push(slotIndex);
  }
  if (
    sem.active < sem.maxSlots &&
    sem.waitQueue.length > 0 &&
    sem.freeSlots.length > 0
  ) {
    const next = sem.waitQueue.shift()!;
    const nextSlot = sem.freeSlots.shift()!;
    grantWaiter(next, nextSlot);
  }
}

/** Create a lease whose cleanup is safe to call from multiple error paths. */
function createSlotLease(
  sem: GroupSemaphore,
  slotIndex: number,
  occupiesNormalCapacity = true,
): { slotIndex: number; release: () => void } {
  let released = false;
  return {
    slotIndex,
    release: () => {
      if (released) return;
      released = true;
      releaseGroupSlot(sem, slotIndex, occupiesNormalCapacity);
    },
  };
}

/** Allocate an overflow token without changing or waking normal capacity. */
function acquireOverflowSlot(sem: GroupSemaphore): number {
  let slotIndex = sem.maxSlots;
  while (sem.heldSlots.has(slotIndex)) slotIndex++;
  // Overflow leases have unique logical slots but never consume normal capacity.
  sem.heldSlots.add(slotIndex);
  return slotIndex;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function acquireGroupSlot(
  group_folder: string,
  maxSlots: number,
  options: { bypassLimit?: boolean; signal?: AbortSignal } = {},
): Promise<{ slotIndex: number; release: () => void }> {
  // Callers normally pass effectiveMaxParallel(), but this boundary is also
  // used by the sandbox runner directly. Never let malformed persisted/API
  // settings create a zero-slot semaphore: every waiter would then remain
  // pending forever and strand the project's queue.
  const safeMaxSlots = Number.isFinite(maxSlots)
    ? Math.max(1, Math.floor(maxSlots))
    : 1;
  const sem = getOrCreateSemaphore(group_folder, safeMaxSlots);

  if (options.signal?.aborted) {
    throw new Error('Sandbox slot acquisition aborted');
  }

  if (options.bypassLimit) {
    return createSlotLease(sem, acquireOverflowSlot(sem), false);
  }
  if (sem.active < sem.maxSlots && sem.freeSlots.length > 0) {
    const slotIndex = sem.freeSlots.shift()!;
    sem.active++;
    sem.heldSlots.add(slotIndex);
    return createSlotLease(sem, slotIndex);
  }

  return new Promise<{ slotIndex: number; release: () => void }>(
    (resolve, reject) => {
      const waiter: SlotWaiter = {
        signal: options.signal,
        grant: (slotIndex: number) => {
          sem.active++;
          sem.heldSlots.add(slotIndex);
          resolve(createSlotLease(sem, slotIndex));
        },
      };
      waiter.onAbort = () => {
        const index = sem.waitQueue.indexOf(waiter);
        if (index === -1) return;
        sem.waitQueue.splice(index, 1);
        reject(new Error('Sandbox slot acquisition aborted'));
      };
      options.signal?.addEventListener('abort', waiter.onAbort, { once: true });
      sem.waitQueue.push(waiter);
    },
  );
}

/** Return the sandbox instance name for a slot index.
 * Single container per project — always uses the bare group_folder.
 * Slot indices are purely logical concurrency tokens for the semaphore. */
export function sandboxInstanceName(
  group_folder: string,
  _slotIndex: number,
): string {
  return group_folder;
}
