import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import * as stateManager from '../../state-manager.js';
import { fetchImage, FETCH_IMAGE_MAX_BYTES } from './fetch-image.js';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32),
]);

function setup(
  body: string | Uint8Array,
  headers: Record<string, string> = {},
) {
  const requested: string[] = [];
  const written: Array<{ relPath: string; size: number; opts: any }> = [];
  const deps = {
    resolveHost: async () => ['93.184.216.34'],
    fetch: (async (input: unknown) => {
      requested.push(String(input));
      return new Response(body, { headers });
    }) as any,
    writeArtifact: (async (
      _g: string,
      relPath: string,
      buf: Buffer,
      opts: any,
    ) => {
      written.push({ relPath, size: buf.length, opts });
      return { relPath, url: `/artifacts/${relPath}` };
    }) as any,
    broadcast: (() => undefined) as any,
  };
  return { deps, requested, written };
}

describe('fetchImage', () => {
  let lookup: ReturnType<typeof spyOn>;
  beforeAll(() => {
    lookup = spyOn(stateManager, 'getGroupByFolder').mockReturnValue({
      folder: 'proj',
    } as any);
  });
  afterAll(() => lookup.mockRestore());
  test('saves a PNG and returns the container path', async () => {
    const { deps, written } = setup(PNG, { 'content-type': 'image/png' });
    const out = await fetchImage(
      'https://example.com/a.png',
      { group_folder: 'proj' },
      deps,
    );
    expect(written).toHaveLength(1);
    expect(written[0].relPath).toMatch(/^web-images\/\d+-[0-9a-f]{8}\.png$/);
    expect(written[0].opts).toMatchObject({
      mimetype: 'image/png',
      source: 'agent',
      source_url: 'https://example.com/a.png',
    });
    expect(out).toContain(
      `Saved image (image/png, ${PNG.length} bytes) to /workspace/group/artifacts/web-images/`,
    );
  });

  test('rejects HTML served as image/png without writing', async () => {
    const { deps, written } = setup('<html></html>', {
      'content-type': 'image/png',
    });
    const out = await fetchImage(
      'https://example.com/a.png',
      { group_folder: 'proj' },
      deps,
    );
    expect(out).toStartWith('Error:');
    expect(written).toHaveLength(0);
  });

  test('rejects a body over the size cap without writing', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(FETCH_IMAGE_MAX_BYTES)]);
    const { deps, written } = setup(big);
    const out = await fetchImage(
      'https://example.com/a.png',
      { group_folder: 'proj' },
      deps,
    );
    expect(out).toContain('10 MB');
    expect(written).toHaveLength(0);
  });

  test('refuses a blocked URL before fetching', async () => {
    const { deps, requested, written } = setup(PNG);
    const out = await fetchImage(
      'http://127.0.0.1/a.png',
      { group_folder: 'proj' },
      deps,
    );
    expect(out).toStartWith('Error:');
    expect(requested).toHaveLength(0);
    expect(written).toHaveLength(0);
  });

  test('requests the original variant for pbs.twimg.com', async () => {
    const { deps, requested } = setup(PNG);
    await fetchImage(
      'https://pbs.twimg.com/media/abc?format=jpg&name=small',
      { group_folder: 'proj' },
      deps,
    );
    const url = new URL(requested[0]);
    expect(url.searchParams.get('name')).toBe('orig');
    expect(url.searchParams.get('format')).toBe('jpg');
  });
});
