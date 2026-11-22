import type { OpenFileContext } from '@/types';

export interface PublishedOpenFileContext {
  key: string;
  conversationId: string | null;
  context: OpenFileContext;
}

let current: PublishedOpenFileContext | null = null;

export function publishOpenFileContext(
  value: PublishedOpenFileContext | null,
): void {
  current = value;
}

export function getOpenFileContext(): PublishedOpenFileContext | null {
  return current;
}

export function snapshotOpenFileContext(
  conversationId: string | null,
): OpenFileContext | undefined {
  if (!current || current.conversationId !== conversationId) return undefined;
  return structuredClone(current.context);
}

export function updateOpenFileContext(
  key: string,
  patch: Partial<OpenFileContext>,
): void {
  if (!current || current.key !== key) return;
  publishOpenFileContext({
    key,
    conversationId: current.conversationId,
    context: { ...current.context, ...patch },
  });
}
