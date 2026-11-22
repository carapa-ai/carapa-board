import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';

import { initDatabase } from '../../db.js';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { memoryReflectorRuns, projects } from '../../db/schema.js';
import { getGroupDir } from '../../group-dir.js';
import { loadState } from '../../state-manager.js';
import { admitNativeImportForReflection } from './native-import-reflect.js';

const projectId = 'native-reflect-test';
const otherProjectId = 'native-reflect-other';
const quietProjectId = 'native-reflect-quiet';
const now = new Date('2026-11-20T12:00:00Z');
const day = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(now.getTime() - n * day).toISOString();

const transcript = [
  {
    id: 'u1',
    type: 'message',
    role: 'user',
    content:
      'Remember that I prefer short answers when reviewing pull requests.',
  },
  {
    id: 'a1',
    type: 'message',
    role: 'assistant',
    content: 'Understood: short answers for pull request reviews.',
  },
]
  .map((entry) => JSON.stringify(entry))
  .join('\n')
  .concat('\n');

async function writeTranscript(project: string, conversationId: string) {
  const file = path.join(
    getGroupDir(project),
    'transcripts',
    `${conversationId}.jsonl`,
  );
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, transcript);
  return file;
}

const runsFor = async (project: string) =>
  (await drizzleDbRef.current.select().from(memoryReflectorRuns)).filter(
    (row) => row.projectId === project,
  );

const baseInput = (transcriptPath: string, newestMessageAt: string | null) => ({
  projectId,
  objectiveId: null,
  conversationId: 'conv-reflect',
  transcriptPath,
  byteOffset: 0,
  byteEndOffset: Buffer.byteLength(transcript),
  newestMessageAt,
  maxAgeDays: 7,
  now,
});

beforeAll(async () => {
  await initDatabase(':memory:');
  for (const id of [projectId, otherProjectId, quietProjectId]) {
    await drizzleDbRef.current.insert(projects).values({
      id,
      jid: `${id}@board`,
      name: id,
      folder: id,
      trigger: '!',
      added_at: new Date().toISOString(),
      ...(id === quietProjectId
        ? { settings: JSON.stringify({ disableObservations: true }) }
        : {}),
    });
  }
  await loadState();
});

afterAll(async () => {
  for (const id of [projectId, otherProjectId, quietProjectId])
    await fs.rm(getGroupDir(id), { recursive: true, force: true });
});

describe('admitNativeImportForReflection', () => {
  test('a recent import is admitted as a pending live row for its own project', async () => {
    const file = await writeTranscript(projectId, 'conv-reflect');
    const result = await admitNativeImportForReflection(
      baseInput(file, daysAgo(1)),
    );
    expect(result.status).toBe('admitted');
    const rows = await runsFor(projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      mode: 'live',
      status: 'pending',
      projectId,
      byteOffset: 0,
      originConversationId: 'conv-reflect',
      originScopeKnown: 1,
      originObjectiveId: null,
    });
  });

  test('sessions outside the window or without a timestamp are skipped', async () => {
    const file = await writeTranscript(otherProjectId, 'conv-old');
    const input = { ...baseInput(file, daysAgo(8)), projectId: otherProjectId };
    expect(await admitNativeImportForReflection(input)).toEqual({
      status: 'skipped',
      reason: 'too_old',
    });
    expect(
      await admitNativeImportForReflection({ ...input, newestMessageAt: null }),
    ).toEqual({
      status: 'skipped',
      reason: 'no_timestamp',
    });
    expect(await runsFor(otherProjectId)).toHaveLength(0);
  });

  test('refuses a transcript outside the given project directory', async () => {
    const foreign = await writeTranscript(otherProjectId, 'conv-foreign');
    const result = await admitNativeImportForReflection(
      baseInput(foreign, daysAgo(1)),
    );
    expect(result).toEqual({ status: 'skipped', reason: 'not_in_project' });
    expect(await runsFor(projectId)).toHaveLength(1); // only the first test's row
    expect(await runsFor(otherProjectId)).toHaveLength(0);
  });

  test('a project with disableObservations is not admitted', async () => {
    const file = await writeTranscript(quietProjectId, 'conv-quiet');
    const result = await admitNativeImportForReflection({
      ...baseInput(file, daysAgo(1)),
      projectId: quietProjectId,
    });
    expect(result).toEqual({ status: 'skipped', reason: 'not_admitted' });
    expect(await runsFor(quietProjectId)).toHaveLength(0);
  });
});
