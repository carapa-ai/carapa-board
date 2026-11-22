import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatMessageBubble } from './chat-message-bubble';

const liveReveal = vi.hoisted(() => ({
  current: null as null | {
    phase: 'thinking' | 'waiting' | 'ready' | 'speaking' | 'released';
    bufferedText: string;
    progress: number;
    revealedWords: number;
  },
}));

const markdownContentProps = vi.hoisted(() => ({
  last: null as null | {
    deferUntilVisible?: boolean;
    liveRevealProgress?: number;
  },
}));

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ projectId: 'project-1' }),
}));
vi.mock('@/components/markdown-content-lazy', () => ({
  MarkdownContent: ({
    children,
    liveRevealProgress,
    deferUntilVisible,
  }: {
    children: string;
    liveRevealProgress?: number;
    deferUntilVisible?: boolean;
  }) => {
    markdownContentProps.last = { deferUntilVisible, liveRevealProgress };
    if (liveRevealProgress == null) return <>{children}</>;
    const words = [...children.matchAll(/\S+/g)];
    const visibleWords = Math.floor(words.length * liveRevealProgress);
    const last = words[visibleWords - 1];
    return (
      <>{last ? children.slice(0, (last.index ?? 0) + last[0].length) : ''}</>
    );
  },
}));
vi.mock('@/hooks/use-secure-media', () => ({
  useSecureMedia: (url: string) => ({
    secureUrl: url,
    loading: false,
    error: null,
  }),
}));
vi.mock('@/components/secure-image', () => ({
  SecureImage: (props: React.ImgHTMLAttributes<HTMLImageElement>) => (
    <img {...props} />
  ),
}));
vi.mock('@/lib/live-persona-reveal', () => ({
  clearLivePersonaReveal: vi.fn(),
  useLivePersonaReveal: () => liveReveal.current,
}));
vi.mock('@/lib/use-tts', () => ({
  useTts: () => ({ status: 'idle', play: vi.fn(), stop: vi.fn() }),
}));
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  fetchConfig: vi.fn(async () => ({ ttsEnabled: false })),
  fetchPersonaTurnInspection: vi.fn(),
}));

function renderBubble(
  props: Partial<React.ComponentProps<typeof ChatMessageBubble>> = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ChatMessageBubble
        id="message-1"
        role="assistant"
        content=""
        source="web"
        {...props}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  liveReveal.current = null;
  markdownContentProps.last = null;
  cleanup();
});

