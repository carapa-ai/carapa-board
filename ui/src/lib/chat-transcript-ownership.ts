import type { TranscriptEntry } from '@/types';

/**
 * CarapaRun V1 persists a provider message as
 * `<run-id>-v1-<event-index>-<provider-message-id>`. Some older/live paths use
 * the run id itself as the canonical id, while current CLI chat uses the
 * provider message id. Accept both deterministic projections.
 */
export function transcriptMessageIdMatchesCanonical(
  candidateId: unknown,
  canonicalId: string,
): boolean {
  if (typeof candidateId !== 'string' || !canonicalId) return false;
  if (candidateId === canonicalId) return true;

  const runIdPrefix = `${canonicalId}-v1-`;
  if (candidateId.startsWith(runIdPrefix)) {
    return /^\d+-.+/.test(candidateId.slice(runIdPrefix.length));
  }

  const providerIdSuffix = `-${canonicalId}`;
  if (!candidateId.endsWith(providerIdSuffix)) return false;
  return /-v1-\d+$/.test(candidateId.slice(0, -providerIdSuffix.length));
}

function entryTime(entry: TranscriptEntry): number {
  const value = (entry as { created_at?: string }).created_at;
  if (!value) return Number.NaN;
  return new Date(value).getTime();
}

function sameEntry(left: TranscriptEntry, right: TranscriptEntry): boolean {
  const leftId = (left as { id?: string }).id;
  const rightId = (right as { id?: string }).id;
  if (leftId && rightId) {
    // Persona attribution and its assistant message intentionally share the
    // run id, but they are separate transcript records.
    if (left.type !== right.type) return false;
    // CarapaRun V1 persistence projects the live canonical message id into
    // `<run-id>-v1-<event-index>-<provider-id>`.
    if (
      left.type === 'message' &&
      right.type === 'message' &&
      left.role === 'assistant' &&
      right.role === 'assistant'
    ) {
      const leftIds = [
        leftId,
        (left as { canonicalMessageId?: string }).canonicalMessageId,
      ].filter((id): id is string => typeof id === 'string');
      const rightIds = [
        rightId,
        (right as { canonicalMessageId?: string }).canonicalMessageId,
      ].filter((id): id is string => typeof id === 'string');
      return leftIds.some((candidate) =>
        rightIds.some(
          (canonical) =>
            transcriptMessageIdMatchesCanonical(candidate, canonical) ||
            transcriptMessageIdMatchesCanonical(canonical, candidate),
        ),
      );
    }
    return leftId === rightId;
  }
  // Id-less legacy rows reconcile only when their complete durable records
  // are unchanged; never coalesce user submissions by text or timing.
  if (!leftId && !rightId)
    return JSON.stringify(left) === JSON.stringify(right);
  return false;
}

export function isSyntheticTranscriptId(id: unknown): boolean {
  return typeof id === 'string' && /^transcript-entry-\d+$/.test(id);
}

function assistantTurnAnchor(
  entries: TranscriptEntry[],
  index: number,
): string | null {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const entry = entries[cursor];
    if (entry.type !== 'message') continue;
    if (entry.role === 'user') {
      return typeof entry.id === 'string' ? entry.id : null;
    }
  }
  return null;
}

function assistantTurnOrdinal(
  entries: TranscriptEntry[],
  index: number,
): number {
  let ordinal = 0;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const entry = entries[cursor];
    if (entry.type === 'message' && entry.role === 'user') break;
    if (entry.type === 'message' && entry.role === 'assistant') ordinal += 1;
  }
  return ordinal;
}

