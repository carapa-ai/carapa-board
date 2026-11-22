import { beforeAll, describe, expect, test } from 'bun:test';
import { initDatabase } from '../../db.js';
import { truncateTestDb } from '../../test-helpers.js';
import {
  beginReflectorOperation,
  claimReflectorRun,
  checkpointReflectorRun,
  ensureReflectorRun,
  failReflectorRun,
  failedReflectorRunsForSource,
  getReflectorRun,
  releaseReflectorLeases,
  retireReflectorRun,
  resumeReflectorRun,
} from './reflector-state.js';

describe('tool reflector durable progress', () => {
  beforeAll(async () => {
    await initDatabase(':memory:');
    await truncateTestDb();
  });

  test('retains completed chunks and reuses per-operation receipts after failure', async () => {
    const input = {
      id: 'mrr-resume-test',
      projectId: 'reflector-progress-project',
      transcriptPath: 'transcripts/chat-resume.output.jsonl',
      transcriptFingerprint: 'fingerprint',
      byteOffset: 0,
      profile: 'direct-llm-conversation',
      mode: 'live' as const,
      totalChunks: 2,
    };
    await ensureReflectorRun(input);
    await claimReflectorRun(input.id, 'lease-resume');
    await checkpointReflectorRun(input.id, 'lease-resume', 1, 2);
    await failReflectorRun(input.id, 'lease-resume', 'provider unavailable');

    const resumed = await ensureReflectorRun(input);
    expect(resumed?.nextChunkIndex).toBe(1);
    expect(resumed?.status).toBe('error');

    const operation = {
      runId: input.id,
      operationKey: 'chunk-0:message-1-fact',
      requestFingerprint: 'request-fingerprint',
      operation: 'create',
      resultMemoryId: 'mem-ref-resume',
    };
    const first = await beginReflectorOperation(operation);
    const retry = await beginReflectorOperation(operation);
    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.receipt.id).toBe(first.receipt.id);
    expect(retry.receipt.requestFingerprint).toBe('request-fingerprint');
  });

  test('preserves a failed run identity when its transcript is appended', async () => {
    const input = {
      id: 'mrr-appended-resume-test',
      projectId: 'reflector-progress-project',
      transcriptPath: 'transcripts/chat-appended.output.jsonl',
      transcriptFingerprint: '100:old-prefix-hash',
      byteOffset: 20,
      profile: 'direct-llm-conversation',
      mode: 'live' as const,
      totalChunks: 2,
    };
    await ensureReflectorRun(input);
    await claimReflectorRun(input.id, 'lease-appended');
    await checkpointReflectorRun(input.id, 'lease-appended', 1, 2);
    await failReflectorRun(input.id, 'lease-appended', 'provider unavailable');

    const failed = await failedReflectorRunsForSource({
      projectId: input.projectId,
      transcriptPath: input.transcriptPath,
      profile: input.profile,
      byteOffset: input.byteOffset,
    });
    const resumed = await resumeReflectorRun(
      failed[0]!.id,
      '150:new-transcript-hash',
      3,
    );

    expect(resumed?.id).toBe(input.id);
    expect(resumed?.nextChunkIndex).toBe(1);
    expect(resumed?.totalChunks).toBe(3);
    expect(resumed?.transcriptFingerprint).toBe('150:new-transcript-hash');
    expect(resumed?.status).toBe('pending');
  });

  test('serializes run ownership and rejects stale terminal transitions', async () => {
    const input = {
      id: 'mrr-lease-test',
      projectId: 'reflector-progress-project',
      transcriptPath: 'transcripts/chat-lease.output.jsonl',
      transcriptFingerprint: 'lease-fingerprint',
      byteOffset: 0,
      profile: 'direct-llm-conversation',
      mode: 'live' as const,
      totalChunks: 1,
    };
    await ensureReflectorRun(input);
    expect(await claimReflectorRun(input.id, 'lease-owner')).toBeDefined();
    expect(await claimReflectorRun(input.id, 'lease-racer')).toBeUndefined();
    expect(await checkpointReflectorRun(input.id, 'lease-owner', 1, 1)).toBe(
      true,
    );
    expect(
      await failReflectorRun(input.id, 'lease-racer', 'late failure'),
    ).toBe(false);

    const completed = await ensureReflectorRun(input);
    expect(completed?.status).toBe('completed');
    expect(completed?.nextChunkIndex).toBe(1);
  });

  test('reclaims an expired processing run when its transcript was appended', async () => {
    const input = {
      id: 'mrr-expired-append-test',
      projectId: 'reflector-progress-project',
      transcriptPath: 'transcripts/chat-expired.output.jsonl',
      transcriptFingerprint: '100:expired-prefix',
      byteOffset: 0,
      profile: 'run-agent-conversation',
      mode: 'live' as const,
      totalChunks: 1,
    };
    await ensureReflectorRun(input);
    await claimReflectorRun(input.id, 'expired-owner', {
      now: new Date('2020-01-01T00:00:00.000Z'),
      leaseMs: 1,
    });

    const resumed = await resumeReflectorRun(
      input.id,
      '200:appended-transcript',
      2,
    );
    expect(resumed).toMatchObject({
      status: 'pending',
      transcriptFingerprint: '200:appended-transcript',
      totalChunks: 2,
      nextChunkIndex: 0,
    });
  });

  test('releases only runs processing under the listed lease tokens', async () => {
    const base = {
      projectId: 'reflector-release-project',
      transcriptFingerprint: 'release-fingerprint',
      byteOffset: 0,
      profile: 'direct-llm-conversation',
      mode: 'live' as const,
      totalChunks: 2,
    };
    const ids = ['mrr-release-own', 'mrr-release-foreign', 'mrr-release-done'];
    for (const id of ids) {
      await ensureReflectorRun({
        ...base,
        id,
        transcriptPath: `transcripts/${id}.output.jsonl`,
      });
    }
    await claimReflectorRun(ids[0]!, 'own-token');
    await checkpointReflectorRun(ids[0]!, 'own-token', 1, 2);
    await claimReflectorRun(ids[1]!, 'foreign-token');
    await claimReflectorRun(ids[2]!, 'own-token-done');
    await checkpointReflectorRun(ids[2]!, 'own-token-done', 2, 2);

    expect(await releaseReflectorLeases([])).toBe(0);
    expect((await getReflectorRun(ids[0]!))?.status).toBe('processing');

    expect(await releaseReflectorLeases(['own-token', 'own-token-done'])).toBe(
      1,
    );
    expect(await getReflectorRun(ids[0]!)).toMatchObject({
      status: 'pending',
      leaseToken: null,
      leaseExpiresAt: null,
      nextChunkIndex: 1,
    });
    expect(await getReflectorRun(ids[1]!)).toMatchObject({
      status: 'processing',
      leaseToken: 'foreign-token',
    });
    expect((await getReflectorRun(ids[2]!))?.status).toBe('completed');

    // The released run is claimable by a new owner without waiting for expiry.
    expect(await claimReflectorRun(ids[0]!, 'new-process-token')).toBeDefined();
  });

  test('retireReflectorRun defaults its reason and stores a supplied one', async () => {
    const base = {
      projectId: 'reflector-retire-project',
      transcriptFingerprint: 'fingerprint',
      byteOffset: 0,
      profile: 'direct-llm-conversation',
      mode: 'live' as const,
      totalChunks: 1,
    };
    await ensureReflectorRun({
      ...base,
      id: 'mrr-retire-default',
      transcriptPath: 'transcripts/retire-default.jsonl',
    });
    await ensureReflectorRun({
      ...base,
      id: 'mrr-retire-reason',
      transcriptPath: 'transcripts/retire-reason.jsonl',
    });
    expect(await retireReflectorRun('mrr-retire-default')).toBe(true);
    expect(
      await retireReflectorRun('mrr-retire-reason', 'source_unavailable: x'),
    ).toBe(true);
    const defaulted = await getReflectorRun('mrr-retire-default');
    const reasoned = await getReflectorRun('mrr-retire-reason');
    expect(defaulted?.status).toBe('retired');
    expect(defaulted?.error).toBe('Retired propagation run');
    expect(reasoned?.error).toBe('source_unavailable: x');
  });
});
