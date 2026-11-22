import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { eq } from 'drizzle-orm';

import { initDatabase } from '../../db.js';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import {
  applyImportedConversationUpdate,
  getExternalRunCostsForConversation,
  getImportedConversationState,
} from '../../db/external-run-costs.js';
import { conversations, externalRunCosts, projects } from '../../db/schema.js';
import { getGroupDir } from '../../group-dir.js';
import {
  applyNativeConversationImport,
  nativeImportTranscriptPath,
} from './native-import-apply.js';
import {
  compareNativeImport,
  updateNativeImport,
  type NativeImportUpdateInput,
} from './native-import-update.js';
import { nativeSessionToCarapaRunV1 } from './native-run-v1.js';
import {
  nativeV1ExternalRunRows,
  projectNativeV1TranscriptEntries,
} from './native-v1-import.js';

const projectId = 'native-import-update-test';

function nativeSession(sessionId: string, turnCount: number, cost = 0.5) {
  const messages: Record<string, unknown>[] = [];
  const turns = [];
  for (let n = 1; n <= turnCount; n++) {
    const at = (second: number) =>
      `2026-09-01T10:${String(n).padStart(2, '0')}:${String(second).padStart(2, '0')}Z`;
    messages.push(
      {
        id: `u${n}`,
        type: 'message',
        role: 'user',
        content: `Question ${n}`,
        created_at: at(0),
        external_turn_id: `turn-${n}`,
      },
      {
        id: `a${n}`,
        type: 'message',
        role: 'assistant',
        content: `Answer ${n}`,
        created_at: at(1),
        external_turn_id: `turn-${n}`,
      },
    );
    turns.push({
      turnId: `turn-${n}`,
      startedAt: at(0),
      completedAt: at(1),
      modelName: 'claude-test',
      telemetry: {
        tok_input: 100 * n,
        tok_output: 10 * n,
        cost_usd: cost * n,
      },
    });
  }
  return {
    sessionId,
    source: 'claude',
    createdAt: '2026-09-01T10:00:00Z',
    messages,
    turns,
  };
}

function updateInput(
  conversationId: string,
  session: ReturnType<typeof nativeSession>,
): NativeImportUpdateInput {
  return {
    conversationId,
    v1Runs: nativeSessionToCarapaRunV1(session),
    native: {
      lastUserAt: session.messages.filter((m) => m.role === 'user').at(-1)!
        .created_at as string,
      lastAssistantAt: session.messages
        .filter((m) => m.role === 'assistant')
        .at(-1)!.created_at as string,
      preview: 'Question 1',
    },
  };
}

/** Import `session` the way the script's create path does. */
async function importSession(
  conversationId: string,
  session: ReturnType<typeof nativeSession>,
) {
  const input = updateInput(conversationId, session);
  const transcriptEntries = projectNativeV1TranscriptEntries(
    input.v1Runs,
    conversationId,
  );
  const result = await applyNativeConversationImport({
    projectId,
    conversationId,
    v1Runs: input.v1Runs,
    transcriptEntries,
    conversation: {
      id: conversationId,
      group_folder: projectId,
      preview: input.native.preview,
      title: 'Imported title',
      created_at: session.createdAt,
      read_at: '2026-09-01T10:00:01Z',
      pinned: 0,
      last_user_at: input.native.lastUserAt,
      last_assistant_at: input.native.lastAssistantAt,
    },
    runRows: nativeV1ExternalRunRows(input.v1Runs, projectId, conversationId),
  });
  expect(result.status).toBe('imported');
  return nativeImportTranscriptPath(projectId, null, conversationId);
}

const sha = (data: string | Buffer) =>
  createHash('sha256').update(data).digest('hex');

async function checksums(conversationId: string, transcriptPath: string) {
  const read = (file: string) => fs.readFile(file).catch(() => Buffer.alloc(0));
  const [conversation] = await drizzleDbRef.current
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  const costs = await drizzleDbRef.current
    .select()
    .from(externalRunCosts)
    .where(eq(externalRunCosts.conversation_id, conversationId));
  return {
    transcript: sha(await read(transcriptPath)),
    index: sha(await read(`${transcriptPath}.transcript-index.json`)),
    conversation: sha(JSON.stringify(conversation)),
    costs: sha(JSON.stringify(costs.sort((a, b) => a.id.localeCompare(b.id)))),
    v1: (await fs.readdir(`${getGroupDir(projectId)}/session-transcripts`))
      .sort()
      .join(','),
  };
}

