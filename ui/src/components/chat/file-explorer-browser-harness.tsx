import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/global.css';
import { useStore } from '@/store';
import { FilesTab } from './files-tab';

type Consumer = 'files';
type Context = 'conversation' | 'objective';

declare global {
  interface Window {
    artifactExplorerHarness?: {
      reset: () => void;
      calls: () => string[];
      previewPath: () => string | undefined;
      show: (consumer: Consumer, context: Context) => void;
    };
  }
}

const calls: string[] = [];
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const requestUrl = input instanceof Request ? input.url : String(input);
  const method =
    init?.method ?? (input instanceof Request ? input.method : 'GET');
  const parsed = new URL(requestUrl, window.location.origin);
  const filesMatch = parsed.pathname.match(
    /^\/api\/projects\/browser-project\/files\/(repo|group)(?:\/content)?$/,
  );
  if (filesMatch) {
    const source = filesMatch[1]!;
    if (method === 'HEAD')
      return new Response(null, {
        headers: { 'Content-Type': 'text/plain', 'Content-Length': '4096' },
      });
    const path = parsed.searchParams.get('path') ?? '';
    const search = parsed.searchParams.get('search');
    calls.push(
      search ? `${source}-search:${search}` : `${source}-list:${path}`,
    );
    const prefix = source === 'repo' ? 'src' : 'notes';
    const file = (name: string, filePath: string) => ({
      kind: 'file',
      name,
      path: filePath,
    });
    if (path)
      return Response.json({
        entries: [
          file('preview-image.png', `${prefix}/preview-image.png`),
          file(
            'a-very-long-file-name-that-must-stay-contained.ts',
            `${prefix}/a-very-long-file-name-that-must-stay-contained.ts`,
          ),
          file('second-file.ts', `${prefix}/second-file.ts`),
        ],
      });
    if (search)
      return Response.json({
        entries: [
          file(
            `${source}-search-image.png`,
            `${prefix}/${source}-search-image.png`,
          ),
          file(
            `${source}-search-note.txt`,
            `${prefix}/${source}-search-note.txt`,
          ),
        ],
      });
    return Response.json({
      entries: [{ kind: 'directory', name: prefix, path: prefix }],
    });
  }
  return originalFetch(input, init);
};

function Harness() {
  const [consumer, setConsumer] = useState<Consumer>('files');
  const [context, setContext] = useState<Context>('conversation');
  window.artifactExplorerHarness = {
    reset: () => {
      calls.length = 0;
      setConsumer('files');
      setContext('conversation');
    },
    show: (nextConsumer, nextContext) => {
      setConsumer(nextConsumer);
      setContext(nextContext);
    },
    calls: () => [...calls],
    previewPath: () => {
      const state = useStore.getState().previewTabsByProject['browser-project'];
      return state?.tabs.find((tab) => tab.id === state.activeTabId)?.path;
    },
  };
  return (
    <div
      data-ui="explorer-context"
      data-context={context}
      data-consumer={consumer}
      className="bg-background text-foreground"
    >
      <FilesTab
        key={context}
        project_id="browser-project"
        conversation_id={null}
      />
    </div>
  );
}

export function mountArtifactExplorerHarness(element: HTMLElement) {
  createRoot(element).render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness />
    </QueryClientProvider>,
  );
}
