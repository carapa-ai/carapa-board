import { Database } from 'bun:sqlite';
import { sha256Hex } from '../../lib/hash.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';

import { isPathInside } from '../../lib/path-containment.js';

type NativeMemoryProvider = 'claude' | 'codex';

export interface NativeMemorySource {
  provider: NativeMemoryProvider;
  sourceLabel: string;
  nativeProject: string;
  cwd: string | null;
  sourcePath: string;
  relativePath: string;
  content: Buffer;
  sourceBirthtime: string;
  sourceMtime: string;
  sourceMode: number;
}

export interface NativeMemoryTarget extends NativeMemorySource {
  projectId: string | null;
  destinationRoot: string;
  destinationPath: string;
  mappingKey: string;
  sha256: string;
}

export function encodeClaudeProject(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function safeSegment(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'unknown';
}

export function loadProjectCatalog(lines: string[]): Map<string, string> {
  const entries = lines.map((line) => line.trim()).filter(Boolean);
  const result = new Map<string, string>();
  for (const entry of entries) {
    const id = entry.split('/').at(-1)!;
    if (entry === id || !result.has(id)) result.set(id, entry);
  }
  return result;
}

export function resolveNativeMemoryProject(
  memory: NativeMemorySource,
  projectMap: Map<string, string>,
): { projectId: string | null; mappingKey: string } {
  const providerKey = `${memory.provider}-project:${memory.nativeProject}`;
  const direct = projectMap.get(providerKey);
  if (direct) return { projectId: direct, mappingKey: providerKey };
  if (memory.cwd) {
    const cwdKey = `cwd:${memory.cwd}`;
    const mapped = projectMap.get(cwdKey);
    if (mapped) return { projectId: mapped, mappingKey: cwdKey };
  }
  if (memory.provider === 'claude') {
    for (const [key, projectId] of projectMap) {
      if (
        key.startsWith('cwd:') &&
        encodeClaudeProject(key.slice(4)) === memory.nativeProject
      ) {
        return { projectId, mappingKey: key };
      }
    }
  }
  return { projectId: null, mappingKey: providerKey };
}

export function targetNativeMemory(
  memory: NativeMemorySource,
  groupsRoot: string,
  projectCatalog: Map<string, string>,
  projectMap: Map<string, string>,
): NativeMemoryTarget {
  const { projectId, mappingKey } = resolveNativeMemoryProject(
    memory,
    projectMap,
  );
  const projectPath = projectId ? projectCatalog.get(projectId) : null;
  if (projectId && !projectPath)
    throw new Error(`Unknown project id "${projectId}" for ${mappingKey}`);
  const origin = path.join(
    safeSegment(memory.provider),
    safeSegment(memory.sourceLabel),
    safeSegment(memory.nativeProject),
  );
  const destinationRoot = projectPath
    ? path.join(groupsRoot, projectPath, '.agent', 'memories', 'native', origin)
    : path.join(groupsRoot, 'main', '.agent', 'memories', 'unmapped', origin);
  const destinationPath = path.join(destinationRoot, memory.relativePath);
  if (!isPathInside(destinationRoot, destinationPath)) {
    throw new Error(`Unsafe native memory path: ${memory.relativePath}`);
  }
  return {
    ...memory,
    projectId,
    destinationRoot,
    destinationPath,
    mappingKey,
    sha256: sha256Hex(memory.content),
  };
}

async function walkFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && !entry.name.startsWith('._'))
        result.push(file);
    }
  }
  await walk(root);
  return result.sort();
}

async function fileMemory(
  provider: NativeMemoryProvider,
  sourceLabel: string,
  nativeProject: string,
  cwd: string | null,
  root: string,
  file: string,
): Promise<NativeMemorySource> {
  const stats = await fs.stat(file);
  return {
    provider,
    sourceLabel,
    nativeProject,
    cwd,
    sourcePath: file,
    relativePath: path.relative(root, file),
    content: await fs.readFile(file),
    sourceBirthtime: stats.birthtime.toISOString(),
    sourceMtime: stats.mtime.toISOString(),
    sourceMode: stats.mode & 0o777,
  };
}

