import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Capacitor } from '@capacitor/core';
import {
  Bell,
  BellOff,
  Mic,
  MicOff,
  Radio,
  Square,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { Select, SelectItem } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import {
  ListeningLanguagePicker,
  useSpeechLanguageOptions,
} from '@/components/chat/listening-language-picker';
import {
  fetchConversations,
  fetchLiveActivity,
  getPersonaLiveMode,
  heartbeatPersonaLiveMode,
  leavePersonaLiveMode,
  setPersonaLiveMode,
  startPersonaLiveQueueItem,
  stopChatAgent,
  type PersonaLiveQueueSnapshot,
  type RuntimeSelection,
} from '@/lib/api';
import {
  activateNativeSpeechSession,
  enqueueNativeSpeech,
} from '@/lib/push-bridge';
import { queryKeys } from '@/lib/query-keys';
import { useProjects } from '@/hooks/use-projects';
import { useStore } from '@/store';
import { cn } from '@/lib/utils';
import {
  metadataFromConversation,
  PERSONA_LIVE_MODE_HINT,
  resolveLiveModeKind,
} from '@/lib/live-mode';
import { patchPersonaLiveModeStatus } from '@/lib/live-mode-query';
import { useLiveVoice } from '@/hooks/use-live-voice';
import {
  cutOffLiveSpeech,
  cutOffLiveSpeechForServerStop,
  enqueueLiveReply,
  retryBlockedLiveSpeech,
  useLiveSpeech,
  setLiveCompletionAnnouncements,
  setLiveSpeechFocus,
  setLiveSpeechMuted,
} from '@/lib/use-tts';
import { messageSpeechUrl } from '@/lib/message-speech-url';
import {
  beginLivePersonaReveal,
  bufferLivePersonaChunk,
  releaseLivePersonaReveal,
} from '@/lib/live-persona-reveal';
import { submitLiveModeTranscriptWithQueueOwnership } from '@/lib/live-mode-queue';

function resumePersonaPlayback(
  projectId: string,
  conversationId: string,
  liveModeSessionId: string,
  playback: { messageId: string; text: string },
  queue?: {
    item: NonNullable<PersonaLiveQueueSnapshot['current']>;
    runId: string;
    offsetSeconds: number;
  },
): void {
  setLiveSpeechFocus(conversationId);
  beginLivePersonaReveal(playback.messageId, conversationId);
  bufferLivePersonaChunk(playback.messageId, playback.text);
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
    void enqueueNativeSpeech(
      conversationId,
      playback.messageId,
      liveModeSessionId,
    ).then((queued) => {
      if (queued) return;
      releaseLivePersonaReveal(playback.messageId);
    });
    return;
  }
  enqueueLiveReply({
    messageId: playback.messageId,
    conversationId,
    projectId,
    text: playback.text,
    audioUrl: messageSpeechUrl(projectId, conversationId, playback.messageId),
    startOffsetSeconds: queue?.offsetSeconds,
    // Queue-v2 start claims are authorized per conversation and atomic per
    // item, so a refreshed observer may resume a released clip and unblock it.
    onStarted:
      queue && queue.item.state === 'released'
        ? () => {
            void startPersonaLiveQueueItem(
              projectId,
              conversationId,
              queue.item.id,
              queue.runId,
              liveModeSessionId,
            );
          }
        : undefined,
  });
}

/** One global Live Mode listener. Stable dictation finals enter the ordinary
 * text-message path with the current Live Mode routing metadata. */
interface LiveModePanelProps {
  projectId: string;
  activeConversationId: string | null;
  agentCmd?: string;
  runtimeSelection?: RuntimeSelection;
  personaDriven?: boolean;
  draftEnabled?: boolean;
  draftKind?: 'personas' | 'work';
  onDraftEnabledChange?: (enabled: boolean) => void;
  onDraftKindChange?: (kind: 'personas' | 'work') => void;
  allowDraftStart?: boolean;
  /** Receives the first committed spoken phrase of a draft chat so the host
   * can create the conversation with it, exactly like a typed first message. */
  onDraftTranscript?: (text: string) => Promise<void> | void;
}

