import { hasSafeSegments } from './project-file-links';

export interface FileDeepLink {
  source: 'group' | 'repo';
  /** Relative to the group folder (`group`) or the repository root (`repo`). */
  path: string;
}

/**
 * Parses the chat route's `?file=<source>:<path>` value. Returns null for
 * anything but a known source with a safe relative path (no `..`, no absolute
 * or backslash paths), so an invalid link is ignored instead of followed.
 */
export function parseFileDeepLink(
  value: string | null | undefined,
): FileDeepLink | null {
  const match = /^(group|repo):(.+)$/s.exec(value ?? '');
  if (!match || !hasSafeSegments(match[2].split('/'))) return null;
  return { source: match[1] as FileDeepLink['source'], path: match[2] };
}

/**
 * App path that opens `path` in the chat preview panel. A repo file in a
 * conversation worktree needs `conversationId`; group files do not.
 */
export function fileDeepLinkPath(
  projectId: string,
  { source, path }: FileDeepLink,
  conversationId?: string | null,
): string {
  const search = new URLSearchParams();
  if (conversationId) search.set('conversationId', conversationId);
  search.set('file', `${source}:${path}`);
  return `/chat/${encodeURIComponent(projectId)}?${search}`;
}
