import { afterEach, expect, it, vi } from 'vitest';
import { listProjectMembersForAttribution } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('reads a 403 member list (non-owner) as empty and still throws other errors', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ error: 'No' }, { status: 403 }))
    .mockResolvedValueOnce(Response.json({ error: 'Boom' }, { status: 500 }));
  vi.stubGlobal('fetch', fetchMock);
  expect(await listProjectMembersForAttribution('project-a')).toEqual([]);
  await expect(listProjectMembersForAttribution('project-a')).rejects.toThrow(
    'Boom',
  );
});
