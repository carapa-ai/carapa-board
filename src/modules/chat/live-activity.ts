/** Safe, intentionally small state for the global Live Agent surface. */
export type LiveActivityState =
  | 'idle'
  | 'working'
  | 'needs_input'
  | 'complete'
  | 'failed';

export interface LiveConversationActivity {
  folder: string;
  conversation_id: string;
  /** Persona replies own the audio channel; legacy marker speech stays off. */
  persona_driven: boolean;
  title: string | null;
  preview: string | null;
  state: LiveActivityState;
  status: string | null;
  updated_at: string;
  completion_summary?: string | null;
}

const LIVE_MARKER_PREFIX = '[[live: ';
const MAX_COMPLETION_SUMMARY_LENGTH = 240;

/** Example placeholder from the protocol instruction, not a speakable status. */
export function isLiveStatusPlaceholder(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^concise status$/i.test(value.replace(/[\t ]+/g, ' ').trim())
  );
}

/** Sent to chat agents so the hidden status protocol has an actual producer. */
export const LIVE_ACTIVITY_AGENT_INSTRUCTION = `

LIVE MODE IS ON. You MUST emit \`[[live: concise status]]\` immediately before doing any work, including before tools or reasoning. For audio input, listen first so you can detect the spoken language, then emit the first marker. Write every marker in the same language as the user's current message; if uncertain, use the established language of the conversation. Emit another marker at each meaningful milestone and while waiting for input. Every response must contain at least one marker, including short responses. Keep each status to one concise line. Never include user content, tool output, secrets, or a final answer in a status. These markers are hidden from the user, so do not explain or refer to them. Continue with the normal user-facing answer after any marker.`;

/** Explicitly clears marker behavior remembered by persistent agent sessions. */
export const LIVE_ACTIVITY_DISABLED_INSTRUCTION = `

LIVE MODE IS OFF. Do not emit \`[[live: ...]]\` markers or live progress statuses in this response.`;

/**
 * Persona Live Mode (`personas` kind): the persona's reply is synthesized and
 * read aloud in full, so it must be written as speech, not as chat markdown.
 * This replaces the OFF notice on persona turns and already forbids markers,
 * which stay Work-only.
 */
export const PERSONA_LIVE_VOICE_INSTRUCTION = `

LIVE VOICE MODE IS ON: your reply is read aloud. Answer in the language of the user, in 1-4 short spoken sentences (longer only when the user explicitly asks for detail). No markdown, headings, tables, lists, code blocks, links or file paths unless asked; say numbers and names as they are spoken. Do not emit \`[[live: ...]]\` markers.`;
const MAX_TITLE_LENGTH = 500;
const MAX_PREVIEW_LENGTH = 240;
/** Finished entries only live this long; they are pure reconnect hints. */
const TERMINAL_ACTIVITY_TTL_MS = 5 * 60_000;
/** Soft cap: only terminal entries are evicted, oldest first. */
const MAX_LIVE_ACTIVITIES = 500;
/** Insertion order is update order: upserts delete before set. */
const activities = new Map<string, LiveConversationActivity>();

/** Running and waiting entries must stay visible until their state changes. */
function isActiveState(state: LiveActivityState): boolean {
  return state === 'working' || state === 'needs_input';
}

function pruneLiveActivities(now = Date.now()): void {
  for (const [k, activity] of activities) {
    if (
      !isActiveState(activity.state) &&
      now - Date.parse(activity.updated_at) > TERMINAL_ACTIVITY_TTL_MS
    )
      activities.delete(k);
  }
  let excess = activities.size - MAX_LIVE_ACTIVITIES;
  for (const [k, activity] of activities) {
    if (excess <= 0) break;
    if (isActiveState(activity.state)) continue;
    activities.delete(k);
    excess--;
  }
}

function key(folder: string, conversationId: string): string {
  return `${folder}\u0000${conversationId}`;
}

function short(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, max) : null;
}

/** A marker may only carry one printable, single-line status sentence. */
export function validateLiveStatus(value: unknown): string | null {
  if (typeof value !== 'string' || /[\r\n\u0000-\u001f\u007f]/.test(value))
    return null;
  const normalized = value.replace(/[\t ]+/g, ' ').trim();
  if (!normalized || isLiveStatusPlaceholder(normalized)) return null;
  return normalized;
}

/** Completion state is derived from run lifecycle, never generated prose. */
export function resolveLiveCompletionState(
  stoppedByUser: boolean,
  failed: boolean,
): Extract<LiveActivityState, 'needs_input' | 'failed' | 'complete'> {
  if (stoppedByUser) return 'needs_input';
  return failed ? 'failed' : 'complete';
}

