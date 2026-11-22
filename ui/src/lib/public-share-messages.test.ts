// Bun supplies these test globals at runtime; the UI package intentionally
// does not depend on Bun's type declarations.
// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import {
  mergeOlderPage,
  mergePublicMessages,
  mergeRefreshedPage,
} from './public-share-messages';

const msg = (id: string) => ({ id });
const page = (ids: string[], hasMore: boolean, nextOffset: number) => ({
  conversation: {},
  messages: ids.map(msg),
  total: 0,
  hasMore,
  nextOffset,
});
const ids = (response: { messages: { id: string }[] }) =>
  response.messages.map((m) => m.id);

describe('public share message paging', () => {
  test('load older, refresh, load older again yields no duplicate ids', () => {
    let current = page(['m5', 'm6'], true, 2);
    current = mergeOlderPage(current, page(['m3', 'm4'], true, 4));
    // A new message arrived; the first page now starts one message later.
    current = mergeRefreshedPage(current, page(['m6', 'm7'], true, 2));
    expect(current.nextOffset).toBe(4);
    expect(ids(current)).toEqual(['m3', 'm4', 'm5', 'm6', 'm7']);
    // Offsets shifted by one, so the server repeats m4 at the start of the page.
    current = mergeOlderPage(current, page(['m2', 'm3', 'm4'], false, 7));
    expect(ids(current)).toEqual(['m2', 'm3', 'm4', 'm5', 'm6', 'm7']);
    expect(current.hasMore).toBe(false);
  });

  test('a message arriving between pages is appended after existing ones', () => {
    expect(
      mergePublicMessages(
        [msg('a'), msg('b')],
        [msg('b'), msg('c')],
        'merge',
      ).map((m) => m.id),
    ).toEqual(['a', 'b', 'c']);
  });

  test('refresh with no current page takes the incoming page and its cursor', () => {
    const next = page(['a'], true, 1);
    expect(mergeRefreshedPage(null, next)).toBe(next);
  });
});
