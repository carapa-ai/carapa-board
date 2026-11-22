import { describe, expect, test } from 'bun:test';
import {
  RENAME_GROUP_MEMORY_GRAPH_CYPHER,
  renameGroupMemoryGraph,
  renameGroupMemoryGraphInSession,
} from './store.js';

type Node = { label: 'Memory' | 'Entity'; group_folder: string };

/** Fake session that applies the rename query's semantics to in-memory nodes. */
function fakeSession(nodes: Node[]) {
  const calls: Array<{ query: string; params?: Record<string, unknown> }> = [];
  return {
    calls,
    session: {
      async run(query: string, params?: Record<string, unknown>) {
        calls.push({ query, params });
        let c = 0;
        for (const node of nodes) {
          if (node.group_folder === params?.old) {
            node.group_folder = params.new as string;
            c++;
          }
        }
        return { records: [{ get: () => c }] };
      },
    },
  };
}

describe('renameGroupMemoryGraphInSession', () => {
  test('moves only the old folder nodes and returns the count', async () => {
    const nodes: Node[] = [
      { label: 'Memory', group_folder: 'old' },
      { label: 'Entity', group_folder: 'old' },
      { label: 'Entity', group_folder: 'old-sibling' },
      { label: 'Memory', group_folder: '__eval__:run-1' },
    ];
    const { calls, session } = fakeSession(nodes);
    expect(await renameGroupMemoryGraphInSession(session, 'old', 'new')).toBe(
      2,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toBe(RENAME_GROUP_MEMORY_GRAPH_CYPHER);
    expect(calls[0].query).toContain('n.group_folder = $old');
    expect(calls[0].query).not.toMatch(/STARTS WITH|=~/);
    expect(nodes.map((n) => n.group_folder)).toEqual([
      'new',
      'new',
      'old-sibling',
      '__eval__:run-1',
    ]);
  });

  test('issues no query for blank or eval folders on either side', async () => {
    const { calls, session } = fakeSession([]);
    for (const [from, to] of [
      ['', 'new'],
      ['old', '  '],
      ['__eval__:run-1', 'new'],
      ['old', '__eval__:run-1'],
    ]) {
      expect(await renameGroupMemoryGraphInSession(session, from, to)).toBe(0);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('renameGroupMemoryGraph', () => {
  test('throws when the driver is unavailable', async () => {
    await expect(renameGroupMemoryGraph('old', 'new')).rejects.toThrow(
      /unavailable/,
    );
  });

  test('returns 0 for blank or eval folders without needing a driver', async () => {
    expect(await renameGroupMemoryGraph('', 'new')).toBe(0);
    expect(await renameGroupMemoryGraph('old', '__eval__:x')).toBe(0);
  });
});
