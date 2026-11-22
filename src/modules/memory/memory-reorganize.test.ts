import { describe, expect, test } from 'bun:test';
import type { RegisteredGroup } from '../../types.js';
import {
  normalizeMemoryReorganization,
  relatedMemoryProjects,
} from './memory-reorganize.js';

function group(
  folder: string,
  parentId?: string,
  memorySourceProjects?: string[],
): RegisteredGroup {
  return {
    folder,
    name: folder,
    trigger: '@test',
    added_at: '2026-08-01T00:00:00.000Z',
    ...(parentId ? { parentId } : {}),
    settings: { memorySourceProjects },
  };
}

describe('related memory projects', () => {
  test('allows ancestors, descendants, and configured memory sources only', () => {
    const groups = {
      root: group('root'),
      app: group('app', 'root', ['framework']),
      child: group('child', 'app'),
      grandchild: group('grandchild', 'child'),
      sibling: group('sibling', 'root'),
      framework: group('framework'),
      frameworkChild: group('framework-child', 'framework'),
      otherApp: group('other-app', undefined, ['framework']),
    };

    const related = relatedMemoryProjects('app', groups);
    expect(related.map((project) => project.id)).toEqual([
      'child',
      'framework',
      'grandchild',
      'root',
    ]);
    expect(related.find((project) => project.id === 'root')?.relationship).toBe(
      'parent',
    );
    expect(
      related.find((project) => project.id === 'framework')?.relationship,
    ).toBe('memory-source');
    expect(related.some((project) => project.id === 'framework-child')).toBe(
      false,
    );
    expect(related.some((project) => project.id === 'sibling')).toBe(false);
    expect(related.some((project) => project.id === 'other-app')).toBe(false);
  });
});

describe('memory reorganization response validation', () => {
  const allowedMemoryIds = new Set(['mem-a', 'mem-b']);
  const allowedProjectIds = new Set(['parent', 'framework']);

  test('accepts only allowed moves and accounts for every memory', () => {
    const decisions = normalizeMemoryReorganization({
      output: JSON.stringify({
        items: [
          {
            memory_id: 'mem-a',
            disposition: 'move',
            confidence: 0.96,
            reason: 'Framework-owned convention',
            target_project_id: 'framework',
          },
          {
            memory_id: 'mem-b',
            disposition: 'keep',
            confidence: 0.8,
            reason: 'Application-specific integration choice',
          },
        ],
      }),
      allowedMemoryIds,
      allowedProjectIds,
    });
    expect(decisions).toEqual([
      {
        memoryId: 'mem-a',
        disposition: 'move',
        confidence: 0.96,
        reason: 'Framework-owned convention',
        targetProjectId: 'framework',
      },
      {
        memoryId: 'mem-b',
        disposition: 'keep',
        confidence: 0.8,
        reason: 'Application-specific integration choice',
      },
    ]);
  });

  test('converts low-confidence moves to keep', () => {
    const decisions = normalizeMemoryReorganization({
      output: JSON.stringify({
        items: [
          {
            memory_id: 'mem-a',
            disposition: 'move',
            confidence: 0.89,
            reason: 'Possibly shared',
            target_project_id: 'framework',
          },
          {
            memory_id: 'mem-b',
            disposition: 'keep',
            confidence: 1,
            reason: 'Correctly placed',
          },
        ],
      }),
      allowedMemoryIds,
      allowedProjectIds,
    });
    expect(decisions[0]).toMatchObject({
      disposition: 'keep',
    });
    expect(decisions[0]?.targetProjectId).toBeUndefined();
  });

  test('rejects unrelated destinations', () => {
    expect(() =>
      normalizeMemoryReorganization({
        output: JSON.stringify({
          items: [
            {
              memory_id: 'mem-a',
              disposition: 'move',
              confidence: 0.99,
              reason: 'Wrong destination',
              target_project_id: 'unrelated',
            },
            {
              memory_id: 'mem-b',
              disposition: 'keep',
              confidence: 1,
              reason: 'Correctly placed',
            },
          ],
        }),
        allowedMemoryIds,
        allowedProjectIds,
      }),
    ).toThrow('Invalid target project for mem-a');
  });
});
