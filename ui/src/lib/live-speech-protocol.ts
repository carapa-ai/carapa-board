export function validateLiveStatus(text: string): string | null {
  const value = text.replace(/\s+/g, ' ').trim();
  return value.length > 0 && !/[{}<>`]/.test(value) && !/^concise status$/i.test(value)
    ? value
    : null;
}

/** Extract replayable Live narration while preserving marker examples shown as code. */
export function liveStatusesFromMarkdown(content: string): string[] {
  const statuses: string[] = [];
  const marker = /\[\[live:\s*([^\]\r\n]+)\]\]/gi;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(content)) !== null) {
    const codeExample = content.slice(0, match.index).trimEnd().endsWith('`')
      && content.slice(match.index + match[0].length).trimStart().startsWith('`');
    if (codeExample) continue;
    const status = validateLiveStatus(match[1]);
    if (status) statuses.push(status);
  }
  return statuses;
}

export interface LiveSpeechActivity { conversationId: string; title: string; state: string; status: string | null; completionSummary?: string | null; }
export type LiveSpeechPriority = 'focused' | 'background-completion' | 'background-blocker';
export function speechForLiveActivity(item: LiveSpeechActivity, focusedId: string | null, announceCompletions: boolean): { text: string; priority: LiveSpeechPriority } | null {
  const background = item.conversationId !== focusedId;
  const blocker = /needs.?input|failed|blocked|error/i.test(`${item.state} ${item.status || ''}`);
  const complete = /complete|done|success/i.test(`${item.state} ${item.status || ''}`);
  // Only explicit live markers are ordinary speech input. Lifecycle-only
  // transitions may interrupt for a blocker, but must never turn cached titles,
  // previews, or generic idle/working state into speech.
  const genericLifecycleStatus = /^(?:working|idle|running|complete|completed|done)$/i.test(item.status?.trim() || '');
  const description = (!genericLifecycleStatus && item.status)
    || (complete && background ? item.completionSummary : null)
    || (blocker
    ? (item.state === 'failed' ? 'A conversation failed' : 'A conversation needs input')
    : null);
  if (!description) return null;
  if (complete && background && !announceCompletions && !blocker) return null;
  return { text: description, priority: background ? (blocker ? 'background-blocker' : 'background-completion') : 'focused' };
}
