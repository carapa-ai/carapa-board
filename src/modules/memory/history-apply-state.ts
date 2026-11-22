import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { memoryHistoryApplyOperations } from '../../db/schema.js';
import {
  historyOpTargetId,
  type HistoryMemoryOp,
} from './history-reflector-core.js';
import type { Memory } from './types.js';

export type HistoryApplyReceipt =
  typeof memoryHistoryApplyOperations.$inferSelect;

export function operationFingerprint(operation: HistoryMemoryOp): string {
  return createHash('sha256')
    .update(JSON.stringify(operation))
    .digest('base64url');
}

export async function getHistoryApplyReceipts(
  manifestId: string,
): Promise<HistoryApplyReceipt[]> {
  return drizzleDbRef.current
    .select()
    .from(memoryHistoryApplyOperations)
    .where(eq(memoryHistoryApplyOperations.manifestId, manifestId));
}

export async function prepareHistoryApplyReceipts(
  manifestId: string,
  projectId: string,
  operations: HistoryMemoryOp[],
  timeline: Memory[],
): Promise<HistoryApplyReceipt[]> {
  const byId = new Map(timeline.map((memory) => [memory.id, memory]));
  const now = new Date().toISOString();
  await drizzleDbRef.current.transaction(async (tx: any) => {
    for (const [operationIndex, operation] of operations.entries()) {
      const targetId = historyOpTargetId(operation);
      await tx
        .insert(memoryHistoryApplyOperations)
        .values({
          id: `mhap-${createHash('sha256')
            .update(`${manifestId}\0${operationIndex}`)
            .digest('base64url')
            .slice(0, 32)}`,
          manifestId,
          projectId,
          operationIndex,
          requestFingerprint: operationFingerprint(operation),
          expectedTargetVersion: targetId
            ? (byId.get(targetId)?.updated_at ?? null)
            : null,
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
    }
  });
  const receipts = await getHistoryApplyReceipts(manifestId);
  if (receipts.length !== operations.length) {
    throw new Error('History apply progress is incomplete; retry the review');
  }
  const byIndex = new Map(
    receipts.map((receipt) => [receipt.operationIndex, receipt]),
  );
  return operations.map((operation, index) => {
    const receipt = byIndex.get(index);
    if (
      !receipt ||
      receipt.projectId !== projectId ||
      receipt.requestFingerprint !== operationFingerprint(operation)
    ) {
      throw new Error('History apply progress does not match this review');
    }
    return receipt;
  });
}

export async function checkpointHistoryApplyReceipt(
  id: string,
  status: 'pending' | 'completed',
  baselineFingerprint: string,
): Promise<void> {
  await drizzleDbRef.current
    .update(memoryHistoryApplyOperations)
    .set({
      status,
      baselineFingerprint,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(memoryHistoryApplyOperations.id, id));
}
