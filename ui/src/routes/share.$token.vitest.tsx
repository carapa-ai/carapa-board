import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentType, ReactNode } from 'react';
import { Route } from './share.$token';
import type { PublicConversationResponse } from '@/types';

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useParams: () => ({ token: 'share-token' }),
  }),
}));

vi.mock('@/components/markdown-content-lazy', () => ({
  MarkdownContent: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));

const conversation: PublicConversationResponse = {
  conversation: {
    title: 'Shared conversation',
    liveMode: false,
    ttsEnabled: false,
    visitorPromptingEnabled: true,
    promptMaxChars: 500,
  },
  messages: [],
  total: 0,
  hasMore: false,
  nextOffset: 0,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes('/prompts/')) return jsonResponse({ status: 'completed' });
  if (url.includes('/prompts'))
    return jsonResponse(
      { error: 'This prompt could not be submitted safely.' },
      422,
    );
  if (url.includes('/visitor-session'))
    return jsonResponse({ csrfToken: 'csrf-token', displayName: 'Guest' });
  return jsonResponse(conversation);
});

class FakeEventSource {
  onerror: ((event: Event) => void) | null = null;
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

const PublicSharePage = (Route as unknown as { component: ComponentType })
  .component;

function renderPage() {
  return render(<PublicSharePage />);
}

function promptStatus(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-ui="public-visitor-prompt-status"]',
  );
}

/** Models the browser dropping focus from the textarea while it is disabled. */
function moveFocusAway(): void {
  const other = document.createElement('button');
  document.body.appendChild(other);
  other.focus();
  other.remove();
}

async function promptTextarea() {
  return screen.findByRole('textbox', { name: 'Message to the personas' });
}

async function enabledPromptTextarea() {
  const textarea = await promptTextarea();
  // The textarea stays disabled until the visitor session is ready.
  await waitFor(() => expect(textarea.hasAttribute('disabled')).toBe(false));
  return textarea;
}

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal(
    'EventSource',
    FakeEventSource as unknown as typeof EventSource,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('public share visitor prompt', () => {
  it('gives the prompt textarea an accessible name', async () => {
    renderPage();
    const textarea = await promptTextarea();
    expect(textarea.getAttribute('aria-label')?.trim()).toBe(
      'Message to the personas',
    );
  });

  it('returns focus to the textarea once a send settles', async () => {
    renderPage();
    const textarea = await enabledPromptTextarea();
    textarea.focus();
    expect(document.activeElement).toBe(textarea);
    fireEvent.change(textarea, { target: { value: 'Hello personas' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    // Browsers drop focus when the focused textarea becomes disabled.
    moveFocusAway();
    expect(document.activeElement).not.toBe(textarea);

    await waitFor(() =>
      expect(promptStatus()?.dataset.promptState).toBe('rejected'),
    );
    await waitFor(() => expect(textarea.hasAttribute('disabled')).toBe(false));
    await waitFor(() => expect(document.activeElement).toBe(textarea));
  });

  it('does not move focus when the textarea was not focused at send time', async () => {
    renderPage();
    const textarea = await enabledPromptTextarea();
    const sendButton = screen.getByRole('button', { name: 'Send' });
    // Rendering the page must not pull focus into the textarea.
    expect(document.activeElement).not.toBe(textarea);
    // The visitor types in the textarea, then moves focus to the Send button
    // (Tab) before sending: the send starts from the button, not from the
    // textarea, so focus must not be pulled back into the composer.
    textarea.focus();
    fireEvent.change(textarea, { target: { value: 'Hello personas' } });
    sendButton.focus();
    expect(document.activeElement).toBe(sendButton);
    fireEvent.click(sendButton);
    // Browsers drop focus from the send button while it is disabled.
    moveFocusAway();

    await waitFor(() =>
      expect(promptStatus()?.dataset.promptState).toBe('rejected'),
    );
    await waitFor(() => expect(textarea.hasAttribute('disabled')).toBe(false));
    expect(document.activeElement).not.toBe(textarea);
  });
});
