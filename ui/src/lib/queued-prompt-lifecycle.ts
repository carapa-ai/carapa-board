import type { QueuedPrompt } from '@/store';

/** Browser-owned prompts and confirmed persona-boundary queues can be changed
 * by the composer. Legacy server receipts remain immutable until the backend
 * classifies their ownership from the canonical transcript. */
export function isMutableQueuedPrompt(prompt: QueuedPrompt): boolean {
  return !prompt.serverOwned || prompt.serverQueueOwner === 'persona';
}

/** A pending Direct follow-up can only be withdrawn: the server hides its
 * canonical row, but editing or steering it is not supported. */
export function isDeletableQueuedPrompt(prompt: QueuedPrompt): boolean {
  return isMutableQueuedPrompt(prompt) || prompt.serverQueueOwner === 'direct';
}

/** A Direct follow-up is created with its canonical transcript row already
 * present, so the row cannot be used as proof that the transcript owns the
 * prompt. Until the server consumes it, the queue entry stays visible as the
 * only place that can withdraw it. */
export function isPendingDirectQueuedPrompt(prompt: QueuedPrompt): boolean {
  return (
    prompt.serverOwned === true &&
    prompt.serverQueueOwner === 'direct' &&
    !prompt.consumedByServer
  );
}

/** Restore a failed in-flight browser batch without duplicating prompts that
 * another observer already returned to the queue. Failed work stays ahead of
 * prompts submitted later while the request was in flight. */
export function restoreFailedQueuedPromptBatch(
  current: QueuedPrompt[],
  batch: QueuedPrompt[],
): QueuedPrompt[] {
  const currentIds = new Set(
    current.flatMap((prompt) => (prompt.id ? [prompt.id] : [])),
  );
  const missing = batch.filter((prompt) =>
    prompt.id ? !currentIds.has(prompt.id) : !current.includes(prompt),
  );
  return [...missing, ...current];
}

/** Permanently discard an in-flight browser batch after the target
 * conversation is confirmed to no longer exist. */
export function discardQueuedPromptBatch(
  current: QueuedPrompt[],
  batch: QueuedPrompt[],
): QueuedPrompt[] {
  const ids = new Set(
    batch.flatMap((prompt) => (prompt.id ? [prompt.id] : [])),
  );
  const idlessBatch = batch.filter((prompt) => !prompt.id);
  return current.filter((prompt) => {
    if (prompt.id) return !ids.has(prompt.id);
    if (batch.includes(prompt)) return false;
    if (!prompt.awaitingAcknowledgement) return true;
    return !idlessBatch.some((candidate) =>
      Object.entries(candidate).every(
        ([key, value]) =>
          key === 'awaitingAcknowledgement' ||
          prompt[key as keyof QueuedPrompt] === value,
      ),
    );
  });
}

/** A 404 from a send route is only a stale conversation when the backend
 * names the conversation. "Objective not found" and "Project not found" are
 * different failures and must not discard prompts or clear the selection. */
export function isConversationNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { status?: number }).status === 404 &&
    error.message === 'Conversation not found'
  );
}

export function missingConversationPromptNotice(queuedCount?: number): string {
  if (queuedCount === undefined) {
    return 'Message not sent: the conversation no longer exists.';
  }
  return `Removed ${queuedCount} queued message${queuedCount === 1 ? '' : 's'}: the conversation no longer exists.`;
}

/** Finish the provisional HTTP handoff and make the exact browser batch
 * eligible for completion-driven draining. */
export function releaseQueuedPromptBatchForDrain(
  current: QueuedPrompt[],
  batch: QueuedPrompt[],
): QueuedPrompt[] {
  const released = batch.map(
    ({ awaitingAcknowledgement: _, ...prompt }) => prompt,
  );
  const releasedIds = new Set(
    released.flatMap((prompt) => (prompt.id ? [prompt.id] : [])),
  );
  const withoutProvisionalCopies = current.filter((prompt) =>
    prompt.id ? !releasedIds.has(prompt.id) : !batch.includes(prompt),
  );
  return restoreFailedQueuedPromptBatch(withoutProvisionalCopies, released);
}

/** Reserve a browser batch for one in-flight drain without removing its
 * visible ownership record before the backend acknowledgement arrives. */
export function markQueuedPromptBatchAwaitingAcknowledgement(
  current: QueuedPrompt[],
  batch: QueuedPrompt[],
): QueuedPrompt[] {
  const ids = new Set(
    batch.flatMap((prompt) => (prompt.id ? [prompt.id] : [])),
  );
  return current.map((prompt) => {
    const belongsToBatch = prompt.id
      ? ids.has(prompt.id)
      : batch.includes(prompt);
    return belongsToBatch
      ? { ...prompt, awaitingAcknowledgement: true }
      : prompt;
  });
}

