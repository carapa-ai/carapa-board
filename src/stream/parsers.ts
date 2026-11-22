/**
 * Display re-exports and shared stream types for agent output.
 *
 * Holds the `ChunkData` stream shape used by the UI, transcript and Run V1
 * conversion, the Codex interrupt-event predicate, and re-exports of the
 * display formatters from `agent-display.ts`. Run output itself is parsed from
 * the Run V1 event stream, not here.
 */

export {
  formatThinkingMarkdown,
  formatToolResult,
  formatToolUse,
} from './agent-display.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ChunkData =
  | {
      type: 'text';
      content: string;
      entryId?: string;
      /** False while later fragments can still extend this semantic entry. */
      entryComplete?: boolean;
      /** Marks the provider message that owns the persisted run result. */
      canonicalEntry?: boolean;
    }
  | { type: 'compaction'; status: string; session_id?: string }
  /** Agents/commands still running after the turn; an empty list clears them. */
  | {
      type: 'background_tasks';
      tasks: Array<{ id: string; description: string; startedAt?: number }>;
    }
  | { type: 'session'; session_id: string };

export function isCodexTurnInterruptedEvent(
  event: Record<string, any>,
): boolean {
  return (
    (event.type === 'item.completed' &&
      event.item?.type === 'error' &&
      event.item.message === 'turn interrupted') ||
    (event.type === 'turn.failed' &&
      event.error?.message === 'turn interrupted') ||
    (event.type === 'error' &&
      (event.message === 'turn interrupted' ||
        event.error?.message === 'turn interrupted'))
  );
}
