import { beforeEach, describe, expect, it } from 'vitest';
import {
  publishOpenFileContext,
  snapshotOpenFileContext,
  updateOpenFileContext,
} from './open-file-context';

describe('open file context store', () => {
  beforeEach(() => {
    publishOpenFileContext(null);
  });

  it('snapshots metadata without file or selected contents', () => {
    publishOpenFileContext({
      key: 'p:tab',
      conversationId: 'conversation-a',
      context: { source: 'group', path: '.env', line: 1, column: 2 },
    });
    updateOpenFileContext('p:tab', {
      selection: {
        start: { line: 1, column: 2 },
        end: { line: 1, column: 8 },
      },
      unsavedChanges: true,
    });
    const captured = snapshotOpenFileContext('conversation-a');
    expect(captured).toEqual({
      source: 'group',
      path: '.env',
      line: 1,
      column: 2,
      selection: {
        start: { line: 1, column: 2 },
        end: { line: 1, column: 8 },
      },
      unsavedChanges: true,
    });
  });

  it('replaces the published context when the visible preview changes', () => {
    publishOpenFileContext({
      key: 'one',
      conversationId: 'conversation-a',
      context: { source: 'repo', path: 'a.ts', repoContext: 'main' },
    });
    publishOpenFileContext({
      key: 'two',
      conversationId: 'conversation-b',
      context: { source: 'artifact', path: 'b.md' },
    });
    expect(snapshotOpenFileContext('conversation-b')?.path).toBe('b.md');
  });

  it('rejects context published for another conversation or New', () => {
    publishOpenFileContext({
      key: 'a',
      conversationId: 'conversation-a',
      context: { source: 'artifact', path: 'a.md' },
    });

    expect(snapshotOpenFileContext('conversation-b')).toBeUndefined();
    expect(snapshotOpenFileContext(null)).toBeUndefined();
    expect(snapshotOpenFileContext('conversation-a')?.path).toBe('a.md');
  });
});
