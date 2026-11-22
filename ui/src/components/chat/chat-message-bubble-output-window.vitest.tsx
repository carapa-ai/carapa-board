import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api';
import { copyToClipboard } from '@/lib/utils';
import { ChatMessageBubble } from './chat-message-bubble';

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ projectId: 'project-1' }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/markdown-content-lazy', () => ({
  MarkdownContent: ({ children }: { children: string }) => <>{children}</>,
  ChunkedMarkdownContent: ({ chunks }: { chunks: { content: string }[] }) => (
    <>{chunks.map((chunk) => chunk.content).join('')}</>
  ),
}));
vi.mock('@/lib/use-tts', () => ({
  useTts: () => ({ status: 'idle', play: vi.fn(), stop: vi.fn() }),
}));
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  fetchConfig: vi.fn(async () => ({ ttsEnabled: false })),
  fetchPersonaTurnInspection: vi.fn(),
}));
vi.mock('@/lib/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/utils')>()),
  copyToClipboard: vi.fn(async () => true),
}));

type Props = ComponentProps<typeof ChatMessageBubble>;
type OutputContext = NonNullable<Props['taskOutputContext']>;

const tailEntries = () => [
  { id: 't', content: 'TAIL', startOffset: 5, endOffset: 9 },
];
const outputContext = (
  overrides: Partial<OutputContext> = {},
): OutputContext => ({
  projectId: 'project-1',
  taskId: 'task-1',
  runId: 'r1',
  initialEntries: tailEntries(),
  totalEndOffset: 9,
  ...overrides,
});
const olderPage = {
  content: 'OLDER',
  nextCursor: 0,
  hasMore: false,
  total: 9,
  runId: 'r1',
  entries: [{ id: 'o', content: 'OLDER', startOffset: 0, endOffset: 5 }],
};
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

function bubble(
  taskOutputContext: OutputContext = outputContext(),
  role: Props['role'] = 'assistant',
) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <ChatMessageBubble
        id="m1"
        role={role}
        content="TAIL"
        taskOutputContext={taskOutputContext}
      />
    </QueryClientProvider>
  );
}

const loadButton = () => screen.getByText(/earlier output/);

describe('ChatMessageBubble task output window', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(copyToClipboard).mockClear();
    vi.mocked(toast.error).mockClear();
  });
  afterEach(cleanup);

  it('copies the visible window including loaded older output', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse(olderPage));
    render(bubble());
    fireEvent.click(loadButton());
    await screen.findByText(/OLDER/);
    fireEvent.click(screen.getByTitle('Copy to clipboard'));
    await waitFor(() => expect(copyToClipboard).toHaveBeenCalled());
    const copied = vi.mocked(copyToClipboard).mock.calls[0][0];
    expect(copied).toContain('OLDER');
    expect(copied).toContain('TAIL');
  });

  it('keeps loaded output across equal entries and resets on a new offset', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonResponse(olderPage));
    const { rerender } = render(bubble());
    fireEvent.click(loadButton());
    await screen.findByText(/OLDER/);

    rerender(bubble(outputContext({ initialEntries: tailEntries() })));
    expect(screen.getByText(/OLDER/)).toBeTruthy();

    rerender(
      bubble(
        outputContext({
          initialEntries: [
            { id: 't2', content: 'NEWTAIL', startOffset: 5, endOffset: 12 },
          ],
          totalEndOffset: 12,
        }),
      ),
    );
    expect(screen.queryByText(/OLDER/)).toBeNull();
  });

  it.each([
    [
      'an error status',
      () =>
        vi
          .mocked(apiFetch)
          .mockResolvedValue(jsonResponse({ error: 'x' }, 500)),
    ],
    [
      'a network failure',
      () => vi.mocked(apiFetch).mockRejectedValue(new Error('offline')),
    ],
  ])('shows an error and allows retry after %s', async (_name, arrange) => {
    arrange();
    render(bubble());
    fireEvent.click(loadButton());
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect((loadButton() as HTMLButtonElement).disabled).toBe(false),
    );
    expect(loadButton().textContent).toBe('Load earlier output');
  });

  it('reveals user message actions on keyboard focus', () => {
    const { container } = render(bubble(outputContext(), 'user'));
    const actions = container
      .querySelector('button[title="Copy to clipboard"]')
      ?.closest('div');
    expect(actions?.className).toContain('group-focus-within/msg:opacity-100');
  });
});