export interface LiveModePanelHandle {
  start: (kind?: 'personas' | 'work') => void;
}

const LISTENING_ENGINES = {
  server: 'CarapaBoard transcription',
  whisper: 'Whisper on this device',
  system: 'Android recognizer',
} as const;

/** "Listening in Romanian · Android recognizer" (or auto-detect). */
function listeningDescription(listening: {
  engine: keyof typeof LISTENING_ENGINES;
  language: string;
}): string {
  let language = 'auto-detected language';
  if (listening.language !== 'auto') {
    try {
      language =
        new Intl.DisplayNames(['en'], { type: 'language' }).of(
          listening.language,
        ) ?? listening.language;
    } catch {
      language = listening.language;
    }
  }
  return `Listening in ${language} · ${LISTENING_ENGINES[listening.engine]}`;
}

export const LiveModePanel = forwardRef<
  LiveModePanelHandle,
  LiveModePanelProps
>(function LiveModePanel(
  {
    projectId,
    activeConversationId,
    agentCmd,
    runtimeSelection,
    personaDriven = false,
    draftEnabled = false,
    draftKind = 'work',
    onDraftEnabledChange,
    onDraftKindChange,
    allowDraftStart = true,
    onDraftTranscript,
  },
  ref,
) {
  const { data: projects = [] } = useProjects();
  const queryClient = useQueryClient();
  const localEnabled = useStore((s) => s.liveModeEnabled);
  const focusedId = useStore((s) => s.liveModeFocusedConversationId);
  const focusedProjectId = useStore((s) => s.liveModeCurrentProjectId);
  const enabled = useStore((s) =>
    activeConversationId
      ? s.liveModeEnabledByConversation[activeConversationId] === true
      : draftEnabled,
  );
  const registry = useStore((s) => s.liveModeRegistry);
  const setEnabled = useStore((s) => s.setLiveModeEnabled);
  const setConversationEnabled = useStore(
    (s) => s.setConversationLiveModeEnabled,
  );
  const setConversationSession = useStore(
    (s) => s.setConversationLiveModeSession,
  );
  const liveModeKind = useStore((s) =>
    resolveLiveModeKind(
      activeConversationId
        ? s.liveModeKindByConversation[activeConversationId]
        : draftKind,
      personaDriven,
    ),
  );
  const setConversationKind = useStore((s) => s.setConversationLiveModeKind);
  const setFocus = useStore((s) => s.setLiveModeFocus);
  const setRegistry = useStore((s) => s.setLiveModeRegistry);
  const liveModeSessionId = useStore((s) => s.liveModeSessionId);
  const playbackSessionId = useStore((s) =>
    activeConversationId
      ? (s.liveModeSessionByConversation[activeConversationId] ?? null)
      : null,
  );
  const locallyOwned =
    localEnabled &&
    focusedId === activeConversationId &&
    focusedProjectId === projectId;
  const draftListening = !activeConversationId && draftEnabled;
  const microphoneKey = activeConversationId ?? `project:${projectId}:new`;
  const microphoneEnabled = useStore(
    (s) => s.liveModeMicrophoneEnabledByConversation[microphoneKey] === true,
  );
  const setMicrophoneEnabled = useStore((s) => s.setLiveModeMicrophoneEnabled);
  const chosenLanguage = useStore(
    (s) => s.liveModeLanguageByConversation[microphoneKey],
  );
  const setChosenLanguage = useStore((s) => s.setLiveModeLanguage);
  const languageOptions = useSpeechLanguageOptions();
  const microphoneMuted = !microphoneEnabled;
  const speech = useLiveSpeech();
  const announceCompletions = speech.announceCompletions;
  useEffect(() => {
    if (!enabled || speech.error !== 'Audio permission required') return;
    const retry = () => retryBlockedLiveSpeech();
    document.addEventListener('pointerdown', retry, {
      once: true,
      capture: true,
    });
    document.addEventListener('keydown', retry, { once: true, capture: true });
    return () => {
      document.removeEventListener('pointerdown', retry, { capture: true });
      document.removeEventListener('keydown', retry, { capture: true });
    };
  }, [enabled, speech.error]);
  const hydrated = useRef(false);
  const ownershipChannelRef = useRef<BroadcastChannel | null>(null);
  const agentCmdRef = useRef(agentCmd);
  agentCmdRef.current = agentCmd;
  const runtimeSelectionRef = useRef(runtimeSelection);
  runtimeSelectionRef.current = runtimeSelection;
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel('carapa-live-mode-owner');
    ownershipChannelRef.current = channel;
    channel.onmessage = (event) => {
      const ownerSessionId = String(event.data?.liveModeSessionId || '');
      if (!ownerSessionId || ownerSessionId === liveModeSessionId) return;
      // A different tab has claimed the single playback owner. Stop this
      // tab's audio and discard its local ownership without changing the
      // conversation's server-authoritative on/off state.
      void cutOffLiveSpeechForServerStop();
      setEnabled(false);
      setFocus(null, null);
    };
    return () => {
      if (ownershipChannelRef.current === channel)
        ownershipChannelRef.current = null;
      channel.close();
    };
  }, [liveModeSessionId, setEnabled, setFocus]);
  const draftTranscriptInFlight = useRef(false);
  const onDraftTranscriptRef = useRef(onDraftTranscript);
  onDraftTranscriptRef.current = onDraftTranscript;
  const submitTranscript = async (text: string) => {
    if (draftListening) {
      // Only the first phrase creates the conversation; ignore anything
      // spoken while that send is still in flight.
      if (draftTranscriptInFlight.current) return;
      draftTranscriptInFlight.current = true;
      try {
        await onDraftTranscriptRef.current?.(text);
      } finally {
        draftTranscriptInFlight.current = false;
      }
      return;
    }
    if (!activeConversationId || !locallyOwned) return;
    await submitLiveModeTranscriptWithQueueOwnership({
      projectId,
      conversationId: activeConversationId,
      text,
      agentCmd: agentCmdRef.current,
      runtimeSelection: runtimeSelectionRef.current,
      liveModeSessionId,
      liveModeKind,
    });
  };
  const voice = useLiveVoice(
    (locallyOwned || draftListening) && microphoneEnabled,
    submitTranscript,
    { suppressReplyEcho: true, reconnect: true, language: chosenLanguage },
  );
  useEffect(() => {
    const playbackConversationId =
      enabled && activeConversationId
        ? activeConversationId
        : localEnabled
          ? focusedId
          : null;
    setLiveSpeechFocus(playbackConversationId);
    if (enabled && playbackSessionId) {
      void activateNativeSpeechSession(playbackSessionId).catch(
        () => undefined,
      );
    }
    return () => setLiveSpeechFocus(null);
  }, [
    activeConversationId,
    enabled,
    focusedId,
    localEnabled,
    playbackSessionId,
  ]);
  useEffect(() => {
    if (!localEnabled) hydrated.current = false;
  }, [localEnabled]);
  useEffect(() => {
    if (!activeConversationId || !enabled) return;
    const beat = () => {
      void heartbeatPersonaLiveMode(
        projectId,
        activeConversationId,
        liveModeSessionId,
      ).catch(() => undefined);
    };
    beat();
    const timer = window.setInterval(beat, 5_000);
    return () => window.clearInterval(timer);
  }, [activeConversationId, enabled, liveModeSessionId, projectId]);
  const liveModeStatus = useQuery({
    queryKey: queryKeys.personaLiveMode.status(
      projectId,
      activeConversationId!,
    ),
    queryFn: () =>
      getPersonaLiveMode(projectId, activeConversationId!, liveModeSessionId),
    enabled: Boolean(activeConversationId),
  });
  useEffect(() => {
    if (!activeConversationId || Capacitor.getPlatform() !== 'android') return;
    const watchedConversationId = activeConversationId;
    return () => {
      void leavePersonaLiveMode(projectId, watchedConversationId).catch(
        () => undefined,
      );
    };
  }, [activeConversationId, projectId]);
  useEffect(() => {
    if (!activeConversationId || !liveModeStatus.data) return;
    setConversationEnabled(activeConversationId, liveModeStatus.data.enabled);
    setConversationSession(
      activeConversationId,
      liveModeStatus.data.liveModeSessionId,
    );
    if (liveModeStatus.data.liveModeKind)
      setConversationKind(
        activeConversationId,
        liveModeStatus.data.liveModeKind,
      );
    if (liveModeStatus.data.enabled && liveModeStatus.data.ownedBySession) {
      setEnabled(true);
      setFocus(activeConversationId, projectId);
    } else if (
      !liveModeStatus.data.enabled &&
      useStore.getState().liveModeFocusedConversationId === activeConversationId
    ) {
      // Another device stopped Live Mode while this one missed the broadcast
      // (for example a locked tablet). Drop stale local ownership and capture.
      void cutOffLiveSpeechForServerStop();
      setEnabled(false);
      setFocus(null, null);
    }
    if (
      liveModeStatus.data.enabled &&
      liveModeStatus.data.liveModeKind === 'personas' &&
      liveModeStatus.data.liveModeSessionId
    ) {
      for (const playback of liveModeStatus.data.resumePlaybacks) {
        resumePersonaPlayback(
          projectId,
          activeConversationId,
          liveModeStatus.data.liveModeSessionId,
          playback,
        );
      }
      const snapshot = liveModeStatus.data.snapshot;
      const item = snapshot?.current;
      const canPlay =
        item && (item.state === 'playing' || item.state === 'released');
      if (snapshot && item && canPlay) {
        resumePersonaPlayback(
          projectId,
          activeConversationId,
          snapshot.leaderSessionId!,
          {
            messageId: item.messageId,
            text: item.text,
          },
          {
            item,
            runId: snapshot.runId,
            offsetSeconds:
              item.state === 'playing' && item.startedAt
                ? Math.max(0, (Date.now() - Date.parse(item.startedAt)) / 1000)
                : 0,
          },
        );
      }
    }
  }, [
    activeConversationId,
    liveModeStatus.data,
    projectId,
    setConversationEnabled,
    setConversationKind,
    setConversationSession,
    setEnabled,
    setFocus,
  ]);

  const patchStoppedStatus = (conversationId: string) =>
    patchPersonaLiveModeStatus(queryClient, conversationId, {
      enabled: false,
      ownedBySession: false,
      liveModeSessionId: null,
    });

  const toggleLiveMode = async (kindOverride?: 'personas' | 'work') => {
    const nextEnabled = !enabled;
    const startKind = kindOverride ?? liveModeKind;
    if (!activeConversationId) {
      if (nextEnabled) {
        try {
          if (localEnabled && focusedId && focusedProjectId) {
            await Promise.all([
              stopChatAgent(focusedProjectId, focusedId).catch(() => undefined),
              setPersonaLiveMode(
                focusedProjectId,
                focusedId,
                false,
                liveModeSessionId,
                liveModeKind,
              ),
            ]);
            setConversationEnabled(focusedId, false);
            patchStoppedStatus(focusedId);
          }
          await activateNativeSpeechSession(liveModeSessionId);
        } catch {
          return;
        }
      }
      if (nextEnabled && kindOverride) onDraftKindChange?.(kindOverride);
      // A voice-started chat needs an armed microphone to receive the first phrase.
      if (nextEnabled) setMicrophoneEnabled(microphoneKey, true);
      // A user Stop silences this device at once, also in a draft chat.
      if (!nextEnabled) void cutOffLiveSpeech();
      onDraftEnabledChange?.(nextEnabled);
      return;
    }
    if (!nextEnabled) {
      // A user Stop means silence now: cut the current clip, queued and
      // prepared clips, and Android native speech immediately (the cut
      // reply's text is released), in parallel with the server stop. The
      // server-side stop protocol (lookahead cancellation, durable stop
      // signal) is unchanged.
      void cutOffLiveSpeech();
      if (locallyOwned) {
        try {
          await stopChatAgent(projectId, activeConversationId);
        } catch {
          return;
        }
      } else {
        await stopChatAgent(projectId, activeConversationId).catch(
          () => undefined,
        );
      }
    }
    // Register pacing before the browser begins accepting persona audio. This
    // prevents an already-running text discussion from filling the speech
    // queue during the toggle round trip.
    try {
      if (
        nextEnabled &&
        localEnabled &&
        focusedId &&
        focusedId !== activeConversationId &&
        focusedProjectId
      ) {
        await Promise.all([
          stopChatAgent(focusedProjectId, focusedId).catch(() => undefined),
          setPersonaLiveMode(
            focusedProjectId,
            focusedId,
            false,
            liveModeSessionId,
            liveModeKind,
          ),
        ]);
        setConversationEnabled(focusedId, false);
        patchStoppedStatus(focusedId);
      }
      if (nextEnabled) await activateNativeSpeechSession(liveModeSessionId);
      const registration = await setPersonaLiveMode(
        projectId,
        activeConversationId,
        nextEnabled,
        liveModeSessionId,
        startKind,
      );
      setConversationEnabled(activeConversationId, registration.enabled);
      setConversationKind(activeConversationId, registration.liveModeKind);
      // Keep the cached status in step with this user action; otherwise a
      // quick round trip through another conversation re-applies the stale one.
      queryClient.setQueryData<Awaited<ReturnType<typeof getPersonaLiveMode>>>(
        queryKeys.personaLiveMode.status(projectId, activeConversationId!),
        {
          enabled: registration.enabled,
          ownedBySession: registration.enabled,
          liveModeKind: registration.liveModeKind,
          liveModeSessionId: registration.liveModeSessionId,
          resumePlaybacks: [],
          snapshot: null,
        },
      );
      if (nextEnabled) {
        setFocus(activeConversationId, projectId);
        ownershipChannelRef.current?.postMessage({ liveModeSessionId });
      } else if (focusedId === activeConversationId) {
        setFocus(null, null);
      }
      if (
        nextEnabled &&
        registration.liveModeKind === 'personas' &&
        registration.resumePlaybacks.length > 0
      ) {
        // Rebuild the speech queue explicitly: the original chat_message and
        // speech_ready events may have happened while this client was away.
        for (const playback of registration.resumePlaybacks) {
          resumePersonaPlayback(
            projectId,
            activeConversationId,
            liveModeSessionId,
            playback,
          );
        }
      }
      const current = registration.snapshot?.current;
      if (
        nextEnabled &&
        registration.liveModeKind === 'personas' &&
        registration.snapshot &&
        current &&
        (current.state === 'released' || current.state === 'playing')
      ) {
        resumePersonaPlayback(
          projectId,
          activeConversationId,
          liveModeSessionId,
          {
            messageId: current.messageId,
            text: current.text,
          },
          {
            item: current,
            runId: registration.snapshot.runId,
            offsetSeconds:
              current.state === 'playing' && current.startedAt
                ? Math.max(
                    0,
                    (Date.now() - Date.parse(current.startedAt)) / 1000,
                  )
                : 0,
          },
        );
      }
      setEnabled(nextEnabled ? true : locallyOwned ? false : localEnabled);
    } catch {
      return;
    }
  };

  useImperativeHandle(
    ref,
    () => ({
      start: (kind) => {
        if (enabled || (!activeConversationId && !allowDraftStart)) return;
        if (kind === 'personas' && !personaDriven) return;
        void toggleLiveMode(kind);
      },
    }),
    [
      activeConversationId,
      allowDraftStart,
      enabled,
      personaDriven,
      toggleLiveMode,
    ],
  );

  const project = projects.find((p) => p.id === projectId);
  const projectConversations = useQuery({
    queryKey: queryKeys.liveMode.conversations(projectId),
    // Cached as InfiniteData<Conversation[]>: files-tab and changes-tab read
    // every ['conversations'] entry as that shape.
    queryFn: async () => ({
      pages: [await fetchConversations(projectId, 2000)],
      pageParams: [0],
    }),
    select: (data) => data.pages.flat(),
    enabled: localEnabled && Boolean(project),
  });
  const projectActivity = useQuery({
    queryKey: queryKeys.liveMode.registry(projectId),
    queryFn: () => fetchLiveActivity(projectId),
    enabled: localEnabled && Boolean(project),
    refetchInterval: localEnabled ? 5000 : false,
  });
  const accessible = useMemo(() => {
    if (!project || !projectConversations.data || !projectActivity.data)
      return [];
    const activities = new Map(
      projectActivity.data.activities.map((a) => [a.conversation_id, a]),
    );
    return projectConversations.data.map((conversation) =>
      metadataFromConversation(
        conversation,
        project.name,
        activities.get(conversation.id),
      ),
    );
  }, [project, projectConversations.data, projectActivity.data]);
  useEffect(() => {
    if (!localEnabled) return;
    if (
      project &&
      (projectConversations.isPending || projectActivity.isPending)
    )
      return;
    if (!hydrated.current) {
      // Enabling and websocket reconnects can deliver a full historical
      // snapshot. Establish that snapshot as the silent comparison baseline.
      hydrated.current = true;
    }
    const current = registry
      .map(
        (item) => `${item.conversationId}:${item.state}:${item.status ?? ''}`,
      )
      .join('|');
    const next = accessible
      .map(
        (item) => `${item.conversationId}:${item.state}:${item.status ?? ''}`,
      )
      .join('|');
    if (current !== next) setRegistry(accessible);
  }, [
    localEnabled,
    accessible,
    registry,
    setRegistry,
    project,
    projectConversations.isPending,
    projectActivity.isPending,
  ]);

  if (!enabled) return null;

  return (
    <div
      data-testid="live-mode-composer-controls"
      className="rounded-xl border border-border bg-muted/20 px-2 py-1.5 sm:px-3 sm:py-2"
    >
      <div className="flex flex-row flex-nowrap items-center gap-1.5 sm:flex-wrap sm:gap-2 lg:flex-nowrap">
        <Button
          data-ui="live-mode-toggle"
          size="sm"
          variant={enabled ? 'destructive' : 'outline'}
          className="w-auto shrink-0 gap-1.5"
          aria-label={enabled ? 'Stop Live Mode' : 'Start Live Mode'}
          disabled={!activeConversationId && !allowDraftStart}
          onClick={() => {
            void toggleLiveMode();
          }}
        >
          {enabled ? (
            <Square className="size-3.5" />
          ) : (
            <Radio className={cn('size-3.5', enabled && 'animate-pulse')} />
          )}{' '}
          {enabled ? 'Stop Live Mode' : 'Live Mode'}
        </Button>
        <Select
          data-ui="live-mode-kind"
          aria-label="Live Mode speech policy"
          compact
          className={cn(
            'min-w-0 flex-1 sm:flex-initial',
            enabled && 'hidden sm:inline-flex',
          )}
          value={liveModeKind}
          disabled={enabled || (!activeConversationId && !allowDraftStart)}
          onValueChange={(nextValue) => {
            const nextKind = nextValue === 'work' ? 'work' : 'personas';
            if (activeConversationId)
              setConversationKind(activeConversationId, nextKind);
            else onDraftKindChange?.(nextKind);
          }}
        >
          <SelectItem value="personas" disabled={!personaDriven}>
            Persona · full replies
          </SelectItem>
          <SelectItem value="work">Work · short narration</SelectItem>
        </Select>
        {!personaDriven && (
          <span
            data-ui="live-mode-persona-hint"
            className="min-w-0 truncate text-xs text-muted-foreground"
          >
            {PERSONA_LIVE_MODE_HINT}
          </span>
        )}
        {enabled && !activeConversationId && (
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            Starts with the first message
          </span>
        )}
        {enabled && activeConversationId && !locallyOwned && (
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            Live Mode active on another device
          </span>
        )}
        {(locallyOwned || draftListening) && (
          <div
            className="ml-auto flex shrink-0 items-center gap-1"
            data-ui="live-mode-audio-controls"
          >
            {microphoneEnabled && voice.listening && (
              <ListeningLanguagePicker
                dataUi="live-mode-listening-language"
                selectDataUi="live-mode-language-select"
                data-engine={voice.listening.engine}
                language={voice.listening.language}
                value={chosenLanguage ?? ''}
                options={languageOptions}
                title={`${listeningDescription(voice.listening)} · change for this chat`}
                ariaLabel={`${listeningDescription(voice.listening)}. Speech language for this chat`}
                onChange={(code) =>
                  setChosenLanguage(microphoneKey, code || null)
                }
              />
            )}
            <Button
              type="button"
              data-ui="live-mode-microphone-toggle"
              data-state={microphoneEnabled ? 'on' : 'off'}
              size="icon-sm"
              variant="outline"
              className={cn(
                microphoneEnabled &&
                  'border-primary/40 bg-primary/10 text-primary',
              )}
              aria-label={
                microphoneEnabled
                  ? 'Mute Live Mode microphone'
                  : 'Unmute Live Mode microphone'
              }
              aria-pressed={microphoneEnabled}
              title={
                microphoneEnabled ? 'Mute microphone' : 'Unmute microphone'
              }
              onClick={() =>
                setMicrophoneEnabled(microphoneKey, !microphoneEnabled)
              }
            >
              {microphoneEnabled ? (
                <Mic className="size-3.5" />
              ) : (
                <MicOff className="size-3.5" />
              )}
            </Button>
            {locallyOwned && (
              <>
                <Button
                  type="button"
                  data-ui="live-mode-speech-toggle"
                  data-state={speech.muted ? 'off' : 'on'}
                  size="icon-sm"
                  variant="outline"
                  className={cn(
                    !speech.muted &&
                      'border-primary/40 bg-primary/10 text-primary',
                  )}
                  aria-label={
                    speech.muted
                      ? 'Unmute Live Mode speech'
                      : 'Mute Live Mode speech'
                  }
                  aria-pressed={!speech.muted}
                  title={speech.muted ? 'Unmute speech' : 'Mute speech'}
                  onClick={() => setLiveSpeechMuted(!speech.muted)}
                >
                  {speech.muted ? (
                    <VolumeX className="size-3.5" />
                  ) : (
                    <Volume2 className="size-3.5" />
                  )}
                </Button>
                <Button
                  type="button"
                  data-ui="live-mode-background-announcements-toggle"
                  data-state={announceCompletions ? 'on' : 'off'}
                  size="icon-sm"
                  variant="outline"
                  className={cn(
                    announceCompletions &&
                      'border-primary/40 bg-primary/10 text-primary',
                  )}
                  aria-label={
                    announceCompletions
                      ? 'Disable background completion announcements'
                      : 'Announce background completion'
                  }
                  aria-pressed={announceCompletions}
                  title={
                    announceCompletions
                      ? 'Disable background completion announcements'
                      : 'Announce background completion'
                  }
                  onClick={() => {
                    setLiveCompletionAnnouncements(!announceCompletions);
                  }}
                >
                  {announceCompletions ? (
                    <Bell className="size-3.5" />
                  ) : (
                    <BellOff className="size-3.5" />
                  )}
                </Button>
              </>
            )}
          </div>
        )}
        {enabled && speech.error === 'Audio permission required' && (
          <button
            type="button"
            data-ui="live-mode-enable-audio"
            className="text-left text-[11px] text-primary underline"
            title="Allow this device to play Live Mode speech"
            onClick={retryBlockedLiveSpeech}
          >
            Enable audio
          </button>
        )}
      </div>
      {(locallyOwned || draftListening) && (
        <span role="status" className="sr-only" aria-label="Live audio state">
          Microphone {microphoneMuted ? 'off' : voice.status}. Speech{' '}
          {speech.error ? `error: ${speech.error}` : speech.status}.
        </span>
      )}
    </div>
  );
});
