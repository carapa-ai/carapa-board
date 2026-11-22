import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserTab } from './browser-tab';
import '@/global.css';

export function mountBrowserHarness(element: HTMLElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  createRoot(element).render(
    <QueryClientProvider client={client}>
      <div style={{ width: 620, height: 760 }}>
        <BrowserTab projectId="browser-project" conversationId="chat" active />
      </div>
    </QueryClientProvider>,
  );
}
