// Bun supplies these test globals at runtime; the UI package intentionally
// does not depend on Bun's type declarations.
// @ts-nocheck
import { expect, test } from 'bun:test';
import {
  countLoadedObjectiveRows,
  mergeObjectivePages,
  nextObjectiveOffset,
} from './pagination';

test('objective explorer pagination keeps earlier pages and dedupes items when loading more', () => {
  const key = (item: { id: string }) => item.id;
  const page1 = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  // A new event shifted offsets, so page 2 repeats the last row of page 1.
  const page2 = [{ id: 'c' }, { id: 'd' }];

  expect(mergeObjectivePages([page1], key).map(key)).toEqual(['a', 'b', 'c']);
  expect(mergeObjectivePages([page1, page2], key).map(key)).toEqual([
    'a',
    'b',
    'c',
    'd',
  ]);

  expect(nextObjectiveOffset(countLoadedObjectiveRows([page1]), 5)).toBe(3);
  expect(nextObjectiveOffset(countLoadedObjectiveRows([page1, page2]), 5)).toBe(
    undefined,
  );
});
