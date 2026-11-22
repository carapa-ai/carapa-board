/**
 * Tests for src/concurrency/semaphore.ts — acquireGroupSlot, sandboxInstanceName.
 */

import { describe, test, expect } from 'bun:test';
import { acquireGroupSlot, sandboxInstanceName } from './semaphore.js';

// Each test uses a unique group name to avoid cross-test semaphore state.
let groupCounter = 0;
function uniqueGroup(): string {
  return `test-group-${Date.now()}-${groupCounter++}`;
}

// ─── acquireGroupSlot ────────────────────────────────────────────────────────

describe('acquireGroupSlot', () => {
  test('normalizes a zero slot limit instead of deadlocking', async () => {
    const group = uniqueGroup();
    const { slotIndex, release } = await acquireGroupSlot(group, 0);
    expect(slotIndex).toBe(0);
    release();
  });

  test('returns distinct slot indices for concurrent acquisitions', async () => {
    const group = uniqueGroup();
    const a = await acquireGroupSlot(group, 3);
    const b = await acquireGroupSlot(group, 3);
    expect(a.slotIndex).not.toBe(b.slotIndex);
    a.release();
    b.release();
  });

  test('waits when all slots are occupied and resolves after release', async () => {
    const group = uniqueGroup();
    const maxSlots = 2;

    const first = await acquireGroupSlot(group, maxSlots);
    const second = await acquireGroupSlot(group, maxSlots);

    // Third acquisition should be queued
    let resolved = false;
    const thirdPromise = acquireGroupSlot(group, maxSlots).then((r) => {
      resolved = true;
      return r;
    });

    // Give the event loop a tick — third should still be waiting
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Release one slot — third should now resolve
    first.release();
    const third = await thirdPromise;
    expect(resolved).toBe(true);

    second.release();
    third.release();
  });

  test('removes an aborted waiter without consuming the next released slot', async () => {
    const group = uniqueGroup();
    const first = await acquireGroupSlot(group, 1);
    const controller = new AbortController();
    const aborted = acquireGroupSlot(group, 1, {
      signal: controller.signal,
    });
    const next = acquireGroupSlot(group, 1);

    controller.abort();
    await expect(aborted).rejects.toThrow('slot acquisition aborted');
    first.release();

    const nextLease = await next;
    expect(nextLease.slotIndex).toBe(0);
    nextLease.release();
  });

  test('respects FIFO order for waiting tasks', async () => {
    const group = uniqueGroup();
    const maxSlots = 1;

    const first = await acquireGroupSlot(group, maxSlots);

    const order: number[] = [];
    const p1 = acquireGroupSlot(group, maxSlots).then((r) => {
      order.push(1);
      r.release();
    });
    const p2 = acquireGroupSlot(group, maxSlots).then((r) => {
      order.push(2);
      r.release();
    });
    const p3 = acquireGroupSlot(group, maxSlots).then((r) => {
      order.push(3);
      r.release();
    });

    first.release();
    await Promise.all([p1, p2, p3]);

    expect(order).toEqual([1, 2, 3]);
  });

  test('wakes waiting tasks when maxSlots is increased', async () => {
    const group = uniqueGroup();
    const maxSlots1 = 1;

    const first = await acquireGroupSlot(group, maxSlots1);

    let secondResolved = false;
    const secondPromise = acquireGroupSlot(group, maxSlots1).then((r) => {
      secondResolved = true;
      r.release();
    });

    // Increase limit — this should wake the waiter
    await acquireGroupSlot(group, 3); // same group, higher limit → triggers wake-up logic

    first.release();
    await secondPromise;
    expect(secondResolved).toBe(true);
  });

  test('does not exceed a reduced maxSlots limit while leases are active', async () => {
    const group = uniqueGroup();
    const first = await acquireGroupSlot(group, 3);
    const second = await acquireGroupSlot(group, 3);
    const third = await acquireGroupSlot(group, 3);

    let waiterResolved = false;
    const waiter = acquireGroupSlot(group, 1).then((lease) => {
      waiterResolved = true;
      return lease;
    });

    // Slot 0 is still valid under the reduced limit, but two active leases
    // remain above the new limit after it is released.
    first.release();
    await Promise.resolve();
    expect(waiterResolved).toBe(false);

    // Once all leases above the new limit are gone, the queued waiter may run.
    second.release();
    third.release();
    const queuedLease = await waiter;
    expect(waiterResolved).toBe(true);
    queuedLease.release();
  });

  test('does not exceed the limit when increasing after a reduction', async () => {
    const group = uniqueGroup();
    const first = await acquireGroupSlot(group, 3);
    const second = await acquireGroupSlot(group, 3);
    const third = await acquireGroupSlot(group, 3);

    let reducedWaiterResolved = false;
    const reducedWaiter = acquireGroupSlot(group, 1).then((lease) => {
      reducedWaiterResolved = true;
      return lease;
    });

    let increasedWaiterResolved = false;
    const increasedWaiter = acquireGroupSlot(group, 2).then((lease) => {
      increasedWaiterResolved = true;
      return lease;
    });

    await Promise.resolve();
    expect(reducedWaiterResolved).toBe(false);
    expect(increasedWaiterResolved).toBe(false);

    first.release();
    await Promise.resolve();
    expect(increasedWaiterResolved).toBe(false);

    second.release();
    const reducedLease = await reducedWaiter;
    expect(reducedWaiterResolved).toBe(true);
    expect(increasedWaiterResolved).toBe(false);

    third.release();
    reducedLease.release();
    const increasedLease = await increasedWaiter;
    expect(increasedWaiterResolved).toBe(true);
    increasedLease.release();
  });

  test('does not reissue a slot still held after reducing then increasing the limit', async () => {
    const group = uniqueGroup();
    const first = await acquireGroupSlot(group, 3);
    const second = await acquireGroupSlot(group, 3);
    const third = await acquireGroupSlot(group, 3);

    const reducedWaiter = acquireGroupSlot(group, 1);
    const increasedWaiter = acquireGroupSlot(group, 2);

    // Slot 1 remains held while the limit is reduced to 1 and then increased
    // to 2. It must not be re-added to the free pool during that increase.
    first.release();
    third.release();

    const reducedLease = await reducedWaiter;
    reducedLease.release();
    const increasedLease = await increasedWaiter;
    expect(increasedLease.slotIndex).not.toBe(second.slotIndex);

    second.release();
    increasedLease.release();
  });

  test('keeps normal capacity free when a manual lease starts first', async () => {
    const group = uniqueGroup();
    const manual = await acquireGroupSlot(group, 1, { bypassLimit: true });
    const normal = await acquireGroupSlot(group, 1);

    expect(manual.slotIndex).toBe(1);
    expect(normal.slotIndex).toBe(0);

    normal.release();
    manual.release();
  });

  test('grants distinct overflow leases without waking normal waiters', async () => {
    const group = uniqueGroup();
    const normal = await acquireGroupSlot(group, 1);
    let waiterResolved = false;
    const waiterPromise = acquireGroupSlot(group, 1).then((lease) => {
      waiterResolved = true;
      return lease;
    });

    const firstManual = await acquireGroupSlot(group, 1, {
      bypassLimit: true,
    });
    const secondManual = await acquireGroupSlot(group, 1, {
      bypassLimit: true,
    });

    expect(firstManual.slotIndex).not.toBe(normal.slotIndex);
    expect(secondManual.slotIndex).not.toBe(firstManual.slotIndex);
    expect(waiterResolved).toBe(false);

    firstManual.release();
    secondManual.release();
    await Promise.resolve();
    expect(waiterResolved).toBe(false);

    normal.release();
    const waiter = await waiterPromise;
    waiter.release();
  });

  test('wakes a normal waiter when automatic capacity releases before manual leases', async () => {
    const group = uniqueGroup();
    const normal = await acquireGroupSlot(group, 1);
    let waiterResolved = false;
    const waiterPromise = acquireGroupSlot(group, 1).then((lease) => {
      waiterResolved = true;
      return lease;
    });
    const firstManual = await acquireGroupSlot(group, 1, {
      bypassLimit: true,
    });
    const secondManual = await acquireGroupSlot(group, 1, {
      bypassLimit: true,
    });

    normal.release();
    const waiter = await waiterPromise;
    expect(waiterResolved).toBe(true);
    expect(waiter.slotIndex).toBe(normal.slotIndex);

    waiter.release();
    firstManual.release();
    secondManual.release();
  });

  test('ignores duplicate release calls so capacity cannot be exceeded', async () => {
    const group = uniqueGroup();
    const first = await acquireGroupSlot(group, 1);

    first.release();
    first.release();

    const second = await acquireGroupSlot(group, 1);
    let thirdResolved = false;
    const thirdPromise = acquireGroupSlot(group, 1).then((lease) => {
      thirdResolved = true;
      return lease;
    });

    await Promise.resolve();
    expect(thirdResolved).toBe(false);

    second.release();
    const third = await thirdPromise;
    third.release();
  });
});