export async function discoverClaudeMemories(
  home: string,
  sourceLabel: string,
): Promise<NativeMemorySource[]> {
  const projectsRoot = path.join(home, 'projects');
  let projects: Dirent[];
  try {
    projects = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: NativeMemorySource[] = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const memoryRoot = path.join(projectsRoot, project.name, 'memory');
    for (const file of await walkFiles(memoryRoot)) {
      result.push(
        await fileMemory(
          'claude',
          sourceLabel,
          project.name,
          null,
          memoryRoot,
          file,
        ),
      );
    }
  }
  return result;
}

function markdownCwd(content: Buffer): string | null {
  const match = content.toString('utf8').match(/^cwd:\s*(.+)$/m);
  return match?.[1]?.trim() || null;
}

export async function discoverCodexMemories(
  home: string,
  sourceLabel: string,
): Promise<NativeMemorySource[]> {
  const result: NativeMemorySource[] = [];
  const memoriesRoot = path.join(home, 'memories');
  for (const file of await walkFiles(memoriesRoot)) {
    const memory = await fileMemory(
      'codex',
      sourceLabel,
      'global-files',
      null,
      memoriesRoot,
      file,
    );
    result.push({ ...memory, cwd: markdownCwd(memory.content) });
  }

  const memoryDbPath = path.join(home, 'memories_1.sqlite');
  const stateDbPath = path.join(home, 'state_5.sqlite');
  try {
    const memoryDb = new Database(memoryDbPath, { readonly: true });
    const rows = memoryDb
      .query(
        `
      SELECT thread_id, source_updated_at, generated_at, raw_memory, rollout_summary
      FROM stage1_outputs
      ORDER BY source_updated_at, thread_id
    `,
      )
      .all() as Array<Record<string, unknown>>;
    memoryDb.close();
    const cwdByThread = new Map<string, string>();
    try {
      const stateDb = new Database(stateDbPath, { readonly: true });
      const threads = stateDb
        .query('SELECT id, cwd FROM threads')
        .all() as Array<{ id: string; cwd: string }>;
      stateDb.close();
      for (const thread of threads) cwdByThread.set(thread.id, thread.cwd);
    } catch {}
    for (const row of rows) {
      const threadId = String(row.thread_id);
      const timestamp = new Date(Number(row.source_updated_at) * 1000);
      for (const [name, value] of [
        ['raw-memory.md', row.raw_memory],
        ['rollout-summary.md', row.rollout_summary],
      ] as const) {
        if (typeof value !== 'string' || !value.trim()) continue;
        result.push({
          provider: 'codex',
          sourceLabel,
          nativeProject: threadId,
          cwd: cwdByThread.get(threadId) || null,
          sourcePath: `${memoryDbPath}#stage1_outputs/${threadId}/${name}`,
          relativePath: name,
          content: Buffer.from(value.endsWith('\n') ? value : `${value}\n`),
          sourceBirthtime: timestamp.toISOString(),
          sourceMtime: timestamp.toISOString(),
          sourceMode: 0o600,
        });
      }
    }
  } catch {}
  return result;
}

export interface NativeMemoryManifestEntry {
  provider: NativeMemoryProvider;
  sourceLabel: string;
  nativeProject: string;
  sourcePath: string;
  relativePath: string;
  sourceBirthtime: string;
  sourceMtime: string;
  sha256: string;
}

export function manifestEntry(
  target: NativeMemoryTarget,
): NativeMemoryManifestEntry {
  return {
    provider: target.provider,
    sourceLabel: target.sourceLabel,
    nativeProject: target.nativeProject,
    sourcePath: target.sourcePath,
    relativePath: target.relativePath,
    sourceBirthtime: target.sourceBirthtime,
    sourceMtime: target.sourceMtime,
    sha256: target.sha256,
  };
}
