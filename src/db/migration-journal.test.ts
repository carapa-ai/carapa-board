import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

describe('Drizzle migration journal', () => {
  test('keeps migration timestamps strictly increasing', () => {
    const journal = JSON.parse(
      readFileSync(join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8'),
    ) as { entries: JournalEntry[] };

    const outOfOrder = journal.entries.slice(1).flatMap((entry, index) => {
      const previous = journal.entries[index];
      return entry.when > previous.when
        ? []
        : [
            `${entry.tag} (${entry.when}) follows ${previous.tag} (${previous.when})`,
          ];
    });

    expect(outOfOrder).toEqual([]);
  });
});