/** Remove a batch after the backend has acknowledged durable/canonical
 * ownership, without depending on a WebSocket chat_message acknowledgement. */
export function removeAcknowledgedQueuedPromptBatch(
  current: QueuedPrompt[],
  batch: QueuedPrompt[],
): QueuedPrompt[] {
  const ids = new Set(
    batch.flatMap((prompt) => (prompt.id ? [prompt.id] : [])),
  );
  return current.filter((prompt) =>
    prompt.id ? !ids.has(prompt.id) : !batch.includes(prompt),
  );
}

/** Apply durable queue receipts without retiring the final visible owner before
 * its canonical transcript row can take over. */
export function reconcileQueuedPromptReceipts(
  current: QueuedPrompt[],
  receipts: {
    consumed: Iterable<string>;
    released: Iterable<string>;
    withdrawn?: Iterable<string>;
    queueOwners?: Readonly<Record<string, 'persona' | 'direct'>>;
  },
): QueuedPrompt[] {
  const consumed = new Set(receipts.consumed);
  const released = new Set(receipts.released);
  const withdrawn = new Set(receipts.withdrawn);
  let changed = false;
  const reconciled = current.flatMap((prompt) => {
    if (prompt.id && withdrawn.has(prompt.id)) {
      changed = true;
      return [];
    }
    if (prompt.id && consumed.has(prompt.id)) {
      if (
        prompt.consumedByServer &&
        prompt.serverOwned &&
        !prompt.serverReleased &&
        !prompt.awaitingAcknowledgement
      ) {
        return [prompt];
      }
      changed = true;
      const {
        awaitingAcknowledgement: _,
        serverReleased: _serverReleased,
        serverOwned: _serverOwned,
        ...consumedPrompt
      } = prompt;
      return [
        {
          ...consumedPrompt,
          serverOwned: true,
          serverQueueOwner: prompt.serverQueueOwner ?? 'server',
          consumedByServer: true,
        },
      ];
    }
    if (!prompt.id || !released.has(prompt.id) || prompt.consumedByServer) {
      if (
        prompt.id &&
        prompt.serverOwned &&
        !prompt.serverQueueOwner &&
        receipts.queueOwners
      ) {
        changed = true;
        return [
          {
            ...prompt,
            serverQueueOwner: receipts.queueOwners[prompt.id] ?? 'server',
          },
        ];
      }
      return [prompt];
    }
    changed = true;
    const {
      awaitingAcknowledgement: _,
      serverOwned: _serverOwned,
      ...releasedPrompt
    } = prompt;
    return [{ ...releasedPrompt, serverReleased: true }];
  });
  return changed ? reconciled : current;
}

/** Transfer a browser-owned batch to one durable server-owned mirror without
 * leaving any of the original prompts eligible for completion draining. */
export function replaceQueuedPromptBatchWithServerOwned(
  current: QueuedPrompt[],
  batch: QueuedPrompt[],
  replacement: QueuedPrompt,
  preserveReleasedBrowserOwner = true,
): QueuedPrompt[] {
  const ids = new Set(
    batch.flatMap((prompt) => (prompt.id ? [prompt.id] : [])),
  );
  const result: QueuedPrompt[] = [];
  let inserted = false;
  for (const prompt of current) {
    const belongsToBatch = prompt.id
      ? ids.has(prompt.id)
      : batch.includes(prompt);
    if (belongsToBatch) {
      // `serverReleased` without `awaitingAcknowledgement` means the release
      // receipt arrived during this attempt (reconcile strips the flag), so
      // the late ack must not re-claim ownership. With the flag still set,
      // `serverReleased` is stale from an earlier rejected attempt, and the
      // server-owned replacement applies.
      if (
        preserveReleasedBrowserOwner &&
        prompt.serverReleased &&
        !prompt.awaitingAcknowledgement &&
        prompt.id === replacement.id
      ) {
        const {
          awaitingAcknowledgement: _,
          serverOwned: _serverOwned,
          ...releasedPrompt
        } = prompt;
        result.push(releasedPrompt);
        inserted = true;
        continue;
      }
      if (!inserted) {
        result.push(replacement);
        inserted = true;
      }
      continue;
    }
    if (prompt.id && prompt.id === replacement.id) {
      if (!inserted) {
        result.push(replacement);
        inserted = true;
      }
      continue;
    }
    result.push(prompt);
  }
  // If a canonical chat_message acknowledgement removed the pending batch
  // before the HTTP response arrived, ownership is already complete and a
  // new server-owned mirror would be stale.
  if (!inserted && batch.length === 0) result.push(replacement);
  return result;
}
