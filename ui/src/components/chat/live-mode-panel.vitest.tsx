import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRef } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveModePanel, type LiveModePanelHandle } from './live-mode-panel';
import { useStore } from '@/store';
import {
  getPersonaLiveMode,
  setPersonaLiveMode,
  stopChatAgent,
} from '@/lib/api';

const liveVoice = vi.hoisted(() => ({
  state: { status: 'idle', capturing: false },
  enabled: false,
  onFinal: null as null | ((text: string) => void | Promise<void>),
}));
const speech = vi.hoisted(() => ({
  state: {
    announceCompletions: false,
    error: null as string | null,
    muted: false,
    status: 'idle',
  },
  setMuted: vi.fn(),
  setAnnouncements: vi.fn(),
  retry: vi.fn(),
  enqueue: vi.fn(() => true),
  beginReveal: vi.fn(),
  bufferReveal: vi.fn(),
}));

vi.mock('@/hooks/use-projects', () => ({ useProjects: () => ({ data: [] }) }));
vi.mock('@/hooks/use-live-voice', () => ({
  useLiveVoice: (
    enabled: boolean,
    onFinal: (text: string) => void | Promise<void>,
  ) => {
    liveVoice.enabled = enabled;
    liveVoice.onFinal = onFinal;
    return liveVoice.state;
  },
}));
vi.mock('@/lib/push-bridge', () => ({
  activateNativeSpeechSession: vi.fn(async () => undefined),
  enqueueNativeSpeech: vi.fn(async () => false),
}));
vi.mock('@/lib/live-persona-reveal', () => ({
  beginLivePersonaReveal: speech.beginReveal,
  bufferLivePersonaChunk: speech.bufferReveal,
  releaseLivePersonaReveal: vi.fn(),
}));
vi.mock('@/lib/use-tts', () => ({
  cutOffLiveSpeech: vi.fn(async () => undefined),
  cutOffLiveSpeechForServerStop: vi.fn(async () => undefined),
  enqueueLiveReply: speech.enqueue,
  retryBlockedLiveSpeech: speech.retry,
  setLiveCompletionAnnouncements: speech.setAnnouncements,
  setLiveSpeechFocus: vi.fn(),
  setLiveSpeechMuted: speech.setMuted,
  useLiveSpeech: () => speech.state,
}));
vi.mock('@/lib/api', () => {
  return {
    fetchConfig: vi.fn(async () => ({})),
    fetchConversations: vi.fn(async () => []),
    fetchLiveActivity: vi.fn(async () => ({ activities: [] })),
    getPersonaLiveMode: vi.fn(() => new Promise(() => undefined)),
    heartbeatPersonaLiveMode: vi.fn(async () => undefined),
    leavePersonaLiveMode: vi.fn(async () => undefined),
    sendChatMessage: vi.fn(async () => ({
      delivery: 'steered',
      queueOwner: 'direct',
    })),
    setPersonaLiveMode: vi.fn(
      async (
        _projectId,
        _conversationId,
        enabled,
        liveModeSessionId,
        liveModeKind,
      ) => ({
        ok: true,
        enabled,
        liveModeKind,
        liveModeSessionId: enabled ? liveModeSessionId : null,
        resumePlaybacks: [],
        snapshot: null,
      }),
    ),
    startPersonaLiveQueueItem: vi.fn(async () => undefined),
    stopChatAgent: vi.fn(async () => undefined),
  };
});

const projectId = 'live-project';
const conversationId = 'live-conversation';

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const panel = createRef<LiveModePanelHandle>();
  const start = (kind?: 'personas' | 'work') =>
    act(() => panel.current?.start(kind));
  return {
    start,
    ...render(
      <QueryClientProvider client={queryClient}>
        <LiveModePanel
          ref={panel}
          projectId={projectId}
          activeConversationId={conversationId}
          personaDriven
        />
      </QueryClientProvider>,
    ),
  };
}

function renderDraftPanel(
  onDraftTranscript: (text: string) => Promise<void> | void,
  draftEnabled = true,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const panel = createRef<LiveModePanelHandle>();
  const Harness = ({ draftEnabled }: { draftEnabled: boolean }) => (
    <QueryClientProvider client={queryClient}>
      <LiveModePanel
        ref={panel}
        projectId={projectId}
        activeConversationId={null}
        draftEnabled={draftEnabled}
        onDraftEnabledChange={() => undefined}
        onDraftTranscript={onDraftTranscript}
      />
    </QueryClientProvider>
  );
  return { panel, ...render(<Harness draftEnabled={draftEnabled} />) };
}

beforeEach(() => {
  vi.clearAllMocks();
  speech.state = {
    announceCompletions: false,
    error: null,
    muted: false,
    status: 'idle',
  };
  useStore.setState({
    liveModeEnabled: false,
    liveModeFocusedConversationId: null,
    liveModeCurrentProjectId: null,
    liveModeEnabledByConversation: { [conversationId]: false },
    liveModeKindByConversation: { [conversationId]: 'work' },
    liveModeMicrophoneEnabledByConversation: { [conversationId]: false },
    liveModeSessionId: 'test-session',
  });
});

afterEach(cleanup);

