import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bot,
  Eye,
  FileText,
  Loader2,
  LockKeyhole,
  MessageCircle,
  Pause,
  Play,
  Radio,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  Square,
  UserRound,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { MarkdownContent } from '@/components/markdown-content-lazy';
import { Button } from '@/components/ui/button';
import { API_BASE_URL } from '@/lib/api-config';
import {
  mergeOlderPage,
  mergeRefreshedPage,
} from '@/lib/public-share-messages';
import { nextPromptPollDecision } from '@/lib/public-share-prompt-poll';
import { PublicSpeechRequestGate } from '@/lib/public-speech-request';
import {
  nextPublicReplayMessageId,
  nextPublicReplaySpeakerId,
  PUBLIC_REPLAY_READING_DELAY_MS,
  publicReplayAudioProgress,
  publicReplayMessageVisibility,
} from '@/lib/public-conversation-replay';
import type {
  PublicAttachment,
  PublicConversationMessage,
  PublicConversationResponse,
} from '@/types';
import { cn } from '@/lib/utils';

// Violet accents (borders, tints, glows, progress fill) and the white-on-gradient
// logo are translucent or saturated mid-tones that read on both themes.
function publicApi(path: string): string {
  return `${API_BASE_URL}${path}`;
}

function PublicAttachmentView({
  attachment,
}: {
  attachment: PublicAttachment;
}) {
  const url = publicApi(attachment.url);
  if (attachment.type === 'image') {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer">
        <img
          src={url}
          alt={attachment.caption || attachment.filename || 'Attached image'}
          className="max-h-[32rem] w-auto max-w-full rounded-2xl border border-border/60 object-contain shadow-sm"
        />
      </a>
    );
  }
  if (attachment.type === 'video')
    return (
      <video
        src={url}
        controls
        className="max-h-[32rem] max-w-full rounded-2xl border border-border/60 shadow-sm"
      />
    );
  if (attachment.type === 'audio')
    return <audio src={url} controls className="w-full" />;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-2 rounded-xl border border-border/60 bg-background/60 px-3 py-2 text-sm transition-colors hover:bg-muted"
    >
      <FileText className="size-4" />{' '}
      {attachment.filename || 'Download attachment'}
    </a>
  );
}

function messageTime(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function messageDay(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year:
      date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  }).format(date);
}

function messageDayKey(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toDateString();
}