export function upsertLiveActivity(
  input: Pick<
    LiveConversationActivity,
    'folder' | 'conversation_id' | 'state'
  > &
    Partial<
      Omit<
        LiveConversationActivity,
        'folder' | 'conversation_id' | 'state' | 'updated_at'
      >
    >,
): LiveConversationActivity {
  const previous = activities.get(key(input.folder, input.conversation_id));
  const activity: LiveConversationActivity = {
    folder: input.folder,
    conversation_id: input.conversation_id,
    persona_driven:
      input.persona_driven === undefined
        ? (previous?.persona_driven ?? false)
        : input.persona_driven,
    title:
      input.title === undefined
        ? (previous?.title ?? null)
        : short(input.title, MAX_TITLE_LENGTH),
    preview:
      input.preview === undefined
        ? (previous?.preview ?? null)
        : short(input.preview, MAX_PREVIEW_LENGTH),
    state: input.state,
    status:
      input.status === undefined
        ? (previous?.status ?? null)
        : validateLiveStatus(input.status),
    updated_at: new Date().toISOString(),
    completion_summary:
      input.completion_summary === undefined
        ? (previous?.completion_summary ?? null)
        : short(input.completion_summary, MAX_COMPLETION_SUMMARY_LENGTH),
  };
  const activityKey = key(activity.folder, activity.conversation_id);
  activities.delete(activityKey);
  activities.set(activityKey, activity);
  pruneLiveActivities();
  return activity;
}

export function getLiveActivities(): LiveConversationActivity[] {
  pruneLiveActivities();
  return [...activities.values()].sort((a, b) =>
    b.updated_at.localeCompare(a.updated_at),
  );
}

export function getLiveActivity(
  folder: string,
  conversationId: string,
): LiveConversationActivity | undefined {
  pruneLiveActivities();
  return activities.get(key(folder, conversationId));
}

/** Test-only reset; registry state is deliberately process-local. */
export function clearLiveActivitiesForTest(): void {
  activities.clear();
}

/**
 * Incrementally removes hidden [[live: concise status]] markers.  Only exact,
 * validated markers report status; malformed markers are still never shown.
 */
export class LiveMarkerParser {
  private pending = '';
  private lastVisibleChar = '';

  private appendVisible(value: string): string {
    if (value) this.lastVisibleChar = value.at(-1) ?? '';
    return value;
  }

  push(chunk: string): { visible: string; statuses: string[] } {
    let input = this.pending + chunk;
    this.pending = '';
    let visible = '';
    const statuses: string[] = [];
    while (input.length > 0) {
      const start = input.indexOf(LIVE_MARKER_PREFIX);
      if (start < 0) {
        // Hold only a suffix that can still become the exact marker prefix.
        let keepLength = 0;
        for (
          let i = Math.min(input.length, LIVE_MARKER_PREFIX.length - 1);
          i > 0;
          i--
        ) {
          if (LIVE_MARKER_PREFIX.startsWith(input.slice(-i))) {
            keepLength = i;
            break;
          }
        }
        visible += this.appendVisible(
          input.slice(0, input.length - keepLength),
        );
        this.pending = keepLength ? input.slice(-keepLength) : '';
        return { visible, statuses };
      }
      visible += this.appendVisible(input.slice(0, start));
      if (this.lastVisibleChar === '`') {
        // Preserve marker syntax shown as Markdown code. The opening backtick
        // is available before the marker even when stream chunks split it.
        visible += this.appendVisible(LIVE_MARKER_PREFIX);
        input = input.slice(start + LIVE_MARKER_PREFIX.length);
        continue;
      }
      const candidate = input.slice(start);
      const end = input.indexOf(']]', start + LIVE_MARKER_PREFIX.length);
      if (end < 0) {
        const statusSoFar = candidate.slice(LIVE_MARKER_PREFIX.length);
        const definitelyInvalid = /[\r\n\u0000-\u001f\u007f]/.test(statusSoFar);
        if (definitelyInvalid) {
          // It cannot become a valid marker; preserve it as normal prose.
          visible += this.appendVisible(candidate);
          return { visible, statuses };
        }
        this.pending = candidate;
        return { visible, statuses };
      }
      const fullCandidate = input.slice(start, end + 2);
      const rawStatus = input.slice(start + LIVE_MARKER_PREFIX.length, end);
      const status = validateLiveStatus(rawStatus);
      if (status) statuses.push(status);
      else if (!isLiveStatusPlaceholder(rawStatus))
        visible += this.appendVisible(fullCandidate);
      input = input.slice(end + 2);
    }
    return { visible, statuses };
  }

  finish(): { visible: string; statuses: string[] } {
    const pending = this.pending;
    this.pending = '';
    // An unfinished candidate was never proven to be a marker, so preserve it.
    return { visible: this.appendVisible(pending), statuses: [] };
  }
}

export function stripLiveMarkers(content: string): {
  content: string;
  statuses: string[];
} {
  const parser = new LiveMarkerParser();
  const first = parser.push(content);
  const last = parser.finish();
  return {
    content: first.visible + last.visible,
    statuses: [...first.statuses, ...last.statuses],
  };
}

/** Final defense at assistant persistence boundaries. */
export function sanitizePersistedAssistantProse(content: string): string {
  return stripLiveMarkers(content)
    .content.replace(/<tool_result(?:\s[^>]*)?>[\s\S]*?<\/tool_result>/gi, '')
    .replace(/<tool_result(?:\s[^>]*)?\s*\/\s*>/gi, '');
}