describe('Live Mode participant rendering', () => {
  it('keeps a pinned viewport aligned before each spoken growth paint', () => {
    const onContentGrow = vi.fn();
    liveReveal.current = {
      phase: 'speaking',
      bufferedText: 'First line\n\nSecond line',
      progress: 0.34,
      revealedWords: 1,
    };
    const { rerender } = renderBubble({ onContentGrow });
    expect(onContentGrow).toHaveBeenCalledTimes(1);

    liveReveal.current = {
      phase: 'speaking',
      bufferedText: 'First line\n\nSecond line',
      progress: 0.75,
      revealedWords: 3,
    };
    const queryClient = new QueryClient();
    rerender(
      <QueryClientProvider client={queryClient}>
        <ChatMessageBubble
          id="message-1"
          role="assistant"
          content="Canonical content changed"
          source="web"
          onContentGrow={onContentGrow}
        />
      </QueryClientProvider>,
    );
    expect(onContentGrow).toHaveBeenCalledTimes(2);
  });

  it('renders a known streaming participant before the first content chunk', () => {
    const { container } = renderBubble({
      isStreaming: true,
      virtualSenderName: 'Ada',
      virtualSenderIdentity: 'Systems thinker',
      senderUserId: 'ai:ada',
    });

    expect(screen.getByText('Ada')).toBeTruthy();
    expect(screen.getByText('Systems thinker')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Thinking');
    expect(
      container.querySelector('[data-ui="chat-persona-avatar-slot"]'),
    ).toBeTruthy();
    expect(
      container
        .querySelector('[data-ui="chat-persona-header"]')
        ?.getAttribute('data-avatar-state'),
    ).toBe('reserved');
    expect(
      container.querySelector('[data-ui="chat-message-actions"]'),
    ).toBeNull();
  });

  it('preserves the participant row and avatar slot across streaming handoff', () => {
    const { container, rerender } = renderBubble({
      isStreaming: true,
      virtualSenderName: 'Ada',
      senderUserId: 'ai:ada',
      virtualSenderAvatarUrl: '/ada.png',
      content: 'Partial answer',
    });
    const header = container.querySelector('[data-ui="chat-persona-header"]');
    expect(
      container.querySelector('[data-ui="chat-persona-avatar"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('[data-ui="chat-default-assistant-avatar"]'),
    ).toBeNull();

    const queryClient = new QueryClient();
    rerender(
      <QueryClientProvider client={queryClient}>
        <ChatMessageBubble
          id="message-1"
          role="assistant"
          source="web"
          virtualSenderName="Ada"
          senderUserId="ai:ada"
          virtualSenderAvatarUrl="/ada.png"
          content="Canonical answer"
          telemetry={{ tok_input: 12, tok_output: 8, duration_ms: 1000 }}
          isStreaming={false}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText('Canonical answer')).toBeTruthy();
    expect(container.querySelector('[data-ui="chat-persona-header"]')).toBe(
      header,
    );
    expect(
      container.querySelector('[data-ui="chat-persona-avatar"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('[data-ui="chat-message-actions"]'),
    ).toBeTruthy();
  });

  it('delays persona content until playback and then reveals it in the same row', () => {
    liveReveal.current = {
      phase: 'waiting',
      bufferedText: '',
      progress: 0,
      revealedWords: 0,
    };
    const { container, rerender } = renderBubble({
      virtualSenderName: 'Grace',
      senderUserId: 'ai:grace',
      content: 'Hidden until playback',
    });
    expect(screen.queryByText('Hidden until playback')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain(
      'Waiting to speak',
    );

    liveReveal.current = {
      phase: 'speaking',
      bufferedText: 'Now speaking\n\nLater words stay hidden',
      progress: 0.4,
      revealedWords: 2,
    };
    const queryClient = new QueryClient();
    rerender(
      <QueryClientProvider client={queryClient}>
        <ChatMessageBubble
          id="message-1"
          role="assistant"
          source="web"
          virtualSenderName="Grace"
          senderUserId="ai:grace"
          content="Canonical text remains hidden behind playback"
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText('Now speaking')).toBeTruthy();
    expect(screen.queryByText(/Later words/)).toBeNull();
    expect(
      container.querySelectorAll('[data-ui="chat-ai-user-message"]'),
    ).toHaveLength(1);

    liveReveal.current = {
      phase: 'speaking',
      bufferedText: 'Now speaking\n\nLater words stay hidden',
      progress: 0.84,
      revealedWords: 5,
    };
    rerender(
      <QueryClientProvider client={queryClient}>
        <ChatMessageBubble
          id="message-1"
          role="assistant"
          source="web"
          virtualSenderName="Grace"
          senderUserId="ai:grace"
          content="Canonical text still hidden behind playback"
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/Later words stay/)).toBeTruthy();
    expect(screen.queryByText(/hidden/)).toBeNull();
  });

  // Gap covered: a non-last row gets deferMarkdown=true, and the deferred
  // placeholder renders the full text — so a speaking row with an active
  // reveal must never be deferred, or the whole reply shows at once.
  it('never defers a row while its live reveal is pending, but defers released and plain rows', () => {
    liveReveal.current = {
      phase: 'speaking',
      bufferedText: 'One two three four five six',
      progress: 0.5,
      revealedWords: 3,
    };
    renderBubble({ deferMarkdown: true, content: 'Canonical text' });
    expect(markdownContentProps.last?.deferUntilVisible).toBe(false);
    expect(markdownContentProps.last?.liveRevealProgress).toBe(0.5);
    cleanup();

    // Released: the full text may be shown, so deferral applies again.
    liveReveal.current = {
      phase: 'released',
      bufferedText: 'One two three four five six',
      progress: 1,
      revealedWords: 6,
    };
    renderBubble({ deferMarkdown: true, content: 'Canonical text' });
    expect(markdownContentProps.last?.deferUntilVisible).toBe(true);
    expect(markdownContentProps.last?.liveRevealProgress).toBeUndefined();
    cleanup();

    liveReveal.current = null;
    renderBubble({ deferMarkdown: true, content: 'Plain earlier reply' });
    expect(markdownContentProps.last?.deferUntilVisible).toBe(true);
    expect(markdownContentProps.last?.liveRevealProgress).toBeUndefined();
  });
});
