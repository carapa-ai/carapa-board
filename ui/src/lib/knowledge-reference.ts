import { createContext } from 'react';
import { knowledgeDocumentUrl } from './knowledge-files';
import { API_BASE_URL } from './api-config';
import { useStore } from '@/store';

export interface KnowledgeReference {
  kbId: string;
  filename: string;
  kbName?: string;
}

export const KNOWLEDGE_DRAG_TYPE = 'application/x-carapa-knowledge';

export const KnowledgeComposerContext = createContext<{
  projectId: string;
  insert: (reference: KnowledgeReference) => void;
} | null>(null);

export function knowledgeReferenceMarkdown(
  reference: KnowledgeReference,
): string {
  const label = [reference.kbName, reference.filename]
    .filter(Boolean)
    .join(' / ')
    .replace(/[\\[\]]/g, '\\$&')
    .replace(/[\r\n]/g, ' ');
  return `[${label}](${knowledgeDocumentUrl(reference.kbId, reference.filename, 'content')})`;
}

export function parseKnowledgeReference(
  href: string,
): KnowledgeReference | null {
  try {
    const url = new URL(href, window.location.origin);
    const apiOrigin = new URL(API_BASE_URL || '/', window.location.origin)
      .origin;
    if (url.origin !== window.location.origin && url.origin !== apiOrigin)
      return null;
    const match = url.pathname.match(
      /^\/api\/knowledge\/([^/]+)\/files\/content$/,
    );
    const filename = url.searchParams.get('filename');
    return match && filename
      ? { kbId: decodeURIComponent(match[1]), filename }
      : null;
  } catch {
    return null;
  }
}

export function openKnowledgeReference(
  projectId: string,
  reference: KnowledgeReference,
) {
  useStore.getState().openPreviewTab(projectId, {
    id: `knowledge:${reference.kbId}:${reference.filename}`,
    title: reference.filename,
    kind: 'file',
    path: reference.filename,
    source:
      API_BASE_URL +
      knowledgeDocumentUrl(reference.kbId, reference.filename, 'content'),
  });
}
