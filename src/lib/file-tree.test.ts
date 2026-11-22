import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listDirectoryAt } from './file-tree.js';
import { openTrustedDir } from './group-fs.js';

const root = path.join(os.tmpdir(), `carapa-file-tree-${Date.now()}`);

/** listDirectoryAt for the directory at `rootDir`. */
async function listDirectory(
  rootDir: string,
  ...args: DropFirst<Parameters<typeof listDirectoryAt>>
) {
  const dir = (await openTrustedDir(rootDir))!;
  try {
    return await listDirectoryAt(dir, ...args);
  } finally {
    await dir.close();
  }
}
type DropFirst<T extends unknown[]> = T extends [unknown, ...infer R]
  ? R
  : never;

beforeAll(async () => {
  await fs.mkdir(path.join(root, 'folder'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(root, 'z.txt'), ''),
    fs.writeFile(path.join(root, 'a.txt'), ''),
    fs.writeFile(path.join(root, 'folder', 'child.txt'), ''),
    fs.writeFile(path.join(root, 'node_modules', 'hidden.txt'), ''),
  ]);
});
afterAll(() => fs.rm(root, { recursive: true, force: true }));

describe('listDirectory', () => {
  test('returns one deterministic, paginated directory level', async () => {
    expect(await listDirectory(root, '', 2)).toEqual({
      entries: [
        { kind: 'directory', name: 'folder', path: 'folder' },
        { kind: 'file', name: 'a.txt', path: 'a.txt', sizeBytes: 0 },
      ],
      nextCursor: '2',
    });
    expect(await listDirectory(root, '', 2, '2')).toEqual({
      entries: [{ kind: 'file', name: 'z.txt', path: 'z.txt', sizeBytes: 0 }],
      nextCursor: undefined,
    });
  });

  test('rejects traversal and invalid cursors', async () => {
    await expect(listDirectory(root, '../outside', 50)).rejects.toThrow(
      'Path escapes root',
    );
    await expect(listDirectory(root, '', 50, 'nope')).rejects.toThrow(
      'Invalid cursor',
    );
  });

  test('sorts by name or modified time, directories first, before paging', async () => {
    const dir = path.join(root, 'sorted');
    await fs.mkdir(path.join(dir, 'sub'), { recursive: true });
    const stamps = { b: 1000, c: 2000, a: 3000 };
    for (const [name, secs] of Object.entries(stamps)) {
      const file = path.join(dir, `${name}.md`);
      await fs.writeFile(file, '');
      await fs.utimes(file, secs, secs);
    }
    const names = async (...args: Parameters<typeof listDirectory>) =>
      (await listDirectory(...args)).entries.map((e) => e.name);
    const none = new Set<string>();

    expect(
      await names(root, 'sorted', 10, undefined, none, { order: 'desc' }),
    ).toEqual(['sub', 'c.md', 'b.md', 'a.md']);
    expect(
      await names(root, 'sorted', 10, undefined, none, {
        sort: 'modified',
        order: 'desc',
      }),
    ).toEqual(['sub', 'a.md', 'c.md', 'b.md']);
    expect(
      await names(root, 'sorted', 10, undefined, none, {
        sort: 'modified',
        order: 'asc',
      }),
    ).toEqual(['sub', 'b.md', 'c.md', 'a.md']);

    const options = { sort: 'modified', order: 'desc' } as const;
    const first = await listDirectory(
      root,
      'sorted',
      2,
      undefined,
      none,
      options,
    );
    const second = await listDirectory(
      root,
      'sorted',
      2,
      first.nextCursor,
      none,
      options,
    );
    expect([...first.entries, ...second.entries].map((e) => e.name)).toEqual([
      'sub',
      'a.md',
      'c.md',
      'b.md',
    ]);
    expect(second.nextCursor).toBeUndefined();
    expect(second.entries[1]!.modifiedAt).toBe(
      new Date(1000 * 1000).toISOString(),
    );
  });
});
