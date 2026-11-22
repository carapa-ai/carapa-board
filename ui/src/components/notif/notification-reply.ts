export interface NotificationReplyTarget {
  projectId: string;
  objectiveId?: string;
}

export interface NotificationReplySource {
  summary: string;
  content: string;
  created_at?: string | null;
}

const MAX_QUOTED_CONTENT_CHARS = 2000;

function decodeSegment(segment: string): string | null {
  try {
    const decoded = decodeURIComponent(segment);
    if (!decoded || /[/\\]/.test(decoded) || decoded.includes('..')) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Maps a notification `action_url` to the project (and objective) in which a
 * reply conversation should be created. Returns null when no reply target can
 * be derived.
 */
export function parseNotificationReplyTarget(
  actionUrl: string | null | undefined,
): NotificationReplyTarget | null {
  if (!actionUrl || !actionUrl.startsWith('/') || actionUrl.startsWith('//')) {
    return null;
  }
  const queryStart = actionUrl.search(/[?#]/);
  const pathname = queryStart < 0 ? actionUrl : actionUrl.slice(0, queryStart);
  const segments = pathname.split('/').slice(1);
  const [root, rawProject, rawObjective, ...rest] = segments;

  if (root === 'objective') {
    if (!rawProject || !rawObjective || rest.length > 0) return null;
    const projectId = decodeSegment(rawProject);
    const objectiveId = decodeSegment(rawObjective);
    return projectId && objectiveId ? { projectId, objectiveId } : null;
  }
  if (root === 'chat' || root === 'board') {
    if (!rawProject || rawObjective !== undefined) return null;
    const projectId = decodeSegment(rawProject);
    return projectId ? { projectId } : null;
  }
  return null;
}

/** Builds the composer draft that quotes a notification above the reply. */
export function buildNotificationReplyDraft(
  payload: NotificationReplySource,
): string {
  const time = payload.created_at ? ` (${payload.created_at})` : '';
  const content =
    payload.content.length > MAX_QUOTED_CONTENT_CHARS
      ? `${payload.content.slice(0, MAX_QUOTED_CONTENT_CHARS)}…`
      : payload.content;
  const quoted = content
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return `Re: notification "${payload.summary}"${time}\n${quoted}\n\n`;
}