beforeAll(async () => {
  await initDatabase(':memory:');
  await drizzleDbRef.current.insert(projects).values({
    id: projectId,
    jid: `${projectId}@board`,
    name: projectId,
    folder: projectId,
    trigger: '!',
    added_at: new Date().toISOString(),
  });
});

afterAll(async () => {
  await fs.rm(getGroupDir(projectId), { recursive: true, force: true });
});

describe('native import explain comparison and update', () => {
  test('a partial import is explained, completed by --update, and then idempotent', async () => {
    const conversationId = 'conv-claude-partial';
    const full = nativeSession('partial', 4);
    const transcriptPath = await importSession(
      conversationId,
      nativeSession('partial', 2),
    );

    const comparison = await compareNativeImport(
      updateInput(conversationId, full),
    );
    expect(comparison.status).toBe('partial');
    expect(comparison.missingTurns.transcript).toEqual(['turn-3', 'turn-4']);
    expect(comparison.missingTurns.runCosts).toEqual(['turn-3', 'turn-4']);
    expect(comparison.transcript.turns).toEqual({ native: 4, stored: 2 });
    expect(comparison.transcript.messages).toEqual({ native: 8, stored: 4 });

    const dryRun = await updateNativeImport(updateInput(conversationId, full), {
      apply: false,
    });
    expect(dryRun.status).toBe('updated');
    expect(dryRun).not.toHaveProperty('appendedRange');

    const sizeBefore = (await fs.stat(transcriptPath)).size;
    const applied = await updateNativeImport(
      updateInput(conversationId, full),
      { apply: true },
    );
    expect(applied.status).toBe('updated');
    const range = (
      applied as {
        appendedRange?: { byteOffset: number; byteEndOffset: number };
      }
    ).appendedRange;
    expect(range?.byteOffset).toBeGreaterThan(0);
    expect(range?.byteOffset).toBe(sizeBefore);
    const bytes = await fs.readFile(transcriptPath);
    expect(range?.byteEndOffset).toBe(bytes.length);
    const appendedFirstLine = projectNativeV1TranscriptEntries(
      nativeSessionToCarapaRunV1(full),
      conversationId,
    )
      .map((entry) => JSON.stringify(entry))
      .find((line) =>
        bytes.subarray(range!.byteOffset).toString('utf8').startsWith(line),
      );
    expect(appendedFirstLine).toBeDefined();

    const index = JSON.parse(
      await fs.readFile(`${transcriptPath}.transcript-index.json`, 'utf8'),
    ).records as Record<string, string[]>;
    const expectedIds = projectNativeV1TranscriptEntries(
      nativeSessionToCarapaRunV1(full),
      conversationId,
    ).map((entry) => String(entry.id));
    for (const id of expectedIds) expect(index[id]).toBeDefined();
    expect(
      (await getExternalRunCostsForConversation(conversationId)).length,
    ).toBe(4);
    expect(
      await compareNativeImport(updateInput(conversationId, full)),
    ).toMatchObject({ status: 'complete', reasons: [] });

    const before = await checksums(conversationId, transcriptPath);
    const again = await updateNativeImport(updateInput(conversationId, full), {
      apply: true,
    });
    expect(again.status).toBe('unchanged');
    expect(again).not.toHaveProperty('appendedRange');
    expect(await checksums(conversationId, transcriptPath)).toEqual(before);
  });

  test('a transcript with a Board-authored line is refused and left byte-identical', async () => {
    const conversationId = 'conv-claude-continued';
    const session = nativeSession('continued', 2);
    const transcriptPath = await importSession(conversationId, session);
    await fs.appendFile(
      transcriptPath,
      `${JSON.stringify({ id: 'board-1', type: 'message', role: 'user', content: 'Follow-up in the Board' })}\n`,
    );
    const before = await checksums(conversationId, transcriptPath);

    const result = await updateNativeImport(
      updateInput(conversationId, nativeSession('continued', 3)),
      { apply: true },
    );
    expect(result.status).toBe('refused');
    expect(
      (await compareNativeImport(updateInput(conversationId, session))).status,
    ).toBe('diverged');
    expect(await checksums(conversationId, transcriptPath)).toEqual(before);
  });

  test('a wrong stored cost is corrected and equal turns are not rewritten', async () => {
    const conversationId = 'conv-claude-cost';
    const session = nativeSession('cost', 3);
    await importSession(conversationId, session);
    const [row] = (
      await getExternalRunCostsForConversation(conversationId)
    ).filter((r) => r.external_turn_id === 'turn-2');
    await drizzleDbRef.current
      .update(externalRunCosts)
      .set({ cost_usd: 99, tok_input: 1 })
      .where(eq(externalRunCosts.id, row.id));

    const result = await updateNativeImport(
      updateInput(conversationId, session),
      { apply: true },
    );
    expect(result).toMatchObject({
      status: 'updated',
      changes: { runCostsInserted: [], runCostsCorrected: ['turn-2'] },
    });
    const stored = await getExternalRunCostsForConversation(conversationId);
    const turn2 = stored.find((r) => r.external_turn_id === 'turn-2')!;
    expect(turn2.cost_usd).toBeCloseTo(1, 5);
    expect(turn2.tok_input).toBe(200);
    expect(
      (
        await updateNativeImport(updateInput(conversationId, session), {
          apply: true,
        })
      ).status,
    ).toBe('unchanged');
  });

  test('user-owned conversation state is preserved; dry run writes nothing', async () => {
    const conversationId = 'conv-claude-preserve';
    const transcriptPath = await importSession(
      conversationId,
      nativeSession('preserve', 1),
    );
    await drizzleDbRef.current
      .update(conversations)
      .set({ read_at: '2026-12-01T00:00:00Z', pinned: 1, title: 'My title' })
      .where(eq(conversations.id, conversationId));
    const grown = nativeSession('preserve', 3);

    const before = await checksums(conversationId, transcriptPath);
    const dryRun = await updateNativeImport(
      updateInput(conversationId, grown),
      { apply: false },
    );
    expect(dryRun.status).toBe('updated');
    expect(await checksums(conversationId, transcriptPath)).toEqual(before);

    await updateNativeImport(updateInput(conversationId, grown), {
      apply: true,
    });
    const [row] = await drizzleDbRef.current
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(row).toMatchObject({
      read_at: '2026-12-01T00:00:00Z',
      pinned: 1,
      title: 'My title',
      group_folder: projectId,
      last_assistant_at: '2026-09-01T10:03:01Z',
      last_user_at: '2026-09-01T10:03:00Z',
    });
    expect(await getImportedConversationState(conversationId)).toBeTruthy();
  });

  test('--update keeps a fully read import read and leaves an unread one unread', async () => {
    const readSession = nativeSession('read-advance', 1);
    await importSession('conv-claude-read', readSession);
    await drizzleDbRef.current
      .update(conversations)
      .set({ read_at: '2026-09-01T10:01:01Z' })
      .where(eq(conversations.id, 'conv-claude-read'));
    // importSession leaves read_at (10:00:01Z) before last_assistant_at.
    await importSession(
      'conv-claude-unread',
      nativeSession('unread-advance', 1),
    );
    const grown = (id: string) => nativeSession(id, 3);

    const dryRun = await updateNativeImport(
      updateInput('conv-claude-read', grown('read-advance')),
      { apply: false },
    );
    expect(dryRun).toMatchObject({
      status: 'updated',
      changes: { conversationColumns: expect.arrayContaining(['read_at']) },
    });
    expect(
      await updateNativeImport(
        updateInput('conv-claude-unread', grown('unread-advance')),
        { apply: false },
      ),
    ).toMatchObject({
      changes: { conversationColumns: expect.not.arrayContaining(['read_at']) },
    });

    for (const [conversationId, sessionId] of [
      ['conv-claude-read', 'read-advance'],
      ['conv-claude-unread', 'unread-advance'],
    ]) {
      await updateNativeImport(updateInput(conversationId, grown(sessionId)), {
        apply: true,
      });
    }
    const readAt = async (id: string) =>
      (
        await drizzleDbRef.current
          .select({ read_at: conversations.read_at })
          .from(conversations)
          .where(eq(conversations.id, id))
      )[0]?.read_at;
    expect(await readAt('conv-claude-read')).toBe('2026-09-01T10:03:01Z');
    expect(await readAt('conv-claude-unread')).toBe('2026-09-01T10:00:01Z');

    // A read that lands between planning and the write is not overwritten by
    // the older planned value.
    await drizzleDbRef.current
      .update(conversations)
      .set({ read_at: '2026-09-02T00:00:00.000Z' })
      .where(eq(conversations.id, 'conv-claude-read'));
    await applyImportedConversationUpdate('conv-claude-read', {
      conversationPatch: { read_at: '2026-09-01T10:03:01Z' },
      insertRuns: [],
      updateRuns: [],
    });
    expect(await readAt('conv-claude-read')).toBe('2026-09-02T00:00:00.000Z');
  });
});
