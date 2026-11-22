import { describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  discoverCodexMemories,
  encodeClaudeProject,
  loadProjectCatalog,
  resolveNativeMemoryProject,
  targetNativeMemory,
  type NativeMemorySource,
} from './native-memory-import.js';

const memory: NativeMemorySource = {
  provider: 'claude',
  sourceLabel: 'sandbox',
  nativeProject: '-home-user-projects-carapa',
  cwd: null,
  sourcePath: '/native/MEMORY.md',
  relativePath: 'MEMORY.md',
  content: Buffer.from('memory'),
  sourceBirthtime: '2026-01-01T00:00:00.000Z',
  sourceMtime: '2026-02-01T00:00:00.000Z',
  sourceMode: 0o600,
};

describe('native memory import', () => {
  test('matches Claude encoded project folders through cwd mappings', () => {
    expect(encodeClaudeProject('/home/user/projects/carapa')).toBe(
      '-home-user-projects-carapa',
    );
    expect(
      resolveNativeMemoryProject(
        memory,
        new Map([['cwd:/home/user/projects/carapa', 'carapa']]),
      ),
    ).toEqual({
      projectId: 'carapa',
      mappingKey: 'cwd:/home/user/projects/carapa',
    });
  });

  test('keeps provider, source, and native project scopes around MEMORY.md', () => {
    const target = targetNativeMemory(
      memory,
      '/groups',
      loadProjectCatalog(['carapa', 'carapa/carapa-board']),
      new Map([['claude-project:-home-user-projects-carapa', 'carapa']]),
    );
    expect(target.destinationPath).toBe(
      '/groups/carapa/.agent/memories/native/claude/sandbox/home-user-projects-carapa/MEMORY.md',
    );
  });

  test('routes unmapped native projects under the main group', () => {
    const target = targetNativeMemory(
      { ...memory, nativeProject: '-unknown-project' },
      '/groups',
      loadProjectCatalog(['main']),
      new Map(),
    );
    expect(target.projectId).toBeNull();
    expect(target.destinationPath).toBe(
      '/groups/main/.agent/memories/unmapped/claude/sandbox/unknown-project/MEMORY.md',
    );
  });

  test('reads Codex content after selecting its file metadata', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-memory-'));
    const memoriesRoot = path.join(home, 'memories');
    const memoryPath = path.join(memoriesRoot, 'MEMORY.md');
    const replacementPath = path.join(home, 'replacement.md');
    await fs.mkdir(memoriesRoot);
    await fs.writeFile(memoryPath, 'cwd: /old\nold memory\n');
    await fs.writeFile(replacementPath, 'cwd: /new\nnew memory\n');

    const stat = fs.stat.bind(fs);
    let replaced = false;
    const statSpy = spyOn(fs, 'stat').mockImplementation((async (
      file: Parameters<typeof fs.stat>[0],
    ) => {
      if (!replaced && file === memoryPath) {
        replaced = true;
        await fs.rename(replacementPath, memoryPath);
      }
      return stat(file);
    }) as typeof fs.stat);

    try {
      const [discovered] = await discoverCodexMemories(home, 'host');
      expect(discovered?.content.toString('utf8')).toBe(
        'cwd: /new\nnew memory\n',
      );
      expect(discovered?.cwd).toBe('/new');
    } finally {
      statSpy.mockRestore();
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
