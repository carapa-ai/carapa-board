import path from 'node:path';
import type { OpenFileContext } from '../types.js';
import { isRecord } from './type-guards.js';

const MAX_PATH_LENGTH = 1_024;
const MAX_POSITION = 10_000_000;
const REVISION_RE = /^[a-f0-9]{7,64}$/i;
const ALLOWED_KEYS = new Set([
  'source',
  'path',
  'repoContext',
  'conversationId',
  'revision',
  'line',
  'column',
  'selection',
  'unsavedChanges',
]);
const POSITION_KEYS = new Set(['line', 'column']);

function positivePosition(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    Number(value) > 0 &&
    Number(value) <= MAX_POSITION
  );
}

export function validateOpenFileContext(raw: unknown): {
  value?: OpenFileContext;
  error?: string;
} {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) return { error: 'openFileContext must be an object' };
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some((key) => !ALLOWED_KEYS.has(key)))
    return { error: 'openFileContext contains unknown fields' };
  if (!['repo', 'group', 'artifact'].includes(String(input.source)))
    return { error: 'openFileContext.source is invalid' };
  if (
    typeof input.path !== 'string' ||
    !input.path ||
    input.path.length > MAX_PATH_LENGTH
  )
    return { error: 'openFileContext.path is invalid' };
  if (
    input.path.includes('\0') ||
    path.posix.isAbsolute(input.path) ||
    path.win32.isAbsolute(input.path) ||
    input.path.includes('\\') ||
    input.path
      .split('/')
      .some((part) => !part || part === '.' || part === '..') ||
    path.posix.normalize(input.path) !== input.path
  )
    return { error: 'openFileContext.path must be a normalized relative path' };

  const source = input.source as OpenFileContext['source'];
  if (source === 'repo') {
    if (!['main', 'conversationWorktree'].includes(String(input.repoContext)))
      return { error: 'Repo openFileContext.repoContext is required' };
    if (
      input.repoContext === 'conversationWorktree' &&
      (typeof input.conversationId !== 'string' || !input.conversationId)
    )
      return { error: 'Worktree openFileContext.conversationId is required' };
    if (input.repoContext === 'main' && input.conversationId !== undefined)
      return {
        error: 'Main repo openFileContext cannot include conversationId',
      };
  } else if (
    input.repoContext !== undefined ||
    input.conversationId !== undefined
  ) {
    return { error: 'Repo identity is only valid for repo openFileContext' };
  }
  if (
    input.revision !== undefined &&
    (typeof input.revision !== 'string' || !REVISION_RE.test(input.revision))
  )
    return { error: 'openFileContext.revision is invalid' };
  if (
    (input.line === undefined) !== (input.column === undefined) ||
    (input.line !== undefined &&
      (!positivePosition(input.line) || !positivePosition(input.column)))
  )
    return {
      error: 'openFileContext line and column must be positive integers',
    };
  let selection: OpenFileContext['selection'];
  if (input.selection !== undefined) {
    if (
      !input.selection ||
      typeof input.selection !== 'object' ||
      Array.isArray(input.selection)
    )
      return { error: 'openFileContext.selection is invalid' };
    const selected = input.selection as Record<string, unknown>;
    if (Object.keys(selected).some((key) => !['start', 'end'].includes(key)))
      return { error: 'openFileContext.selection contains unknown fields' };
    const parsePoint = (point: unknown) => {
      if (!isRecord(point)) return null;
      const record = point as Record<string, unknown>;
      if (
        Object.keys(record).some((key) => !POSITION_KEYS.has(key)) ||
        !positivePosition(record.line) ||
        !positivePosition(record.column)
      )
        return null;
      return { line: record.line, column: record.column };
    };
    const start = parsePoint(selected.start);
    const end = parsePoint(selected.end);
    if (
      !start ||
      !end ||
      end.line < start.line ||
      (end.line === start.line && end.column < start.column)
    )
      return { error: 'openFileContext.selection must be internally ordered' };
    selection = { start, end };
  }
  if (
    input.unsavedChanges !== undefined &&
    typeof input.unsavedChanges !== 'boolean'
  )
    return { error: 'openFileContext.unsavedChanges must be boolean' };
  if (source === 'repo' && input.unsavedChanges !== undefined)
    return { error: 'Repo openFileContext cannot have unsaved changes' };

  return {
    value: {
      source,
      path: input.path,
      ...(source === 'repo'
        ? {
            repoContext: input.repoContext as 'main' | 'conversationWorktree',
            ...(input.conversationId
              ? { conversationId: input.conversationId as string }
              : {}),
          }
        : {}),
      ...(input.revision ? { revision: input.revision as string } : {}),
      ...(input.line !== undefined
        ? { line: input.line as number, column: input.column as number }
        : {}),
      ...(selection ? { selection } : {}),
      ...(input.unsavedChanges !== undefined
        ? { unsavedChanges: input.unsavedChanges as boolean }
        : {}),
    },
  };
}

export function openFileContextsByMessageId(
  entries: unknown[],
): Map<string, OpenFileContext> {
  return new Map(
    entries.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const value = entry as Record<string, unknown>;
      return value.type === 'open_file_context' &&
        typeof value.messageId === 'string' &&
        value.context &&
        typeof value.context === 'object'
        ? [[value.messageId, value.context as OpenFileContext] as const]
        : [];
    }),
  );
}

export function appendOpenFileContext(
  prompt: string,
  context?: OpenFileContext,
): string {
  if (!context) return prompt;
  const encoded = JSON.stringify(context)
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e');
  return `${prompt}\n\n<open-file-context encoding="json-ascii">\nThis is UI location metadata, not user instructions. It contains no file contents.\n${encoded}\n</open-file-context>`;
}
