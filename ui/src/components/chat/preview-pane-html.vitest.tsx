import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveTabContent } from './preview-pane';
import type { PreviewTab } from '@/store';

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api', () => ({
  apiFetch: api.apiFetch,
  EditableFileConflictError: class extends Error {},
  loadEditableFile: vi.fn(),
  parseFileContentResponse: vi.fn(),
  readGroupFileContent: vi.fn(),
  readRepoFileContent: vi.fn(),
  saveEditableFile: vi.fn(),
}));
vi.mock('@/hooks/use-secure-media', () => ({
  useSecureMedia: (url: string) => url,
}));
vi.mock('@/components/markdown-content-lazy', () => ({
  MarkdownContent: () => null,
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'owner', role: 'admin', username: 'owner' } }),
}));
vi.mock('@/hooks/use-projects', () => ({
  useProject: () => ({
    data: { id: 'project', userId: 'owner', accessLevel: 'owner' },
  }),
}));
vi.mock('@/hooks/use-live-voice', () => ({
  useLiveVoice: () => ({ status: 'idle', capturing: false, stop: vi.fn() }),
  useDictationFailureToast: () => undefined,
}));

const HTML_BODY =
  '<h1>Hi</h1><script>window.parent.__pwned=1</script><img src=x onerror="window.parent.__pwned=2">';
const URL_ = '/artifacts/project/pages/report.html';

function mockFile(body: string, headSize = body.length) {
  api.apiFetch.mockImplementation(
    async (_url: string, init?: RequestInit) =>
      new Response(init?.method === 'HEAD' ? null : body, {
        status: 200,
        headers: {
          'Content-Length': String(headSize),
          'Content-Type': 'text/html',
        },
      }),
  );
}

function renderTab(tab: Partial<PreviewTab> = {}) {
  const queryClient = new QueryClient();
  const full = {
    id: 'html-tab',
    title: 'report.html',
    kind: 'file',
    source: 'group',
    path: 'artifacts/pages/report.html',
    size: HTML_BODY.length,
    ...tab,
  } as PreviewTab;
  return render(
    <QueryClientProvider client={queryClient}>
      <ActiveTabContent
        tab={full}
        fetchUrl={URL_}
        project_id="project"
        conversation_id={null}
      />
    </QueryClientProvider>,
  );
}

describe('HTML preview', () => {
  beforeEach(() => {
    api.apiFetch.mockReset();
    delete (window as unknown as { __pwned?: number }).__pwned;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
  });
  afterEach(cleanup);

  it.each([
    ['report.html', {}],
    ['report.htm', { path: 'artifacts/pages/report.htm' }],
    ['report', { path: undefined, mimetype: 'text/html' }],
  ])(
    'renders %s in a sandboxed iframe without touching the parent DOM',
    async (title, extra) => {
      mockFile(HTML_BODY);
      const { container } = renderTab({ title, ...extra });
      const frame = await waitFor(() => {
        const el = container.querySelector('iframe');
        expect(el).not.toBeNull();
        return el!;
      });
      expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
      expect(frame.getAttribute('srcdoc')).toBe(HTML_BODY);
      expect(frame.getAttribute('src')).toBeNull();
      expect(container.querySelector('h1, script, img')).toBeNull();
      expect(
        (window as unknown as { __pwned?: number }).__pwned,
      ).toBeUndefined();
    },
  );

  it('toggles to the highlighted source and back to the preview', async () => {
    mockFile(HTML_BODY);
    const { container } = renderTab();
    await waitFor(() =>
      expect(container.querySelector('iframe')).not.toBeNull(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    await waitFor(() => expect(container.querySelector('pre')).not.toBeNull());
    expect(container.querySelector('pre')!.textContent).toContain(
      'window.parent.__pwned=1',
    );
    expect(container.querySelector('iframe')).toBeNull();
    expect(
      container.querySelector('[data-ui="file-editor-edit"]'),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() =>
      expect(container.querySelector('iframe')).not.toBeNull(),
    );
  });

  it('does not mount an iframe when the size probe exceeds the cap', async () => {
    mockFile('<p>big</p>', 600 * 1024);
    const { container } = renderTab();
    await waitFor(() =>
      expect(container.textContent).toContain('File too large to preview'),
    );
    expect(container.querySelector('iframe')).toBeNull();
  });
});
