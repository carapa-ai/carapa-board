import { useSyncExternalStore } from 'react';

export type LivePersonaRevealPhase =
  | 'thinking'
  | 'preparing'
  | 'waiting'
  | 'speaking'
  | 'released';

export interface LivePersonaRevealState {
  messageId: string;
  conversationId: string;
  bufferedText: string;
  phase: LivePersonaRevealPhase;
  progress: number;
  revealedWords: number;
}

const states = new Map<string, LivePersonaRevealState>();
const listeners = new Map<string, Set<() => void>>();

/**
 * Voice preparation of the current reply (server synthesis) has a bounded
 * deadline. A reveal stuck in `preparing` beyond this window would otherwise
 * spin forever — e.g. when the durable queue run stalls after a failed
 * current item and never releases the queued reply. Release it so the reply
 * text is shown instead of an endless spinner; if voice arrives later it
 * still plays over the visible text. The timer arms when preparation of the
 * current item starts, not when a queued lookahead is registered.
 */
const PREPARING_RELEASE_TIMEOUT_MS = 120_000;
const preparingTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearPreparingTimer(messageId: string): void {
  const timer = preparingTimers.get(messageId);
  if (timer) {
    clearTimeout(timer);
    preparingTimers.delete(messageId);
  }
}

function armPreparingTimer(messageId: string): void {
  clearPreparingTimer(messageId);
  preparingTimers.set(
    messageId,
    setTimeout(() => {
      preparingTimers.delete(messageId);
      releaseLivePersonaReveal(messageId);
    }, PREPARING_RELEASE_TIMEOUT_MS),
  );
}

function wordCount(text: string): number {
  return text.trim().match(/\S+/g)?.length ?? 0;
}

function emit(messageId: string, next: LivePersonaRevealState | null): void {
  if (next) states.set(messageId, next);
  else states.delete(messageId);
  for (const listener of listeners.get(messageId) ?? []) listener();
}

export function beginLivePersonaReveal(
  messageId: string,
  conversationId: string,
): void {
  if (states.has(messageId)) return;
  emit(messageId, {
    messageId,
    conversationId,
    bufferedText: '',
    phase: 'preparing',
    progress: 0,
    revealedWords: 0,
  });
  // No release timer here: a queued lookahead also begins a reveal at
  // registration, and its wait for the talking stick is legitimately
  // unbounded. The timer arms only when the item becomes current and its
  // voice preparation starts (markLivePersonaSynthesizing), so a lookahead
  // gets a fresh deadline when its turn arrives.
}

/** Returns true when this chunk belongs to a voice-delayed persona bubble. */
export function bufferLivePersonaChunk(
  messageId: string,
  chunk: string,
): boolean {
  const current = states.get(messageId);
  if (!current) return false;
  emit(messageId, { ...current, bufferedText: current.bufferedText + chunk });
  return true;
}

/** Replace streamed deltas with the canonical persisted message text. */
export function replaceLivePersonaBuffer(
  messageId: string,
  content: string,
): boolean {
  const current = states.get(messageId);
  if (!current) return false;
  const revealedWords =
    current.phase === 'released'
      ? wordCount(content)
      : Math.floor(wordCount(content) * current.progress);
  emit(messageId, { ...current, bufferedText: content, revealedWords });
  return true;
}

export function markLivePersonaWaiting(messageId: string): void {
  const current = states.get(messageId);
  if (!current || current.phase === 'released') return;
  // Waiting for the talking stick is legitimately unbounded; only voice
  // preparation is bounded.
  clearPreparingTimer(messageId);
  emit(messageId, { ...current, phase: 'waiting' });
}

export function markLivePersonaThinking(messageId: string): void {
  const current = states.get(messageId);
  if (!current || current.phase === 'released') return;
  clearPreparingTimer(messageId);
  emit(messageId, { ...current, phase: 'thinking' });
}

export function markLivePersonaSynthesizing(messageId: string): void {
  const current = states.get(messageId);
  if (!current || current.phase === 'released') return;
  emit(messageId, { ...current, phase: 'preparing' });
  // Queue heartbeat snapshots repeat this signal every few seconds; re-arming
  // would push the bounded release deadline back forever and the timeout would
  // never fire. Arm only when no preparing timer is running (leaving
  // preparing clears it, so a later preparing phase gets a fresh deadline).
  if (!preparingTimers.has(messageId)) armPreparingTimer(messageId);
}

export function markLivePersonaPlaybackStarted(messageId: string): void {
  const current = states.get(messageId);
  if (!current || current.phase === 'released') return;
  clearPreparingTimer(messageId);
  emit(messageId, {
    ...current,
    phase: 'speaking',
    progress: 0,
    revealedWords: 0,
  });
}

export function updateLivePersonaPlayback(
  messageId: string,
  progress: number,
): void {
  const current = states.get(messageId);
  if (!current || current.phase !== 'speaking') return;
  const bounded = Math.max(0, Math.min(1, progress));
  const revealedWords = Math.floor(wordCount(current.bufferedText) * bounded);
  // Speech averages only a few words per second. Avoid reparsing Markdown on
  // every animation frame when the visible word boundary has not changed.
  if (revealedWords === current.revealedWords && bounded < 1) return;
  emit(messageId, { ...current, progress: bounded, revealedWords });
}

export function releaseLivePersonaReveal(messageId: string): void {
  clearPreparingTimer(messageId);
  const current = states.get(messageId);
  if (!current || current.phase === 'released') return;
  emit(messageId, {
    ...current,
    phase: 'released',
    progress: 1,
    revealedWords: wordCount(current.bufferedText),
  });
}

export function releaseLivePersonaReveals(messageIds?: Iterable<string>): void {
  if (messageIds) {
    for (const messageId of messageIds) releaseLivePersonaReveal(messageId);
    return;
  }
  for (const messageId of [...states.keys()])
    releaseLivePersonaReveal(messageId);
}

export function clearLivePersonaReveal(messageId: string): void {
  clearPreparingTimer(messageId);
  if (states.has(messageId)) emit(messageId, null);
}

export function getLivePersonaRevealState(
  messageId: string,
): LivePersonaRevealState | null {
  return states.get(messageId) ?? null;
}

export function useLivePersonaReveal(
  messageId: string,
): LivePersonaRevealState | null {
  return useSyncExternalStore(
    (listener) => {
      const set = listeners.get(messageId) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(messageId, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(messageId);
      };
    },
    () => states.get(messageId) ?? null,
    () => null,
  );
}

export function resetLivePersonaRevealsForTest(): void {
  for (const messageId of [...preparingTimers.keys()])
    clearPreparingTimer(messageId);
  for (const messageId of [...states.keys()]) emit(messageId, null);
}