describe('LiveModePanel lifecycle', () => {
  it('starts, exposes active audio controls, toggles the microphone, and stops cleanly', async () => {
    const user = userEvent.setup();
    const { container, start } = renderPanel();

    start();
    await waitFor(() =>
      expect(setPersonaLiveMode).toHaveBeenCalledWith(
        projectId,
        conversationId,
        true,
        'test-session',
        'work',
      ),
    );
    expect(screen.getByRole('button', { name: 'Stop Live Mode' })).toBeTruthy();
    const microphone = screen.getByRole('button', {
      name: 'Unmute Live Mode microphone',
    });
    expect(microphone.getAttribute('data-state')).toBe('off');

    await user.click(microphone);
    expect(
      screen
        .getByRole('button', { name: 'Mute Live Mode microphone' })
        .getAttribute('data-state'),
    ).toBe('on');

    await user.click(screen.getByRole('button', { name: 'Stop Live Mode' }));
    await waitFor(() =>
      expect(stopChatAgent).toHaveBeenCalledWith(projectId, conversationId),
    );
    // A user Stop cuts local reply audio immediately instead of letting the
    // current clip reach its recorded end.
    const { cutOffLiveSpeech } = await import('@/lib/use-tts');
    expect(vi.mocked(cutOffLiveSpeech)).toHaveBeenCalledOnce();
    expect(setPersonaLiveMode).toHaveBeenLastCalledWith(
      projectId,
      conversationId,
      false,
      'test-session',
      'work',
    );
    expect(
      screen.queryByRole('button', { name: 'Start Live Mode' }),
    ).toBeNull();
    expect(container.querySelector('[data-ui="live-mode-toggle"]')).toBeNull();
    expect(container.querySelector('[data-ui="live-mode-kind"]')).toBeNull();
    expect(
      container.querySelector('[data-ui="live-mode-audio-controls"]'),
    ).toBeNull();
  });

  it.each(['personas', 'work'] as const)(
    'starts with the %s kind chosen from the composer menu',
    async (kind) => {
      const { start } = renderPanel();
      useStore.setState({
        liveModeKindByConversation: {
          [conversationId]: kind === 'work' ? 'personas' : 'work',
        },
      });

      start(kind);

      await waitFor(() =>
        expect(setPersonaLiveMode).toHaveBeenCalledWith(
          projectId,
          conversationId,
          true,
          'test-session',
          kind,
        ),
      );
      expect(
        useStore.getState().liveModeKindByConversation[conversationId],
      ).toBe(kind);
    },
  );

  it('routes transcript finals only while this panel owns an enabled microphone', async () => {
    const user = userEvent.setup();
    const { start } = renderPanel();
    start();
    await screen.findByRole('button', { name: 'Stop Live Mode' });
    await user.click(
      screen.getByRole('button', { name: 'Unmute Live Mode microphone' }),
    );

    await liveVoice.onFinal?.('spoken request');
    const { sendChatMessage } = await import('@/lib/api');
    expect(sendChatMessage).toHaveBeenCalledWith(
      projectId,
      'spoken request',
      conversationId,
      undefined,
      undefined,
      undefined,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      'test-session',
      'work',
      expect.any(String),
      [expect.any(String)],
    );
  });

  it('arms the microphone in a draft chat and sends only the first spoken phrase', async () => {
    useStore.setState({
      liveModeMicrophoneEnabledByConversation: {
        [`project:${projectId}:new`]: true,
      },
    });
    let finishSend: () => void = () => undefined;
    const onDraftTranscript = vi.fn(
      () => new Promise<void>((resolve) => (finishSend = resolve)),
    );
    renderDraftPanel(onDraftTranscript);

    expect(
      screen
        .getByRole('button', { name: 'Mute Live Mode microphone' })
        .getAttribute('data-state'),
    ).toBe('on');
    expect(liveVoice.enabled).toBe(true);

    const first = liveVoice.onFinal?.('first phrase');
    await liveVoice.onFinal?.('second phrase');
    expect(onDraftTranscript).toHaveBeenCalledOnce();
    expect(onDraftTranscript).toHaveBeenCalledWith('first phrase');
    finishSend();
    await first;
  });

  it('turns the draft microphone on when Live Mode starts in a new chat', async () => {
    const { panel } = renderDraftPanel(vi.fn(), false);
    await act(async () => panel.current?.start('work'));
    expect(
      useStore.getState().liveModeMicrophoneEnabledByConversation[
        `project:${projectId}:new`
      ],
    ).toBe(true);
  });

  it('keeps the draft microphone off until it is unmuted', async () => {
    renderDraftPanel(vi.fn());
    expect(liveVoice.enabled).toBe(false);
    expect(
      screen.getByRole('button', { name: 'Unmute Live Mode microphone' }),
    ).toBeTruthy();
  });

  it('drops stale local ownership when the status refetch reports Live Mode off', async () => {
    vi.mocked(getPersonaLiveMode).mockResolvedValueOnce({
      ok: true,
      enabled: false,
      ownedBySession: false,
      liveModeKind: 'work',
      liveModeSessionId: null,
      resumePlaybacks: [],
      snapshot: null,
    } as never);
    useStore.setState({
      liveModeEnabled: true,
      liveModeFocusedConversationId: conversationId,
      liveModeCurrentProjectId: projectId,
      liveModeEnabledByConversation: { [conversationId]: true },
    });
    renderPanel();

    await waitFor(() =>
      expect(useStore.getState().liveModeEnabled).toBe(false),
    );
    expect(useStore.getState().liveModeFocusedConversationId).toBeNull();
    expect(
      useStore.getState().liveModeEnabledByConversation[conversationId],
    ).toBe(false);
  });
});
