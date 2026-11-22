import type { MarkdownFileOpenHandler } from '@/lib/project-file-links';
import {
  memo,
  useState,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import {
  GitFork,
  Copy,
  Check,
  FileText,
  Zap,
  Notebook,
  MoreVertical,
  Volume2,
  Square,
  Loader2,
  FileSearch,
  UserRound,
  Bot,
  Smartphone,
} from 'lucide-react';
import { useStore } from '@/store';
import { useParams } from '@tanstack/react-router';
import { cn, formatRelativeTime, copyToClipboard } from '@/lib/utils';
import { cacheHitPercent } from '@/lib/cache-hit-rate';
import {
  clipTaskOutputPageEntryToGap,
  createTaskOutputWindow,
  hideTestingVerdictOutputEntries,
  type ReviewVerdictTone,
  mergeTaskOutputWindow,
  seedTaskOutputTailWindow,
  TASK_OUTPUT_TAIL_PAGE_BYTES,
  taskOutputWindowChunks,
  taskOutputWindowGaps,
  type TaskOutputWindowEntry,
} from '@/lib/task-message-rendering';
import {
  ChunkedMarkdownContent,
  MarkdownContent,
} from '@/components/markdown-content-lazy';
import type {
  ChatDeepLink,
  ChatMessageAttachment,
  ToolCallDisplay,
} from '@/types';
import { Button } from '@/components/ui/button';
import {
  appLinkPath,
  isPlainLeftClick,
  navigateToAppPath,
} from '@/lib/app-links';
import { API_BASE_URL } from '@/lib/api-config';
import { messageSpeechUrl } from '@/lib/message-speech-url';
import { LIVE_STATUS_TTS_STEPS } from '@/lib/live-speech-client';
import { apiFetch, fetchPersonaTurnInspection } from '@/lib/api';
import { useSecureMedia } from '@/hooks/use-secure-media';
import { SecureImage } from '@/components/secure-image';
import defaultAssistantAvatar from '@/assets/carapa-default-assistant-avatar.png';
import { useQuery } from '@tanstack/react-query';
import { useTts } from '@/lib/use-tts';
import {
  clearLivePersonaReveal,
  useLivePersonaReveal,
} from '@/lib/live-persona-reveal';
import { COST_TEXT_CLASS } from '@/lib/cost-display';
import {
  hasCompleteBacktickFence,
  stripToolActivityMarkers,
} from '@/lib/markdown';
import { ImageHoverPreview } from '@/components/image-hover-preview';
import { liveStatusesFromMarkdown } from '@/lib/live-speech-protocol';
import { stripChatControlMetadata } from '@/lib/chat-control-metadata';
import {
  handoffInnerScrollTop,
  nextInnerPinnedState,
  type InnerScrollState,
} from './chat-message-bubble-scroll';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export interface ChatMessageBubbleProps {
  id: string;
  /** Stable semantic marker for distinct transcript and stream renderers. */
  dataUi?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at?: string;
  /** Renders a review message as a green (approve), red (reject) or amber (neutral) note card. */
  verdictTone?: ReviewVerdictTone;

  // task-detail context: agent/model display in header
  agent_name?: string | null;
  model_name?: string | null;
  fallbackAgentName?: string;
  project_id?: string;
  conversation_id?: string;
  stream_key?: string | null;
  // Resolved authenticated username, or legacy/external sender fallback.
  sender_name?: string | null;
  senderUserId?: string | null;
  senderAvatarUrl?: string | null;
  /** Configured display name for the ordinary/main assistant. */
  assistantSenderName?: string | null;
  virtualSenderName?: string | null;
  virtualSenderIdentity?: string | null;
  virtualSenderAvatarUrl?: string | null;
  virtualSenderAvatarFallbackUrl?: string | null;
  speechText?: string | null;
  speechVoice?: string | null;
  speechLang?: string | null;
  isOtherUser?: boolean;
  // chat-page context: collapsible thinking block
  thinking?: string;
  // chat-page context: media/document attachments
  attachments?: ChatMessageAttachment[] | null;
  /** Links stored on this message (e.g. an ask answer's conversation). */
  deepLinks?: ChatDeepLink[] | null;
  // chat-page context: 'web' | 'whatsapp' — presence switches layout to chat-page mode
  source?: string;
  // chat-page context: error styling
  isError?: boolean;
  /** Effective project preference for each tool block's initial disclosure. */
  toolCallDisplay?: ToolCallDisplay;

  onFork?: (messageId: string) => void;
  onSendMessage?: import('@/components/markdown-content').QuestionSendHandler;
  onImplementPlan?: (artifactPath: string) => void;
  onSendPlanToKanban?: (
    plan: import('@/components/markdown-content').PlanKanbanAction,
  ) => Promise<void>;
  onOpenArtifact?: MarkdownFileOpenHandler;
  questionAnswer?: string;
  // telemetry from direct LLM mode
  telemetry?: Record<string, unknown> | null;
  /** chat-page context: streaming indicator for active runs */
  isStreaming?: boolean;
  /** Memory context is being prepared before the agent starts. */
  preparingMemory?: boolean;
  /** Status for a steered user message, shown in the action footer. */
  steeringDeliveryStatus?: ReactNode;
  /** Keep a pinned chat viewport aligned as voice-revealed text grows. */
  onContentGrow?: () => void;
  /** Pin the latest completed assistant bubble to its inner bottom before
   * paint, matching the position of the streaming renderer it replaces. */
  pinInnerToBottom?: boolean;
  /** Historical bubbles do not need live inner-scroll observers. */
  observeInnerScroll?: boolean;
  deferMarkdown?: boolean;
  /** Shared across the live and canonical renderers for a single stream handoff. */
  innerScrollStateRef?: MutableRefObject<InnerScrollState | null>;
  /** Bound the initial Markdown parse for unusually large persisted messages.
   * Earlier content remains available in equal-sized increments. */
  /** Persisted task output paging context for large assistant messages. */
  taskOutputContext?: {
    projectId: string;
    taskId: string;
    runId?: string | null;
    messageId?: string;
    contentStartBytes?: number;
    initialBeforeOffset?: number;
    initialEntries?: TaskOutputWindowEntry[];
    totalEndOffset?: number;
  };
  initialRenderChars?: number;
  /** Keep the message id on the single outer message owner in chat-page mode. */
  suppressInnerMessageId?: boolean;
}

/** Value signature of a task-output page's entries, stable across equal refetches. */
function taskOutputInitialEntriesSignature(
  entries: TaskOutputWindowEntry[] | undefined,
): string {
  if (!entries?.length) return '';
  const edge = (e: TaskOutputWindowEntry) =>
    `${e.id}:${e.startOffset}-${e.endOffset}`;
  return `${entries.length}|${edge(entries[0])}|${edge(entries[entries.length - 1])}`;
}

/** Compact token-count formatter for telemetry sub-metrics (cache/reasoning). */
function fmtCompactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Normalize media URLs for WhatsApp and local uploads */
function proxyMediaUrl(url: string): string {
  let finalUrl = url;

  // Handle WhatsApp media proxy
  const waMatch = url.match(/\/api\/media\/(.+)$/);
  if (waMatch) {
    finalUrl = API_BASE_URL + `/api/wa-media/${waMatch[1]}`;
  } else if (url.startsWith('/')) {
    finalUrl = API_BASE_URL + url;
  }

  return finalUrl;
}

import { Filesystem, Directory } from '@capacitor/filesystem';
import { FileOpener } from '@capacitor-community/file-opener';
import { Capacitor } from '@capacitor/core';
import { toast } from 'sonner';
import { useAppConfig } from '@/hooks/use-app-config';

function AttachmentRenderer({
  attachment,
}: {
  attachment: ChatMessageAttachment;
}) {
  const normalizedUrl = proxyMediaUrl(attachment.url);
  const {
    secureUrl,
    loading: secureLoading,
    error,
  } = useSecureMedia(normalizedUrl);
  const [downloading, setDownloading] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioPosition, setAudioPosition] = useState(0);
  const [decodedDuration, setDecodedDuration] = useState(0);
  const url = secureUrl;

  useEffect(() => {
    setAudioPlaying(false);
    setAudioPosition(0);
    setDecodedDuration(0);
  }, [url]);

  const handleOpenNative = async (e: React.MouseEvent) => {
    if (!Capacitor.isNativePlatform()) return;

    e.preventDefault();
    setDownloading(true);

    try {
      // 1. Fetch the data using our secure apiFetch (with handshake)
      const response = await apiFetch(normalizedUrl);
      if (!response.ok) throw new Error('Failed to download file');

      const blob = await response.blob();

      // 2. Convert Blob to Base64 (Filesystem.writeFile needs base64)
      const reader = new FileReader();
      const base64Data = await new Promise<string>((resolve, reject) => {
        reader.onerror = () =>
          reject(reader.error ?? new Error('Failed to read file'));
        reader.onloadend = () => {
          const res = reader.result;
          if (typeof res !== 'string') {
            reject(new Error('Failed to read file'));
            return;
          }
          resolve(res.split(',')[1] ?? ''); // Remove data:mime;base64, prefix
        };
        reader.readAsDataURL(blob);
      });

      // 3. Save to temporary directory
      const fileName = attachment.filename || `file_${Date.now()}`;
      const savedFile = await Filesystem.writeFile({
        path: fileName,
        data: base64Data,
        directory: Directory.Cache,
      });

      // 4. Open with system viewer
      await FileOpener.open({
        filePath: savedFile.uri,
        contentType: attachment.mimetype || 'application/octet-stream',
      });
    } catch (err) {
      console.error('Native download failed:', err);
      toast.error('Could not open file');
    } finally {
      setDownloading(false);
    }
  };

  const loading = secureLoading || downloading;
  const formatAudioDuration = (seconds: number) => {
    const wholeSeconds = Math.max(0, Math.round(seconds));
    return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, '0')}`;
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-2 rounded bg-black/5 dark:bg-white/5 animate-pulse">
        <div className="size-4 rounded-full bg-black/10 dark:bg-white/10" />
        <div className="h-3 w-24 bg-black/10 dark:bg-white/10 rounded" />
      </div>
    );
  }

  if (error || !url) {
    return (
      <div
        className="rounded bg-black/5 dark:bg-white/5 px-2 py-1.5 text-xs text-muted-foreground"
        data-ui="attachment-media-error"
      >
        Could not load {attachment.type}.
      </div>
    );
  }

  const commonProps = {
    onClick: handleOpenNative,
    className: cn(
      'flex items-center gap-2 px-2 py-1.5 rounded transition-colors',
      'bg-black/5 hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10',
    ),
  };

  if (attachment.type === 'image') {
    return (
      <div className="flex flex-col gap-1">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          {...commonProps}
          // bg-black/20 stays in both themes: letterbox behind object-contain
          // media, not a dark-only patch.
          className="group/img relative block overflow-hidden rounded-lg border border-black/10 hover:border-black/20 dark:border-white/10 dark:hover:border-white/20 bg-black/20 transition-all duration-200"
        >
          <ImageHoverPreview src={url} alt={attachment.filename || 'Image'}>
            <img
              src={url}
              alt={attachment.filename || 'Image'}
              className="max-w-full max-h-80 rounded object-contain transition-transform duration-300 group-hover/img:scale-[1.02]"
              loading="lazy"
            />
          </ImageHoverPreview>
          {/* The hover veil is deliberately dark in both themes so the white
              label keeps >= 4.5:1 over the image. */}
          <div className="pointer-events-none absolute inset-0 bg-black/40 opacity-0 group-hover/img:opacity-100 transition-opacity flex items-center justify-center">
            <span className="text-[10px] text-white font-medium bg-black/60 px-2 py-1 rounded-full backdrop-blur-sm border border-white/10">
              {Capacitor.isNativePlatform() ? 'Open Image' : 'View Original'}
            </span>
          </div>
        </a>
        {attachment.filename && (
          <span className="text-[10px] text-muted-foreground px-1 truncate">
            {attachment.filename}
          </span>
        )}
        {attachment.caption && (
          <p className="text-xs opacity-70 mt-0.5">{attachment.caption}</p>
        )}
      </div>
    );
  }

  if (attachment.type === 'video') {
    return (
      <div className="flex flex-col gap-1">
        <video
          src={url}
          controls
          // bg-black/20 stays in both themes: letterbox behind the video.
          className="max-w-full max-h-80 rounded-lg border border-black/10 bg-black/20 dark:border-white/10"
          preload="metadata"
        />
        {attachment.filename && (
          <span className="text-[10px] text-muted-foreground px-1 truncate">
            {attachment.filename}
          </span>
        )}
        {attachment.caption && (
          <p className="text-xs opacity-70 mt-0.5">{attachment.caption}</p>
        )}
      </div>
    );
  }

  if (attachment.type === 'audio') {
    const duration = attachment.durationSeconds ?? decodedDuration;
    const toggleAudio = () => {
      const audio = audioRef.current;
      if (!audio) return;
      if (audio.paused) {
        void audio
          .play()
          .then(() => setAudioPlaying(true))
          .catch(() => setAudioPlaying(false));
      } else {
        audio.pause();
        setAudioPlaying(false);
      }
    };

    return (
      <div className="flex items-center gap-2 rounded-full bg-black/5 dark:bg-white/5 px-2 py-1.5">
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          onLoadedMetadata={(event) => {
            if (Number.isFinite(event.currentTarget.duration)) {
              setDecodedDuration(event.currentTarget.duration);
            }
          }}
          onTimeUpdate={(event) => {
            const sourceDuration = event.currentTarget.duration;
            const displayDuration = attachment.durationSeconds;
            // MediaRecorder WebM files can contain a bogus timeline (for
            // example 3:17 for a short voice note). Keep the visible
            // progress on the recorder's known timeline while mapping it to
            // the media element's internal timeline.
            const position =
              displayDuration &&
              Number.isFinite(sourceDuration) &&
              sourceDuration > 0
                ? (event.currentTarget.currentTime / sourceDuration) *
                  displayDuration
                : event.currentTarget.currentTime;
            setAudioPosition(
              Math.min(Math.max(position, 0), displayDuration ?? position),
            );
          }}
          onEnded={() => {
            setAudioPlaying(false);
            setAudioPosition(0);
          }}
          className="hidden"
        />
        <button
          type="button"
          onClick={toggleAudio}
          className="flex size-7 shrink-0 items-center justify-center rounded-full hover:bg-black/10 dark:hover:bg-white/10"
          aria-label={audioPlaying ? 'Pause audio' : 'Play audio'}
        >
          {audioPlaying ? (
            <Square className="size-3.5" />
          ) : (
            <Volume2 className="size-4" />
          )}
        </button>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.01}
          value={Math.min(audioPosition, duration || 0)}
          onChange={(event) => {
            const position = Number(event.target.value);
            if (audioRef.current) {
              const sourceDuration = audioRef.current.duration;
              audioRef.current.currentTime =
                duration &&
                Number.isFinite(sourceDuration) &&
                sourceDuration > 0
                  ? (position / duration) * sourceDuration
                  : position;
            }
            setAudioPosition(position);
          }}
          disabled={!duration}
          className="h-1 min-w-24 flex-1 accent-primary"
          aria-label="Audio progress"
        />
        <span className="min-w-20 text-right text-xs tabular-nums text-muted-foreground">
          {formatAudioDuration(audioPosition)} /{' '}
          {duration ? formatAudioDuration(duration) : '--:--'}
        </span>
        {attachment.caption && (
          <p className="text-xs opacity-70 mt-1">{attachment.caption}</p>
        )}
      </div>
    );
  }

  // document / fallback
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" {...commonProps}>
      <FileText className="size-4 shrink-0 opacity-60" />
      <span className="text-xs truncate">
        {attachment.filename || 'Document'}
      </span>
    </a>
  );
}

/** Compact performance telemetry shown below assistant messages. */
export function TelemetryBar({
  telemetry,
}: {
  telemetry: Record<string, unknown>;
}) {
  const tokOut =
    typeof telemetry.tok_output === 'number' ? telemetry.tok_output : null;
  const tokIn =
    typeof telemetry.tok_input === 'number' ? telemetry.tok_input : null;
  const tokCtx =
    typeof telemetry.tok_context_last === 'number'
      ? telemetry.tok_context_last
      : null;
  const tokCacheRead =
    typeof telemetry.tok_cache_read === 'number'
      ? telemetry.tok_cache_read
      : null;
  const tokCacheWrite =
    typeof telemetry.tok_cache_write === 'number'
      ? telemetry.tok_cache_write
      : 0;
  const inputTokenSemantics =
    telemetry.inputTokenSemantics === 'fresh' ||
    typeof telemetry.session_id === 'string'
      ? 'fresh'
      : 'total';
  const displayedTokIn =
    tokIn !== null && tokCacheRead !== null && inputTokenSemantics === 'fresh'
      ? tokIn + tokCacheRead + tokCacheWrite
      : tokIn;
  const tokReasoning =
    typeof telemetry.tok_reasoning === 'number'
      ? telemetry.tok_reasoning
      : null;
  const total =
    typeof telemetry.total_tokens === 'number' ? telemetry.total_tokens : null;
  const duration_ms =
    typeof telemetry.duration_ms === 'number' ? telemetry.duration_ms : null;
  const cost_usd =
    typeof telemetry.cost_usd === 'number' ? telemetry.cost_usd : null;
  const model =
    typeof telemetry.model_name === 'string' ? telemetry.model_name : null;
  const context_size =
    typeof telemetry.context_size === 'number' ? telemetry.context_size : null;
  const cachePercent =
    tokCacheRead !== null &&
    tokIn !== null &&
    cacheHitPercent(tokIn, tokCacheRead, inputTokenSemantics, tokCacheWrite) !==
      null
      ? `${cacheHitPercent(tokIn, tokCacheRead, inputTokenSemantics, tokCacheWrite)!.toFixed(1)}%`
      : null;
  const tps =
    tokOut && duration_ms && duration_ms > 0
      ? ((tokOut / duration_ms) * 1000).toFixed(1)
      : null;

  // tokIn is per-turn for simple chat but CUMULATIVE session input for Codex
  // (turn.completed reports running totals). Using cumulative tokIn for the
  // context-usage % would show an absurd >1000% figure, so the simple-chat
  // estimate fallback only applies when usage is per-turn — signaled by the
  // absence of cache/reasoning breakdown (only cumulative agents set those).
  const tokInIsCumulative = tokCacheRead !== null || tokReasoning !== null;

  const parts: string[] = [];
  if (model)
    parts.push(model.replace('gpt-', 'GPT-').replace('claude-', 'Claude '));

  let contextWarning = '';
  if (context_size !== null && tokCtx !== null) {
    // Accurate per-turn context snapshot
    const contextPercent = (tokCtx / context_size) * 100;
    const percentStr = contextPercent.toFixed(1);

    if (contextPercent > 80)
      contextWarning = 'text-red-600 dark:text-red-400 font-bold';
    else if (contextPercent > 60)
      contextWarning = 'text-amber-700 dark:text-amber-400 font-medium';

    parts.push(
      `Ctx: ${tokCtx.toLocaleString()} / ${(context_size / 1000).toFixed(0)}k (${percentStr}%)`,
    );
  } else if (context_size !== null && tokIn !== null && !tokInIsCumulative) {
    // Simple-chat estimate: per-turn input + output as a context approximation
    const currentUsage = tokIn + (tokOut || 0);
    const contextPercent = (currentUsage / context_size) * 100;
    const percentStr = contextPercent.toFixed(1);

    if (contextPercent > 80)
      contextWarning = 'text-red-600 dark:text-red-400 font-bold';
    else if (contextPercent > 60)
      contextWarning = 'text-amber-700 dark:text-amber-400 font-medium';

    parts.push(
      `Ctx: ${currentUsage.toLocaleString()} / ${(context_size / 1000).toFixed(0)}k (${percentStr}%)`,
    );
  } else if (total !== null && tokIn === null && tokOut === null) {
    parts.push(`${total.toLocaleString()} tok`);
  }

  if (displayedTokIn !== null && tokOut !== null) {
    // Label as "Total:" when a model or context line precedes it (reads like
    // "model · Ctx: ... · Total: ↑in ↓out · ..."); bare "↑in ↓out" otherwise.
    const labeled = model !== null || context_size !== null;
    parts.push(
      labeled
        ? `Total: ↑${displayedTokIn} ↓${tokOut}`
        : `↑${displayedTokIn} ↓${tokOut}`,
    );
  }
  if (tokCacheRead !== null)
    parts.push(
      cachePercent
        ? `⚡${fmtCompactTokens(tokCacheRead)} (${cachePercent})`
        : `⚡${fmtCompactTokens(tokCacheRead)}`,
    );
  if (tokReasoning !== null && tokReasoning > 0)
    parts.push(`🧠${fmtCompactTokens(tokReasoning)}`);
  if (tps) parts.push(`${tps} t/s`);
  if (duration_ms !== null) parts.push(`${(duration_ms / 1000).toFixed(1)}s`);
  if (parts.length === 0 && cost_usd === null) return null;
  return (
    <div
      data-ui="chat-message-telemetry"
      className={cn(
        'flex min-w-0 max-w-full flex-1 items-center gap-1.5 overflow-x-auto overscroll-x-contain text-[11px] text-muted-foreground scrollbar-none',
        contextWarning,
      )}
    >
      <Zap
        className={cn(
          'size-3 shrink-0 sticky left-0 bg-transparent',
          contextWarning ? 'text-current' : 'text-muted-foreground',
        )}
      />
      <span className="shrink-0 whitespace-nowrap pr-2">
        {parts.join(' · ')}
        {cost_usd !== null && (
          <span className={COST_TEXT_CLASS}>
            {parts.length > 0 ? ' · ' : ''}${cost_usd.toFixed(4)}
          </span>
        )}
      </span>
    </div>
  );
}

/** Icon-only message action: 24px target, readable at rest, visible keyboard focus. */
const ACTION_BUTTON_CLASS =
  'rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * Shared message bubble component used in both the task detail dialog and the
 * chat page.
 *
 * Layout modes:
 * - **task-detail mode** (no `source` prop): user/system metadata above the
 *   bubble; assistant run metadata lives in the run divider and actions sit
 *   below the bubble.
 * - **chat-page mode** (`source` prop present): bubble-first layout with the
 *   timestamp inside the bubble and action buttons below it.
 */
export const ChatMessageBubble = memo(function ChatMessageBubble({
  id,
  dataUi,
  role,
  content,
  created_at,
  agent_name,
  model_name,
  fallbackAgentName,
  sender_name,
  senderUserId,
  senderAvatarUrl,
  assistantSenderName,
  virtualSenderName,
  virtualSenderIdentity,
  virtualSenderAvatarUrl,
  virtualSenderAvatarFallbackUrl,
  speechText,
  speechVoice,
  speechLang,
  isOtherUser = false,
  thinking,
  attachments,
  deepLinks,
  source,
  isError,
  toolCallDisplay = 'compact',
  onFork,
  onSendMessage,
  onImplementPlan,
  onSendPlanToKanban,
  onOpenArtifact,
  questionAnswer,
  telemetry,
  isStreaming,
  preparingMemory,
  steeringDeliveryStatus,
  onContentGrow,
  pinInnerToBottom,
  observeInnerScroll = false,
  deferMarkdown = false,
  innerScrollStateRef,
  initialRenderChars,
  taskOutputContext,
  suppressInnerMessageId = false,
  verdictTone,
  project_id: propProjectId,
  conversation_id,
  stream_key,
}: ChatMessageBubbleProps) {
  const params = useParams({ strict: false }) as unknown as {
    projectId?: string;
  };
  const project_id = propProjectId || params.projectId;

  const isUser = role === 'user';
  const isSystem = role === 'system';
  const isWhatsApp = source === 'whatsapp';
  const livePersonaReveal = useLivePersonaReveal(id);
  const isLiveVoicePending =
    livePersonaReveal != null && livePersonaReveal.phase !== 'released';
  const voiceSourceContent = stripChatControlMetadata(
    livePersonaReveal?.bufferedText || content,
  );
  const displayContent = livePersonaReveal
    ? livePersonaReveal.phase === 'speaking'
      ? voiceSourceContent
      : livePersonaReveal.phase === 'released'
        ? voiceSourceContent
        : ''
    : stripChatControlMetadata(content);
  const liveRevealProgress =
    livePersonaReveal?.phase === 'speaking'
      ? livePersonaReveal.progress
      : undefined;
  const liveRevealAwaitingFirstWord =
    livePersonaReveal?.phase === 'speaking' &&
    livePersonaReveal.revealedWords === 0;
  // Web is the default origin and gets no marker; agent authorship is
  // already shown by the header badge.
  const sourceLabel = isWhatsApp
    ? 'Sent via WhatsApp'
    : source === 'android'
      ? 'Sent from the Android app'
      : source === 'ios'
        ? 'Sent from the iOS app'
        : null;
  const sourceIcon = sourceLabel ? (
    <Smartphone
      data-ui="chat-message-source-icon"
      aria-label={sourceLabel}
      className="size-3 shrink-0"
    >
      <title>{sourceLabel}</title>
    </Smartphone>
  ) : null;
  const [copied, setCopied] = useState(false);
  const [inspectionOpen, setInspectionOpen] = useState(false);
  const [renderChars, setRenderChars] = useState(
    initialRenderChars ?? Number.POSITIVE_INFINITY,
  );
  const [taskOutputWindow, setTaskOutputWindow] = useState(() =>
    createTaskOutputWindow([]),
  );
  const [loadingOlder, setLoadingOlder] = useState(false);
  const outputRequestRef = useRef(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const hasTaskOutputContext = taskOutputContext != null;
  const hasLivePersonaReveal = livePersonaReveal != null;
  // The dialog refetches output pages on unrelated task updates and hands over
  // a new but equal `initialEntries` array. Reset on the entries' value, not
  // their identity, so already-loaded older output is kept.
  const initialEntriesSignature = taskOutputInitialEntriesSignature(
    taskOutputContext?.initialEntries,
  );
  useEffect(() => {
    setRenderChars(initialRenderChars ?? Number.POSITIVE_INFINITY);
  }, [id, initialRenderChars]);
  useEffect(() => {
    outputRequestRef.current += 1;
    setLoadingOlder(false);
    // Ordinary chat streams do not use the task pagination window. Replacing
    // it on every chunk would schedule an extra state update for each render.
    if (!hasTaskOutputContext) return;
    const initialBeforeOffset =
      taskOutputContext?.initialBeforeOffset ??
      taskOutputContext?.contentStartBytes ??
      0;
    // A run-less oversized message arrives with no server-provided output
    // page. Seeding the whole content would push megabytes through the
    // Markdown renderer at once; keep only the newest tail so the remaining
    // prefix stays a pageable gap. Run-scoped rows are excluded: their pages
    // use run-stream offsets, not message-relative offsets. The tail is cut
    // from the raw `content` because the server pages raw stored bytes;
    // stripped display text would shift offsets. Live voice reveal is
    // excluded because its display text is a partial buffer.
    const tailSeed =
      taskOutputContext &&
      !taskOutputContext.runId &&
      !hasLivePersonaReveal &&
      content &&
      !taskOutputContext.initialEntries?.length
        ? seedTaskOutputTailWindow(
            `message:${id}`,
            content,
            initialBeforeOffset,
          )
        : null;
    const initialEntries = taskOutputContext?.initialEntries?.length
      ? taskOutputContext.initialEntries
      : tailSeed
        ? tailSeed.entries
        : taskOutputContext && displayContent
          ? [
              {
                id: `message:${id}`,
                content: displayContent,
                startOffset: initialBeforeOffset,
                endOffset:
                  initialBeforeOffset +
                  new TextEncoder().encode(displayContent).byteLength,
              },
            ]
          : [];
    setTaskOutputWindow(
      createTaskOutputWindow(
        initialEntries,
        taskOutputContext?.totalEndOffset ??
          tailSeed?.totalEndOffset ??
          initialEntries.at(-1)?.endOffset ??
          0,
      ),
    );
  }, [
    content,
    displayContent,
    id,
    hasTaskOutputContext,
    hasLivePersonaReveal,
    taskOutputContext?.runId,
    taskOutputContext?.messageId,
    taskOutputContext?.contentStartBytes,
    taskOutputContext?.initialBeforeOffset,
    initialEntriesSignature,
    taskOutputContext?.totalEndOffset,
  ]);

  const loadOlderTaskOutput = useCallback(async () => {
    if (!taskOutputContext || loadingOlder) return;
    const gap = taskOutputWindowGaps(taskOutputWindow)[0];
    if (!gap) return;
    setLoadingOlder(true);
    const requestId = outputRequestRef.current + 1;
    outputRequestRef.current = requestId;
    try {
      const params = new URLSearchParams({
        limit: String(TASK_OUTPUT_TAIL_PAGE_BYTES),
        offset: '0',
      });
      if (gap.endOffset > 0) params.set('beforeOffset', String(gap.endOffset));
      if (taskOutputContext.runId) params.set('runId', taskOutputContext.runId);
      if (taskOutputContext.messageId)
        params.set('messageId', taskOutputContext.messageId);
      const response = await apiFetch(
        `${API_BASE_URL}/api/projects/${taskOutputContext.projectId}/tasks/${taskOutputContext.taskId}/output?${params}`,
      );
      if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
      }
      const page = (await response.json()) as {
        content: string;
        nextCursor: number;
        hasMore: boolean;
        total?: number;
        runId?: string | null;
        entries?: TaskOutputWindowEntry[];
      };
      if (
        requestId !== outputRequestRef.current ||
        (page.runId &&
          taskOutputContext.runId &&
          page.runId !== taskOutputContext.runId)
      )
        return;
      if (page.content) {
        const rawEntries = page.entries?.length
          ? page.entries
          : [
              {
                id: `page:${page.nextCursor}:${gap.endOffset}`,
                content: page.content,
                startOffset: page.nextCursor,
                endOffset:
                  page.nextCursor +
                  new TextEncoder().encode(page.content).byteLength,
              },
            ];
        // A run-less message query answers with the whole message as one
        // entry. Merging it raw would replace the seeded tail and push
        // megabytes back into the renderer, so clip each run-less page entry
        // to the requested gap first. Run-paged output keeps its entries.
        const pageEntries = taskOutputContext.runId
          ? rawEntries
          : rawEntries.flatMap((entry) => {
              const clipped = clipTaskOutputPageEntryToGap(entry, gap);
              return clipped ? [clipped] : [];
            });
        if (pageEntries.length > 0) {
          setTaskOutputWindow((current) =>
            mergeTaskOutputWindow(current, pageEntries, {
              direction: 'older',
              totalEndOffset: page.total,
            }),
          );
        }
      }
    } catch (error) {
      // The gap stays in the window, so the loader button doubles as Retry.
      if (requestId === outputRequestRef.current) {
        toast.error(
          error instanceof Error && error.message
            ? `Could not load earlier output: ${error.message}`
            : 'Could not load earlier output',
        );
      }
    } finally {
      if (requestId === outputRequestRef.current) setLoadingOlder(false);
    }
  }, [loadingOlder, taskOutputWindow, taskOutputContext]);
  useEffect(() => {
    // Once the canonical transcript contains the released message, the
    // ephemeral presentation layer is no longer needed. Refreshes therefore
    // always render persisted text normally and never resume old audio.
    // Do not clear merely because the cache has *some* content: immediately
    // after streaming it can still contain provider deltas whose whitespace
    // differs from the canonical saved Markdown. Keep rendering the canonical
    // reveal buffer until the cache contains that exact text.
    const canonicalRevealText = stripChatControlMetadata(
      livePersonaReveal?.bufferedText ?? '',
    );
    const canonicalCacheReady =
      canonicalRevealText.length > 0 &&
      stripChatControlMetadata(content) === canonicalRevealText;
    if (livePersonaReveal?.phase === 'released' && canonicalCacheReady) {
      clearLivePersonaReveal(id);
    }
  }, [content, id, livePersonaReveal?.bufferedText, livePersonaReveal?.phase]);
  useLayoutEffect(() => {
    if (
      livePersonaReveal?.phase === 'speaking' &&
      livePersonaReveal.revealedWords > 0
    ) {
      onContentGrow?.();
    }
  }, [
    livePersonaReveal?.phase,
    livePersonaReveal?.revealedWords,
    onContentGrow,
  ]);

  const taskOutputGaps = taskOutputWindowGaps(taskOutputWindow);
  const taskOutputChunks = useMemo(
    () =>
      hasTaskOutputContext
        ? taskOutputWindowChunks(
            hideTestingVerdictOutputEntries(taskOutputWindow),
          )
        : [],
    [hasTaskOutputContext, taskOutputWindow],
  );
  const taskOutputText = taskOutputContext
    ? taskOutputChunks.map((chunk) => chunk.content).join('')
    : displayContent;
  // Window entries keep raw stored bytes, the coordinate system the server
  // pages, so offsets are never derived from this text. For run-less windows,
  // only the display text derived from those entries is stripped of routing
  // metadata and trailing whitespace. Run-scoped windows are unchanged.
  const pagedDisplayContent =
    taskOutputContext && !taskOutputContext.runId
      ? stripChatControlMetadata(taskOutputText)
      : taskOutputText;
  const rawRenderStart = Number.isFinite(renderChars)
    ? Math.max(0, pagedDisplayContent.length - renderChars)
    : 0;
  const nextRenderBlock =
    rawRenderStart > 0
      ? pagedDisplayContent.indexOf('\n\n', rawRenderStart)
      : -1;
  const renderStart =
    taskOutputContext || !Number.isFinite(renderChars)
      ? 0
      : nextRenderBlock >= 0
        ? nextRenderBlock + 2
        : rawRenderStart;
  const renderedContent = pagedDisplayContent.slice(renderStart);
  const earlierContentButton =
    renderStart > 0 || (taskOutputContext && taskOutputGaps.length > 0) ? (
      <button
        type="button"
        onClick={() =>
          taskOutputContext
            ? void loadOlderTaskOutput()
            : setRenderChars((chars) => chars + (initialRenderChars ?? 0))
        }
        disabled={loadingOlder}
        data-ui={taskOutputContext ? 'task-output-gap-loader' : undefined}
        data-gap-start={taskOutputGaps[0]?.startOffset}
        data-gap-end={taskOutputGaps[0]?.endOffset}
        className="mb-2 w-full rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted/35 hover:text-foreground"
      >
        {loadingOlder ? 'Loading earlier output…' : 'Load earlier output'}
      </button>
    ) : null;

  const setMessageActionsInfo = useStore((s) => s.setMessageActionsInfo);
  const setKbSaveDialogInfo = useStore((s) => s.setKbSaveDialogInfo);

  const { data: appConfig } = useAppConfig();
  const tts = useTts();
  const isAssistant = !isUser && !isSystem;
  const ttsActive = tts.activeId === id;
  const hasPersonaInspection = Boolean(
    project_id && conversation_id && agent_name?.startsWith('ai:'),
  );
  const personaInspection = useQuery({
    queryKey: ['persona-turn-inspection', project_id, conversation_id, id],
    queryFn: () =>
      fetchPersonaTurnInspection(
        String(project_id),
        String(conversation_id),
        id,
      ),
    enabled: inspectionOpen && hasPersonaInspection,
    staleTime: Infinity,
  });

  // Inner-bubble auto-scroll. The bubble body is its own scroll container
  // (max-h-[50vh] overflow-y-auto), so while a long response streams the newest
  // tokens would otherwise grow below the fold inside the bubble. Every long
  // message starts at its newest content, then stops following as soon as the
  // reader scrolls up and resumes only after they return to the bottom.
  const innerAutoScroll = observeInnerScroll;
  const innerPinnedRef = useRef(true);
  const innerLastScrollTopRef = useRef(0);
  const priorToolDisplayRef = useRef(toolCallDisplay);
  const disclosureScrollSnapshotRef = useRef<{
    display: ToolCallDisplay;
    pinned: boolean;
    scrollTop: number;
  } | null>(null);
  if (priorToolDisplayRef.current !== toolCallDisplay) {
    const currentContent = contentRef.current;
    const isAtInnerBottom = currentContent
      ? currentContent.scrollHeight -
          currentContent.clientHeight -
          currentContent.scrollTop <=
        1
      : false;
    disclosureScrollSnapshotRef.current = {
      display: toolCallDisplay,
      // The DOM position can be one scroll event ahead of the refs when a
      // display-setting render lands in the same frame as the user's scroll.
      pinned: (innerAutoScroll && innerPinnedRef.current) || isAtInnerBottom,
      scrollTop: currentContent?.scrollTop ?? innerLastScrollTopRef.current,
    };
    priorToolDisplayRef.current = toolCallDisplay;
  }
  const rememberInnerScrollState = useCallback(
    (el: HTMLDivElement) => {
      if (!innerScrollStateRef) return;
      innerScrollStateRef.current = {
        pinned: innerPinnedRef.current,
        scrollTop: el.scrollTop,
      };
    },
    [innerScrollStateRef],
  );
  const handleToolDisclosureChange = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    const settingSnapshot = disclosureScrollSnapshotRef.current;
    const useSettingSnapshot = settingSnapshot?.display === toolCallDisplay;
    // Only an observed bubble tracks its pin state and last scroll offset. For
    // the others `innerPinnedRef` stays at its initial `true`, which would
    // throw a reader who scrolled up to the top of a tool call back to the end.
    const wasPinned = useSettingSnapshot
      ? settingSnapshot.pinned
      : innerAutoScroll && innerPinnedRef.current;
    const unpinnedScrollTop = useSettingSnapshot
      ? settingSnapshot.scrollTop
      : innerAutoScroll
        ? innerLastScrollTopRef.current
        : el.scrollTop;
    requestAnimationFrame(() => {
      if (contentRef.current !== el) return;
      innerPinnedRef.current = wasPinned;
      el.scrollTop = wasPinned ? el.scrollHeight : unpinnedScrollTop;
      innerLastScrollTopRef.current = el.scrollTop;
      rememberInnerScrollState(el);
      onContentGrow?.();
      if (useSettingSnapshot) {
        requestAnimationFrame(() => {
          if (disclosureScrollSnapshotRef.current === settingSnapshot) {
            disclosureScrollSnapshotRef.current = null;
          }
        });
      }
    });
  }, [
    innerAutoScroll,
    onContentGrow,
    rememberInnerScrollState,
    toolCallDisplay,
  ]);
  useLayoutEffect(() => {
    const snapshot = disclosureScrollSnapshotRef.current;
    if (!snapshot || snapshot.display !== toolCallDisplay) return;
    const el = contentRef.current;
    if (!el) return;
    const frame = requestAnimationFrame(() => {
      if (contentRef.current !== el) return;
      innerPinnedRef.current = snapshot.pinned;
      el.scrollTop = snapshot.pinned ? el.scrollHeight : snapshot.scrollTop;
      innerLastScrollTopRef.current = el.scrollTop;
      rememberInnerScrollState(el);
      onContentGrow?.();
      if (disclosureScrollSnapshotRef.current === snapshot) {
        disclosureScrollSnapshotRef.current = null;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [onContentGrow, rememberInnerScrollState, toolCallDisplay]);
  // Position every mounted overflowed body before its first paint. Canonical
  // replay additionally keeps a deliberately unpinned streaming reader at its
  // prior offset during the renderer handoff.
  useLayoutEffect(() => {
    if (isStreaming) return;
    const el = contentRef.current;
    if (!el) return;
    el.style.overflowAnchor = 'none';
    const previousState = pinInnerToBottom
      ? innerScrollStateRef?.current
      : undefined;
    innerPinnedRef.current = previousState?.pinned ?? true;
    el.scrollTop = handoffInnerScrollTop(el.scrollHeight, previousState);
    innerLastScrollTopRef.current = el.scrollTop;
  }, [id, innerScrollStateRef, isStreaming, pinInnerToBottom]);

  useEffect(() => {
    if (!innerAutoScroll) return;
    const el = contentRef.current;
    if (!el) return;
    el.style.overflowAnchor = 'none';
    // A canonical renderer can replace a stream while the reader is partway
    // through it. Preserve that unpinned state instead of treating the new DOM
    // node as a fresh message and snapping it back to the bottom.
    innerPinnedRef.current = pinInnerToBottom
      ? (innerScrollStateRef?.current?.pinned ?? true)
      : true;
    innerLastScrollTopRef.current = el.scrollTop;
    rememberInnerScrollState(el);

    // Unpin only on an actual upward scroll; growing content alone must not unpin
    // (otherwise streaming/lazy text expands the distance-from-bottom and stops the
    // follow). Re-pin only when the user returns to the actual bottom. A large
    // threshold here makes short upward scrolls ineffective because the next token
    // immediately snaps the bubble back down.
    const handleScroll = () => {
      const scrollTop = el.scrollTop;
      innerPinnedRef.current = nextInnerPinnedState(
        innerPinnedRef.current,
        scrollTop,
        innerLastScrollTopRef.current,
        el.scrollHeight,
        el.clientHeight,
      );
      innerLastScrollTopRef.current = scrollTop;
      rememberInnerScrollState(el);
    };
    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY < 0 && el.scrollHeight > el.clientHeight) {
        innerPinnedRef.current = false;
        rememberInnerScrollState(el);
      }
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    el.addEventListener('wheel', handleWheel, { passive: true });

    // Pin now, then react only when lazy Markdown actually changes. The old
    // implementation polled every animation frame for 1.5 seconds in EVERY
    // assistant bubble; a long conversation could run thousands of redundant
    // callbacks on load. Resize/mutation/load events preserve the same all-
    // bubbles-to-bottom behavior without continuous frame work.
    const pinToInnerBottom = () => {
      if (innerPinnedRef.current) {
        el.scrollTop = el.scrollHeight;
        innerLastScrollTopRef.current = el.scrollTop;
        rememberInnerScrollState(el);
      }
    };
    pinToInnerBottom();

    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(pinToInnerBottom);
    resizeObserver?.observe(el);
    const mutationObserver =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(pinToInnerBottom);
    mutationObserver?.observe(el, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    el.addEventListener('load', pinToInnerBottom, true);

    const settleTimer = setTimeout(() => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      el.removeEventListener('load', pinToInnerBottom, true);
    }, 1500);

    return () => {
      el.removeEventListener('scroll', handleScroll);
      el.removeEventListener('wheel', handleWheel);
      clearTimeout(settleTimer);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      el.removeEventListener('load', pinToInnerBottom, true);
    };
  }, [
    innerAutoScroll,
    innerScrollStateRef,
    pinInnerToBottom,
    rememberInnerScrollState,
  ]);
  // Follow streaming token growth (content prop changes).
  useEffect(() => {
    if (!innerAutoScroll || !innerPinnedRef.current) return;
    const el = contentRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    innerLastScrollTopRef.current = el.scrollTop;
    rememberInnerScrollState(el);
  }, [content, innerAutoScroll, rememberInnerScrollState]);

  // Task-output bubbles show the paged, verdict-filtered window rather than the
  // `content` prop (only the newest page), so copy/save must use what is shown.
  const actionText = useMemo(
    () =>
      stripToolActivityMarkers(
        hasTaskOutputContext ? pagedDisplayContent : content,
      ),
    [hasTaskOutputContext, pagedDisplayContent, content],
  );

  const handleCopy = useCallback(async () => {
    const success = await copyToClipboard(actionText);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [actionText]);

  // Hidden while streaming (matches forkButton, whose onFork is withheld
  // mid-stream) — copying/saving a half-streamed message is not useful.
  const copyButton = !isStreaming && !isLiveVoicePending && (
    <button
      onClick={handleCopy}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      className={cn(ACTION_BUTTON_CLASS, 'hidden md:inline-flex')}
      title="Copy to clipboard"
      aria-label="Copy message"
    >
      {copied ? (
        <Check className="size-3 text-green-700 dark:text-green-500" />
      ) : (
        <Copy className="size-3" />
      )}
    </button>
  );

  const liveStatuses = useMemo(
    () => (isAssistant ? liveStatusesFromMarkdown(content) : []),
    [content, isAssistant],
  );
  const ttsText =
    liveStatuses.length > 0 ? liveStatuses.join(' ') : speechText || actionText;
  const ttsButton = isAssistant &&
    !isStreaming &&
    !isLiveVoicePending &&
    appConfig?.ttsEnabled &&
    content && (
      <button
        data-ui={
          liveStatuses.length > 0
            ? 'chat-live-narration-replay'
            : 'chat-message-tts'
        }
        data-message-id={id}
        onClick={() =>
          tts.toggle(id, ttsText, {
            lang:
              liveStatuses.length > 0
                ? appConfig?.ttsLang
                : speechLang || appConfig?.ttsLang,
            voice:
              liveStatuses.length > 0
                ? appConfig?.ttsVoice
                : speechVoice || appConfig?.ttsVoice,
            format: appConfig?.ttsFormat,
            ...(liveStatuses.length > 0
              ? {
                  exactChunks: liveStatuses,
                  format: 'ogg',
                  steps: LIVE_STATUS_TTS_STEPS,
                }
              : {}),
            projectId: project_id,
            ...(liveStatuses.length === 0 &&
            senderUserId?.startsWith('ai:') &&
            project_id &&
            conversation_id
              ? {
                  prepareUrl: messageSpeechUrl(project_id, conversation_id, id),
                  audioUrl: messageSpeechUrl(project_id, conversation_id, id),
                  cacheKey: `${conversation_id}-${id}`,
                  conversationId: conversation_id,
                  messageId: id,
                }
              : {}),
          })
        }
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        className={cn(ACTION_BUTTON_CLASS, 'inline-flex')}
        aria-label={
          ttsActive
            ? 'Stop'
            : liveStatuses.length > 0
              ? 'Replay Live narration'
              : 'Play message aloud'
        }
        title={
          ttsActive
            ? 'Stop'
            : liveStatuses.length > 0
              ? 'Replay Live narration'
              : 'Play (text-to-speech)'
        }
      >
        {ttsActive && tts.loading ? (
          <Loader2 className="size-3 animate-spin" />
        ) : ttsActive ? (
          <Square className="size-3 text-primary" />
        ) : (
          <Volume2 className="size-3" />
        )}
      </button>
    );

  const forkButton = onFork && (
    <button
      onClick={() => onFork(id)}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      className={cn(ACTION_BUTTON_CLASS, 'hidden md:inline-flex')}
      title="Fork from here"
      aria-label="Fork conversation from this message"
    >
      <GitFork className="size-3" />
    </button>
  );

  const saveToKbButton = project_id && !isSystem && !isStreaming && (
    <button
      onClick={() =>
        setKbSaveDialogInfo({
          content: actionText,
          project_id,
        })
      }
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      className={cn(ACTION_BUTTON_CLASS, 'hidden md:inline-flex')}
      title="Save to Knowledge Base"
      aria-label="Save message to Knowledge Base"
    >
      <Notebook className="size-3" />
    </button>
  );

  const personaInspectionButton = hasPersonaInspection && !isStreaming && (
    <button
      data-ui="chat-persona-inspection-button"
      data-message-id={id}
      onClick={() => setInspectionOpen(true)}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      className={cn(ACTION_BUTTON_CLASS, 'inline-flex')}
      title="Inspect prompt and transcript"
      aria-label="Inspect prompt and transcript"
    >
      <FileSearch className="size-3" />
    </button>
  );

  const personaInspectionDialog = hasPersonaInspection && (
    <Dialog open={inspectionOpen} onOpenChange={setInspectionOpen}>
      <DialogContent
        data-ui="chat-persona-inspection-dialog"
        className="flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-4xl"
      >
        <DialogHeader>
          <DialogTitle>Persona turn inspection</DialogTitle>
          <DialogDescription>
            The exact captured prompt, handoff metadata, and provider transcript
            for this turn.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain pr-1">
          {personaInspection.isLoading ? (
            <div
              className="flex items-center gap-2 text-sm text-muted-foreground"
              role="status"
            >
              <Loader2 className="size-4 animate-spin" />
              Loading turn details…
            </div>
          ) : personaInspection.error ? (
            <p className="text-sm text-destructive" role="alert">
              {personaInspection.error instanceof Error
                ? personaInspection.error.message
                : 'Could not load turn details.'}
            </p>
          ) : personaInspection.data ? (
            <>
              <section data-ui="chat-persona-inspection-handoff">
                <h3 className="mb-1 text-sm font-semibold">Handoff</h3>
                <pre className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 text-xs whitespace-pre-wrap break-words">
                  {JSON.stringify(personaInspection.data.handoff, null, 2)}
                </pre>
              </section>
              <section data-ui="chat-persona-inspection-system-prompt">
                <h3 className="mb-1 text-sm font-semibold">System prompt</h3>
                <pre className="max-h-96 overflow-auto rounded-md border bg-muted/40 p-3 text-xs whitespace-pre-wrap break-words">
                  {personaInspection.data.systemPrompt}
                </pre>
              </section>
              <section data-ui="chat-persona-inspection-turn-prompt">
                <h3 className="mb-1 text-sm font-semibold">Turn prompt</h3>
                <pre className="max-h-96 overflow-auto rounded-md border bg-muted/40 p-3 text-xs whitespace-pre-wrap break-words">
                  {personaInspection.data.prompt}
                </pre>
              </section>
              {personaInspection.data.history &&
                personaInspection.data.history.length > 0 && (
                  <section data-ui="chat-persona-inspection-history">
                    <h3 className="mb-1 text-sm font-semibold">
                      Conversation history supplied to the model
                    </h3>
                    <pre className="max-h-96 overflow-auto rounded-md border bg-muted/40 p-3 text-xs whitespace-pre-wrap break-words">
                      {JSON.stringify(personaInspection.data.history, null, 2)}
                    </pre>
                  </section>
                )}
              <section data-ui="chat-persona-inspection-transcript">
                <h3 className="mb-1 text-sm font-semibold">
                  Run transcript (V1 events)
                </h3>
                <pre className="max-h-[50vh] overflow-auto rounded-md border bg-muted/40 p-3 text-xs whitespace-pre-wrap break-words">
                  {personaInspection.data.transcript ||
                    'No provider transcript was emitted.'}
                </pre>
              </section>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );

  const actionsMenuButton = project_id && !isSystem && (
    <button
      onClick={(e) => {
        e.stopPropagation();
        setMessageActionsInfo({
          id,
          content: actionText,
          project_id,
          anchorY: e.clientY,
          hasFork: !!onFork,
          onFork: onFork ? () => onFork(id) : undefined,
        });
      }}
      className="rounded-full border border-border/50 bg-muted/30 p-1.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
      title="Message actions"
      aria-label="Message actions"
    >
      <MoreVertical className="size-4" />
    </button>
  );

  const deepLinksNav = deepLinks && deepLinks.length > 0 && (
    <nav
      data-ui="chat-message-deep-links"
      aria-label="Message links"
      className={cn(
        'flex flex-wrap items-center gap-2 px-2',
        isUser && 'justify-end',
      )}
    >
      {deepLinks.map((link) => (
        <Button
          key={`${link.label}:${link.href}`}
          asChild
          size="sm"
          variant={link.variant ?? 'outline'}
        >
          <a
            href={link.href}
            onClick={(event) => {
              // In-app links use the client-side router so the board keeps
              // its state; modifier clicks and external hrefs keep the
              // browser default.
              if (!isPlainLeftClick(event)) return;
              const appPath = appLinkPath(link.href);
              if (!appPath) return;
              event.preventDefault();
              void navigateToAppPath(appPath);
            }}
          >
            {link.label}
          </a>
        </Button>
      ))}
    </nav>
  );

  // ─── chat-page mode (source prop present) ────────────────────────────────
  if (source !== undefined) {
    const assistantDisplayName = virtualSenderName || assistantSenderName;
    const assistantAvatarUrl = virtualSenderAvatarUrl ?? undefined;
    const assistantExpectsAvatar = Boolean(
      virtualSenderName || senderUserId?.startsWith('ai:'),
    );
    return (
      <div
        data-ui={
          dataUi ??
          (isUser
            ? isOtherUser
              ? 'chat-other-user-message'
              : 'chat-current-user-message'
            : virtualSenderName
              ? 'chat-ai-user-message'
              : 'chat-assistant-message')
        }
        data-message-id={id}
        data-project-id={project_id || undefined}
        data-conversation-id={conversation_id || undefined}
        data-stream-key={stream_key || undefined}
        data-sender-user-id={senderUserId || undefined}
        className={cn(
          'group/msg flex min-w-0 flex-col gap-1.5',
          isUser ? 'items-end' : 'w-full items-start',
        )}
      >
        {!isUser && assistantDisplayName && (
          <div
            data-ui={
              virtualSenderName
                ? 'chat-persona-header'
                : 'chat-main-agent-header'
            }
            data-avatar-state={
              assistantExpectsAvatar
                ? assistantAvatarUrl
                  ? 'image'
                  : 'reserved'
                : 'default'
            }
            className={cn(
              'flex min-w-0 max-w-full items-center gap-2 px-2',
              virtualSenderName &&
                isStreaming &&
                'animate-in fade-in duration-300',
            )}
          >
            {assistantDisplayName &&
              (assistantExpectsAvatar ? (
                <span
                  data-ui={
                    virtualSenderName
                      ? 'chat-persona-avatar-slot'
                      : 'chat-main-agent-avatar-slot'
                  }
                  className="relative size-8 shrink-0 rounded-full bg-muted ring-1 ring-border/70 sm:size-9"
                >
                  {assistantAvatarUrl && (
                    <SecureImage
                      data-ui={
                        virtualSenderName
                          ? 'chat-persona-avatar'
                          : 'chat-main-agent-avatar'
                      }
                      src={assistantAvatarUrl}
                      fallbackSrc={virtualSenderAvatarFallbackUrl ?? undefined}
                      alt={`${assistantDisplayName} avatar`}
                      className="absolute inset-0 size-full rounded-full object-contain"
                    />
                  )}
                </span>
              ) : (
                <span
                  data-ui="chat-default-assistant-avatar-slot"
                  className="relative size-9 shrink-0 rounded-full bg-muted ring-1 ring-border"
                >
                  <img
                    data-ui="chat-default-assistant-avatar"
                    src={defaultAssistantAvatar}
                    alt={`${assistantDisplayName} avatar`}
                    className="absolute inset-0 size-full rounded-full object-contain"
                  />
                </span>
              ))}
            <span className="min-w-0">
              <span
                data-ui={
                  virtualSenderName
                    ? 'chat-persona-name'
                    : 'chat-main-agent-name'
                }
                className="block truncate text-sm font-semibold leading-tight text-foreground"
              >
                {assistantDisplayName}
              </span>
              {virtualSenderIdentity &&
                virtualSenderIdentity !== virtualSenderName && (
                  <span
                    data-ui="chat-persona-identity"
                    className="mt-0.5 block truncate text-[11px] leading-tight text-muted-foreground"
                  >
                    {virtualSenderIdentity}
                  </span>
                )}
            </span>
          </div>
        )}
        {isUser && sender_name && (
          <div
            data-ui="chat-human-header"
            className="flex min-w-0 max-w-full items-center gap-2 px-2"
          >
            <span
              data-ui="chat-human-avatar-slot"
              className="relative size-7 shrink-0 rounded-full bg-muted ring-1 ring-border/70"
            >
              {senderAvatarUrl ? (
                <SecureImage
                  data-ui="chat-human-avatar"
                  src={senderAvatarUrl}
                  alt={`${sender_name} avatar`}
                  className="absolute inset-0 size-full rounded-full object-cover"
                />
              ) : source === 'agent' ? (
                <Bot
                  data-ui="chat-agent-author-icon"
                  className="size-full p-1 text-muted-foreground"
                />
              ) : (
                <UserRound
                  data-ui="chat-human-avatar-fallback"
                  className="size-full p-1 text-muted-foreground"
                />
              )}
            </span>
            <span
              data-ui="chat-human-name"
              className="block min-w-0 truncate text-xs font-medium text-muted-foreground"
            >
              {sender_name}
            </span>
            {source === 'agent' && (
              <span
                data-ui="chat-agent-author-badge"
                className="shrink-0 rounded-full border border-border/70 px-1.5 text-[10px] font-medium leading-4 text-muted-foreground"
              >
                Agent
              </span>
            )}
          </div>
        )}
        <div
          className={cn(
            'min-w-0 overflow-hidden break-words border leading-7',
            isSystem ? 'text-[0.9375rem]' : 'text-base',
            livePersonaReveal?.phase === 'speaking' &&
              'min-w-[11.3rem] min-h-[2.875rem]',
            isError
              ? // The oklch() shadows are theme-neutral (black drop shadow, 5%
                // white inset highlight), so they stay as they are in both themes.
                'w-full max-w-full rounded-2xl border-destructive/25 bg-destructive/[0.07] px-4 py-3 text-destructive shadow-[0_1px_2px_oklch(0_0_0/0.12)]'
              : isUser
                ? isOtherUser
                  ? 'max-w-[min(90%,42rem)] rounded-2xl rounded-br-md border-violet-600/[0.2] bg-violet-500/[0.08] px-3.5 py-2.5 text-foreground shadow-[inset_0_1px_0_oklch(1_0_0/0.05)] dark:border-violet-300/[0.12] dark:bg-violet-400/[0.045]'
                  : 'max-w-[min(90%,42rem)] rounded-2xl rounded-br-md border-primary/[0.14] bg-primary/[0.045] px-3.5 py-2.5 text-foreground shadow-[inset_0_1px_0_oklch(1_0_0/0.05)]'
                : 'w-full max-w-full rounded-2xl border-black/[0.07] bg-black/[0.02] px-4 py-3 text-foreground shadow-[inset_0_1px_0_oklch(1_0_0/0.05)] dark:border-white/[0.07] dark:bg-white/[0.02]',
          )}
        >
          {attachments && attachments.length > 0 && (
            <div className="flex flex-col gap-2 mb-1">
              {attachments.map((att, i) => (
                <AttachmentRenderer key={i} attachment={att} />
              ))}
            </div>
          )}
          {!isUser && thinking && (
            <details className="mb-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none font-medium text-muted-foreground">
                Thinking…
              </summary>
              <div className="mt-1.5 whitespace-pre-wrap border-l border-border/70 pl-2.5">
                {thinking}
              </div>
            </details>
          )}
          {displayContent &&
            !liveRevealAwaitingFirstWord &&
            (isUser ? (
              hasCompleteBacktickFence(displayContent) ||
              /\]\(\/api\/knowledge\/[^/]+\/files\/content\?filename=[^)\s]+\)/.test(
                displayContent,
              ) ? (
                <div
                  ref={contentRef}
                  data-ui={
                    hasCompleteBacktickFence(displayContent)
                      ? 'chat-user-fenced-markdown'
                      : 'chat-user-knowledge-markdown'
                  }
                  className="chat-message-prose markdown-output markdown-output--inline -mr-3.5 pr-3.5 max-h-[50vh] overflow-y-auto overflow-x-hidden break-words [&_pre]:max-w-full [&_pre]:overflow-x-auto"
                >
                  <MarkdownContent>{displayContent}</MarkdownContent>
                </div>
              ) : (
                <p
                  ref={contentRef}
                  data-ui="chat-user-plain-text"
                  className="-mr-3.5 whitespace-pre-wrap break-words pr-3.5 leading-7 max-h-[50vh] overflow-y-auto"
                >
                  {displayContent}
                </p>
              )
            ) : (
              <div
                ref={contentRef}
                data-ui="chat-message-content"
                data-message-id={suppressInnerMessageId ? undefined : id}
                className={cn(
                  'chat-response-content chat-message-prose markdown-output markdown-output--inline prose prose-base prose-invert -mr-4 pr-4 max-w-none max-h-[50vh] overflow-y-auto overflow-x-hidden break-words [contain:inline-size] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_code]:break-words',
                  livePersonaReveal?.phase === 'speaking' &&
                    'live-voice-markdown',
                  // `prose-error` marks the turn as error-tinted markdown, so
                  // the global link treatment skips it and the destructive
                  // styling stays the only colour the turn carries.
                  isError && 'prose-error [&_*]:!text-destructive/90',
                )}
              >
                {earlierContentButton}
                <MarkdownContent
                  // A pending live voice reveal must pace the words itself:
                  // the deferred placeholder renders the full text, so never
                  // defer a row whose reveal is still pending. Released rows
                  // defer again once the reveal has finished.
                  deferUntilVisible={deferMarkdown && !isLiveVoicePending}
                  onSendMessage={onSendMessage}
                  onImplementPlan={onImplementPlan}
                  onSendPlanToKanban={onSendPlanToKanban}
                  onOpenArtifact={onOpenArtifact}
                  projectFolder={project_id}
                  questionAnswer={questionAnswer}
                  liveRevealProgress={liveRevealProgress}
                  toolCallDisplay={toolCallDisplay}
                  toolActivityRunning={isStreaming === true}
                  onToolDisclosureChange={handleToolDisclosureChange}
                >
                  {renderedContent}
                </MarkdownContent>
              </div>
            ))}
          {!isUser && isStreaming && !displayContent && !livePersonaReveal && (
            <p
              data-ui={
                preparingMemory
                  ? 'chat-memory-preparing'
                  : 'chat-participant-thinking'
              }
              className="flex items-center gap-1 text-xs text-muted-foreground"
              role="status"
            >
              <Loader2 className="size-3 animate-spin" />
              {preparingMemory ? 'Preparing memory…' : 'Thinking…'}
            </p>
          )}
          {livePersonaReveal &&
            livePersonaReveal.phase !== 'released' &&
            (livePersonaReveal.phase !== 'speaking' ||
              liveRevealAwaitingFirstWord) && (
              <div
                data-ui="chat-persona-voice-status"
                data-voice-phase={livePersonaReveal.phase}
                className="flex items-center gap-2 text-sm text-muted-foreground"
                role="status"
              >
                <Loader2 className="size-4 animate-spin" />
                <span>
                  {livePersonaReveal.phase === 'thinking'
                    ? 'Thinking…'
                    : livePersonaReveal.phase === 'waiting'
                      ? 'Waiting to speak…'
                      : 'Preparing voice…'}
                </span>
              </div>
            )}
          {created_at && (
            <div
              className={cn(
                'mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground',
                isUser ? 'justify-end' : 'justify-start',
              )}
            >
              <time
                data-ui="chat-message-time"
                dateTime={created_at}
                title={new Date(created_at).toLocaleString()}
                className="flex items-center gap-1"
              >
                {sourceIcon}
                {new Date(created_at).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
            </div>
          )}
        </div>
        {deepLinksNav}
        <div
          data-ui="chat-message-footer"
          className={cn(
            'flex min-h-6 w-full min-w-0 items-center gap-1 px-2 text-muted-foreground',
            isUser && 'justify-end',
          )}
        >
          {/* Pulsing dot in the always-present footer row (height is governed
              by the action buttons), so it adds/removes no line — avoids the
              layout shift the old standalone "Streaming…" <p> caused on
              completion. Matches the ConversationStatus / ObjectiveCard dot. */}
          {!isUser && (isStreaming || isLiveVoicePending) && (
            <span
              data-ui="chat-message-activity"
              className="inline-flex shrink-0 items-center text-[10px] text-amber-700/80 dark:text-amber-500/80"
              title={isLiveVoicePending ? 'Speaking…' : 'Streaming…'}
              aria-label={isLiveVoicePending ? 'Speaking' : 'Streaming'}
            >
              <span className="size-1.5 rounded-full bg-amber-600 dark:bg-amber-500 animate-pulse" />
            </span>
          )}
          {!isUser && telemetry && <TelemetryBar telemetry={telemetry} />}
          {steeringDeliveryStatus}
          {!isStreaming && !isLiveVoicePending && (
            <>
              <div
                data-ui="chat-message-actions"
                className={cn(
                  'flex shrink-0 items-center gap-1',
                  !isUser && telemetry && 'ml-1 border-l border-border/50 pl-2',
                )}
              >
                {copyButton}
                {ttsButton}
                {personaInspectionButton}
                {forkButton}
                {saveToKbButton}
                {actionsMenuButton}
              </div>
            </>
          )}
        </div>
        {personaInspectionDialog}
      </div>
    );
  }

  // ─── task-detail mode (no source prop) ───────────────────────────────────
  const displayName = isSystem
    ? 'Note'
    : isUser
      ? 'You'
      : agent_name || fallbackAgentName || 'Agent';
  const headerLabel =
    displayName +
    (!isSystem && !isUser && model_name ? ` · ${model_name}` : '');

  return (
    <div
      className={cn(
        'group/msg flex min-w-0 flex-col gap-1.5',
        isSystem || verdictTone
          ? 'items-center'
          : isUser
            ? 'items-end'
            : 'w-full items-start',
      )}
    >
      {!isAssistant && (
        <div className="flex items-center gap-1.5 px-2 text-[11px] text-muted-foreground">
          <span>{headerLabel}</span>
          {created_at && <span>{formatRelativeTime(created_at)}</span>}
          <div className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/msg:opacity-100 group-focus-within/msg:opacity-100">
            {copyButton}
            {ttsButton}
            {!isSystem && forkButton}
            {saveToKbButton}
            {actionsMenuButton}
          </div>
        </div>
      )}
      <div
        className={cn(
          'min-w-0 overflow-hidden break-words border leading-7',
          isSystem || verdictTone ? 'text-[0.9375rem]' : 'text-base',
          verdictTone && verdictTone !== 'neutral'
            ? cn(
                'max-w-[90%] rounded-xl px-3.5 py-2.5 text-foreground markdown-output markdown-output--inline',
                verdictTone === 'approve'
                  ? 'border-emerald-600/30 bg-emerald-500/10 dark:border-emerald-500/25 dark:bg-emerald-500/[0.08]'
                  : 'border-red-600/40 bg-red-500/10 dark:border-red-500/30 dark:bg-red-500/[0.10]',
              )
            : isSystem || verdictTone
              ? 'max-w-[90%] rounded-xl border-amber-600/30 bg-amber-500/10 px-3.5 py-2.5 italic text-muted-foreground dark:border-amber-500/20 dark:bg-amber-500/[0.07]'
              : isUser
                ? // The oklch() inset shadow is a 5% white highlight, theme-neutral.
                  'max-w-[min(90%,42rem)] rounded-2xl rounded-br-md border-primary/[0.14] bg-primary/[0.045] px-3.5 py-2.5 text-foreground shadow-[inset_0_1px_0_oklch(1_0_0/0.05)] markdown-output markdown-output--inline'
                : 'w-full max-w-full rounded-2xl border-black/[0.07] bg-black/[0.02] px-4 py-3 text-foreground shadow-[inset_0_1px_0_oklch(1_0_0/0.05)] dark:border-white/[0.07] dark:bg-white/[0.02] markdown-output markdown-output--inline',
        )}
      >
        {attachments && attachments.length > 0 && (
          <div className="flex flex-col gap-2 mb-1">
            {attachments.map((att, i) => (
              <AttachmentRenderer key={i} attachment={att} />
            ))}
          </div>
        )}
        {!isUser && thinking && (
          <details className="mb-2 text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none font-medium text-muted-foreground">
              Thinking…
            </summary>
            <div className="mt-1.5 whitespace-pre-wrap border-l border-border/70 pl-2.5">
              {thinking}
            </div>
          </details>
        )}
        <div
          ref={contentRef}
          data-ui="chat-message-content"
          data-message-id={id}
          className={cn(
            'chat-response-content overflow-y-auto overflow-x-hidden',
            // A full-width bubble must not let a wide table or code line widen
            // its container (dialogs and the Runs panel are shrink-to-fit
            // grid/flex children); the table and code blocks scroll instead.
            // A centred verdict card sizes to its content (it is capped at
            // 90% already); inline-size containment would collapse it to its
            // padding, one character per line.
            isAssistant
              ? cn('max-h-[40vh]', !verdictTone && '[contain:inline-size]')
              : 'max-h-[50vh]',
          )}
        >
          {earlierContentButton}
          {taskOutputContext?.runId ? (
            <ChunkedMarkdownContent
              chunks={taskOutputChunks}
              onSendMessage={onSendMessage}
              onImplementPlan={onImplementPlan}
              onSendPlanToKanban={onSendPlanToKanban}
              onOpenArtifact={onOpenArtifact}
              projectFolder={project_id}
              questionAnswer={questionAnswer}
              toolCallDisplay={toolCallDisplay}
              toolActivityRunning={isStreaming === true}
              onToolDisclosureChange={handleToolDisclosureChange}
            />
          ) : (
            <MarkdownContent
              onSendMessage={onSendMessage}
              onImplementPlan={onImplementPlan}
              onSendPlanToKanban={onSendPlanToKanban}
              onOpenArtifact={onOpenArtifact}
              projectFolder={project_id}
              questionAnswer={questionAnswer}
              toolCallDisplay={toolCallDisplay}
              toolActivityRunning={isStreaming === true}
              onToolDisclosureChange={handleToolDisclosureChange}
            >
              {renderedContent}
            </MarkdownContent>
          )}
        </div>
      </div>
      {steeringDeliveryStatus}
      {isAssistant && (
        <div className="flex items-center gap-1 px-2 text-muted-foreground">
          {copyButton}
          {ttsButton}
          {forkButton}
          {saveToKbButton}
          {actionsMenuButton}
        </div>
      )}
    </div>
  );
});