function sameReconciledEntry(
  previous: TranscriptEntry[],
  previousIndex: number,
  incoming: TranscriptEntry[],
  incomingIndex: number,
): boolean {
  const prior = previous[previousIndex];
  const candidate = incoming[incomingIndex];
  const syntheticAssistantPair =
    prior.type === 'message' &&
    candidate.type === 'message' &&
    prior.role === 'assistant' &&
    candidate.role === 'assistant' &&
    isSyntheticTranscriptId(prior.id) &&
    isSyntheticTranscriptId(candidate.id);
  if (!syntheticAssistantPair) return sameEntry(prior, candidate);

  const priorAnchor = assistantTurnAnchor(previous, previousIndex);
  const candidateAnchor = assistantTurnAnchor(incoming, incomingIndex);
  return (
    priorAnchor !== null &&
    priorAnchor === candidateAnchor &&
    assistantTurnOrdinal(previous, previousIndex) ===
      assistantTurnOrdinal(incoming, incomingIndex)
  );
}

/**
 * Return steering user ids followed by a persisted assistant continuation or
 * a subsequent ordinary prompt. Consecutive steers can share one continuation;
 * a later prompt also closes a turn that stopped without another reply. Keep
 * the browser-owned boundary while only the steering receipts are persisted.
 *
 * `pendingIds` names in-flight steers the server accepted as `pending`. They
 * were never spliced into the running turn; once the transcript shows a reply
 * or a later prompt after them they ran as their own turn, so the transcript
 * owns them (they are not part of `requiredIds` boundaries).
 */
export function canonicalSteeringIdsWithContinuation(
  entries: TranscriptEntry[],
  acknowledgedIds: ReadonlySet<string> = new Set(),
  requiredIds: ReadonlySet<string> = new Set(),
  pendingIds: ReadonlySet<string> = new Set(),
): Set<string> {
  const ids = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] as unknown as {
      role?: unknown;
      id?: unknown;
      content?: unknown;
      steeringDelivery?: unknown;
    };
    if (
      entry.role !== 'user' ||
      typeof entry.id !== 'string' ||
      (entry.steeringDelivery !== 'steered' &&
        !acknowledgedIds.has(entry.id) &&
        !pendingIds.has(entry.id))
    ) {
      continue;
    }
    for (let next = index + 1; next < entries.length; next += 1) {
      const candidate = entries[next] as unknown as {
        role?: unknown;
        id?: unknown;
        content?: unknown;
        steeringDelivery?: unknown;
      };
      if (candidate.role === 'user') {
        if (
          candidate.steeringDelivery === 'steered' ||
          (typeof candidate.id === 'string' &&
            (acknowledgedIds.has(candidate.id) || pendingIds.has(candidate.id)))
        ) {
          continue;
        }
        // Pending or queued steering is not evidence of a new turn.
        if (!candidate.steeringDelivery) ids.add(entry.id);
        break;
      }
      if (
        candidate.role === 'assistant' &&
        typeof candidate.content === 'string' &&
        candidate.content.trim().length > 0
      ) {
        ids.add(entry.id);
        break;
      }
    }
  }
  if ([...requiredIds].some((id) => !ids.has(id))) return new Set();
  return ids;
}

/**
 * Preserve turns omitted by a stale follow-up refetch without making the
 * browser snapshot authoritative. Incoming entries keep their identity and
 * order; an id-less optimistic user entry is consumed by its acknowledged
 * canonical counterpart, and only genuinely absent prior entries are restored
 * at their stable neighboring ownership position (or chronological position
 * when no neighboring owner is available).
 */
