import { describe, expect, test } from 'bun:test';
import {
  scoreMemoryQuality,
  type QualityItem,
} from './memory-quality-score.js';

const item = (id: string, content: string, rest: Partial<QualityItem> = {}) =>
  ({ id, content, ...rest }) as QualityItem;

describe('scoreMemoryQuality', () => {
  test('empty input yields a zeroed report', () => {
    const { overall, bySource } = scoreMemoryQuality([]);
    expect(overall.count).toBe(0);
    expect(overall.length).toMatchObject({ median: 0, p90: 0, max: 0 });
    expect(overall.leadSentence.share).toBe(0);
    expect(overall.importance.share).toBe(0);
    expect(overall.nearDuplicates.pairs).toEqual([]);
    expect(bySource).toEqual({});
  });

  test('length median, p90 and shareOver600 on a fixed set', () => {
    const lengths = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    const report = scoreMemoryQuality(
      lengths.map((n, i) => item(`m${i}`, 'x'.repeat(n))),
    );
    expect(report.overall.length.median).toBe(550);
    expect(report.overall.length.p90).toBe(900);
    expect(report.overall.length.max).toBe(1000);
    // 600 is not over 600; 700..1000 are.
    expect(report.overall.length.shareOver600).toBe(0.4);
  });

  test('lead sentence share: a 300-char single sentence has no lead', () => {
    const report = scoreMemoryQuality([
      item('long', 'a'.repeat(300)),
      item('short', 'Short fact. And then a very long tail ' + 'b'.repeat(400)),
      item('newline', 'Headline\n' + 'c'.repeat(400)),
    ]);
    expect(report.overall.leadSentence.share).toBeCloseTo(2 / 3);
    expect(report.overall.leadSentence.missingIds).toEqual(['long']);
  });

  test.each([
    'not yet live',
    'not yet merged',
    'not yet deployed',
    'not yet verified',
    'pending deploy',
    'pending merge',
    'pending review',
    'pending approval',
    'awaiting',
    'in the backlog',
    'in backlog',
    'uncommitted',
    'unmerged',
    'in flight',
    'in progress',
    'currently running',
    'todo',
  ])('stale phrase "%s" is flagged', (phrase) => {
    const report = scoreMemoryQuality([
      item('stale', `The change is ${phrase.toUpperCase()} today.`),
    ]);
    expect(report.overall.staleStatus.ids).toEqual(['stale']);
  });

  test('stale phrase respects word boundaries', () => {
    const report = scoreMemoryQuality([
      item('a', 'This is unawaiting nothing.'),
      item('b', 'A stable decision about mastodon.'),
    ]);
    expect(report.overall.staleStatus.count).toBe(0);
  });

  test('tag bounds: 1 and 7 flagged, 2 and 6 fine, missing counts as 0', () => {
    const tags = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);
    const report = scoreMemoryQuality([
      item('one', 'x', { tags: tags(1) }),
      item('two', 'x', { tags: tags(2) }),
      item('six', 'x', { tags: tags(6) }),
      item('seven', 'x', { tags: tags(7) }),
      item('none', 'x'),
    ]);
    expect(report.overall.tags.ids).toEqual(['one', 'seven', 'none']);
    expect(report.overall.tags.share).toBeCloseTo(3 / 5);
  });

  test('importance share excludes items without importance', () => {
    const report = scoreMemoryQuality([
      item('hi', 'x', { importance: 0.9 }),
      item('lo', 'x', { importance: 0.5 }),
      item('none', 'x'),
    ]);
    expect(report.overall.importance.considered).toBe(2);
    expect(report.overall.importance.share).toBe(0.5);
    expect(report.overall.importance.ids).toEqual(['hi']);
  });

  test('near duplicates: ~0.8 Jaccard pair found, ~0.5 not', () => {
    const base = 'alpha bravo charlie delta echoes foxtrot golf hotel india';
    // 9 shared words vs 9 + 1 distinct each way: 9 / 11 = 0.82
    const similar = `${base} juliet`;
    const report = scoreMemoryQuality([
      item('a', `${base} kilo`),
      item('b', similar),
      // shares 3 of 9 words with `base`, so Jaccard stays well below 0.7
      item('c', 'alpha bravo charlie lima mike november oscar papa quebec'),
    ]);
    const { pairs, pairCount } = report.overall.nearDuplicates;
    expect(pairCount).toBe(1);
    expect(pairs.map((p) => [p.a, p.b])).toEqual([['a', 'b']]);
  });

  test('more than 2000 items skips comparison and returns no pairs', () => {
    const items = Array.from({ length: 2001 }, (_, i) =>
      item(`m${i}`, 'identical content words everywhere'),
    );
    const { nearDuplicates } = scoreMemoryQuality(items).overall;
    expect(nearDuplicates.skipped).toBe(true);
    expect(nearDuplicates.itemCount).toBe(2001);
    expect(nearDuplicates.pairs).toEqual([]);
    expect(nearDuplicates.pairCount).toBe(0);
  });

  test('groups per source with unknown fallback and caps id lists', () => {
    const items = [
      item('o1', 'x', { source: 'observer' }),
      item('a1', 'x', { source: 'agent' }),
      item('u1', 'x'),
      ...Array.from({ length: 60 }, (_, i) =>
        item(`s${i}`, 'todo item', { source: 'observer' }),
      ),
    ];
    const report = scoreMemoryQuality(items);
    expect(report.overall.count).toBe(63);
    expect(Object.keys(report.bySource).sort()).toEqual([
      'agent',
      'observer',
      'unknown',
    ]);
    expect(report.bySource.observer.count).toBe(61);
    expect(report.bySource.unknown.count).toBe(1);
    expect(report.bySource.observer.staleStatus.count).toBe(60);
    expect(report.bySource.observer.staleStatus.ids).toHaveLength(50);
  });
});
