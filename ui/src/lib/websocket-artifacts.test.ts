// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { queryKeys } from './query-keys';
import { invalidateArtifactExplorerQueries } from './artifact-cache';

describe('artifact WebSocket invalidation', () => {
  test('invalidates every browse and search page for only the changed project', () => {
    const client = new QueryClient();
    const changedKeys = [
      [...queryKeys.artifacts.explorer('alpha'), 'images', 'cursor-2'],
      [...queryKeys.artifacts.search('alpha'), 'photo', 'cursor-3'],
      queryKeys.artifacts.all('alpha'),
    ];
    const otherKey = [...queryKeys.artifacts.explorer('beta'), '', 'cursor-1'];
    for (const key of [...changedKeys, otherKey]) client.setQueryData(key, {});

    invalidateArtifactExplorerQueries(client, 'alpha');

    for (const key of changedKeys)
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    expect(client.getQueryState(otherKey)?.isInvalidated).toBe(false);
  });
});