export function reconcileTranscriptOwnership(
  previous: TranscriptEntry[],
  incoming: TranscriptEntry[],
): TranscriptEntry[] {
  const matchedIncoming = new Set<number>();
  const matchedPrevious = new Map<number, number>();
  const missing: Array<{ entry: TranscriptEntry; previousIndex: number }> = [];
  previous.forEach((prior, previousIndex) => {
    const match = incoming.findIndex(
      (entry, index) =>
        !matchedIncoming.has(index) &&
        sameReconciledEntry(previous, previousIndex, incoming, index),
    );
    if (match < 0) {
      // A stale browser snapshot can contain both the aggregated transcript
      // row and its terminal live-message alias. The authoritative refetch
      // contains only one row for that canonical assistant response. Once one
      // prior owner has consumed it above, do not restore another assistant
      // owner carrying the same identity.
      if (
        prior.type === 'message' &&
        prior.role === 'assistant' &&
        incoming.some((entry, index) =>
          sameReconciledEntry(previous, previousIndex, incoming, index),
        )
      ) {
        return;
      }
      missing.push({ entry: prior, previousIndex });
      return;
    }
    matchedIncoming.add(match);
    matchedPrevious.set(previousIndex, match);
  });
  if (missing.length === 0) return incoming;

  // Timestamp-less legacy rows cannot be chronologically sorted. Use the
  // stable ownership of their nearest surviving predecessor/successor instead
  // so an omitted historical turn cannot cross a newer user boundary.
  const anchoredBefore = new Map<number, Array<TranscriptEntry>>();
  const anchoredAfter = new Map<number, Array<TranscriptEntry>>();
  const unanchored: TranscriptEntry[] = [];
  for (const { entry, previousIndex } of missing) {
    let successor: number | undefined;
    for (let index = previousIndex + 1; index < previous.length; index += 1) {
      successor = matchedPrevious.get(index);
      if (successor !== undefined) break;
    }
    if (successor !== undefined) {
      const entries = anchoredBefore.get(successor) ?? [];
      entries.push(entry);
      anchoredBefore.set(successor, entries);
      continue;
    }
    let predecessor: number | undefined;
    for (let index = previousIndex - 1; index >= 0; index -= 1) {
      predecessor = matchedPrevious.get(index);
      if (predecessor !== undefined) break;
    }
    if (predecessor !== undefined) {
      const entries = anchoredAfter.get(predecessor) ?? [];
      entries.push(entry);
      anchoredAfter.set(predecessor, entries);
    } else {
      unanchored.push(entry);
    }
  }

  const merged: TranscriptEntry[] = [];
  incoming.forEach((entry, incomingIndex) => {
    merged.push(...(anchoredBefore.get(incomingIndex) ?? []), entry);
    merged.push(...(anchoredAfter.get(incomingIndex) ?? []));
  });
  for (const entry of unanchored) {
    const time = entryTime(entry);
    const insertionIndex = Number.isFinite(time)
      ? merged.findIndex((candidate) => {
          const candidateTime = entryTime(candidate);
          return Number.isFinite(candidateTime) && candidateTime > time;
        })
      : -1;
    merged.splice(
      insertionIndex < 0 ? merged.length : insertionIndex,
      0,
      entry,
    );
  }
  return merged;
}

const STEERING_RECEIPT_MATCH_WINDOW_MS = 10_000;

/**
 * Find the persisted user row for an in-flight steer whose POST outcome the
 * browser never learned (rejected fetch, or a response without a delivery).
 * Match by id (server id or client submission id) first, then by identical
 * content created within the same window used for optimistic de-duplication.
 */
export function findTranscriptSteeringReceipt(
  entries: readonly TranscriptEntry[],
  message: {
    localId: string;
    serverId?: string;
    content: string;
    createdAt: string;
  },
): { id: string; steeringDelivery?: unknown } | undefined {
  const sentAt = new Date(message.createdAt).getTime();
  for (const entry of entries) {
    if (
      entry.type !== 'message' ||
      entry.role !== 'user' ||
      entry.optimistic ||
      typeof entry.id !== 'string'
    ) {
      continue;
    }
    const sameId = [entry.id, ...(entry.clientSubmissionIds ?? [])].some(
      (id) => id === message.localId || id === message.serverId,
    );
    const createdAt = entryTime(entry);
    if (
      sameId ||
      (entry.content === message.content &&
        Number.isFinite(createdAt) &&
        Math.abs(createdAt - sentAt) < STEERING_RECEIPT_MATCH_WINDOW_MS)
    ) {
      return { id: entry.id, steeringDelivery: entry.steeringDelivery };
    }
  }
  return undefined;
}
