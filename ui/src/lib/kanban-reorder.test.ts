// Bun supplies these test globals at runtime; the UI package intentionally
// does not depend on Bun's type declarations.
// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { computeReorderUpdates } from './kanban-reorder';

const t = (id, priority, running = false) => ({ id, priority, running });

const col = [t('a', 0), t('b', 1000), t('c', 2000)];

/** Apply updates to the full column and return ids in priority order. */
function orderAfter(full, updates) {
  const next = new Map(updates.map((u) => [u.id, u.priority]));
  return full
    .map((x) => ({ id: x.id, priority: next.get(x.id) ?? x.priority }))
    .sort((x, y) => x.priority - y.priority)
    .map((x) => x.id);
}

describe('computeReorderUpdates', () => {
  test('returns no updates for a done stage', () => {
    expect(computeReorderUpdates(col, 0, 2, 'done', col)).toEqual([]);
  });

  test('updates only the dragged card for an active stage', () => {
    expect(computeReorderUpdates(col, 0, 2, 'active', col)).toEqual([
      { id: 'a', priority: 3000 },
    ]);
  });

  test('keeps hidden cards in their relative order', () => {
    const full = [t('a', 0), t('h', 1000), t('b', 2000), t('c', 3000)];
    const visible = [full[0], full[2], full[3]];
    const toBottom = computeReorderUpdates(visible, 0, 2, 'active', full);
    expect(toBottom).toEqual([{ id: 'a', priority: 4000 }]);
    expect(orderAfter(full, toBottom)).toEqual(['h', 'b', 'c', 'a']);

    const full2 = [t('a', 0), t('h', 500), t('b', 2000), t('c', 3000)];
    const visible2 = [full2[0], full2[2], full2[3]];
    const middle = computeReorderUpdates(visible2, 2, 1, 'active', full2);
    expect(middle).toEqual([{ id: 'c', priority: 1000 }]);
    expect(orderAfter(full2, middle)).toEqual(['a', 'h', 'c', 'b']);
  });

  test('moving to the top or bottom steps 1000 past the neighbour', () => {
    expect(computeReorderUpdates(col, 2, 0, 'active', col)).toEqual([
      { id: 'c', priority: -1000 },
    ]);
    expect(computeReorderUpdates(col, 0, 2, 'queue', col)).toEqual([
      { id: 'a', priority: 3000 },
    ]);
  });

  test('skips running cards when picking neighbours', () => {
    const running = [t('r', 5000, true), t('a', 0), t('b', 1000)];
    // b moved to the top of the visible list: r is running, so a is next.
    expect(computeReorderUpdates(running, 2, 0, 'active', running)).toEqual([
      { id: 'b', priority: -1000 },
    ]);
    // a moved below b: r is the only prior card, but it is running.
    expect(computeReorderUpdates(running, 1, 2, 'active', running)).toEqual([
      { id: 'a', priority: 2000 },
    ]);
    const mixed = [t('a', 0), t('r', 9000, true), t('b', 1000), t('c', 2000)];
    // c moved between r and b: prev (a, skipping r) = 0, next = b = 1000.
    expect(computeReorderUpdates(mixed, 3, 2, 'active', mixed)).toEqual([
      { id: 'c', priority: 500 },
    ]);
  });

  test('renumbers the full column when neighbours have no priority gap', () => {
    const full = [t('a', 0), t('h', 0), t('b', 0), t('c', 0)];
    const visible = [full[0], full[2], full[3]];
    const updates = computeReorderUpdates(visible, 0, 1, 'active', full);
    // a moves directly after b; h keeps its place before b.
    expect(orderAfter(full, updates)).toEqual(['h', 'b', 'a', 'c']);
    expect(updates.map((u) => u.id).sort()).toEqual(['a', 'b', 'c'].sort());
  });
});
