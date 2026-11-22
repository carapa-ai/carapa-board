/**
 * Core objective-move workflow: the database move keeps every memory version
 * and sidecar with the objective, its chats and transcripts follow it (also
 * when a later call backfills them), and a refused move changes nothing.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  onTestFinished,
  spyOn,
  test,
} from 'bun:test';
import fs from 'fs';
import path from 'path';
import { eq } from 'drizzle-orm';

import { initDatabase, insertMemory, supersedeMemory } from '../../db.js';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import {
  conversations,
  memories,
  memoryEvidenceCertificates,
  memoryTranscriptEvidence,
} from '../../db/schema.js';
import { chatTranscriptPath, getGroupDir } from '../../group-dir.js';
import {
  getVectorStoreHooks,
  setVectorStoreHooks,
  type VectorStoreHooks,
} from '../vector-store/hooks.js';
import * as stateManager from '../../state-manager.js';
import { truncateTestDb } from '../../test-helpers.js';
import { createObjective, getObjective } from './db-objectives.js';
import { getObjectiveDir } from './objective-folder.js';
import { moveObjective } from './move-objective.js';

const SOURCE = 'move-source';
const TARGET = 'move-target';
const THIRD = 'move-third';
const canWriteProject = () => true;

let initialised = false;
beforeEach(async () => {
  if (!initialised) {
    await initDatabase(':memory:');
    initialised = true;
  }
  await truncateTestDb();
  spyOn(stateManager, 'getGroupByFolder').mockImplementation((folder) =>
    folder === TARGET
      ? {
          jid: 'move-target@g.us',
          name: 'Move target',
          folder: TARGET,
          trigger: 'ai',
          added_at: new Date().toISOString(),
          settings: {},
        }
      : undefined,
  );
});

afterEach(() => {
  mock.restore();
  for (const project of [SOURCE, TARGET, THIRD]) {
    fs.rmSync(getGroupDir(project), { recursive: true, force: true });
  }
});

function objectiveFixture(status: 'paused' | 'active') {
  return createObjective({
    project_id: SOURCE,
    title: 'Evolve',
    description: '',
    status,
    priority: 0,
    progress: 0,
    deadline: null,
    metadata: null,
    trigger_config: null,
    work_dir: '/workspace/group/objectives/placeholder',
  });
}

function createSourceFolder(objectiveId: string): void {
  const dir = getObjectiveDir(SOURCE, objectiveId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), '{"brain":true}');
}

async function rowsOf(objectiveId: string) {
  return drizzleDbRef.current
    .select()
    .from(memories)
    .where(eq(memories.objective_id, objectiveId))
    .orderBy(memories.id);
}

describe('moveObjective', () => {
  test('moves every memory version and its sidecars with the objective', async () => {
    const objective = await objectiveFixture('paused');
    createSourceFolder(objective.id);
    const base = {
      group_folder: SOURCE,
      memory_type: 'task' as const,
      source: 'agent' as const,
      objective_id: objective.id,
    };
    const old = await insertMemory({
      ...base,
      content: 'old fact',
      valid_from: '2026-01-01T00:00:00.000Z',
    });
    const current = await insertMemory({
      ...base,
      content: 'new fact',
      valid_from: '2026-02-01T00:00:00.000Z',
    });
    await supersedeMemory(old.id, current.id, '2026-02-01T00:00:00.000Z');
    const other = await insertMemory({
      ...base,
      content: 'other objective',
      objective_id: 'obj-other',
    });
    await drizzleDbRef.current.insert(memoryTranscriptEvidence).values({
      id: 'evidence-1',
      memoryId: current.id,
      projectId: SOURCE,
      sourceRef: 'chat',
      messageId: 'm1',
      messageCreatedAt: '2026-02-01T00:00:00.000Z',
      excerpt: 'said so',
      createdAt: '2026-02-01T00:00:00.000Z',
    });
    await drizzleDbRef.current.insert(memoryEvidenceCertificates).values({
      id: 'cert-1',
      memory_id: current.id,
      project_id: SOURCE,
      memory_fingerprint: 'fp',
      verdict: 'keep',
      value_justification: 'useful',
      evidence_type: 'human',
      reflector_version: 'v1',
      origin: 'human',
      created_at: '2026-02-01T00:00:00.000Z',
      updated_at: '2026-02-01T00:00:00.000Z',
    });
    const before = await rowsOf(objective.id);

    // The vector store fails once: the first call reports it, and repeating
    // the same request (no source named) finishes the move.
    const previousHooks = getVectorStoreHooks();
    let vectorCalls = 0;
    setVectorStoreHooks({
      isAvailable: () => true,
      moveObjectiveMemoryScope: async () => {
        if (++vectorCalls === 1) throw new Error('neo4j down');
      },
    } as unknown as VectorStoreHooks);
    onTestFinished(() =>
      setVectorStoreHooks(previousHooks as unknown as VectorStoreHooks),
    );

    const result = await moveObjective({
      objectiveId: objective.id,
      sourceProject: SOURCE,
      targetProject: TARGET,
      canWriteProject,
    });

    expect(result).toMatchObject({
      movedMemories: 2,
      vectorStoreUpdated: false,
      folderMoved: true,
      contextUpdated: true,
      notified: 'skipped',
    });
    expect(result.objective).toMatchObject({
      id: objective.id,
      project_id: TARGET,
      work_dir: `/workspace/group/objectives/${objective.id}`,
      move_source_project: SOURCE,
    });
    const targetDir = getObjectiveDir(TARGET, objective.id);
    expect(fs.existsSync(getObjectiveDir(SOURCE, objective.id))).toBe(false);
    expect(fs.readFileSync(path.join(targetDir, 'state.json'), 'utf8')).toBe(
      '{"brain":true}',
    );
    expect(
      fs.readFileSync(
        path.join(targetDir, '.claude', 'rules', 'objective-context.md'),
        'utf8',
      ),
    ).toContain(`- **Project ID**: \`${TARGET}\``);

    const retry = await moveObjective({
      objectiveId: objective.id,
      targetProject: TARGET,
      canWriteProject,
    });
    expect(retry).toMatchObject({ vectorStoreUpdated: true, movedMemories: 2 });
    expect(retry.objective.move_source_project).toBeNull();
    // Repeating the original request (REST names the source) after completion.
    const noop = await moveObjective({
      objectiveId: objective.id,
      sourceProject: SOURCE,
      targetProject: TARGET,
      canWriteProject,
    });
    expect(noop).toMatchObject({ folderMoved: false, movedMemories: 2 });
    expect(vectorCalls).toBe(2);

    const after = await rowsOf(objective.id);
    expect(after.map((row) => row.group_folder)).toEqual([TARGET, TARGET]);
    expect(after.map(({ group_folder: _, ...row }) => row)).toEqual(
      before.map(({ group_folder: _, ...row }) => row),
    );
    expect(
      (
        await drizzleDbRef.current
          .select()
          .from(memoryTranscriptEvidence)
          .where(eq(memoryTranscriptEvidence.memoryId, current.id))
      )[0]?.projectId,
    ).toBe(TARGET);
    expect(
      (
        await drizzleDbRef.current
          .select()
          .from(memoryEvidenceCertificates)
          .where(eq(memoryEvidenceCertificates.memory_id, current.id))
      )[0]?.project_id,
    ).toBe(TARGET);
    expect(
      (
        await drizzleDbRef.current
          .select()
          .from(memories)
          .where(eq(memories.id, other.id))
      )[0]?.group_folder,
    ).toBe(SOURCE);
  });

  test('moves the objective chats with their transcripts, then backfills a leftover', async () => {
    const objective = await objectiveFixture('paused');
    createSourceFolder(objective.id);
    const addChat = async (id: string, objective_id: string | null) => {
      await drizzleDbRef.current.insert(conversations).values({
        id,
        group_folder: SOURCE,
        objective_id,
        created_at: '2026-10-01T00:00:00.000Z',
      });
      const live = chatTranscriptPath(SOURCE, undefined, id);
      fs.mkdirSync(path.dirname(live), { recursive: true });
      fs.writeFileSync(live, `{"role":"user","content":"hello ${id}"}\n`);
      fs.writeFileSync(`${live}.transcript-index.json`, '{}');
    };
    const projectOf = async (id: string) =>
      (
        await drizzleDbRef.current
          .select()
          .from(conversations)
          .where(eq(conversations.id, id))
      )[0]?.group_folder;
    await addChat('conv-1790000000001-chat1', objective.id);
    await addChat('conv-1790000000002-plain', null);

    const result = await moveObjective({
      objectiveId: objective.id,
      sourceProject: SOURCE,
      targetProject: TARGET,
      canWriteProject,
    });
    expect(result).toMatchObject({
      movedConversations: 1,
      skippedTranscripts: 0,
      conversationStepComplete: true,
    });
    expect(result.objective.move_source_project).toBeNull();
    const moved = chatTranscriptPath(
      TARGET,
      undefined,
      'conv-1790000000001-chat1',
    );
    expect(fs.readFileSync(moved, 'utf8')).toContain(
      'hello conv-1790000000001',
    );
    expect(fs.existsSync(`${moved}.transcript-index.json`)).toBe(true);
    expect(
      fs.existsSync(
        chatTranscriptPath(SOURCE, undefined, 'conv-1790000000001-chat1'),
      ),
    ).toBe(false);
    expect(await projectOf('conv-1790000000001-chat1')).toBe(TARGET);
    expect(await projectOf('conv-1790000000002-plain')).toBe(SOURCE);

    // A chat an earlier move left behind: the caller needs write access to its project.
    await addChat('conv-1790000000003-late', objective.id);
    await expect(
      moveObjective({
        objectiveId: objective.id,
        targetProject: TARGET,
        canWriteProject: () => false,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await projectOf('conv-1790000000003-late')).toBe(SOURCE);

    const backfill = await moveObjective({
      objectiveId: objective.id,
      targetProject: TARGET,
      canWriteProject,
    });
    expect(backfill).toMatchObject({
      movedConversations: 1,
      conversationStepComplete: true,
      folderMoved: false,
    });
    expect(await projectOf('conv-1790000000003-late')).toBe(TARGET);
    expect(
      fs.existsSync(
        chatTranscriptPath(TARGET, undefined, 'conv-1790000000003-late'),
      ),
    ).toBe(true);
    expect(
      await moveObjective({
        objectiveId: objective.id,
        targetProject: TARGET,
        canWriteProject,
      }),
    ).toMatchObject({ movedConversations: 0, conversationStepComplete: true });
  });

  test('refuses an active objective and leaves the data unchanged', async () => {
    const objective = await objectiveFixture('active');
    createSourceFolder(objective.id);
    const memory = await insertMemory({
      group_folder: SOURCE,
      memory_type: 'task',
      source: 'agent',
      content: 'fact',
      objective_id: objective.id,
    });

    await expect(
      moveObjective({
        objectiveId: objective.id,
        sourceProject: SOURCE,
        targetProject: TARGET,
        canWriteProject,
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect((await getObjective(objective.id))?.project_id).toBe(SOURCE);
    expect((await rowsOf(objective.id))[0]?.group_folder).toBe(SOURCE);
    expect((await rowsOf(objective.id))[0]?.id).toBe(memory.id);
    expect(fs.existsSync(getObjectiveDir(SOURCE, objective.id))).toBe(true);
    expect(fs.existsSync(getObjectiveDir(TARGET, objective.id))).toBe(false);
  });

  test('refuses a target whose objectives dir is a symlink to a third project', async () => {
    const objective = await objectiveFixture('paused');
    createSourceFolder(objective.id);
    const thirdObjectives = path.join(getGroupDir(THIRD), 'objectives');
    fs.mkdirSync(thirdObjectives, { recursive: true });
    fs.mkdirSync(getGroupDir(TARGET), { recursive: true });
    fs.symlinkSync(
      thirdObjectives,
      path.join(getGroupDir(TARGET), 'objectives'),
    );

    await expect(
      moveObjective({
        objectiveId: objective.id,
        sourceProject: SOURCE,
        targetProject: TARGET,
        canWriteProject,
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect(fs.readdirSync(thirdObjectives)).toEqual([]);
    expect(fs.existsSync(getObjectiveDir(SOURCE, objective.id))).toBe(true);
    expect((await getObjective(objective.id))?.project_id).toBe(SOURCE);
  });
});
