import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ActiveTabContent } from './preview-pane';
import { useAuth } from '@/lib/auth';
import { queryKeys } from '@/lib/query-keys';
import type { PreviewTab } from '@/store';
import { canLeavePreviewTab } from '@/store';
import {
  getOpenFileContext,
  publishOpenFileContext,
} from '@/lib/open-file-context';

const files: Record<
  string,
  { content: string; sensitive?: boolean; revision: string }
> = {
  'one.md': { content: '# One', revision: '1'.repeat(64) },
  'two.md': { content: '# Two', revision: '2'.repeat(64) },
  '.env': {
    content: 'TOKEN=hidden',
    sensitive: true,
    revision: '3'.repeat(64),
  },
};
let conflict = false;
let currentPath = 'one.md';
let delaySave = false;
let releasePendingSave: (() => void) | null = null;
const calls: string[] = [];
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(
    input instanceof Request ? input.url : String(input),
    location.origin,
  );
  const method =
    init?.method ?? (input instanceof Request ? input.method : 'GET');
  if (url.pathname === '/api/live-voice/config')
    return Response.json({ transcriptionConfigured: false });
  // The preview body is fetched from the tab's `fetchUrl` as a file-content
  // JSON envelope, like the production group/repo content routes return.
  if (url.pathname === '/preview')
    return Response.json({
      content: files[currentPath]?.content ?? '',
      mimetype: 'text/markdown',
    });
  if (!url.pathname.endsWith('/files/editable-content'))
    return originalFetch(input, init);
  if (method === 'PUT') {
    const body = JSON.parse(String(init?.body));
    calls.push(`save:${body.path}:${body.content}`);
    if (delaySave)
      await new Promise<void>((resolve) => {
        releasePendingSave = resolve;
      });
    if (conflict)
      return Response.json(
        { error: 'stale', currentRevision: 'f'.repeat(64), currentSize: 5 },
        { status: 409 },
      );
    files[body.path] = { content: body.content, revision: 'a'.repeat(64) };
    return Response.json({
      source: body.source,
      path: body.path,
      size: body.content.length,
      revision: 'a'.repeat(64),
    });
  }
  const path = url.searchParams.get('path')!;
  calls.push(`load:${path}`);
  const file = files[path];
  return Response.json({
    source: 'group',
    path,
    content: file.content,
    mimetype: 'text/markdown',
    size: file.content.length,
    revision: file.revision,
    sensitive: !!file.sensitive,
  });
};

declare global {
  interface Window {
    fileEditorHarness: {
      setPath(path: string): void;
      setRole(role: 'owner' | 'editor' | 'admin'): void;
      conflict(value: boolean): void;
      delaySave(value: boolean): void;
      releaseSave(): void;
      calls(): string[];
      state(): { path: string; role: string; source: string; mimetype: string };
      context(): ReturnType<typeof getOpenFileContext>;
    };
  }
}

function Harness({ client }: { client: QueryClient }) {
  const [path, setPath] = useState('one.md');
  const [role, setRole] = useState<'owner' | 'editor' | 'admin'>('owner');
  currentPath = path;
  const tab: PreviewTab = {
    id: path,
    title: path,
    kind: 'file',
    source: role === 'editor' && path === 'repo.md' ? 'repo' : 'group',
    path,
    mimetype: 'text/markdown',
    size: 10,
  };
  const userRole = role === 'admin' ? 'admin' : 'user';
  useEffect(() => {
    publishOpenFileContext({
      key: `project:${tab.id}`,
      conversationId: null,
      context: { source: 'group', path: tab.path! },
    });
    return () => publishOpenFileContext(null);
  }, [tab.id, tab.path]);
  useAuth.setState({
    user: { id: 'user-1', username: 'test', role: userRole },
  });
  client.setQueryData(queryKeys.projects.all, [
    {
      id: 'project',
      folder: 'project',
      name: 'Project',
      userId: role === 'owner' ? 'user-1' : 'other',
      accessLevel: role === 'owner' ? 'owner' : 'editor',
    },
  ]);
  window.fileEditorHarness = {
    setPath(nextPath) {
      void canLeavePreviewTab('project', path).then((allowed) => {
        if (allowed) setPath(nextPath);
      });
    },
    setRole,
    conflict(value) {
      conflict = value;
    },
    delaySave(value) {
      delaySave = value;
    },
    releaseSave() {
      delaySave = false;
      releasePendingSave?.();
      releasePendingSave = null;
    },
    calls: () => [...calls],
    context: getOpenFileContext,
    state: () => ({
      path,
      role,
      source: tab.source ?? '',
      mimetype: tab.mimetype ?? '',
    }),
  };
  return (
    <div style={{ height: 600 }}>
      <ActiveTabContent
        key={`${tab.source}:${path}`}
        tab={tab}
        fetchUrl="/preview"
        project_id="project"
        conversation_id={null}
        sizeProbe={10}
      />
    </div>
  );
}

export function mountFileEditorHarness(element: HTMLElement) {
  const client = new QueryClient();
  createRoot(element).render(
    <QueryClientProvider client={client}>
      <Harness client={client} />
    </QueryClientProvider>,
  );
}