function PersonaAvatar({ message }: { message: PublicConversationMessage }) {
  const [failed, setFailed] = useState(false);
  const initial = (message.displayName || 'A').trim().charAt(0).toUpperCase();
  const avatarUrl = message.avatarUrl ? publicApi(message.avatarUrl) : null;
  return (
    <div
      data-ui={
        message.isPersona ? 'public-persona-avatar' : 'public-message-avatar'
      }
      className={cn(
        'relative flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-3xl border shadow-md sm:size-28',
        message.isPersona
          ? 'border-violet-400/25 bg-gradient-to-br from-violet-500/20 to-fuchsia-500/10 text-violet-700 dark:text-violet-500'
          : 'border-border/60 bg-muted text-muted-foreground',
      )}
    >
      {avatarUrl && !failed ? (
        <img
          src={avatarUrl}
          alt={`${message.displayName || 'Persona'} avatar`}
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : message.isPersona ? (
        <span className="text-3xl font-semibold">{initial}</span>
      ) : (
        <Bot className="size-5" />
      )}
    </div>
  );
}

function PublicSharePage() {
  const { token } = Route.useParams();
  const [data, setData] = useState<PublicConversationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [visitorSession, setVisitorSession] = useState<{
    csrfToken: string;
    displayName: string;
  } | null>(null);
  const [promptState, setPromptState] = useState<{
    status:
      | 'idle'
      | 'judging'
      | 'running'
      | 'rejected'
      | 'rate-limited'
      | 'unavailable'
      | 'completed';
    requestId?: string;
    message?: string;
  }>({ status: 'idle' });
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  // Whether focus has to be handed back to the prompt textarea once the
  // disabled-while-busy window ends.
  const promptRestoreFocusRef = useRef(false);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [speechPlayback, setSpeechPlayback] = useState<{
    messageId: string;
    phase: 'loading' | 'playing';
  } | null>(null);
  const [replay, setReplay] = useState<{
    startMessageId: string;
    currentMessageId: string;
    phase: 'preparing' | 'playing' | 'paused' | 'waiting' | 'error';
    progress: number;
    error: string | null;
  } | null>(null);
  // Latched once the owner revokes the link: in-flight reads that were
  // authorized before revocation must not restore the conversation.
  const revokedRef = useRef(false);
  const dataRef = useRef(data);
  dataRef.current = data;
  const readySpeechIdsRef = useRef(new Set<string>());
  for (const message of data?.messages ?? []) {
    if (message.speech?.state === 'ready')
      readySpeechIdsRef.current.add(message.id);
  }
  const speechPlaybackRef = useRef<typeof speechPlayback>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const replayRef = useRef<{
    generation: number;
    startMessageId: string;
    currentMessageId: string;
    paused: boolean;
    resumePhase: 'preparing' | 'playing' | 'waiting';
    timer: ReturnType<typeof setTimeout> | null;
    timerStartedAt: number;
    timerRemainingMs: number;
    frame: number | null;
    revealedWords: number;
  } | null>(null);
  const replayGenerationRef = useRef(0);
  const speechPrefetchesRef = useRef(
    new Map<
      string,
      {
        controller: AbortController;
        promise: Promise<void>;
      }
    >(),
  );
  const speechRequestsRef = useRef(new PublicSpeechRequestGate());
  const clearAudio = useCallback(() => {
    speechRequestsRef.current.cancel();
    const controller = replayRef.current;
    if (controller?.timer) clearTimeout(controller.timer);
    if (
      controller?.frame !== null &&
      controller?.frame !== undefined &&
      typeof cancelAnimationFrame === 'function'
    ) {
      cancelAnimationFrame(controller.frame);
    }
    if (controller) {
      controller.timer = null;
      controller.frame = null;
    }
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.pause();
      audioRef.current.removeAttribute('src');
      audioRef.current.load();
    }
    audioRef.current = null;
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = null;
    speechPlaybackRef.current = null;
    setSpeechPlayback(null);
  }, []);

  const stopReplay = useCallback(() => {
    replayGenerationRef.current += 1;
    for (const prefetch of speechPrefetchesRef.current.values())
      prefetch.controller.abort();
    speechPrefetchesRef.current.clear();
    clearAudio();
    replayRef.current = null;
    setReplay(null);
  }, [clearAudio]);

  const stopAudio = useCallback(() => {
    clearAudio();
  }, [clearAudio]);

  const fetchPage = useCallback(
    async (offset = 0) => {
      const response = await fetch(
        publicApi(
          `/api/public/conversations/${encodeURIComponent(token)}?limit=100&offset=${offset}`,
        ),
        { cache: 'no-store' },
      );
      if (!response.ok)
        throw new Error(
          response.status === 404
            ? 'This public link is unavailable.'
            : 'Unable to load the conversation.',
        );
      return response.json() as Promise<PublicConversationResponse>;
    },
    [token],
  );

  const refresh = useCallback(
    async (autoSpeakId?: string) => {
      const next = await fetchPage(0);
      if (revokedRef.current) return;
      setData((current) => mergeRefreshedPage(current, next));
      if (
        autoSpeakId &&
        soundEnabled &&
        next.conversation.liveMode &&
        !replayRef.current
      ) {
        const message = next.messages.find(
          (item) => item.id === autoSpeakId && item.speechAvailable,
        );
        if (message) void playSpeech(message);
      }
      // playSpeech intentionally reads the stable token and audio refs; adding it
      // here would recreate the SSE connection on every audio state change.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [fetchPage, soundEnabled],
  );

  const markSpeechReady = useCallback(
    (
      messageId: string,
      descriptor: {
        durationMs?: unknown;
        mimeType?: unknown;
      },
    ) => {
      readySpeechIdsRef.current.add(messageId);
      setData((current) =>
        current
          ? {
              ...current,
              messages: current.messages.map((item) =>
                item.id !== messageId || !item.speech
                  ? item
                  : {
                      ...item,
                      speech: {
                        ...item.speech,
                        state: 'ready',
                        durationMs:
                          typeof descriptor.durationMs === 'number'
                            ? descriptor.durationMs
                            : item.speech.durationMs,
                        mimeType:
                          typeof descriptor.mimeType === 'string'
                            ? descriptor.mimeType
                            : item.speech.mimeType,
                      },
                    },
              ),
            }
          : current,
      );
    },
    [],
  );

  const loadSpeechBlob = useCallback(
    async (
      message: PublicConversationMessage,
      request: ReturnType<PublicSpeechRequestGate['begin']>,
    ): Promise<Blob> => {
      const speechUrl = publicApi(
        message.speech?.url ??
          `/api/public/conversations/${encodeURIComponent(token)}/messages/${encodeURIComponent(message.id)}/speech`,
      );
      const prepareSpeech = async () => {
        const prepared = await fetch(`${speechUrl}?prepare=1`, {
          method: 'POST',
          signal: request.signal,
        });
        if (!prepared.ok)
          throw new Error('Speech is unavailable for this message.');
        const descriptor = (await prepared.json()) as {
          durationMs?: unknown;
          mimeType?: unknown;
        };
        if (!speechRequestsRef.current.isCurrent(request))
          throw new DOMException('Speech request cancelled', 'AbortError');
        markSpeechReady(message.id, descriptor);
      };
      if (
        message.speech?.state !== 'ready' &&
        !readySpeechIdsRef.current.has(message.id)
      ) {
        const prefetch = speechPrefetchesRef.current.get(message.id);
        if (prefetch) {
          await prefetch.promise;
          if (!speechRequestsRef.current.isCurrent(request))
            throw new DOMException('Speech request cancelled', 'AbortError');
        }
      }
      if (
        message.speech?.state !== 'ready' &&
        !readySpeechIdsRef.current.has(message.id)
      ) {
        await prepareSpeech();
      }
      let response = await fetch(speechUrl, { signal: request.signal });
      // The page may have loaded a ready descriptor immediately before an
      // administrator clears the filesystem cache. Let GET invalidate that
      // stale server link, then prepare and retry once without a page refresh.
      if (response.status === 404) {
        readySpeechIdsRef.current.delete(message.id);
        await prepareSpeech();
        response = await fetch(speechUrl, { signal: request.signal });
      }
      if (!response.ok)
        throw new Error('Speech is unavailable for this message.');
      return response.blob();
    },
    [markSpeechReady, token],
  );

  const playSpeech = useCallback(
    async (message: PublicConversationMessage) => {
      stopReplay();
      const request = speechRequestsRef.current.begin();
      setSoundEnabled(true);
      speechPlaybackRef.current = { messageId: message.id, phase: 'loading' };
      setSpeechPlayback(speechPlaybackRef.current);
      setError(null);
      try {
        const blob = await loadSpeechBlob(message, request);
        if (!speechRequestsRef.current.isCurrent(request)) return;
        const url = URL.createObjectURL(blob);
        if (!speechRequestsRef.current.isCurrent(request)) {
          URL.revokeObjectURL(url);
          return;
        }
        audioUrlRef.current = url;
        const audio = new Audio(url);
        audioRef.current = audio;
        const finish = () => {
          if (
            speechRequestsRef.current.isCurrent(request) &&
            audioRef.current === audio
          )
            stopAudio();
        };
        audio.onended = finish;
        audio.onerror = finish;
        speechPlaybackRef.current = { messageId: message.id, phase: 'playing' };
        setSpeechPlayback(speechPlaybackRef.current);
        await audio.play();
      } catch (speechError) {
        if (
          request.signal.aborted ||
          !speechRequestsRef.current.isCurrent(request)
        )
          return;
        stopAudio();
        setError(
          speechError instanceof Error
            ? speechError.message
            : 'Speech playback failed.',
        );
      }
    },
    [loadSpeechBlob, stopAudio, stopReplay],
  );

  const advanceReplayRef = useRef<
    (generation: number, messageId: string) => void
  >(() => {});

  const scrollReplayMessageIntoView = useCallback((messageId: string) => {
    requestAnimationFrame(() => {
      const element = [
        ...document.querySelectorAll<HTMLElement>(
          '[data-ui="public-conversation-message"]',
        ),
      ].find((candidate) => candidate.dataset.messageId === messageId);
      element?.scrollIntoView({
        block: 'end',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'auto'
          : 'smooth',
      });
    });
  }, []);

  const scheduleReplayAdvance = useCallback(
    (generation: number, delayMs: number) => {
      const controller = replayRef.current;
      if (!controller || controller.generation !== generation) return;
      controller.timerRemainingMs = delayMs;
      controller.timerStartedAt = performance.now();
      controller.timer = setTimeout(() => {
        const current = replayRef.current;
        if (!current || current.generation !== generation || current.paused)
          return;
        current.timer = null;
        const ids =
          dataRef.current?.messages.map((message) => message.id) ?? [];
        const nextId = nextPublicReplayMessageId(ids, current.currentMessageId);
        if (nextId) advanceReplayRef.current(generation, nextId);
        else stopReplay();
      }, delayMs);
    },
    [stopReplay],
  );

  const prefetchNextReplaySpeaker = useCallback(
    (generation: number, currentMessageId: string) => {
      const controller = replayRef.current;
      const messages = dataRef.current?.messages ?? [];
      if (!controller || controller.generation !== generation) return;
      const nextSpeakerId = nextPublicReplaySpeakerId(
        messages,
        currentMessageId,
      );
      const nextSpeaker = messages.find(
        (message) => message.id === nextSpeakerId,
      );
      if (
        !nextSpeaker?.speech ||
        nextSpeaker.speech.state === 'ready' ||
        readySpeechIdsRef.current.has(nextSpeaker.id)
      )
        return;
      if (speechPrefetchesRef.current.has(nextSpeaker.id)) return;

      const abortController = new AbortController();
      const speechUrl = publicApi(
        nextSpeaker.speech.url ??
          `/api/public/conversations/${encodeURIComponent(token)}/messages/${encodeURIComponent(nextSpeaker.id)}/speech`,
      );
      const promise = (async () => {
        try {
          const response = await fetch(`${speechUrl}?prepare=1`, {
            method: 'POST',
            signal: abortController.signal,
          });
          if (!response.ok) return;
          const descriptor = (await response.json()) as {
            durationMs?: unknown;
            mimeType?: unknown;
          };
          if (
            replayRef.current?.generation !== generation ||
            abortController.signal.aborted
          )
            return;
          markSpeechReady(nextSpeaker.id, descriptor);
        } catch (prefetchError) {
          if (
            !(
              prefetchError instanceof DOMException &&
              prefetchError.name === 'AbortError'
            )
          ) {
            // Prefetch is opportunistic. The normal playback path reports any
            // real preparation failure when this speaker reaches the cursor.
          }
        } finally {
          const active = speechPrefetchesRef.current.get(nextSpeaker.id);
          if (active?.controller === abortController)
            speechPrefetchesRef.current.delete(nextSpeaker.id);
        }
      })();
      speechPrefetchesRef.current.set(nextSpeaker.id, {
        controller: abortController,
        promise,
      });
    },
    [markSpeechReady, token],
  );

  const advanceReplay = useCallback(
    async (generation: number, messageId: string) => {
      const controller = replayRef.current;
      if (!controller || controller.generation !== generation) return;
      clearAudio();
      const current = replayRef.current;
      if (!current || current.generation !== generation) return;
      const message = dataRef.current?.messages.find(
        (item) => item.id === messageId,
      );
      if (!message) {
        stopReplay();
        return;
      }
      current.currentMessageId = messageId;
      current.revealedWords = 0;
      current.resumePhase = message.speechAvailable ? 'preparing' : 'waiting';
      setReplay({
        startMessageId: current.startMessageId,
        currentMessageId: messageId,
        phase: current.paused ? 'paused' : current.resumePhase,
        progress: message.speechAvailable ? 0 : 1,
        error: null,
      });
      scrollReplayMessageIntoView(messageId);

      if (!message.speechAvailable) {
        prefetchNextReplaySpeaker(generation, messageId);
        scheduleReplayAdvance(generation, PUBLIC_REPLAY_READING_DELAY_MS);
        return;
      }

      const request = speechRequestsRef.current.begin();
      try {
        const blob = await loadSpeechBlob(message, request);
        if (!speechRequestsRef.current.isCurrent(request)) return;
        const url = URL.createObjectURL(blob);
        if (
          !speechRequestsRef.current.isCurrent(request) ||
          replayRef.current?.generation !== generation
        ) {
          URL.revokeObjectURL(url);
          return;
        }
        audioUrlRef.current = url;
        const audio = new Audio(url);
        audioRef.current = audio;
        const finish = () => {
          if (
            replayRef.current?.generation !== generation ||
            audioRef.current !== audio
          )
            return;
          clearAudio();
          const active = replayRef.current;
          if (!active || active.generation !== generation) return;
          active.resumePhase = 'waiting';
          setReplay((value) =>
            value ? { ...value, phase: 'waiting', progress: 1 } : value,
          );
          scheduleReplayAdvance(generation, 150);
        };
        audio.onended = finish;
        audio.onerror = () => {
          if (replayRef.current?.generation !== generation) return;
          clearAudio();
          setReplay((value) =>
            value
              ? {
                  ...value,
                  phase: 'error',
                  progress: 1,
                  error: 'Speech is unavailable for this message.',
                }
              : value,
          );
        };

        const playAndTrack = async () => {
          const active = replayRef.current;
          if (!active || active.generation !== generation) return;
          active.resumePhase = 'playing';
          if (active.paused) {
            setReplay((value) =>
              value ? { ...value, phase: 'paused' } : value,
            );
            return;
          }
          await audio.play();
          setReplay((value) =>
            value ? { ...value, phase: 'playing' } : value,
          );
          prefetchNextReplaySpeaker(generation, messageId);
          const updateProgress = () => {
            const replayController = replayRef.current;
            if (
              !replayController ||
              replayController.generation !== generation ||
              audioRef.current !== audio
            )
              return;
            const descriptorDuration = (message.speech?.durationMs ?? 0) / 1000;
            const duration =
              Number.isFinite(audio.duration) && audio.duration > 0
                ? audio.duration
                : descriptorDuration;
            const progress = publicReplayAudioProgress(
              audio.currentTime,
              duration,
            );
            const totalWords =
              message.content.trim().match(/\S+/g)?.length ?? 0;
            const revealedWords = Math.floor(totalWords * progress);
            if (
              revealedWords !== replayController.revealedWords ||
              progress >= 1
            ) {
              replayController.revealedWords = revealedWords;
              setReplay((value) =>
                value && value.currentMessageId === messageId
                  ? { ...value, progress }
                  : value,
              );
            }
            replayController.frame = requestAnimationFrame(updateProgress);
          };
          active.frame = requestAnimationFrame(updateProgress);
        };
        await playAndTrack();
      } catch (speechError) {
        if (
          request.signal.aborted ||
          replayRef.current?.generation !== generation
        )
          return;
        clearAudio();
        setReplay((value) =>
          value
            ? {
                ...value,
                phase: 'error',
                progress: 1,
                error:
                  speechError instanceof Error
                    ? speechError.message
                    : 'Speech playback failed.',
              }
            : value,
        );
      }
    },
    [
      clearAudio,
      loadSpeechBlob,
      prefetchNextReplaySpeaker,
      scheduleReplayAdvance,
      scrollReplayMessageIntoView,
      stopReplay,
    ],
  );
  advanceReplayRef.current = (generation, messageId) => {
    void advanceReplay(generation, messageId);
  };

  const startReplay = useCallback(
    (messageId: string) => {
      stopReplay();
      const generation = replayGenerationRef.current + 1;
      replayGenerationRef.current = generation;
      replayRef.current = {
        generation,
        startMessageId: messageId,
        currentMessageId: messageId,
        paused: false,
        resumePhase: 'preparing',
        timer: null,
        timerStartedAt: 0,
        timerRemainingMs: 0,
        frame: null,
        revealedWords: 0,
      };
      setSoundEnabled(true);
      void advanceReplay(generation, messageId);
    },
    [advanceReplay, stopReplay],
  );

  const pauseReplay = useCallback(() => {
    const controller = replayRef.current;
    if (!controller || controller.paused) return;
    controller.paused = true;
    const currentPhase = replay?.phase;
    if (currentPhase === 'playing') controller.resumePhase = 'playing';
    else if (currentPhase === 'waiting') controller.resumePhase = 'waiting';
    else controller.resumePhase = 'preparing';
    if (controller.timer) {
      clearTimeout(controller.timer);
      controller.timer = null;
      controller.timerRemainingMs = Math.max(
        0,
        controller.timerRemainingMs -
          (performance.now() - controller.timerStartedAt),
      );
    }
    if (controller.frame !== null && typeof cancelAnimationFrame === 'function')
      cancelAnimationFrame(controller.frame);
    controller.frame = null;
    audioRef.current?.pause();
    setReplay((value) => (value ? { ...value, phase: 'paused' } : value));
  }, [replay?.phase]);

  const resumeReplay = useCallback(() => {
    const controller = replayRef.current;
    if (!controller || !controller.paused) return;
    controller.paused = false;
    const generation = controller.generation;
    if (controller.resumePhase === 'waiting') {
      setReplay((value) => (value ? { ...value, phase: 'waiting' } : value));
      scheduleReplayAdvance(
        generation,
        controller.timerRemainingMs || PUBLIC_REPLAY_READING_DELAY_MS,
      );
      return;
    }
    if (controller.resumePhase === 'playing' && audioRef.current) {
      const audio = audioRef.current;
      setReplay((value) => (value ? { ...value, phase: 'playing' } : value));
      void audio.play();
      prefetchNextReplaySpeaker(generation, controller.currentMessageId);
      const updateProgress = () => {
        const active = replayRef.current;
        if (
          !active ||
          active.generation !== generation ||
          active.paused ||
          audioRef.current !== audio
        )
          return;
        const duration =
          Number.isFinite(audio.duration) && audio.duration > 0
            ? audio.duration
            : 0;
        const progress = publicReplayAudioProgress(audio.currentTime, duration);
        const message = dataRef.current?.messages.find(
          (item) => item.id === active.currentMessageId,
        );
        const totalWords = message?.content.trim().match(/\S+/g)?.length ?? 0;
        const revealedWords = Math.floor(totalWords * progress);
        if (revealedWords !== active.revealedWords || progress >= 1) {
          active.revealedWords = revealedWords;
          setReplay((value) => (value ? { ...value, progress } : value));
        }
        active.frame = requestAnimationFrame(updateProgress);
      };
      controller.frame = requestAnimationFrame(updateProgress);
      return;
    }
    setReplay((value) => (value ? { ...value, phase: 'preparing' } : value));
  }, [prefetchNextReplaySpeaker, scheduleReplayAdvance]);

  useEffect(() => {
    document.title = 'Shared conversation · CarapaBoard';
    const robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex, nofollow, noarchive';
    const referrer = document.createElement('meta');
    referrer.name = 'referrer';
    referrer.content = 'no-referrer';
    document.head.appendChild(robots);
    document.head.appendChild(referrer);
    revokedRef.current = false;
    void fetchPage()
      .then((next) => {
        if (!revokedRef.current) setData(next);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    return () => {
      robots.remove();
      referrer.remove();
      stopReplay();
    };
  }, [fetchPage, stopReplay]);

  useEffect(() => {
    const events = new EventSource(
      publicApi(
        `/api/public/conversations/${encodeURIComponent(token)}/events`,
      ),
    );
    events.addEventListener('connected', (event) => {
      setConnected(true);
      try {
        const payload = JSON.parse((event as MessageEvent).data);
        setData((current) =>
          current
            ? {
                ...current,
                conversation: {
                  ...current.conversation,
                  liveMode: payload.liveMode === true,
                },
              }
            : current,
        );
      } catch {
        /* reconnect refresh below is authoritative */
      }
    });
    events.addEventListener('changed', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data);
        void refresh(
          payload.autoSpeak === true ? payload.messageId : undefined,
        );
      } catch {
        void refresh();
      }
    });
    events.addEventListener('speechReady', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data);
        void refresh(
          payload.autoSpeak === true ? payload.messageId : undefined,
        );
      } catch {
        void refresh();
      }
    });
    events.addEventListener('speechFailed', () => {
      // Text remains authoritative; a later manual play can retry generation.
      void refresh();
    });
    events.addEventListener('liveMode', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data);
        setData((current) =>
          current
            ? {
                ...current,
                conversation: {
                  ...current.conversation,
                  liveMode: payload.enabled === true,
                },
              }
            : current,
        );
        if (payload.enabled !== true && !replayRef.current) stopAudio();
      } catch {
        /* ignore malformed event */
      }
    });
    events.addEventListener('revoked', () => {
      revokedRef.current = true;
      stopReplay();
      setError('This public link has been revoked.');
      setData(null);
      setPromptState({ status: 'idle' });
      setConnected(false);
      events.close();
    });
    events.onerror = () => setConnected(false);
    return () => events.close();
  }, [refresh, stopAudio, stopReplay, token]);

  useEffect(() => {
    if (!data?.conversation.visitorPromptingEnabled) {
      setVisitorSession(null);
      return;
    }
    let cancelled = false;
    void fetch(
      publicApi(
        `/api/public/conversations/${encodeURIComponent(token)}/visitor-session`,
      ),
      {
        cache: 'no-store',
        credentials: 'include',
      },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error('Visitor prompting is unavailable.');
        return response.json() as Promise<{
          csrfToken: string;
          displayName: string;
        }>;
      })
      .then((session) => {
        if (!cancelled) setVisitorSession(session);
      })
      .catch((sessionError) => {
        if (!cancelled)
          setPromptState({
            status: 'unavailable',
            message:
              sessionError instanceof Error
                ? sessionError.message
                : 'Visitor prompting is unavailable.',
          });
      });
    return () => {
      cancelled = true;
    };
  }, [data?.conversation.visitorPromptingEnabled, token]);

  useEffect(() => {
    if (
      !promptState.requestId ||
      !['judging', 'running'].includes(promptState.status)
    )
      return;
    let cancelled = false;
    const requestId = promptState.requestId;
    let consecutiveFailures = 0;
    const poll = async () => {
      let response: Response | null = null;
      try {
        response = await fetch(
          publicApi(
            `/api/public/conversations/${encodeURIComponent(token)}/prompts/${encodeURIComponent(requestId)}`,
          ),
          { cache: 'no-store', credentials: 'include' },
        );
      } catch {
        /* network error: handled as a failed poll below */
      }
      if (cancelled) return;
      const decision = nextPromptPollDecision(
        response?.status ?? 0,
        consecutiveFailures,
      );
      consecutiveFailures = decision.consecutiveFailures;
      if (decision.outcome === 'unavailable') {
        cancelled = true;
        setPromptState({
          status: 'unavailable',
          requestId,
          message:
            'This prompt is no longer available. Reload the page to try again.',
        });
        return;
      }
      if (decision.outcome === 'retry' || !response) return;
      const result = (await response.json()) as { status: string };
      if (cancelled) return;
      if (result.status === 'completed') {
        setPromptState({ status: 'completed', requestId });
        void refresh();
      } else if (result.status === 'rejected') {
        setPromptState({
          status: 'rejected',
          requestId,
          message: 'This prompt could not be submitted safely.',
        });
      } else if (result.status === 'failed') {
        setPromptState({
          status: 'unavailable',
          requestId,
          message: 'The personas could not complete this request.',
        });
      } else {
        setPromptState({
          status: result.status === 'judging' ? 'judging' : 'running',
          requestId,
        });
      }
    };
    const handle = setInterval(() => void poll().catch(() => undefined), 1500);
    void poll().catch(() => undefined);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [promptState.requestId, promptState.status, refresh, token]);

  // A disabled textarea drops focus to <body>, so give it back when the
  // prompt stops being judged/run — but only when the textarea actually held
  // focus when the send started, so page loads and unrelated state changes
  // never steal focus.
  useEffect(() => {
    if (!promptRestoreFocusRef.current) return;
    if (promptState.status === 'judging' || promptState.status === 'running')
      return;
    const textarea = promptRef.current;
    if (!textarea || textarea.disabled) return;
    const active = document.activeElement;
    // Only reclaim focus that was lost with the disabled textarea; never pull
    // it away from an element the visitor moved to on purpose.
    if (active && active !== textarea && active !== document.body) return;
    promptRestoreFocusRef.current = false;
    textarea.focus();
  }, [promptState.status]);

  const submitVisitorPrompt = async () => {
    const prompt = promptRef.current?.value.trim() || '';
    if (
      !prompt ||
      !visitorSession ||
      promptState.status === 'judging' ||
      promptState.status === 'running'
    )
      return;
    // Eligibility is the textarea actually holding focus when the send
    // starts: a send triggered from the Send button (Tab + Space, or a
    // click) must not pull focus into the composer afterwards.
    promptRestoreFocusRef.current =
      document.activeElement === promptRef.current;
    setPromptState({ status: 'judging' });
    try {
      const response = await fetch(
        publicApi(
          `/api/public/conversations/${encodeURIComponent(token)}/prompts`,
        ),
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'X-Public-CSRF': visitorSession.csrfToken,
          },
          body: JSON.stringify({ prompt }),
        },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        requestId?: string;
        error?: string;
      };
      if (!response.ok) {
        setPromptState({
          status:
            response.status === 429
              ? 'rate-limited'
              : response.status === 422
                ? 'rejected'
                : 'unavailable',
          message: payload.error || 'The prompt could not be submitted.',
        });
        return;
      }
      if (promptRef.current) promptRef.current.value = '';
      setPromptState({ status: 'running', requestId: payload.requestId });
      void refresh();
    } catch {
      setPromptState({
        status: 'unavailable',
        message: 'The prompt could not be submitted.',
      });
    }
  };

  const loadOlder = async () => {
    if (!data?.hasMore) return;
    setLoadingOlder(true);
    try {
      const older = await fetchPage(data.nextOffset);
      setData((current) =>
        current ? mergeOlderPage(current, older) : current,
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Unable to load older messages.',
      );
    } finally {
      setLoadingOlder(false);
    }
  };

  if (loading)
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-background via-background to-muted/30 text-muted-foreground">
        <Loader2 className="mr-2 size-5 animate-spin" /> Loading shared
        conversation…
      </div>
    );
  if (!data)
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-background via-background to-muted/30 p-6 text-center text-muted-foreground">
        <div className="max-w-sm rounded-2xl border border-border/60 bg-card/80 px-6 py-8 shadow-xl shadow-black/5">
          <LockKeyhole className="mx-auto mb-3 size-8 opacity-60" />
          {error || 'This public link is unavailable.'}
        </div>
      </div>
    );
  const publicMessageIds = data.messages.map((message) => message.id);

  return (
    <main
      data-ui="public-conversation"
      className="relative min-h-screen overflow-hidden bg-gradient-to-b from-background via-background to-muted/25"
    >
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 top-0 h-80 bg-[radial-gradient(ellipse_at_top,rgba(139,92,246,0.10),transparent_65%)]"
      />
      <header
        data-ui="public-conversation-header"
        className="sticky top-0 z-20 border-b border-border/50 bg-background/80 shadow-sm shadow-black/[0.03] backdrop-blur-xl"
      >
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:px-8">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-md shadow-violet-500/20">
              <MessageCircle className="size-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                <Eye className="size-3" /> Public conversation
              </div>
              <h1 className="truncate text-lg font-semibold tracking-tight sm:text-xl">
                {data.conversation.title}
              </h1>
            </div>
          </div>
          <div
            data-ui="public-conversation-header-controls"
            className="flex items-center gap-2 pl-[3.25rem] sm:pl-0"
          >
            {data.conversation.liveMode ? (
              <>
                <span
                  className={cn(
                    'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium',
                    connected
                      ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                      : 'border-border bg-muted/60 text-muted-foreground',
                  )}
                >
                  <span
                    className={cn(
                      'size-1.5 rounded-full',
                      connected
                        ? 'animate-pulse bg-emerald-600 dark:bg-emerald-500'
                        : 'bg-muted-foreground',
                    )}
                  />
                  {connected ? 'Watching live' : 'Reconnecting'}
                </span>
                {data.conversation.ttsEnabled && (
                  <Button
                    type="button"
                    size="sm"
                    variant={soundEnabled ? 'secondary' : 'default'}
                    className="rounded-full"
                    aria-pressed={soundEnabled}
                    onClick={() => {
                      if (soundEnabled) {
                        stopReplay();
                        stopAudio();
                      }
                      setSoundEnabled(!soundEnabled);
                    }}
                  >
                    {soundEnabled ? (
                      <Volume2 className="size-4" />
                    ) : (
                      <VolumeX className="size-4" />
                    )}
                    <span className="hidden sm:inline">
                      {soundEnabled ? 'Sound on' : 'Enable sound'}
                    </span>
                    <span className="sm:hidden">Sound</span>
                  </Button>
                )}
              </>
            ) : data.conversation.ttsEnabled ? (
              <Button
                type="button"
                size="sm"
                variant="default"
                className="rounded-full"
                data-ui="public-conversation-replay"
                disabled={publicMessageIds.length === 0}
                onClick={() =>
                  publicMessageIds[0] && startReplay(publicMessageIds[0])
                }
              >
                <RotateCcw className="size-4" />
                Replay
              </Button>
            ) : null}
          </div>
        </div>
        {data.conversation.liveMode && (
          <div
            data-ui="public-live-mode-banner"
            className="border-t border-violet-500/10 bg-violet-500/[0.06]"
          >
            <p className="mx-auto flex max-w-5xl items-center gap-2 px-4 py-2 text-xs text-violet-700 dark:text-violet-300 sm:px-8">
              <Radio className="size-3.5 animate-pulse" />
              <span>
                <strong className="font-semibold">Live Mode</strong> is active.
                New persona replies will speak when sound is enabled.
              </span>
            </p>
          </div>
        )}
      </header>

      {replay && (
        <div
          data-ui="public-replay-controls"
          data-replay-state={replay.phase}
          className="fixed inset-x-3 bottom-4 z-30 mx-auto flex max-w-xl items-center gap-3 rounded-2xl border border-violet-400/25 bg-background/95 px-3 py-2.5 shadow-2xl shadow-violet-500/15 backdrop-blur-xl sm:px-4"
          role="region"
          aria-label="Conversation replay controls"
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">
              {data.messages.find(
                (message) => message.id === replay.currentMessageId,
              )?.displayName || 'Participant'}
            </div>
            <div
              className="flex items-center gap-2 text-xs text-muted-foreground"
              aria-live="polite"
            >
              <span className="capitalize">
                {replay.phase === 'waiting' ? 'Reading' : replay.phase}
              </span>
              {replay.phase === 'playing' && (
                <span className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full bg-violet-500 transition-[width] duration-100"
                    style={{ width: `${Math.round(replay.progress * 100)}%` }}
                  />
                </span>
              )}
              {replay.error && (
                <span className="truncate text-destructive">
                  {replay.error}
                </span>
              )}
            </div>
          </div>
          {replay.phase === 'error' ? (
            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              aria-label="Retry current replay message"
              title="Retry"
              onClick={() =>
                advanceReplayRef.current(
                  replayRef.current!.generation,
                  replay.currentMessageId,
                )
              }
            >
              <RefreshCw className="size-3.5" />
            </Button>
          ) : (
            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              aria-label={
                replay.phase === 'paused' ? 'Resume replay' : 'Pause replay'
              }
              title={replay.phase === 'paused' ? 'Resume' : 'Pause'}
              onClick={replay.phase === 'paused' ? resumeReplay : pauseReplay}
            >
              {replay.phase === 'paused' ? (
                <Play className="size-3.5" />
              ) : (
                <Pause className="size-3.5" />
              )}
            </Button>
          )}
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Stop replay"
            title="Stop replay"
            onClick={stopReplay}
          >
            <Square className="size-3.5" />
          </Button>
        </div>
      )}

      <div className="relative mx-auto w-full max-w-5xl px-3 py-6 sm:px-8 sm:py-10">
        <div className="mx-auto max-w-3xl">
          {error && (
            <div className="mb-6 flex items-center justify-between rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <span>{error}</span>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Dismiss error"
                onClick={() => setError(null)}
              >
                <RefreshCw className="size-3.5" />
              </Button>
            </div>
          )}
          {data.hasMore && (
            <div className="mb-8 text-center">
              <Button
                className="rounded-full bg-background/70 shadow-sm"
                variant="outline"
                disabled={loadingOlder}
                onClick={loadOlder}
              >
                {loadingOlder && <Loader2 className="size-4 animate-spin" />}
                Load earlier messages
              </Button>
            </div>
          )}
          {data.conversation.ttsEnabled &&
            data.messages.length > 0 &&
            !replay && (
              <p
                data-ui="public-replay-help"
                className="mb-6 flex items-center justify-center gap-2 text-center text-xs text-muted-foreground"
              >
                <RotateCcw className="size-3.5 shrink-0" aria-hidden="true" />
                Use the replay icon beside any turn to replay from that point.
              </p>
            )}

          <section className="space-y-5" aria-label="Conversation messages">
            {data.messages.length === 0 && (
              <div className="rounded-3xl border border-dashed border-border/70 bg-card/50 px-6 py-16 text-center text-muted-foreground">
                <MessageCircle className="mx-auto mb-3 size-8 opacity-40" />
                This conversation has no public messages yet.
              </div>
            )}
            {data.messages.map((message, index) => {
              const replayVisibility = replay
                ? publicReplayMessageVisibility(
                    publicMessageIds,
                    replay.startMessageId,
                    replay.currentMessageId,
                    message.id,
                  )
                : null;
              if (replayVisibility === 'hidden') return null;
              const isReplayCurrent = replayVisibility === 'current';
              const replayProgress = isReplayCurrent
                ? replay?.progress
                : undefined;
              const day = messageDay(message.createdAt);
              const showDay =
                day &&
                messageDayKey(message.createdAt) !==
                  messageDayKey(data.messages[index - 1]?.createdAt ?? null);
              const time = messageTime(message.createdAt);
              const isUser = message.role === 'user';
              return (
                <div key={message.id}>
                  {showDay && (
                    <div
                      className="mb-6 flex items-center gap-3"
                      aria-label={day}
                    >
                      <span className="h-px flex-1 bg-border/60" />
                      <span className="rounded-full border border-border/50 bg-background/70 px-3 py-1 text-[11px] font-medium text-muted-foreground shadow-sm backdrop-blur">
                        {day}
                      </span>
                      <span className="h-px flex-1 bg-border/60" />
                    </div>
                  )}
                  <div
                    className={cn(
                      'flex items-start gap-3 sm:gap-4',
                      isUser && 'justify-end',
                    )}
                  >
                    {!isUser && <PersonaAvatar message={message} />}
                    <article
                      data-ui="public-conversation-message"
                      data-message-id={message.id}
                      data-message-role={message.role}
                      data-replay-state={
                        isReplayCurrent
                          ? replay?.phase
                          : replayVisibility || 'inactive'
                      }
                      className={cn(
                        'w-fit min-w-0 sm:max-w-[78%]',
                        isReplayCurrent && 'scroll-mb-24',
                        isUser
                          ? 'max-w-[calc(100%-3.25rem)] flex flex-col items-end'
                          : 'max-w-[calc(100%-6.75rem)]',
                      )}
                    >
                      <div className="mb-2 grid w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-3 text-muted-foreground">
                        <div className={cn('min-w-0', isUser && 'self-center')}>
                          <span
                            className={cn(
                              'block break-words font-semibold text-foreground/95',
                              message.isPersona
                                ? 'text-base leading-tight sm:text-lg'
                                : 'text-sm',
                            )}
                          >
                            {message.displayName ||
                              (isUser ? 'Participant' : 'Assistant')}
                          </span>
                          {message.isPersona && message.personaTitle && (
                            <span className="mt-1 block text-xs leading-snug text-muted-foreground/80">
                              {message.personaTitle}
                            </span>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center justify-self-end gap-1 whitespace-nowrap text-xs tabular-nums">
                          {data.conversation.ttsEnabled && (
                            <button
                              type="button"
                              data-ui="public-message-replay"
                              data-message-id={message.id}
                              className="inline-flex size-7 items-center justify-center rounded-full transition-colors hover:bg-muted hover:text-foreground"
                              title="Replay conversation from here"
                              aria-label={`Replay conversation from ${message.displayName || 'this message'}`}
                              onClick={() => startReplay(message.id)}
                            >
                              <RotateCcw className="size-3.5" />
                            </button>
                          )}
                          {!replay &&
                            message.speechAvailable &&
                            data.conversation.ttsEnabled && (
                              <button
                                type="button"
                                data-ui="public-message-speech"
                                data-message-id={message.id}
                                data-speech-state={
                                  speechPlayback?.messageId === message.id
                                    ? speechPlayback.phase
                                    : 'idle'
                                }
                                className="inline-flex size-7 items-center justify-center rounded-full transition-colors hover:bg-muted hover:text-foreground"
                                title={
                                  speechPlayback?.messageId === message.id
                                    ? 'Stop speech'
                                    : `Hear ${message.displayName || 'persona'}`
                                }
                                aria-label={
                                  speechPlayback?.messageId === message.id
                                    ? 'Stop speech'
                                    : `Play speech by ${message.displayName || 'persona'}`
                                }
                                onClick={() =>
                                  speechPlaybackRef.current?.messageId ===
                                  message.id
                                    ? stopAudio()
                                    : void playSpeech(message)
                                }
                              >
                                {speechPlayback?.messageId === message.id ? (
                                  speechPlayback.phase === 'loading' ? (
                                    <Loader2 className="size-3.5 animate-spin" />
                                  ) : (
                                    <Square className="size-3" />
                                  )
                                ) : (
                                  <Volume2 className="size-3.5" />
                                )}
                              </button>
                            )}
                          {time && (
                            <time
                              dateTime={message.createdAt || undefined}
                              className="whitespace-nowrap text-right"
                            >
                              {time}
                            </time>
                          )}
                        </div>
                      </div>
                      <div
                        className={cn(
                          'w-full min-w-0 overflow-hidden rounded-2xl px-4 py-3 text-[15px] leading-relaxed shadow-sm sm:px-5 sm:py-4 sm:text-base',
                          isUser
                            ? 'rounded-tr-md border border-foreground/10 bg-foreground/[0.065] text-foreground shadow-black/[0.03] backdrop-blur-sm'
                            : message.isPersona
                              ? 'rounded-tl-md border border-violet-400/15 bg-card/95 shadow-violet-500/[0.06]'
                              : 'rounded-tl-md border border-border/60 bg-card/90',
                        )}
                      >
                        <div
                          data-ui="public-message-content"
                          data-replay-current={
                            isReplayCurrent ? 'true' : undefined
                          }
                          className="min-w-0 break-words [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-0.5"
                        >
                          <MarkdownContent
                            liveRevealProgress={replayProgress}
                            liveRevealPreserveLayout={isReplayCurrent}
                          >
                            {message.content}
                          </MarkdownContent>
                        </div>
                        {message.attachments.length > 0 &&
                          (!isReplayCurrent || replayProgress === 1) && (
                            <div className="mt-3 space-y-2">
                              {message.attachments.map(
                                (attachment, attachmentIndex) => (
                                  <PublicAttachmentView
                                    key={`${message.id}-${attachmentIndex}`}
                                    attachment={attachment}
                                  />
                                ),
                              )}
                            </div>
                          )}
                      </div>
                    </article>
                    {isUser && (
                      <div className="mt-6 flex size-9 shrink-0 items-center justify-center rounded-full border border-foreground/10 bg-foreground/[0.06] text-muted-foreground sm:size-10">
                        <UserRound className="size-4" />
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </section>
          {data.conversation.visitorPromptingEnabled && (
            <form
              data-ui="public-visitor-prompt-composer"
              className="mt-10 rounded-2xl border border-violet-400/20 bg-card/90 p-4 shadow-lg shadow-violet-500/[0.05]"
              onSubmit={(event) => {
                event.preventDefault();
                void submitVisitorPrompt();
              }}
            >
              <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold">
                    Ask the conversation personas
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    {visitorSession?.displayName
                      ? `You’ll appear as ${visitorSession.displayName}. `
                      : ''}
                    Prompts and replies are safety-reviewed; personas cannot use
                    tools.
                  </p>
                </div>
                <ShieldCheck className="size-5 shrink-0 text-violet-700 dark:text-violet-500" />
              </div>
              <textarea
                ref={promptRef}
                data-ui="public-visitor-prompt-input"
                aria-label="Message to the personas"
                maxLength={data.conversation.promptMaxChars}
                rows={3}
                disabled={
                  !visitorSession ||
                  promptState.status === 'judging' ||
                  promptState.status === 'running'
                }
                placeholder="Write a message to the personas…"
                className="w-full resize-y rounded-xl border bg-background px-3 py-2 text-sm outline-none ring-violet-500/30 placeholder:text-muted-foreground focus:ring-2 disabled:opacity-60"
              />
              <div className="mt-2 flex items-center justify-between gap-3">
                <p
                  data-ui="public-visitor-prompt-status"
                  data-prompt-state={promptState.status}
                  className={cn(
                    'text-xs',
                    promptState.status === 'rejected' ||
                      promptState.status === 'rate-limited' ||
                      promptState.status === 'unavailable'
                      ? 'text-destructive'
                      : 'text-muted-foreground',
                  )}
                  aria-live="polite"
                >
                  {promptState.status === 'judging' && 'Reviewing your prompt…'}
                  {promptState.status === 'running' &&
                    'The personas are responding…'}
                  {promptState.status === 'completed' &&
                    'Persona replies are ready.'}
                  {promptState.message}
                </p>
                <Button
                  type="submit"
                  size="sm"
                  disabled={
                    !visitorSession ||
                    promptState.status === 'judging' ||
                    promptState.status === 'running'
                  }
                >
                  {promptState.status === 'judging' ||
                  promptState.status === 'running' ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Send className="size-4" />
                  )}
                  Send
                </Button>
              </div>
            </form>
          )}
          <footer className="flex flex-col items-center gap-2 py-12 text-center text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <LockKeyhole className="size-3.5" />{' '}
              {data.conversation.visitorPromptingEnabled
                ? 'Public conversation link'
                : 'View-only public link'}
            </div>
            <span className="opacity-70">Shared from CarapaBoard</span>
          </footer>
        </div>
      </div>
    </main>
  );
}

export const Route = createFileRoute('/share/$token')({
  component: PublicSharePage,
});
