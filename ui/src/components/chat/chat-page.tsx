import { Select, SelectItem } from '@/components/ui/select';
import type { MarkdownFileOpenHandler } from '@/lib/project-file-links';
import { KnowledgeComposer, KnowledgePicker } from './knowledge-source';
import {
  KNOWLEDGE_DRAG_TYPE,
  knowledgeReferenceMarkdown,
  type KnowledgeReference,
} from '@/lib/knowledge-reference';
import { BookOpen } from 'lucide-react';
import {
  Fragment,
  memo,
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react';
import { Capacitor } from '@capacitor/core';
import { useSmartScroll } from '@/hooks/use-smart-scroll';
import {
  PreviousTranscriptLayer,
  useTranscriptRevealGate,
} from './transcript-reveal-gate';
import { COST_TEXT_CLASS } from '@/lib/cost-display';
import {
  hasPartialResponseBeforeSandboxError,
  isPersistentTurnTimeout,
} from '@/lib/chat-failure-recovery';
import {
  useQuery,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import {
  Send,
  Loader2,
  Plus,
  Paperclip,
  Square,
  Pin,
  PinOff,
  Pencil,
  Check,
  MessageSquare,
  Target,
  GitFork,
  GitBranch,
  Copy,
  X,
  Mic,
  Trash2,
  Camera,
  Video,
  Share2,
  Download,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  Bot,
  ArrowRightLeft,
  MoreHorizontal,
  BrainCircuit,
  Users,
  Radio,
  Globe2,
  PanelLeftClose,
  PanelLeftOpen,
  SquarePen,
  Folder,
  Layers,
} from 'lucide-react';
import { BackgroundTasksPanel } from '@/components/background-tasks-panel';
import { ShareDialog } from '@/components/share-dialog';
import { ProjectWorkspacePane } from '@/components/project-workspace-pane';
import {
  CHAT_MIN_WIDTH,
  useProjectWorkspacePane,
} from '@/hooks/use-project-workspace-pane';
import { useRegisterWorkspaceToggle } from '@/hooks/use-workspace-toggle';
import { useConversationSidebarResize } from '@/hooks/use-conversation-sidebar-resize';
import { useWorkspacePaneReveal } from '@/hooks/use-workspace-pane-reveal';
import { SecureImage } from '@/components/secure-image';
import MeetingRecordingOverlay from '@/components/chat/meeting-recording-overlay';
import { useMeetingRecording } from '@/hooks/use-meeting-recording';
import { useMediaQuery } from '@/hooks/use-media-query';
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/ui/search-input';
import { DeleteConversationDialog } from './delete-conversation-dialog';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '@/components/ui/dropdown-menu';
import { saveMeetingLanguage } from '@/lib/meeting-languages';
import { setViewedConversationPresence } from '@/lib/websocket';
import { clearRejectedLiveModeOwnership } from '@/lib/live-mode-queue';
import { PERSONA_LIVE_MODE_HINT, resolveLiveModeKind } from '@/lib/live-mode';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  FILE_DRAG_TYPE,
  PREVIEW_SELECTION_DRAG_TYPE,
  type PreviewSelectionPayload,
} from '@/lib/drag-types';

import { cn, copyToClipboard } from '@/lib/utils';
import { endsWithOpenQuestion } from '@/lib/ask-user-question';
import {
  fetchChatTranscript,
  type TranscriptResponse,
  sendChatMessage,
  answerCodexUserInput,
  stopChatAgent,
  fetchConversations,
  fetchConversation,
  createConversation,
  fetchProjectWorktrees,
  getConversationDiff,
  uploadAttachment,
  markConversationRead,
  resolvePendingConversation,
  markAllConversationsRead,
  deleteConversation,
  updateConversation,
  generateConversationTitle,
  forkConversation,
  exportConversationHtml,
  fetchProjectCommands,
  type SlashCommand,
  fetchRuntimeCatalog,
  type RuntimeSelection,
  type MemoryContextLevel,
  ApiError,
  extendActiveRun,
  stopBackgroundTask,
  handoffConversation,
  type AttentionResponse,
  fetchConversationAiUsers,
  fetchMainConversationAiUser,
  fetchProjectAvailableAiUsers,
  type AiUser,
  setConversationPersonaLoopApi,
  startConversationPersonaRoundApi,
  createTask,
  fetchPlanArtifactText,
  reconcileQueuedChatMessages,
  withdrawQueuedChatMessage,
  importCodexThread,
  saveBlobAsFile,
} from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { markConversationViewedInAttention } from '@/lib/attention';
import {
  useProject,
  useMeetingAccess,
  useProjects,
} from '@/hooks/use-projects';
import {
  useBlocker,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router';
import {
  canLeaveActivePreview,
  applyIfLeaveAllowed,
  useStore,
  type ChatModeOverride,
  type QueuedPrompt,
} from '@/store';
import { QueuedPromptList } from './queued-prompt-list';
import { hydrate as hydratePreviewTab } from './files-tab';
import type { FileDeepLink } from '@/lib/file-deep-link';
import {
  discardQueuedPromptBatch,
  isConversationNotFoundError,
  isDeletableQueuedPrompt,
  isMutableQueuedPrompt,
  isPendingDirectQueuedPrompt,
  markQueuedPromptBatchAwaitingAcknowledgement,
  missingConversationPromptNotice,
  reconcileQueuedPromptReceipts,
  removeAcknowledgedQueuedPromptBatch,
  releaseQueuedPromptBatchForDrain,
  replaceQueuedPromptBatchWithServerOwned,
  restoreFailedQueuedPromptBatch,
} from '@/lib/queued-prompt-lifecycle';
import type {
  ChatModeDefinition,
  ChatMessage,
  ChatMessageAttachment,
  ChatDeepLink,
  Conversation,
  TranscriptEntry,
  OpenFileContext,
  ToolCallDisplay,
} from '@/types';
import { resolveToolCallDisplay } from '@/types';
import { projectHasRepository, projectUsesCode } from '@/lib/project-code';
import {
  RepositorySetupPrompt,
  REPOSITORY_SETUP_PROMPT,
  GIT_INITIALIZATION_SETUP_PROMPT,
} from './repository-setup-prompt';
import { snapshotOpenFileContext } from '@/lib/open-file-context';
import type {
  QuestionSendHandler,
  QuestionSubmission,
} from '@/components/markdown-content';
import type { PlanKanbanAction } from '@/components/markdown-content';
import { planKanbanTask } from '@/lib/plan-to-kanban';
import {
  usePasteAttachments,
  type PendingAttachment,
} from '@/hooks/use-paste-attachments';
import { ChatMessageBubble } from '@/components/chat/chat-message-bubble';
import { ChatForkDivider } from '@/components/chat/chat-fork-divider';
import { ChatJumpToLatest } from '@/components/chat/chat-jump-to-latest';
import type { BrowserAnnotationSubmission } from '@/components/chat/browser-tab';
import type { InnerScrollState } from '@/components/chat/chat-message-bubble-scroll';
import { RuntimeHarnessIcon } from '@/components/chat/runtime-harness-icon';
import { RuntimePicker } from '@/components/chat/runtime-picker';
import {
  composerCardClassName,
  composerFooterClassName,
  composerFooterIconButtonClassName,
  composerHintClassName,
  composerPillClassName,
  composerSendButtonClassName,
  composerStopButtonClassName,
  composerTextareaClassName,
} from '@/components/chat/composer-styles';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  AiUsersMenu,
  type DraftAiUserSelection,
} from '@/components/chat/ai-users-menu';
import { effectiveDraftInvitedIds } from '@/lib/draft-ai-user-invites';
import {
  ProjectPicker,
  projectTreeOptions,
} from '@/components/layout/project-picker';
import { availableProjectModes } from '@/lib/modes';
import { useDictationFailureToast, useLiveVoice } from '@/hooks/use-live-voice';
import { useVoiceRecorder } from '@/hooks/use-voice-recorder';
import { MicLevelMeter } from './mic-level-meter';
import { dictatedTextInsertion } from '@/lib/dictation-text';
import {
  ListeningLanguagePicker,
  useSpeechLanguageOptions,
} from '@/components/chat/listening-language-picker';
import { stripChatControlMetadata as stripTalkingStickControl } from '@/lib/chat-control-metadata';
import { shouldEndNewConversationComposition } from '@/lib/chat-navigation';
import { AttachmentChips } from '@/components/attachment-chips';
import { ScheduledTasksSidebarSection } from '@/components/chat/scheduled-tasks-sidebar';
import { ConversationListEmptyState } from '@/components/chat/conversation-list-empty-state';
import { toast } from 'sonner';
import {
  describeFailedUploads,
  type FailedUpload,
} from '@/lib/attachment-description';
import { isNative } from '@/lib/native-bridge';
import { noteKeyboardEvent } from '@/lib/hardware-keyboard';
import { useAttributionMembers } from '@/hooks/use-attribution-members';
import { useAuth } from '@/lib/auth';
import {
  LiveModePanel,
  type LiveModePanelHandle,
} from '@/components/chat/live-mode-panel';
import {
  defaultAgentStreamAnchorId,
  hasPersonaResponseAfterLastUser,
  personaSenderId,
} from '@/lib/chat-transcript-speakers';
import { mainResponseOwner } from '@/lib/chat-stream-ownership';
import {
  canonicalSteeringIdsWithContinuation,
  findTranscriptSteeringReceipt,
  reconcileTranscriptOwnership,
} from '@/lib/chat-transcript-ownership';
import {
  isErrorMessageContent,
  simpleHash,
  transcriptToRenderItems,
  type RenderItem,
} from '@/lib/chat-transcript-render-items';
import { codexThreadIdFromDeepLink } from '@/lib/codex-thread-link';
import { useAppConfig } from '@/hooks/use-app-config';

/** Width of the transcript column and the composer under it, so the input
 * card lines up with the agent response bubbles. */
const CHAT_COLUMN_CLASS = 'mx-auto max-w-4xl';
const CONV_PAGE_SIZE = 50;
const CONV_PAGE_TIMEOUT_MS = 15_000;
const NEW_CHAT_KEY = '__new__';
/** Voiced audio a dictated phrase needs (detector default 300 ms is longer
 * than a one-word answer such as "yes"); still above clicks and taps. */
const DICTATION_MIN_SPEECH_MS = 150;

const CONVERSATION_DATE_GROUPS = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['this-week', 'This week'],
  ['older', 'Older'],
] as const;

type ConversationDateGroup = (typeof CONVERSATION_DATE_GROUPS)[number][0];

function conversationDateGroup(
  conversation: Conversation,
): ConversationDateGroup {
  const activityDate = new Date(
    conversation.last_assistant_at ??
      conversation.last_user_at ??
      conversation.created_at,
  );
  const now = new Date();
  const dateKey = (date: Date) =>
    `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  const todayKey = dateKey(now);
  if (dateKey(activityDate) === todayKey) return 'today';

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dateKey(activityDate) === dateKey(yesterday)) return 'yesterday';

  const weekStart = new Date(now);
  const daysSinceMonday = (weekStart.getDay() + 6) % 7;
  weekStart.setDate(weekStart.getDate() - daysSinceMonday);
  weekStart.setHours(0, 0, 0, 0);
  if (activityDate >= weekStart) return 'this-week';
  return 'older';
}

/** Returned by sendPreparedMessage when the backend confirmed that the target
 * conversation no longer exists, so callers must not retry or restore it. */
const CONVERSATION_MISSING_FAILURE = { userMessage: undefined } as const;
type ConversationsData = InfiniteData<Conversation[], number>;
const DEFAULT_CHAT_MODE_OPTIONS: Array<{
  id: ChatModeOverride;
  label: string;
}> = [
  { id: 'ask', label: 'Ask' },
  { id: 'plan', label: 'Plan' },
  { id: 'code', label: 'Code' },
  { id: 'debug', label: 'Debug' },
];
const MEMORY_LEVELS: MemoryContextLevel[] = [
  'off',
  'minimal',
  'standard',
  'deep',
];
const MEMORY_LEVEL_LABELS: Record<MemoryContextLevel, string> = {
  off: 'Off',
  minimal: 'Minimal',
  standard: 'Standard · child projects',
  deep: 'Deep · parent & related projects',
};

const MemoryContextControl = memo(function MemoryContextControl({
  composerKey,
  disabled,
}: {
  composerKey: string;
  disabled?: boolean;
}) {
  const level = useStore(
    useCallback(
      (state: {
        memoryLevelByComposerKey: Record<string, MemoryContextLevel>;
      }) => state.memoryLevelByComposerKey[composerKey] ?? 'off',
      [composerKey],
    ),
  );
  const index = MEMORY_LEVELS.indexOf(level);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={disabled}
          data-ui="memory-context-trigger"
          data-memory-level={level}
          aria-label={`Memory context: ${MEMORY_LEVEL_LABELS[level]}`}
          title={`Memory context: ${MEMORY_LEVEL_LABELS[level]}`}
          className={cn(
            'size-7 shrink-0',
            // Translucent violet fill + hover read on both themes; only the text tones are theme-swapped.
            level === 'off'
              ? 'text-muted-foreground/50'
              : 'bg-violet-500/10 text-violet-600 hover:bg-violet-500/15 hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-300',
          )}
        >
          <BrainCircuit className="size-3.5" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        data-ui="memory-context-control"
        data-memory-level={level}
        className="min-w-0 p-3"
      >
        <label
          data-ui="memory-context-slider"
          className="flex w-28 items-center"
          title={
            level === 'deep'
              ? 'Include current and authorized related-project memories'
              : 'Choose memory context for this turn'
          }
        >
          <span className="sr-only">Memory context</span>
          <input
            type="range"
            min={0}
            max={3}
            step={1}
            value={index}
            disabled={disabled}
            aria-label="Memory context"
            aria-valuetext={MEMORY_LEVEL_LABELS[level]}
            className="h-1 w-full cursor-pointer accent-violet-600 dark:accent-violet-500 disabled:cursor-not-allowed"
            onKeyDown={(event) => event.stopPropagation()}
            onChange={(event) => {
              const next =
                MEMORY_LEVELS[Number(event.currentTarget.value)] ?? 'off';
              useStore.getState().setMemoryLevelForComposer(composerKey, next);
            }}
          />
        </label>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

// --- Transcript rendering ---

function aiUserAvatarUrl(aiUserId: string): string {
  return `/api/ai-users/${encodeURIComponent(aiUserId)}/avatar?thumbnail=1`;
}

function personaAvatarUrl(
  item: Pick<RenderItem, 'emote'>,
  aiUserId: string | undefined,
  aiUser: AiUser | undefined,
): string | undefined {
  const baseAvatarUrl =
    aiUser?.avatarUrl ?? (aiUserId ? aiUserAvatarUrl(aiUserId) : undefined);
  if (item.emote && aiUserId) {
    const versionedEmoteUrl = aiUser?.emotes.find(
      (emote) => emote.name === item.emote,
    )?.url;
    // Preserve the emote identity while participant metadata catches up. The
    // native cache can reuse the matching emote rendered earlier; metadata
    // later replaces this fallback with the canonical versioned URL.
    return (
      versionedEmoteUrl ??
      `/api/ai-users/${encodeURIComponent(aiUserId)}/emotes/${encodeURIComponent(item.emote)}?thumbnail=1`
    );
  }
  return baseAvatarUrl;
}

interface InFlightSteeringMessage {
  localId: string;
  serverId?: string;
  conversationId: string;
  streamKey: string;
  content: string;
  attachments?: ChatMessageAttachment[];
  createdAt: string;
  delivery: 'pending' | 'steered' | 'queued' | 'unconfirmed';
  splitOffset?: number;
  targetMessageId?: string;
}

/**
 * Delivery of a steer whose POST returned. `followup` means the server runs the
 * message as its own turn, which the in-flight list already treats as `pending`;
 * only a response that names no known delivery stays `unconfirmed`.
 */
function steeringDeliveryFromResponse(
  delivery: string | undefined,
): InFlightSteeringMessage['delivery'] {
  if (delivery === 'steered') return 'steered';
  if (delivery === 'pending' || delivery === 'followup') return 'pending';
  return 'unconfirmed';
}

interface ToolActivityBlock {
  start: number;
  end: number;
  kind: 'request' | 'result' | 'error';
  toolId?: string;
  content: string;
  ownedResults: string[];
}

function toolActivityBlocks(content: string): ToolActivityBlock[] {
  const markerPattern =
    /<!--\s*carapa-tool:(request|result|error)(?:\s+tool-id="([^"]+)")?\s*-->/g;
  const blocks: ToolActivityBlock[] = [];
  let match: RegExpExecArray | null;
  while ((match = markerPattern.exec(content)) !== null) {
    let end = markerPattern.lastIndex;
    const lineBreak = content.slice(end).match(/^\r?\n/);
    if (lineBreak) end += lineBreak[0].length;
    let sawQuote = false;
    while (end < content.length) {
      const lineEnd = content.indexOf('\n', end);
      const nextEnd = lineEnd < 0 ? content.length : lineEnd + 1;
      const line = content.slice(end, lineEnd < 0 ? content.length : lineEnd);
      if (!/^[\t ]*>/.test(line)) break;
      sawQuote = true;
      end = nextEnd;
    }
    if (!sawQuote) end = markerPattern.lastIndex;
    blocks.push({
      start: match.index,
      end,
      kind: match[1] as ToolActivityBlock['kind'],
      toolId: match[2],
      content: content.slice(match.index, end),
      ownedResults: [],
    });
  }
  return blocks;
}

/** Keep anonymous (tool-id-less) tool activity atomic at a steering split. */
function safeSteeringBoundary(content: string, boundary: number): number {
  const boundedBoundary = Math.min(content.length, Math.max(0, boundary));
  const blocks = toolActivityBlocks(content);
  const containingBlock = blocks.find(
    (block) => block.start < boundedBoundary && boundedBoundary < block.end,
  );
  if (containingBlock) return containingBlock.end;

  let openRequestStart: number | undefined;
  for (const block of blocks) {
    if (block.start >= boundedBoundary) break;
    if (block.toolId) continue;
    if (block.kind === 'request') {
      openRequestStart = block.start;
    } else if (openRequestStart !== undefined) {
      openRequestStart = undefined;
    }
  }
  return openRequestStart ?? boundedBoundary;
}

/** Split prose chronologically while keeping identified results with their call. */
function splitToolAwareAssistantContent(
  content: string,
  requestedBoundaries: number[],
): string[] {
  const boundaries: number[] = [];
  for (const requested of requestedBoundaries) {
    boundaries.push(
      safeSteeringBoundary(
        content,
        Math.max(boundaries.at(-1) ?? 0, requested),
      ),
    );
  }
  const segments = Array.from({ length: boundaries.length + 1 }, () => '');
  const blocks = toolActivityBlocks(content);
  const requestById = new Map<string, ToolActivityBlock>();
  const relocatedResults = new Set<ToolActivityBlock>();
  for (const block of blocks) {
    if (!block.toolId) continue;
    if (block.kind === 'request') {
      if (!requestById.has(block.toolId)) requestById.set(block.toolId, block);
      continue;
    }
    const request = requestById.get(block.toolId);
    if (!request) continue;
    request.ownedResults.push(block.content);
    relocatedResults.add(block);
  }

  const segmentAt = (position: number) => {
    let segment = 0;
    while (segment < boundaries.length && position >= boundaries[segment]) {
      segment += 1;
    }
    return segment;
  };
  const appendText = (start: number, end: number) => {
    let cursor = start;
    while (cursor < end) {
      const segment = segmentAt(cursor);
      const nextBoundary = boundaries[segment] ?? content.length;
      const sliceEnd = Math.min(end, nextBoundary);
      segments[segment] += content.slice(cursor, sliceEnd);
      cursor = sliceEnd;
    }
  };

  let cursor = 0;
  for (const block of blocks) {
    appendText(cursor, block.start);
    if (!relocatedResults.has(block)) {
      const segment = segmentAt(block.start);
      segments[segment] += block.content + block.ownedResults.join('');
    }
    cursor = block.end;
  }
  appendText(cursor, content.length);
  return segments;
}

function SteeringDeliveryStatus({
  delivery,
}: {
  delivery: 'pending' | 'steered' | 'queued' | 'unconfirmed';
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 text-[10px]',
        delivery === 'steered'
          ? 'text-emerald-700 dark:text-emerald-500'
          : 'text-muted-foreground',
      )}
    >
      {delivery === 'pending' ? (
        <>
          <Loader2 className="size-3 animate-spin" /> Applying to current turn…
        </>
      ) : delivery === 'steered' ? (
        <>
          <Check className="size-3" /> Applied to current turn
        </>
      ) : delivery === 'queued' ? (
        <>Queued for the next turn</>
      ) : (
        <>Delivery not confirmed</>
      )}
    </span>
  );
}
const HistoricalTaskMilestone = memo(function HistoricalTaskMilestone({
  item,
}: {
  item: Pick<
    RenderItem,
    'id' | 'content' | 'taskId' | 'taskTitle' | 'created_at'
  >;
}) {
  return (
    <div
      data-ui="chat-task-milestone"
      data-milestone-id={item.id}
      data-task-id={item.taskId}
      role="status"
      aria-label={`${item.content} (${item.taskId ?? 'unknown'})`}
      className="mx-auto w-full max-w-2xl rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-center text-xs text-muted-foreground"
    >
      <span>{item.content}</span>
    </div>
  );
});

function codexQuestionRequestId(content: string): string | null {
  const match = content.match(/```askuserquestion\s*\n(\{[^\n]*\})\s*\n```/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as { codexRequestId?: unknown };
    return typeof parsed.codexRequestId === 'string'
      ? parsed.codexRequestId
      : null;
  } catch {
    return null;
  }
}

/**
 * Assistant IDs are created before their first streamed chunk and retained by
 * canonical transcript reconciliation. Their content is intentionally mutable;
 * using it as the React key remounts the bubble on every chunk. User messages
 * retain a content key because their optimistic and persisted IDs can differ.
 */
function stableMessageRenderKey(item: RenderItem, occurrence: number): string {
  if (item.role === 'assistant') return `assistant:${item.id}`;
  const content = stripTalkingStickControl(item.content).trim();
  return `${item.role}:${simpleHash(content)}:${occurrence}`;
}

function clearCompletedStreamingForConversation(
  conversationId: string,
  force = false,
  retainCompletionMarker = false,
): void {
  const state = useStore.getState();
  const activeKey = state.activeStreamKeyByConv[conversationId];
  const prevKey = state.prevStreamKeyByConv[conversationId];
  if (activeKey && (force || state.chatStreamingCompleted[activeKey])) {
    if (retainCompletionMarker) state.setChatOutput(activeKey, '');
    else state.clearChatOutput(activeKey);
  }
  if (prevKey && (force || state.chatStreamingCompleted[prevKey])) {
    if (retainCompletionMarker) state.setChatOutput(prevKey, '');
    else {
      state.clearChatOutput(prevKey);
      state.clearPrevStreamKeyForConv(conversationId);
    }
  }
}

function planArtifactFromMessage(content: string): {
  artifactPath: string;
  fallbackContent?: string;
} | null {
  const matches = [
    ...content.matchAll(/```carapaplan\s*\n(\{[^\n]*\})\s*\n```/g),
  ];
  const match = matches.at(-1);
  if (!match) return null;
  try {
    const metadata = JSON.parse(match[1]) as {
      artifactPath?: unknown;
      planText?: unknown;
    };
    if (
      typeof metadata.artifactPath !== 'string' ||
      !metadata.artifactPath.startsWith('artifacts/plans/') ||
      !metadata.artifactPath.endsWith('.md')
    )
      return null;
    const fallbackContent =
      typeof metadata.planText === 'string' && metadata.planText.trim()
        ? metadata.planText
        : content.slice(0, match.index).trim();
    return {
      artifactPath: metadata.artifactPath,
      ...(fallbackContent ? { fallbackContent } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Build the chat-input text inserted when a text selection is dragged out of
 * the file preview pane: an optional file-reference line (`@<path> (lines
 * a-b)` when line numbers are known, else `@<path>`, else omitted) followed
 * by the selected text in a fenced code block. The fence is widened past the
 * longest backtick run inside the selection so a nested ``` fence can't
 * terminate the block early.
 */
function formatSelectionInsert(p: PreviewSelectionPayload): string {
  const longestBackticks = (p.text.match(/`+/g) ?? []).reduce(
    (m, s) => Math.max(m, s.length),
    0,
  );
  const fence = '`'.repeat(Math.max(3, longestBackticks + 1));
  let refLine = '';
  if (p.path) {
    refLine =
      p.startLine != null && p.endLine != null
        ? `@${p.path} (lines ${p.startLine}-${p.endLine})`
        : `@${p.path}`;
  }
  return `${refLine ? refLine + '\n' : ''}${fence}\n${p.text}\n${fence}\n`;
}

// --- StallWarningBanner ---

/**
 * Rendered above the streaming bubble when the in-process stall watchdog
 * fires a `run_stalled_warning` for the active conversation. The agent is
 * still alive but silent; in `graceMs` it will be killed unless the user
 * clicks "Keep waiting" (which calls POST /api/active-runs/:runId/extend).
 *
 * Auto-disappears when activity resumes or the warning is otherwise cleared
 * (answer/extend success, kill, or chat_completed).
 */
const StallWarningBanner = memo(function StallWarningBanner({
  conversationId,
}: {
  conversationId: string | null;
}) {
  const warning = useStore(
    useCallback(
      (s) =>
        conversationId ? s.stalledWarningsByConv[conversationId] : undefined,
      [conversationId],
    ),
  );
  const clearStalledWarning = useStore((s) => s.clearStalledWarning);
  const [extending, setExtending] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!warning) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [warning]);

  if (!warning || !conversationId) return null;

  const remainingMs = Math.max(0, warning.warnedAt + warning.graceMs - nowMs);
  const remainingSec = Math.ceil(remainingMs / 1000);

  const handleExtend = async () => {
    setExtending(true);
    try {
      const ok = await extendActiveRun(warning.runId);
      if (ok) {
        clearStalledWarning(conversationId);
      }
    } catch (err) {
      console.warn('[stall] extend failed', err);
    } finally {
      setExtending(false);
    }
  };

  return (
    <div className="flex justify-start">
      <div
        data-ui="agent-stall-warning"
        data-run-id={warning.runId}
        // Translucent amber fill reads on both themes; border/text tones are theme-swapped.
        className="max-w-[75%] min-w-0 rounded-lg px-3 py-2 text-sm bg-amber-500/10 border border-amber-600/40 text-amber-800 dark:border-amber-500/30 dark:text-amber-100"
      >
        <div className="flex items-start gap-2">
          <Loader2 className="size-3.5 mt-0.5 shrink-0 animate-spin text-amber-700 dark:text-amber-400" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">Agent has gone quiet</p>
            <p className="text-[11px] opacity-70 mt-0.5">
              No output for a while. Will stop in {remainingSec}s.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs shrink-0 border-amber-600/50 hover:bg-amber-500/20 dark:border-amber-500/40"
            onClick={handleExtend}
            disabled={extending || remainingMs === 0}
          >
            Keep waiting
          </Button>
        </div>
      </div>
    </div>
  );
});

// --- BackgroundTasksBanner ---

const BackgroundTasksBanner = memo(function BackgroundTasksBanner({
  conversationId,
  projectId,
}: {
  conversationId: string | null;
  projectId: string;
}) {
  const tasks = useStore(
    useCallback(
      (s) =>
        conversationId ? s.backgroundTasksByConv[conversationId] : undefined,
      [conversationId],
    ),
  );
  if (!conversationId) return null;
  return (
    <BackgroundTasksPanel
      tasks={tasks}
      onStop={(taskId) => stopBackgroundTask(projectId, conversationId, taskId)}
    />
  );
});

// --- StreamingBubble ---

/**
 * Isolated child component that owns the per-chunk Zustand selectors.
 * Moving the `chatStreaming` selector here means only this tiny component
 * re-renders on every chunk — the parent ChatPage and the message list stay
 * untouched until streaming starts/stops (a boolean change, not per-chunk).
 */
// Cap how often the streaming bubble re-renders the markdown subtree.
// ReactMarkdown + rehypeHighlight re-parses + re-tokenizes the entire growing
// response on every render, which on mid-range Android devices saturates the
// main thread when tokens arrive at 30+ Hz (frozen scroll, unresponsive tap).
// 100ms (10 Hz) is fast enough to look fluid and slow enough to keep the
// device responsive. The final chunk and completion event bypass the throttle.
const STREAM_RENDER_MIN_INTERVAL_MS = 100;

function comparableAssistantContent(content: string): string {
  return stripTalkingStickControl(content)
    .replace(
      /\[\[live:\s*[^\]\r\n]+\]\]/gi,
      (match, offset, source: string) => {
        const codeExample =
          source.slice(0, offset).trimEnd().endsWith('`') &&
          source
            .slice(offset + match.length)
            .trimStart()
            .startsWith('`');
        return codeExample ? match : '';
      },
    )
    .replace(/\s+/g, ' ')
    .trim();
}

const EMPTY_STREAMING_ATTACHMENTS: ChatMessageAttachment[] = [];
const StreamingBubble = memo(function StreamingBubble({
  streamKey,
  projectId,
  conversationId,
  isRunning,
  preparingMemory = false,
  virtualSender,
  assistantName,
  onSendMessage,
  onFork,
  onContentGrow,
  onFinalContentCommit,
  onImplementPlan,
  onSendPlanToKanban,
  onOpenArtifact,
  contentOverride,
  completedOverride,
  bubbleId,
  innerScrollStateRef,
  toolCallDisplay,
  showStreamAttachments = true,
}: {
  streamKey: string | null;
  projectId: string;
  conversationId: string | null;
  /** True when a run is in flight for this conversation — used to render the
   *  "Thinking…" placeholder when no stream content has arrived yet. Lets us
   *  own the entire "pending" rendering inside this component so the parent's
   *  inline Thinking… badge doesn't swap with this one (that swap caused a
   *  layout shift on user send). */
  isRunning: boolean;
  preparingMemory?: boolean;
  virtualSender?: Pick<AiUser, 'id' | 'name' | 'identity' | 'avatarUrl'> | null;
  /** Configured name for the default agent when no persona owns this stream. */
  assistantName?: string | null;
  onSendMessage: QuestionSendHandler;
  /** Per-bubble fork handler. Only user messages are forkable (see
   *  ChatMessageBubble onFork comment); the streaming bubble renders an
   *  assistant turn, so this is effectively unused now but kept optional so
   *  the prop can be omitted without a type error. */
  onFork?: (id: string) => void;
  /** Called on every throttled content flush so the OUTER list can follow
   *  token growth (scroll-if-pinned). Decoupled from this bubble's own
   *  in-card scroll. */
  onContentGrow?: () => void;
  /** Synchronously preserve the outer pinned viewport when final canonical
   * Markdown changes this bubble's height before paint. */
  onFinalContentCommit?: () => void;
  /** Plan actions become available on the completed stream frame even when
   * canonical transcript ownership has not resolved yet. */
  onImplementPlan?: (artifactPath: string) => void;
  onSendPlanToKanban?: (plan: PlanKanbanAction) => Promise<void>;
  onOpenArtifact?: MarkdownFileOpenHandler;
  /** A turn segment bounded by an acknowledged steering message. */
  contentOverride?: string;
  completedOverride?: boolean;
  bubbleId?: string;
  innerScrollStateRef?: React.MutableRefObject<InnerScrollState | null>;
  toolCallDisplay: ToolCallDisplay;
  /** False for pre-steering segments; run-level artifacts belong on the final segment. */
  showStreamAttachments?: boolean;
}) {
  const chatStreaming = useStore(
    useCallback(
      (s: { chatStreamingOutput: Record<string, string> }) =>
        streamKey ? s.chatStreamingOutput[streamKey] || '' : '',
      [streamKey],
    ),
  );
  const isStreamingCompleted = useStore(
    useCallback(
      (s: { chatStreamingCompleted: Record<string, boolean> }) =>
        streamKey ? (s.chatStreamingCompleted[streamKey] ?? false) : false,
      [streamKey],
    ),
  );
  const telemetry = useStore(
    useCallback(
      (s: { chatStreamingTelemetry: Record<string, any> }) =>
        streamKey ? s.chatStreamingTelemetry[streamKey] : null,
      [streamKey],
    ),
  );
  const streamingAttachments = useStore(
    useCallback(
      (s: {
        chatStreamingAttachments?: Record<string, ChatMessageAttachment[]>;
      }) =>
        streamKey && showStreamAttachments
          ? (s.chatStreamingAttachments?.[streamKey] ??
            EMPTY_STREAMING_ATTACHMENTS)
          : EMPTY_STREAMING_ATTACHMENTS,
      [showStreamAttachments, streamKey],
    ),
  );
  const effectiveContent = contentOverride ?? chatStreaming;
  const effectiveCompleted = completedOverride ?? isStreamingCompleted;
  const contentOverrideRef = useRef(contentOverride);
  contentOverrideRef.current = contentOverride;

  // Throttled snapshot of the streaming content. The bubble itself still
  // re-renders on every token (cheap), but the heavy MarkdownContent subtree
  // is fed from this snapshot, so highlight.js runs at most ~10 Hz.
  const [displayedContent, setDisplayedContent] = useState(effectiveContent);
  const lastFlushRef = useRef(0);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Completion and the canonical chat_message commonly arrive back-to-back.
  // Flush the authoritative final content before paint so the browser never
  // shows one completed frame with the previous throttled snapshot and then
  // reparses the Markdown in a second frame.
  useLayoutEffect(() => {
    if (!effectiveCompleted) return;
    if (pendingTimerRef.current) {
      clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
    lastFlushRef.current = performance.now();
    setDisplayedContent(effectiveContent);
  }, [effectiveCompleted, effectiveContent]);

  useLayoutEffect(() => {
    if (
      effectiveCompleted &&
      displayedContent === effectiveContent &&
      displayedContent
    ) {
      onFinalContentCommit?.();
    }
  }, [
    displayedContent,
    effectiveCompleted,
    effectiveContent,
    onFinalContentCommit,
  ]);

  useEffect(() => {
    if (effectiveCompleted) return;
    const now = performance.now();
    const elapsed = now - lastFlushRef.current;
    if (elapsed >= STREAM_RENDER_MIN_INTERVAL_MS) {
      lastFlushRef.current = now;
      setDisplayedContent(effectiveContent);
      return;
    }
    if (!pendingTimerRef.current) {
      pendingTimerRef.current = setTimeout(() => {
        pendingTimerRef.current = null;
        lastFlushRef.current = performance.now();
        // Pull the latest content at flush time so we don't render a stale snapshot.
        const latest =
          contentOverrideRef.current ??
          (streamKey
            ? useStore.getState().chatStreamingOutput[streamKey] || ''
            : '');
        setDisplayedContent(latest);
      }, STREAM_RENDER_MIN_INTERVAL_MS - elapsed);
    }
  }, [effectiveContent, effectiveCompleted, streamKey]);

  // After each throttled content flush has committed (DOM updated), let the
  // OUTER message list follow the growth. This bubble re-renders in isolation
  // so the parent's deps-driven auto-scroll never fires mid-stream; without
  // this the response grows below the fold until completion. scrollToBottomIfPinned
  // is a no-op if the user scrolled up, so manual scroll-up is preserved.
  useEffect(() => {
    if (displayedContent) onContentGrow?.();
  }, [displayedContent, onContentGrow]);

  useEffect(() => {
    return () => {
      if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
    };
  }, []);

  // When the parent resolves a new per-run UUID stream key, pull accumulated
  // chunks immediately instead of waiting for the throttle — otherwise the
  // first response in a brand-new conversation can sit invisible until refresh.
  useEffect(() => {
    if (pendingTimerRef.current) {
      clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
    lastFlushRef.current = 0;
    const latest =
      contentOverrideRef.current ??
      (streamKey
        ? useStore.getState().chatStreamingOutput[streamKey] || ''
        : '');
    setDisplayedContent(latest);
  }, [streamKey, bubbleId]);

  // Three render states, all sharing the SAME outer container height so the
  // message list never shifts when the bubble transitions between them:
  //
  //   1. Run active + no stream content yet → "Thinking…" placeholder
  //      (covers both "agent just started" and the buffering gap between the
  //      first chunk landing and the throttled markdown subtree committing).
  //   2. Run active + stream content present  → real <ChatMessageBubble>.
  //   3. Otherwise                            → null (no bubble).
  //
  // Previously this component only covered case 1+2, and the parent rendered a
  // SEPARATE inline Thinking… badge via the `(sending || chatRunning) &&
  // !shouldShowStreamingBubble` clause. That meant the badge appeared first
  // (case "agent started, no chunks") and then *disappeared* the instant the
  // first chunk landed and `<StreamingBubble>` took over — a swap between two
  // sibling rows that briefly shifted the message list up and back down on
  // every user send. Owning the placeholder here eliminates the swap.
  //
  // The placeholder wrapper matches the inline badge's className EXACTLY
  // (max-w-[75%], px-3 py-2, rounded-lg, text-sm, etc.) so even the rare path
  // where the bubble mounts after the badge (e.g. an already-streaming run on
  // page reload) renders at the same height.
  if (!displayedContent) {
    if (!isRunning) return null;
    return (
      <ChatMessageBubble
        id={bubbleId ?? streamKey ?? 'pending-chat-stream'}
        dataUi="chat-generic-main-stream"
        project_id={projectId}
        conversation_id={conversationId ?? undefined}
        stream_key={streamKey}
        role="assistant"
        content=""
        source="web"
        senderUserId={virtualSender ? `ai:${virtualSender.id}` : undefined}
        assistantSenderName={
          virtualSender ? undefined : (assistantName ?? 'Agent')
        }
        virtualSenderName={virtualSender?.name}
        virtualSenderIdentity={virtualSender?.identity}
        virtualSenderAvatarUrl={
          virtualSender
            ? (virtualSender.avatarUrl ?? aiUserAvatarUrl(virtualSender.id))
            : undefined
        }
        attachments={streamingAttachments}
        onSendMessage={onSendMessage}
        isStreaming
        observeInnerScroll
        innerScrollStateRef={innerScrollStateRef}
        toolCallDisplay={toolCallDisplay}
      />
    );
  }

  // If the store has been cleared for this stream key, render nothing — do
  // NOT fall back to the throttled `displayedContent` snapshot. Without this
  // guard, the bubble briefly re-shows the last streamed text on the same
  // commit the parent's `renderedMessages` un-dedupes (when the run finishes
  // and the bubble is cleared from the store). The local state lags the store
  // by one effect tick, so a single render shows: (a) the bubble with stale
  // text, and (b) the same message freshly added from the transcript. The
  // throttle is only useful while the run is actively streaming.
  //
  // The `displayedContent` empty branch above already returns `null` when
  // `chatStreaming` is also empty, so this guard only affects the case where
  // the local snapshot is stale (post-clearing). The live "Thinking…"
  // placeholder branch is preserved because it sits above this guard and
  // only triggers when `chatStreaming` is non-empty.
  if (!effectiveContent) return null;

  // Steering splits a streamed response into independent bubbles. Sanitize
  // each segment because it may bypass the persisted transcript cleanup.
  const visibleContent = stripTalkingStickControl(displayedContent);
  if (!visibleContent) return null;

  return (
    <ChatMessageBubble
      id={bubbleId ?? streamKey!}
      dataUi="chat-generic-main-stream"
      project_id={projectId}
      conversation_id={conversationId ?? undefined}
      stream_key={streamKey}
      role="assistant"
      content={visibleContent}
      source="web"
      senderUserId={virtualSender ? `ai:${virtualSender.id}` : undefined}
      assistantSenderName={
        virtualSender ? undefined : (assistantName ?? 'Agent')
      }
      virtualSenderName={virtualSender?.name}
      virtualSenderIdentity={virtualSender?.identity}
      virtualSenderAvatarUrl={
        virtualSender
          ? (virtualSender.avatarUrl ?? aiUserAvatarUrl(virtualSender.id))
          : undefined
      }
      telemetry={telemetry}
      attachments={streamingAttachments}
      onFork={effectiveCompleted ? onFork : undefined}
      onSendMessage={onSendMessage}
      onImplementPlan={effectiveCompleted ? onImplementPlan : undefined}
      onSendPlanToKanban={effectiveCompleted ? onSendPlanToKanban : undefined}
      onOpenArtifact={onOpenArtifact}
      isStreaming={!effectiveCompleted}
      preparingMemory={preparingMemory}
      pinInnerToBottom={effectiveCompleted}
      observeInnerScroll={!effectiveCompleted}
      innerScrollStateRef={innerScrollStateRef}
      toolCallDisplay={toolCallDisplay}
    />
  );
});

// --- Component ---

interface ChatPageProps {
  project_id: string;
  /** When set, scopes this chat to the given objective instead of the project-level chat. */
  objective_id?: string;
  /** Objective mode can supply its own content while reusing the normal workspace pane shell. */
  workspacePane?: {
    defaultOpen?: boolean;
    /**
     * Deep-link request token. Each new value forces the pane open, including
     * on narrow layouts, until the user dismisses it.
     */
    openRequest?: string;
    marker: string;
    openStateKey: string;
    render: (props: {
      conversationId: string | null;
      onClose: () => void;
      onFileOpen: () => void;
    }) => ReactNode;
  };
  /** Opens the parent-owned artifact panel when the chat is embedded in another layout. */
  onOpenArtifactPanel?: () => void;
  /** Deterministic mounted-test adapter for the completion handoff frame. */
  initialSendingByConv?: Record<string, boolean>;
  /** Route-owned conversation identity; takes precedence over remembered state. */
  route_conversation_id?: string | null;
  /** Validated `?file=` deep link to open in the preview panel. */
  route_file?: FileDeepLink | null;
}

export function ChatPage({
  project_id,
  objective_id,
  workspacePane,
  onOpenArtifactPanel,
  initialSendingByConv,
  route_conversation_id,
  route_file,
}: ChatPageProps) {
  const { data: project } = useProject(project_id);
  const toolCallDisplay = resolveToolCallDisplay(
    project?.settings?.toolCallDisplay,
  );
  const setSettingsProjectId = useStore((s) => s.setSettingsProjectId);

  const { user } = useAuth();
  const { data: projects = [] } = useProjects();
  const handoffProjectOptions = useMemo(
    () => projectTreeOptions(projects).filter((item) => item.id !== project_id),
    [project_id, projects],
  );
  const currentSenderName =
    user?.displayName?.trim() || user?.username || 'You';
  const currentSenderUserId = user?.id;
  const currentSenderAvatarUrl = user?.avatarUrl ?? null;

  const navigate = useNavigate();
  useBlocker({
    shouldBlockFn: async () => !(await canLeaveActivePreview(project_id)),
    enableBeforeUnload: false,
  });
  const { location } = useRouterState();
  const { data: config } = useAppConfig();
  // A URL deep link owns the first render, including same-project query
  // changes. Once the user selects a conversation locally, that selection
  // clears the one-shot route override while the URL catches up.
  const localConversationSelectionRef = useRef(false);
  const previousRouteConversationRef = useRef(route_conversation_id);
  const routeConversationChanged =
    previousRouteConversationRef.current !== route_conversation_id;
  if (routeConversationChanged) {
    previousRouteConversationRef.current = route_conversation_id;
    localConversationSelectionRef.current = false;
  }
  const folderKey = objective_id ?? project_id;
  const newConversationDraftKey = `${folderKey}:${NEW_CHAT_KEY}`;
  const rememberedActiveConvId = useStore(
    (s) => s.activeConvByProject[folderKey] ?? null,
  );
  const activeConvId =
    !localConversationSelectionRef.current && route_conversation_id
      ? route_conversation_id
      : (rememberedActiveConvId ?? null);
  useEffect(() => {
    if (route_conversation_id) {
      useStore
        .getState()
        .setActiveConvForProject(folderKey, route_conversation_id);
    }
  }, [folderKey, route_conversation_id]);
  const liveModeEnabled = useStore(
    (s) =>
      s.liveModeEnabled &&
      s.liveModeFocusedConversationId === activeConvId &&
      s.liveModeCurrentProjectId === project_id,
  );
  const liveModeSessionId = useStore((s) => s.liveModeSessionId);
  const [draftLiveModeEnabled, setDraftLiveModeEnabled] = useState(false);
  const [draftLiveModeKind, setDraftLiveModeKind] = useState<
    'personas' | 'work'
  >('work');
  const liveModePanelRef = useRef<LiveModePanelHandle>(null);
  const effectiveLiveModeEnabled = activeConvId
    ? liveModeEnabled
    : draftLiveModeEnabled;
  const [draftAiUsers, setDraftAiUsers] = useState<DraftAiUserSelection>({
    mainSelection: { mode: 'inherit' },
    invitedAiUserIds: [],
    invitedAiUserIdsProvided: false,
  });
  const { data: invitedAiUsers = [], isPending: invitedAiUsersPending } =
    useQuery({
      queryKey: ['conversation-ai-users', project_id, activeConvId],
      queryFn: () => fetchConversationAiUsers(project_id, activeConvId!),
      enabled: !!activeConvId,
    });
  const { data: mainAiUser = null, isPending: mainAiUserPending } = useQuery({
    queryKey: ['conversation-ai-users', project_id, activeConvId, 'main'],
    queryFn: () => fetchMainConversationAiUser(project_id, activeConvId!),
    enabled: !!activeConvId,
  });
  const { data: draftAvailableAiUsers = [] } = useQuery({
    queryKey: ['project-ai-users', project_id, 'available'],
    queryFn: () => fetchProjectAvailableAiUsers(project_id),
    enabled: !activeConvId,
  });
  const draftMainAiUser = !activeConvId
    ? (draftAvailableAiUsers.find(
        (item) =>
          item.id ===
          (draftAiUsers.mainSelection.mode === 'persona'
            ? draftAiUsers.mainSelection.aiUserId
            : draftAiUsers.mainSelection.mode === 'inherit'
              ? project?.settings?.defaultMainAiUserId
              : null),
      ) ?? null)
    : null;
  const displayedMainAiUser = activeConvId ? mainAiUser : draftMainAiUser;
  // While an active conversation's persona queries are still loading, treat
  // the chat as persona-capable: a stored 'personas' kind must not downgrade
  // to 'work' (and the gating hint must not flash) until the real persona
  // state is known. Drafts resolve synchronously from local draft state.
  const personaQueriesPending =
    !!activeConvId && (invitedAiUsersPending || mainAiUserPending);
  const chatPersonaDriven =
    personaQueriesPending || !!displayedMainAiUser || invitedAiUsers.length > 0;
  const liveModeKind = useStore((s) =>
    activeConvId
      ? resolveLiveModeKind(
          s.liveModeKindByConversation[activeConvId],
          chatPersonaDriven,
        )
      : resolveLiveModeKind(draftLiveModeKind, chatPersonaDriven),
  );
  // The draft kind is stored raw but must never reach the server unresolved:
  // a 'personas' draft with no persona on the chat would start a persona run
  // the chat cannot drive. Resolve it exactly like the panel and send path.
  const resolvedDraftLiveModeKind = resolveLiveModeKind(
    draftLiveModeKind,
    chatPersonaDriven,
  );
  const [draftContinuousPersonaLoop, setDraftContinuousPersonaLoop] =
    useState(false);
  // Claude keeps its prompt cache for 1 hour instead of 5 minutes. Blank-chat draft value;
  // an existing conversation stores its own flag (`promptCache1h`).
  const [draftPromptCache1h, setDraftPromptCache1h] = useState(false);

  const [conversationOwnerUserId, setConversationOwnerUserId] = useState('');
  const [conversationTriggeredByUserId, setConversationTriggeredByUserId] =
    useState('');
  const { members: attributionMembers } = useAttributionMembers(project_id);
  const hasSharedProject = attributionMembers.some(
    (member) => member.access_level !== 'owner',
  );

  // Objective chats are normal chats: the same API calls, with `objective_id`
  // only where the server needs it to pick the objective (list, create, send,
  // mark-all-read). Per-conversation calls are keyed by conversation id.
  const apiFetchConvs = useCallback(
    (limit: number, offset = 0, signal?: AbortSignal) =>
      fetchConversations(project_id, limit, offset, signal, {
        ...(hasSharedProject
          ? {
              ownerUserId: conversationOwnerUserId || undefined,
              triggeredByUserId: conversationTriggeredByUserId || undefined,
            }
          : {}),
        objective_id,
      }),
    [
      project_id,
      objective_id,
      hasSharedProject,
      conversationOwnerUserId,
      conversationTriggeredByUserId,
    ],
  );
  const apiSendMsg = useCallback(
    (
      content: string,
      convId?: string,
      attachments?: ChatMessageAttachment[],
      agent_cmd?: string,
      chat_mode?: ChatModeOverride | null,
      runtime_selection?: RuntimeSelection,
      delivery?: 'steer' | 'queue',
      deepLinks?: ChatDeepLink[],
      memoryContextLevel?: MemoryContextLevel,
      liveModeOverride?: boolean,
      liveModeSessionIdOverride?: string,
      liveModeKindOverride?: 'personas' | 'work',
      clientSubmissionId?: string,
      clientSubmissionIds?: string[],
      openFileContext?: OpenFileContext,
    ) =>
      sendChatMessage(
        project_id,
        content,
        convId,
        attachments,
        agent_cmd,
        chat_mode,
        liveModeOverride ?? effectiveLiveModeEnabled,
        runtime_selection,
        delivery,
        deepLinks,
        memoryContextLevel ? { level: memoryContextLevel } : undefined,
        liveModeSessionIdOverride ?? liveModeSessionId,
        liveModeKindOverride ?? liveModeKind,
        clientSubmissionId,
        clientSubmissionIds,
        objective_id,
        openFileContext,
      ),
    [
      project_id,
      objective_id,
      effectiveLiveModeEnabled,
      liveModeKind,
      liveModeSessionId,
    ],
  );
  const apiCreateConv = useCallback(
    (use_worktree?: boolean, branch?: string | null) =>
      createConversation(project_id, {
        use_worktree,
        branch,
        promptCache1h: draftPromptCache1h,
        mainAiUserSelection: draftAiUsers.mainSelection,
        ...(draftAiUsers.invitedAiUserIdsProvided
          ? { invitedAiUserIds: draftAiUsers.invitedAiUserIds }
          : {}),
        continuousPersonaLoop: draftContinuousPersonaLoop,
        liveMode: draftLiveModeEnabled,
        liveModeSessionId,
        liveModeKind: resolvedDraftLiveModeKind,
        objective_id,
      }),
    [
      project_id,
      objective_id,
      draftAiUsers,
      draftContinuousPersonaLoop,
      draftPromptCache1h,
      draftLiveModeEnabled,
      resolvedDraftLiveModeKind,
      liveModeSessionId,
    ],
  );
  const apiMarkRead = useCallback(
    (convId: string) => markConversationRead(project_id, convId),
    [project_id],
  );
  const apiResolvePending = useCallback(
    (convId: string) => resolvePendingConversation(project_id, convId),
    [project_id],
  );
  const apiMarkAllRead = useCallback(
    () => markAllConversationsRead(project_id, objective_id),
    [project_id, objective_id],
  );
  const apiDeleteConv = useCallback(
    (convId: string) => deleteConversation(project_id, convId),
    [project_id],
  );
  const apiUpdateConv = useCallback(
    (
      convId: string,
      fields: {
        title?: string | null;
        pinned?: boolean;
        promptCache1h?: boolean;
      },
    ) => updateConversation(project_id, convId, fields),
    [project_id],
  );
  const apiForkConv = useCallback(
    (convId: string, messageId?: string, includeAssistantTurn?: boolean) =>
      forkConversation(project_id, convId, messageId, includeAssistantTurn),
    [project_id],
  );
  const apiAnswerCodexInput = useCallback(
    (
      conversationId: string,
      requestId: string,
      answers: Record<string, { answers: string[] }>,
      content: string,
    ) =>
      answerCodexUserInput(
        project_id,
        conversationId,
        requestId,
        answers,
        content,
      ),
    [project_id],
  );

  const convsQueryKey = useMemo(
    () =>
      objective_id
        ? queryKeys.objectiveConversations.all(project_id, objective_id)
        : [
            ...queryKeys.conversations.all(project_id),
            conversationOwnerUserId,
            conversationTriggeredByUserId,
          ],
    [
      project_id,
      objective_id,
      conversationOwnerUserId,
      conversationTriggeredByUserId,
    ],
  );
  const transcriptKey = useCallback(
    (convId: string) => queryKeys.chatTranscript.all(project_id, convId),
    [project_id],
  );

  const queryClient = useQueryClient();
  const [sendingByConv, setSendingByConv] = useState<Record<string, boolean>>(
    initialSendingByConv ?? {},
  );
  const [pendingNewConversationEntry, setPendingNewConversationEntry] =
    useState<TranscriptEntry | null>(null);
  const [stopping, setStopping] = useState(false);
  // A user-initiated stop keeps the current live bubble as the visual owner.
  // The terminal transcript refetch can otherwise replace it with a newly
  // mounted canonical bubble, producing a brief blank frame while React
  // reconciles the two render paths. The next run receives a new stream key,
  // so this latch naturally stops applying without discarding streamed text.
  const [stoppedStreamKey, setStoppedStreamKey] = useState<string | null>(null);
  const stoppedStreamContentRef = useRef<{
    streamKey: string | null;
    content: string;
  }>({ streamKey: null, content: '' });
  const [handoffPending, setHandoffPending] = useState(false);
  const [agentCmdOverride, setAgentCmdOverride] = useState<string>('');
  const [runtimeSelection, setRuntimeSelection] =
    useState<RuntimeSelection | null>(null);
  const { data: runtimeCatalog } = useQuery({
    queryKey: queryKeys.runtimeCatalog,
    queryFn: fetchRuntimeCatalog,
    staleTime: Infinity,
  });
  const configuredRuntimeDefault = useMemo(() => {
    if (!runtimeCatalog) return null;
    if (project?.settings?.chatRuntimeSelection) {
      return project.settings.chatRuntimeSelection;
    }
    return runtimeCatalog.defaults.chat;
  }, [runtimeCatalog, project?.settings?.chatRuntimeSelection]);

  const applyRuntimeSelection = useCallback(
    (selection: RuntimeSelection) => {
      if (!runtimeCatalog) return;
      const model = runtimeCatalog.models.find(
        (m) => m.id === selection.modelId,
      );
      const binding = model?.bindings.find(
        (b) => b.harnessId === selection.harnessId,
      );
      if (!binding) return;
      const reasoning =
        selection.reasoning &&
        binding.reasoning.options.includes(selection.reasoning)
          ? selection.reasoning
          : (binding.reasoning.default ?? binding.reasoning.options[0]);
      setRuntimeSelection({
        harnessId: selection.harnessId,
        modelId: selection.modelId,
        ...(reasoning ? { reasoning } : {}),
        ...(selection.temperature !== undefined
          ? { temperature: selection.temperature }
          : {}),
      });
      setAgentCmdOverride(binding.runtimeId);
    },
    [runtimeCatalog],
  );

  useEffect(() => {
    if (configuredRuntimeDefault && !runtimeSelection)
      applyRuntimeSelection(configuredRuntimeDefault);
  }, [configuredRuntimeDefault, runtimeSelection, applyRuntimeSelection]);

  const [conversationSearch, setConversationSearch] = useState('');

  // Conversations list
  const {
    data: conversationsData,
    fetchNextPage: fetchNextConversationsPage,
    hasNextPage: hasMoreConvs,
    isFetchingNextPage: isFetchingMoreConvs,
    isFetchNextPageError: didFailFetchingMoreConvs,
    status: convsStatus,
    refetch: refetchConversations,
  } = useInfiniteQuery<
    Conversation[],
    Error,
    ConversationsData,
    readonly unknown[],
    number
  >({
    queryKey: convsQueryKey,
    queryFn: async ({ pageParam, signal }) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      const timeout = window.setTimeout(abort, CONV_PAGE_TIMEOUT_MS);
      try {
        return await apiFetchConvs(
          CONV_PAGE_SIZE,
          pageParam,
          controller.signal,
        );
      } finally {
        window.clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
      }
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) =>
      lastPage.length === CONV_PAGE_SIZE
        ? pages.reduce((total, page) => total + page.length, 0)
        : undefined,
    retry: false,
    staleTime: 10_000,
  });
  const conversations = useMemo(
    () => conversationsData?.pages.flat() ?? [],
    [conversationsData],
  );
  const activeConversationFromList = activeConvId
    ? conversations.find((conversation) => conversation.id === activeConvId)
    : undefined;
  const {
    data: independentlyLoadedActiveConversation,
    error: activeConversationDetailError,
  } = useQuery({
    queryKey: ['conversation-detail', project_id, activeConvId],
    queryFn: () => fetchConversation(project_id, activeConvId!),
    enabled: !!activeConvId && !activeConversationFromList,
    staleTime: 10_000,
  });
  const activeConversation =
    activeConversationFromList ?? independentlyLoadedActiveConversation;
  const activeConversationConfirmed = !!activeConversation;
  const aiUsersBySenderId = useMemo<Map<string, AiUser>>(
    () =>
      new Map([
        ...invitedAiUsers.map((item) => [`ai:${item.id}`, item] as const),
        ...(mainAiUser ? [[`ai:${mainAiUser.id}`, mainAiUser] as const] : []),
      ]),
    [invitedAiUsers, mainAiUser],
  );
  const setActiveConvId = useCallback(
    (id: string | null) => {
      localConversationSelectionRef.current = true;
      useStore.getState().setActiveConvForProject(folderKey, id);
    },
    [folderKey],
  );

  // A remembered (localStorage) or deep-linked conversation selection can be
  // dead by the time the board reloads: the conversation was deleted elsewhere
  // or pruned by a server restart. The ['conversation-detail'] query then 404s
  // silently and the dead id survives into the first send, so the first message
  // after a reload fails with the dead-conversation fallback on a chat that
  // looks brand-new. Clear such a selection as soon as the detail query proves
  // it dead — but only when this page session has never seen the conversation
  // live (in the list or via a successful detail load). When a selection dies
  // while the page is open, the send-time fallback (typed-text restore +
  // toast) must still run so the user's message is not lost.
  const seenActiveConvInListRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      activeConvId &&
      (activeConversationFromList || independentlyLoadedActiveConversation)
    ) {
      seenActiveConvInListRef.current = activeConvId;
    }
  }, [
    activeConvId,
    activeConversationFromList,
    independentlyLoadedActiveConversation,
  ]);

  // Auto-select the structured runtime based on conversation history.
  // Only react to active-conversation *transitions*, not to background
  // conversations-list refetches. The conversations query is invalidated on
  // any conversation activity (chat_message, conversations_changed, stream
  // completion in another conversation — see lib/websocket.ts), which changes
  // the `conversations` array reference. If this effect ran on every refetch,
  // composing a prompt in a new (blank) conversation and manually picking an
  // agent would get clobbered when another conversation's
  // stream finished. The ref below records the last convId we synced the
  // picker to, so we only re-sync on a real switch.
  const lastSyncedConvIdRef = useRef<string | null | undefined>(undefined);
  const lastSyncedWithCatalogRef = useRef(false);
  useEffect(() => {
    if (
      lastSyncedConvIdRef.current === activeConvId &&
      (lastSyncedWithCatalogRef.current || !runtimeCatalog)
    )
      return;
    if (!activeConvId) {
      // Entering a new (blank) conversation: reset the picker to the default
      // exactly once, not on every subsequent conversations refetch.
      lastSyncedConvIdRef.current = null;
      lastSyncedWithCatalogRef.current = !!runtimeCatalog;
      if (configuredRuntimeDefault)
        applyRuntimeSelection(configuredRuntimeDefault);
      else setAgentCmdOverride('');
      return;
    }
    // Active conversation: sync the picker to its last-used agent. If the
    // conversations list hasn't loaded (or doesn't yet contain this conv),
    // wait — preserving the current selection until the catalog is available.
    const conv = activeConversation;
    if (!conv) return;
    lastSyncedConvIdRef.current = activeConvId;
    lastSyncedWithCatalogRef.current = !!runtimeCatalog;
    if (conv.runtimeSelection && runtimeCatalog) {
      const storedModel = runtimeCatalog.models.find(
        (model) => model.id === conv.runtimeSelection?.modelId,
      );
      const storedBinding = storedModel?.bindings.find(
        (binding) => binding.harnessId === conv.runtimeSelection?.harnessId,
      );
      if (storedBinding) applyRuntimeSelection(conv.runtimeSelection);
      else if (configuredRuntimeDefault)
        applyRuntimeSelection(configuredRuntimeDefault);
    } else {
      if (configuredRuntimeDefault)
        applyRuntimeSelection(configuredRuntimeDefault);
      else {
        setRuntimeSelection(null);
        setAgentCmdOverride('');
      }
    }
  }, [
    activeConvId,
    activeConversation,
    runtimeCatalog,
    configuredRuntimeDefault,
    applyRuntimeSelection,
  ]);

  const agentOptions = useMemo(
    () => [
      ...(runtimeCatalog?.models.flatMap((model) =>
        model.bindings.map((binding) => ({
          id: binding.runtimeId,
          label: `${binding.harnessId} · ${model.label}`,
          shortLabel: model.label,
          hint: null as string | null,
        })),
      ) ?? []),
    ],
    [runtimeCatalog],
  );

  const selectedAgentOption = useMemo(
    () =>
      agentOptions.find((o) => o.id === agentCmdOverride) ?? agentOptions[0],
    [agentOptions, agentCmdOverride],
  );
  const selectedRuntimeModel = runtimeCatalog?.models.find(
    (m) => m.id === runtimeSelection?.modelId,
  );
  const selectedRuntimeHarness = runtimeCatalog?.harnesses.find(
    (h) => h.id === runtimeSelection?.harnessId,
  );
  const runtimeSummary =
    runtimeSelection && selectedRuntimeHarness && selectedRuntimeModel
      ? [
          selectedRuntimeHarness.label,
          selectedRuntimeModel.label,
          runtimeSelection.reasoning
            ? runtimeSelection.reasoning[0].toUpperCase() +
              runtimeSelection.reasoning.slice(1)
            : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : (selectedAgentOption?.shortLabel ?? 'Agent');
  const effectiveMainSelectionMode = activeConvId
    ? activeConversation?.mainAiUserMode === 'persona' &&
      !activeConversation.mainAiUserId
      ? 'none'
      : (activeConversation?.mainAiUserMode ??
        (activeConversation?.mainAiUserId ? 'persona' : 'inherit'))
    : draftAiUsers.mainSelection.mode;
  const participantsSummary =
    displayedMainAiUser?.name ??
    (effectiveMainSelectionMode === 'none' ? 'No persona' : 'Participants');
  const participantCount = activeConvId
    ? invitedAiUsers.length
    : effectiveDraftInvitedIds(
        draftAiUsers,
        project?.settings?.defaultInvitedAiUserIds,
        draftAvailableAiUsers.map((item) => item.id),
        draftMainAiUser?.id,
      ).length;
  const continuousPersonaLoopEnabled = activeConvId
    ? activeConversation?.continuousPersonaLoop === true
    : draftContinuousPersonaLoop;
  const promptCache1hEnabled = activeConvId
    ? activeConversation?.promptCache1h === true
    : draftPromptCache1h;
  // The picker reads the stored flag, so a failed PATCH leaves the toggle on its previous value.
  const promptCache1hMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      if (!activeConvId) {
        setDraftPromptCache1h(enabled);
        return;
      }
      await apiUpdateConv(activeConvId, { promptCache1h: enabled });
    },
    onSuccess: () => {
      if (!activeConvId) return;
      queryClient.invalidateQueries({ queryKey: convsQueryKey });
      queryClient.invalidateQueries({
        queryKey: ['conversation-detail', project_id, activeConvId],
      });
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : 'Could not update prompt cache',
      ),
  });
  const personaLoopMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      if (!activeConvId) {
        setDraftContinuousPersonaLoop(enabled);
        return;
      }
      await setConversationPersonaLoopApi(project_id, activeConvId, enabled);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: convsQueryKey }),
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : 'Could not update continuous loop',
      ),
  });
  const personaRoundMutation = useMutation({
    mutationFn: async () => {
      if (!activeConvId) return;
      await startConversationPersonaRoundApi(
        project_id,
        activeConvId,
        runtimeSelection ?? undefined,
      );
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : 'Could not start persona round',
      ),
  });
  const activeConversationKey = activeConvId ?? NEW_CHAT_KEY;
  const composerModeKey = `${folderKey}:${activeConversationKey}`;
  const chatModeOverride = useStore(
    useCallback(
      (s: { chatModeByComposerKey: Record<string, ChatModeOverride | null> }) =>
        s.chatModeByComposerKey[composerModeKey] ?? null,
      [composerModeKey],
    ),
  );
  const setChatModeOverride = useCallback(
    (mode: ChatModeOverride | null) =>
      useStore.getState().setChatModeForComposer(composerModeKey, mode),
    [composerModeKey],
  );
  const modeOptions = useMemo(() => {
    const projectModes = project?.settings?.chatModes;
    if (!Array.isArray(projectModes) || projectModes.length === 0) {
      return DEFAULT_CHAT_MODE_OPTIONS;
    }
    const normalized: Array<{ id: string; label: string }> = [];
    const seen = new Set<string>();
    for (const mode of projectModes as ChatModeDefinition[]) {
      const id =
        typeof mode?.id === 'string' ? mode.id.trim().toLowerCase() : '';
      const label = typeof mode?.label === 'string' ? mode.label.trim() : '';
      if (!id || !label || seen.has(id)) continue;
      seen.add(id);
      normalized.push({ id, label });
    }
    return normalized.length > 0 ? normalized : DEFAULT_CHAT_MODE_OPTIONS;
  }, [project?.settings?.chatModes]);
  const selectedModeOption = useMemo(
    () =>
      chatModeOverride
        ? (modeOptions.find((opt) => opt.id === chatModeOverride) ?? null)
        : null,
    [chatModeOverride, modeOptions],
  );
  const effectiveChatModeOverride = selectedModeOption?.id ?? null;

  // The stream key from the most recent chat_started event.
  // chat_started stores the run under the view key (objective id for objective chat, else project).
  const pendingStreamKey = useStore(
    useCallback(
      (s: { pendingStreamKeyByProject: Record<string, string> }) =>
        s.pendingStreamKeyByProject[folderKey] ?? null,
      [folderKey],
    ),
  );
  const queuedPromptsByConv = useStore((s) => s.queuedPromptsByConv);
  const chatRunningByConv = useStore((s) => s.chatRunningByConv);
  const clearStalledWarning = useStore((s) => s.clearStalledWarning);
  const {
    pending: pendingAttachments,
    addFiles,
    removeAt: removeAttachment,
    clear: clearAttachments,
    handlePaste: handleAttachmentPaste,
  } = usePasteAttachments();
  const [isDragOver, setIsDragOver] = useState(false);
  const memoryCapsuleByConv = useStore((s) => s.memoryCapsuleByConv);
  const [inFlightSteeringMessages, setInFlightSteeringMessages] = useState<
    InFlightSteeringMessage[]
  >([]);
  const steeredChatMessageIds = useStore((s) => s.steeredChatMessageIds);
  const lateAudioTranscripts = useStore((s) => s.lateAudioTranscripts);

  useEffect(() => {
    setInFlightSteeringMessages((current) => {
      let changed = false;
      const next = current.map((message) => {
        if (
          message.delivery === 'steered' ||
          !message.serverId ||
          !steeredChatMessageIds[message.serverId]
        ) {
          return message;
        }
        changed = true;
        return { ...message, delivery: 'steered' as const };
      });
      return changed ? next : current;
    });
  }, [steeredChatMessageIds]);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Conversation this page just created and seeded from a blank composer; its
  // transcript is already on screen, so the first-load reveal gate skips it.
  const freshConversationIdRef = useRef<string | null>(null);
  const messagesContentRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [knowledgePickerOpen, setKnowledgePickerOpen] = useState(false);
  const convListRef = useRef<HTMLDivElement>(null);
  const convLoadMoreRef = useRef<HTMLDivElement>(null);
  const fetchNextConversationsPageRef = useRef(fetchNextConversationsPage);
  const isFetchingMoreConvsRef = useRef(isFetchingMoreConvs);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const steeringSubmissionInFlightRef = useRef<Set<string>>(new Set());
  // Conversation ids whose send-time dead-selection validation is still in
  // flight, or NEW_CHAT_KEY while a submission owns the fresh-conversation
  // transition. A second submission arriving while a prior one may still
  // prove the selection dead (or is creating its fresh conversation) stays
  // in the composer instead of also starting a new conversation.
  const pendingSelectionValidationRef = useRef<Set<string>>(new Set());
  const queuedPromptActionInFlightRef = useRef<Set<string>>(new Set());
  const flushingQueueRef = useRef<Set<string>>(new Set());
  const idleQueueRecoveryAttemptRef = useRef<Map<string, string>>(new Map());
  const pendingRunPresentationRef = useRef<{
    conversationId: string;
    previousStreamKey: string | null;
  } | null>(null);
  // Always points at the current draft key so stable callbacks can use it without deps
  const currentDraftKey = activeConvId
    ? `${project_id}:${activeConvId}`
    : newConversationDraftKey;
  const draftKeyRef = useRef(currentDraftKey);

  draftKeyRef.current = currentDraftKey;
  fetchNextConversationsPageRef.current = fetchNextConversationsPage;
  isFetchingMoreConvsRef.current = isFetchingMoreConvs;

  const [hasText, setHasText] = useState(false);

  const readDraft = useCallback(() => textareaRef.current?.value ?? '', []);
  const clearDraft = useCallback(() => {
    if (textareaRef.current) {
      textareaRef.current.value = '';
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.overflowY = 'hidden';
    }
    setHasText(false);
    useStore.getState().clearDraftByKey(draftKeyRef.current);
    useStore.getState().clearDraftDeepLinksByKey(draftKeyRef.current);
  }, []);

  // Slash command autocomplete state
  const [slashVisible, setSlashVisible] = useState(false);
  const [slashFilter, setSlashFilter] = useState('');
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const { data: projectCommands = [] } = useQuery<SlashCommand[]>({
    queryKey: ['project-commands', project_id],
    queryFn: () => fetchProjectCommands(project_id),
    staleTime: 60_000,
  });
  const filteredSlashCommands = useMemo(
    () =>
      slashFilter
        ? projectCommands.filter((c) =>
            c.name.toLowerCase().startsWith(slashFilter.toLowerCase()),
          )
        : projectCommands,
    [projectCommands, slashFilter],
  );

  const fitTextareaHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    // Resetting the height to 'auto' collapses the textarea and clamps its
    // scrollTop to 0, so remember it and restore it below.
    const previousScrollTop = el.scrollTop;
    el.style.height = 'auto';
    const style = getComputedStyle(el);
    const lineHeight = parseFloat(style.lineHeight) || 20;
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const paddingBottom = parseFloat(style.paddingBottom) || 0;
    const minHeight = lineHeight * 2 + paddingTop + paddingBottom;
    const maxHeight = lineHeight * 10 + paddingTop + paddingBottom;
    const newHeight = Math.max(minHeight, Math.min(el.scrollHeight, maxHeight));
    el.style.height = newHeight + 'px';
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
    // Follow text edited at the end; keep the view for a mid-text edit.
    el.scrollTop =
      el.selectionEnd >= el.value.length ? el.scrollHeight : previousScrollTop;
  }, []);

  // The textarea's width changes after it is measured (the send button appears
  // once a restored draft sets hasText, the viewport rotates, a pane opens), so
  // the text rewraps and the height measured earlier clips the last line while
  // overflow stays hidden. Refit whenever the width changes.
  const setComposerTextarea = useCallback(
    (el: HTMLTextAreaElement | null) => {
      textareaRef.current = el;
      if (!el || typeof ResizeObserver === 'undefined') return;
      let lastWidth = el.clientWidth;
      const observer = new ResizeObserver(() => {
        if (el.clientWidth === lastWidth) return;
        lastWidth = el.clientWidth;
        // An empty draft has nothing to clip; clearDraft owns its height.
        if (el.value) fitTextareaHeight();
      });
      observer.observe(el);
      return () => {
        observer.disconnect();
        textareaRef.current = null;
      };
    },
    [fitTextareaHeight],
  );

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    fitTextareaHeight();
    setHasText(!!el.value);
    useStore.getState().saveDraftByKey(draftKeyRef.current, el.value);
    // Slash command autocomplete trigger: value must be exactly "/<word>" with no spaces
    const val = el.value;
    // Double-slash "//" reloads commands from sandbox, then normalizes to "/"
    if (val === '//') {
      el.value = '/';
      useStore.getState().saveDraftByKey(draftKeyRef.current, '/');
      fetchProjectCommands(project_id, true).then((cmds) => {
        queryClient.setQueryData(['project-commands', project_id], cmds);
      });
    }
    const cur = el.value;
    if (/^\/\S*$/.test(cur)) {
      setSlashFilter(cur.slice(1));
      setSlashSelectedIndex(0);
      setSlashVisible(true);
    } else {
      setSlashVisible(false);
    }
  }, [fitTextareaHeight, project_id, queryClient]);

  const setDraftMessage = useCallback(
    (text: string, draftKey = draftKeyRef.current) => {
      useStore.getState().saveDraftByKey(draftKey, text);
      if (draftKeyRef.current !== draftKey) return;
      if (textareaRef.current) {
        textareaRef.current.value = text;
        autoResize();
        textareaRef.current.focus();
        const len = text.length;
        textareaRef.current.setSelectionRange(len, len);
      }
    },
    [autoResize],
  );

  const hideSlash = useCallback(() => setSlashVisible(false), []);
  const selectSlashCommand = useCallback(
    (cmd: SlashCommand) => {
      if (textareaRef.current) {
        textareaRef.current.value = `/${cmd.name} `;
        autoResize();
        textareaRef.current.focus();
      }
      setSlashVisible(false);
    },
    [autoResize],
  );

  const chatStreamRetired = useStore((state) =>
    activeConvId
      ? (state.chatStreamRetiredByConv[activeConvId] ?? false)
      : false,
  );
  const sending =
    !!sendingByConv[activeConvId ?? NEW_CHAT_KEY] && !chatStreamRetired;

  // A transcript refetch can project an accepted steering receipt while its
  // stream is still accumulating chunks. Keep the captured browser boundary
  // until the live buffer is cleared after the completion refetch; otherwise
  // the canonical user row takes ownership early and the whole live response
  // moves below it. Serialize only the ownership ids so ordinary chunk growth
  // does not add another parent subscription to the full streaming payload.
  const liveSteeringLocalIdsKey = useStore(
    useCallback(
      (state: { chatStreamingOutput: Record<string, string> }) =>
        JSON.stringify(
          inFlightSteeringMessages
            .filter(
              (message) =>
                message.conversationId === activeConvId &&
                Boolean(state.chatStreamingOutput[message.streamKey]),
            )
            .map((message) => message.localId),
        ),
      [activeConvId, inFlightSteeringMessages],
    ),
  );
  const liveSteeringLocalIds = useMemo(
    () => new Set<string>(JSON.parse(liveSteeringLocalIdsKey)),
    [liveSteeringLocalIdsKey],
  );

  useEffect(() => {
    if (!activeConvId || !chatStreamRetired) return;
    setSendingByConv((previous) => {
      if (!previous[activeConvId]) return previous;
      const next = { ...previous };
      delete next[activeConvId];
      return next;
    });
  }, [activeConvId, chatStreamRetired]);

  useEffect(() => {
    if (!activeConvId || !chatStreamRetired) return;
    if (sendingByConv[activeConvId]) return;
    useStore.getState().clearRetiredChatStreamForConv(activeConvId);
  }, [activeConvId, chatStreamRetired, sendingByConv]);

  // Transcript query: source of truth for all conversation messages (chat + objective)
  const {
    data: transcriptData,
    isLoading: isLoadingTranscript,
    isPending: isTranscriptPending,
    fetchNextPage: fetchOlderTranscript,
    hasNextPage: hasOlderTranscript,
    isFetchingNextPage: isFetchingOlderTranscript,
  } = useInfiniteQuery<TranscriptResponse>({
    queryKey: transcriptKey(activeConvId!),
    queryFn: ({ pageParam }) =>
      fetchChatTranscript(project_id, activeConvId!, 20, pageParam as number),
    initialPageParam: 0,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? lastPage.nextOffset : undefined,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    // A remembered or deep-linked id can be deleted or belong to another
    // project: wait for the project's list or detail query to confirm it.
    enabled: activeConvId !== null && activeConversationConfirmed,
  });

  // Server-accepted `pending` steers can end up running as their own
  // follow-up turn without ever being marked steered. Let the transcript own
  // them once it shows their reply, so they render at their canonical position.
  const pendingSteeringServerIdsKey = JSON.stringify(
    inFlightSteeringMessages
      .filter(
        (message) =>
          message.conversationId === activeConvId &&
          message.delivery === 'pending' &&
          typeof message.serverId === 'string',
      )
      .map((message) => message.serverId as string),
  );
  const pendingSteeringServerIds = useMemo(
    () => new Set<string>(JSON.parse(pendingSteeringServerIdsKey)),
    [pendingSteeringServerIdsKey],
  );

  // Flatten pages in chronological order (pages[0] = newest, so reverse)
  const transcriptEntries = useMemo(() => {
    if (!activeConvId && pendingNewConversationEntry) {
      return [pendingNewConversationEntry];
    }
    if (!transcriptData) return undefined;
    // The POST acknowledgement can arrive before the transcript projection
    // adds steeringDelivery to the persisted user row. Treat the acknowledged
    // server id as authoritative in that short window too; otherwise both the
    // local split bubble and the canonical transcript row render the prompt.
    const acknowledgedSteeringIds = new Set(
      inFlightSteeringMessages
        .filter(
          (message) =>
            message.conversationId === activeConvId &&
            message.delivery === 'steered' &&
            typeof message.serverId === 'string',
        )
        .map((message) => message.serverId as string),
    );
    const canonicalSteeringMessageIds = canonicalSteeringIdsWithContinuation(
      [...transcriptData.pages].reverse().flatMap((page) => page.entries),
      acknowledgedSteeringIds,
      new Set(
        inFlightSteeringMessages
          .filter(
            (message) =>
              message.conversationId === activeConvId &&
              message.delivery === 'steered' &&
              typeof message.serverId === 'string',
          )
          .map((message) => message.serverId as string),
      ),
      pendingSteeringServerIds,
    );
    for (const message of inFlightSteeringMessages) {
      if (!liveSteeringLocalIds.has(message.localId)) continue;
      canonicalSteeringMessageIds.delete(message.localId);
      if (message.serverId)
        canonicalSteeringMessageIds.delete(message.serverId);
    }
    const steeringMessageIds = new Set(
      inFlightSteeringMessages
        .filter(
          (message) =>
            message.conversationId === activeConvId &&
            !canonicalSteeringMessageIds.has(
              message.serverId ?? message.localId,
            ),
        )
        .flatMap((message) => [
          message.localId,
          ...(message.serverId ? [message.serverId] : []),
        ]),
    );
    const browserQueuedPromptIds = new Set(
      (activeConvId ? (queuedPromptsByConv[activeConvId] ?? []) : []).flatMap(
        (prompt) =>
          prompt.id && prompt.serverReleased && !prompt.serverOwned
            ? [prompt.id]
            : [],
      ),
    );
    const seenMilestoneIds = new Set<string>();
    const seenUserMessageIds = new Set<string>();
    return [...transcriptData.pages]
      .reverse()
      .flatMap((p) => p.entries)
      .filter((entry) => {
        if (entry.type === 'message' && entry.role === 'user' && entry.id) {
          if (seenUserMessageIds.has(entry.id)) return false;
          seenUserMessageIds.add(entry.id);
        }
        if (entry.type !== 'system_milestone' || !('id' in entry)) return true;
        if (!entry.id || seenMilestoneIds.has(entry.id)) return false;
        seenMilestoneIds.add(entry.id);
        return true;
      })
      .map((entry) =>
        (entry as any).role === 'user' &&
        typeof (entry as any).id === 'string' &&
        (steeredChatMessageIds[String((entry as any).id)] ||
          acknowledgedSteeringIds.has(String((entry as any).id)))
          ? { ...entry, steeringDelivery: 'steered' as const }
          : entry,
      )
      .map((entry) => {
        // A transcript that arrived after the message was shown; skipped once
        // the server's copy of the message carries it.
        if (entry.type !== 'message' || entry.role !== 'user') return entry;
        const block = [entry.id, ...(entry.clientSubmissionIds ?? [])]
          .map((id) =>
            typeof id === 'string' ? lateAudioTranscripts[id] : undefined,
          )
          .find(Boolean);
        const content = typeof entry.content === 'string' ? entry.content : '';
        if (!block || content.includes(block)) return entry;
        return {
          ...entry,
          content: [content, block].filter(Boolean).join('\n\n'),
        };
      })
      .filter((entry) => {
        if (entry.type !== 'message' || entry.role !== 'user') return true;
        return ![entry.id, ...(entry.clientSubmissionIds ?? [])].some(
          (id) => typeof id === 'string' && browserQueuedPromptIds.has(id),
        );
      })
      .filter((entry) => {
        if (
          (entry as any).id &&
          steeringMessageIds.has(String((entry as any).id))
        )
          return false;
        if (
          (entry as any).role !== 'user' ||
          typeof (entry as any).content !== 'string'
        )
          return true;
        const createdAt =
          typeof (entry as any).created_at === 'string'
            ? new Date((entry as any).created_at).getTime()
            : Number.NaN;
        return !inFlightSteeringMessages.some(
          (message) =>
            message.conversationId === activeConvId &&
            !canonicalSteeringMessageIds.has(
              message.serverId ?? message.localId,
            ) &&
            message.content === (entry as any).content &&
            Number.isFinite(createdAt) &&
            Math.abs(createdAt - new Date(message.createdAt).getTime()) <
              10_000,
        );
      });
  }, [
    activeConvId,
    inFlightSteeringMessages,
    liveSteeringLocalIds,
    pendingNewConversationEntry,
    pendingSteeringServerIds,
    queuedPromptsByConv,
    steeredChatMessageIds,
    lateAudioTranscripts,
    transcriptData,
  ]);

  const canonicalSteeringMessageIds = useMemo(() => {
    const canonicalIds = canonicalSteeringIdsWithContinuation(
      transcriptEntries ?? [],
      new Set(
        inFlightSteeringMessages
          .filter(
            (message) =>
              message.conversationId === activeConvId &&
              message.delivery === 'steered' &&
              typeof message.serverId === 'string',
          )
          .map((message) => message.serverId as string),
      ),
      new Set(
        inFlightSteeringMessages
          .filter(
            (message) =>
              message.conversationId === activeConvId &&
              message.delivery === 'steered' &&
              typeof message.serverId === 'string',
          )
          .map((message) => message.serverId as string),
      ),
      pendingSteeringServerIds,
    );
    for (const message of inFlightSteeringMessages) {
      if (!liveSteeringLocalIds.has(message.localId)) continue;
      canonicalIds.delete(message.localId);
      if (message.serverId) canonicalIds.delete(message.serverId);
    }
    return canonicalIds;
  }, [
    activeConvId,
    inFlightSteeringMessages,
    liveSteeringLocalIds,
    pendingSteeringServerIds,
    transcriptEntries,
  ]);
  const stoppedStreamCanonicalSteeringAvailable =
    stoppedStreamKey !== null &&
    inFlightSteeringMessages.some(
      (message) =>
        message.streamKey === stoppedStreamKey &&
        canonicalSteeringMessageIds.has(message.serverId ?? message.localId),
    );
  useEffect(() => {
    if (!stoppedStreamCanonicalSteeringAvailable) return;
    stoppedStreamContentRef.current = { streamKey: null, content: '' };
    setStoppedStreamKey(null);
  }, [stoppedStreamCanonicalSteeringAvailable]);
  const visibleInFlightSteeringMessages = useMemo(
    () =>
      inFlightSteeringMessages.filter(
        (message) =>
          message.conversationId === activeConvId &&
          !canonicalSteeringMessageIds.has(message.serverId ?? message.localId),
      ),
    [activeConvId, canonicalSteeringMessageIds, inFlightSteeringMessages],
  );

  useEffect(() => {
    if (canonicalSteeringMessageIds.size === 0) return;
    setInFlightSteeringMessages((current) => {
      const next = current.filter(
        (message) =>
          message.conversationId !== activeConvId ||
          !canonicalSteeringMessageIds.has(message.serverId ?? message.localId),
      );
      return next.length === current.length ? current : next;
    });
  }, [activeConvId, canonicalSteeringMessageIds]);

  // A steer whose POST outcome was lost (fetch rejected mid-deploy, or a
  // response without a delivery) is 'unconfirmed' client-side, though the server
  // may have persisted it. Adopt the delivery recorded on its transcript row so
  // the label clears without a remount; keep 'unconfirmed' while no row matches.
  useEffect(() => {
    if (!activeConvId || !transcriptData) return;
    if (
      !inFlightSteeringMessages.some(
        (message) =>
          message.conversationId === activeConvId &&
          message.delivery === 'unconfirmed',
      )
    ) {
      return;
    }
    const entries = transcriptData.pages.flatMap((page) => page.entries);
    setInFlightSteeringMessages((current) => {
      let changed = false;
      const next = current.flatMap((message) => {
        if (
          message.conversationId !== activeConvId ||
          message.delivery !== 'unconfirmed'
        ) {
          return message;
        }
        const receipt = findTranscriptSteeringReceipt(entries, message);
        if (!receipt) return message;
        changed = true;
        const delivery = receipt.steeringDelivery;
        // A queued steer belongs to the normal queue, as for a POST response.
        if (delivery === 'queued') return [];
        return {
          ...message,
          serverId: receipt.id,
          delivery: (delivery === 'steered'
            ? 'steered'
            : 'pending') as InFlightSteeringMessage['delivery'],
        };
      });
      return changed ? next : current;
    });
  }, [activeConvId, inFlightSteeringMessages, transcriptData]);

  // Refetches can briefly return a page written before the preceding assistant
  // turn was persisted. Keep the last browser-owned transcript as a monotonic
  // floor during a follow-up so a committed turn is never removed and reinserted.
  const stableTranscriptRef = useRef<{
    conversationId: string | null;
    entries: TranscriptEntry[];
    protectingFollowUp: boolean;
  }>({ conversationId: null, entries: [], protectingFollowUp: false });
  const discardFailedOptimisticEntry = useCallback(
    (conversationId: string, optimisticMessageId: string) => {
      const keepEntry = (entry: TranscriptEntry) =>
        !(
          entry.type === 'message' &&
          entry.role === 'user' &&
          entry.optimistic === true &&
          entry.id === optimisticMessageId
        );
      if (stableTranscriptRef.current.conversationId === conversationId) {
        stableTranscriptRef.current.entries =
          stableTranscriptRef.current.entries.filter(keepEntry);
      }
      queryClient.setQueryData<InfiniteData<TranscriptResponse>>(
        transcriptKey(conversationId),
        (current) =>
          current
            ? {
                ...current,
                pages: current.pages.map((page) => ({
                  ...page,
                  entries: page.entries.filter(keepEntry),
                })),
              }
            : current,
      );
    },
    [queryClient, transcriptKey],
  );
  /** Drop a withdrawn Direct follow-up's user row from the transcript cache,
   * the monotonic follow-up snapshot, and any in-flight steering bubble, so
   * the ownership merge cannot restore a row the server now hides. */
  const discardWithdrawnTranscriptEntry = useCallback(
    (conversationId: string, messageId: string) => {
      const keepEntry = (entry: TranscriptEntry) =>
        !(
          entry.type === 'message' &&
          entry.role === 'user' &&
          (entry.id === messageId ||
            entry.clientSubmissionIds?.includes(messageId) === true)
        );
      if (stableTranscriptRef.current.conversationId === conversationId) {
        stableTranscriptRef.current.entries =
          stableTranscriptRef.current.entries.filter(keepEntry);
      }
      queryClient.setQueryData<InfiniteData<TranscriptResponse>>(
        transcriptKey(conversationId),
        (current) =>
          current
            ? {
                ...current,
                pages: current.pages.map((page) => ({
                  ...page,
                  entries: page.entries.filter(keepEntry),
                })),
              }
            : current,
      );
      setInFlightSteeringMessages((current) =>
        current.filter(
          (message) =>
            message.conversationId !== conversationId ||
            (message.serverId ?? message.localId) !== messageId,
        ),
      );
    },
    [queryClient, transcriptKey],
  );
  const ownershipStableTranscriptEntries = useMemo(() => {
    if (!transcriptEntries) return transcriptEntries;
    const followUpActive =
      sending || Boolean(activeConvId && chatRunningByConv[activeConvId]);
    if (stableTranscriptRef.current.conversationId !== activeConvId) {
      stableTranscriptRef.current = {
        conversationId: activeConvId,
        entries: transcriptEntries,
        protectingFollowUp: followUpActive,
      };
      return transcriptEntries;
    }
    if (!followUpActive && !stableTranscriptRef.current.protectingFollowUp) {
      stableTranscriptRef.current.entries = transcriptEntries;
      return transcriptEntries;
    }
    const merged = reconcileTranscriptOwnership(
      stableTranscriptRef.current.entries,
      transcriptEntries,
    );
    const browserQueuedPromptIds = new Set(
      (activeConvId ? (queuedPromptsByConv[activeConvId] ?? []) : []).flatMap(
        (prompt) =>
          prompt.id && prompt.serverReleased && !prompt.serverOwned
            ? [prompt.id]
            : [],
      ),
    );
    const ownedEntries = merged.filter(
      (entry) =>
        entry.type !== 'message' ||
        entry.role !== 'user' ||
        ![entry.id, ...(entry.clientSubmissionIds ?? [])].some(
          (id) => typeof id === 'string' && browserQueuedPromptIds.has(id),
        ),
    );
    stableTranscriptRef.current = {
      conversationId: activeConvId,
      entries: ownedEntries,
      protectingFollowUp: followUpActive || ownedEntries !== transcriptEntries,
    };
    return ownedEntries;
  }, [
    activeConvId,
    chatRunningByConv,
    queuedPromptsByConv,
    sending,
    transcriptEntries,
  ]);

  const hasCurrentTurnDefaultAgentResponse = useMemo(() => {
    const entries = ownershipStableTranscriptEntries ?? [];
    let lastUserIndex = -1;
    for (let index = 0; index < entries.length; index += 1) {
      if ((entries[index] as any).role === 'user') lastUserIndex = index;
    }
    if (lastUserIndex < 0) return false;
    return entries
      .slice(lastUserIndex + 1)
      .some(
        (message) =>
          (message as any).role === 'assistant' &&
          personaSenderId(message as any) === null &&
          typeof (message as any).content === 'string' &&
          (message as any).content.trim().length > 0,
      );
  }, [ownershipStableTranscriptEntries]);

  // The transcript is authoritative once any assistant response exists after
  // the current prompt, regardless of its persona.
  const hasCurrentTurnAssistantResponse = useMemo(() => {
    const entries = ownershipStableTranscriptEntries ?? [];
    let lastUserIndex = -1;
    for (let index = 0; index < entries.length; index += 1) {
      if ((entries[index] as any).role === 'user') lastUserIndex = index;
    }
    if (lastUserIndex < 0) return false;
    return entries
      .slice(lastUserIndex + 1)
      .some(
        (message) =>
          (message as any).role === 'assistant' &&
          typeof (message as any).content === 'string' &&
          (message as any).content.trim().length > 0,
      );
  }, [ownershipStableTranscriptEntries]);

  // Streaming state: resolve the UUID stream key for the active conversation.
  // Declared before renderedMessages so we can trim transcript duplicates while streaming.
  //
  // We track two keys per conversation:
  //   activeConvRunKey: the UUID for the most recently started run
  //   prevConvRunKey:   the UUID for the run before the current one
  //
  // When the user sends a new message, activeConvRunKey switches to the new run's
  // UUID immediately (via chat_started WS event). If the new run hasn't produced
  // any output yet, we fall back to prevConvRunKey so the previous response stays
  // visible until the new run starts streaming or the transcript loads.
  const activeStreamKeyByConv = useStore(
    useCallback(
      (s: { activeStreamKeyByConv: Record<string, string> }) =>
        s.activeStreamKeyByConv,
      [],
    ),
  );
  const prevStreamKeyByConv = useStore(
    useCallback(
      (s: { prevStreamKeyByConv: Record<string, string> }) =>
        s.prevStreamKeyByConv,
      [],
    ),
  );
  // True when the user has deliberately opened a blank "New" composer (distinct
  // from activeConvId being null because a new conversation's first message is
  // still in flight, or because the page was just reloaded). While true, no
  // other conversation's run state may resolve into this view. Set by the "New"
  // button; cleared on send / navigation.
  const composingNewConv = useStore(
    (s) => s.composingNewConversationByProject[folderKey] === true,
  );
  const setComposingNewConv = useCallback(
    (composing: boolean) =>
      useStore
        .getState()
        .setComposingNewConversationForProject(folderKey, composing),
    [folderKey],
  );

  // Drop a selection the server no longer has. Preserve the composer state
  // across this automatic transition: seed the picker-sync refs before
  // clearing (same pattern as forgetMissingConversation) so the runtime
  // auto-select effect keeps the harness/model/reasoning the user chose, and
  // carry typed text into the blank-composer draft key so the persisted-draft
  // effect does not overwrite it with a stale (possibly empty) stored draft.
  const clearDeadActiveConversation = useCallback(() => {
    lastSyncedConvIdRef.current = null;
    lastSyncedWithCatalogRef.current = !!runtimeCatalog;
    const typed = readDraft();
    useStore.getState().saveDraftByKey(newConversationDraftKey, typed);
    setComposingNewConv(true);
    setActiveConvId(null);
  }, [
    newConversationDraftKey,
    readDraft,
    runtimeCatalog,
    setActiveConvId,
    setComposingNewConv,
  ]);

  // Clear a dead conversation selection as soon as the detail query proves it
  // gone (see the seenActiveConvInListRef note above). Runs only when the
  // page session never saw the conversation in the list, so mid-session
  // deletions still keep the send-time fallback (typed-text restore + toast).
  useEffect(() => {
    if (!activeConvId) return;
    if (seenActiveConvInListRef.current === activeConvId) return;
    if (
      !(
        activeConversationDetailError instanceof ApiError &&
        isConversationNotFoundError(activeConversationDetailError)
      )
    )
      return;
    clearDeadActiveConversation();
  }, [
    activeConvId,
    activeConversationDetailError,
    clearDeadActiveConversation,
  ]);
  // Resolve conversation ID for stream key lookup (may be null if not navigated
  // yet). Only fall back to pendingStreamKey for a run we haven't navigated to
  // yet — otherwise a still-streaming conversation's run state (chatRunning, the
  // Stop button, the streaming bubble) bleeds into a freshly-opened blank "New"
  // composer and blocks the user from sending until that run finishes.
  const convIdForStream =
    activeConvId ?? (composingNewConv ? null : pendingStreamKey);
  const activeConvRunKey = convIdForStream
    ? (activeStreamKeyByConv[convIdForStream] ?? null)
    : null;
  const prevConvRunKey = convIdForStream
    ? (prevStreamKeyByConv[convIdForStream] ?? null)
    : null;

  const activeRunContent = useStore(
    useCallback(
      (s: { chatStreamingOutput: Record<string, string> }) =>
        activeConvRunKey ? (s.chatStreamingOutput[activeConvRunKey] ?? '') : '',
      [activeConvRunKey],
    ),
  );
  const prevRunContent = useStore(
    useCallback(
      (s: { chatStreamingOutput: Record<string, string> }) =>
        prevConvRunKey ? (s.chatStreamingOutput[prevConvRunKey] ?? '') : '',
      [prevConvRunKey],
    ),
  );
  const activeRunPersonaDriven = useStore(
    useCallback(
      (s: {
        chatStreamPresentation: Record<
          string,
          { personaDriven?: boolean } | undefined
        >;
      }) =>
        activeConvRunKey
          ? s.chatStreamPresentation[activeConvRunKey]?.personaDriven === true
          : false,
      [activeConvRunKey],
    ),
  );

  const pendingRunPresentation = pendingRunPresentationRef.current;
  // Once a new user turn has been submitted, the canonical transcript owns
  // the previous response. Reusing that response as the live fallback would
  // move it below the new optimistic prompt and make old output look newly
  // generated. Before chat_started the previous key is still active; after it,
  // the same key becomes the previous key until the new run emits content.
  const awaitingNewRunStart = Boolean(
    sending &&
    convIdForStream &&
    pendingRunPresentation?.conversationId === convIdForStream &&
    pendingRunPresentation.previousStreamKey !== null &&
    pendingRunPresentation.previousStreamKey === activeConvRunKey,
  );
  const awaitingNewRunOutput = Boolean(
    sending &&
    convIdForStream &&
    pendingRunPresentation?.conversationId === convIdForStream &&
    pendingRunPresentation.previousStreamKey !== null &&
    pendingRunPresentation.previousStreamKey === prevConvRunKey &&
    !activeRunContent,
  );
  const awaitingNewRunPresentation =
    awaitingNewRunStart || awaitingNewRunOutput;

  // Use the active key if it already has content. Outside a newly submitted
  // turn, fall back to the previous key so a lifecycle-only key transition
  // does not blank a response that has not reached the transcript yet. A
  // persona-driven run never uses that fallback: its canonical speaker rows
  // can outlive the generic stream, and a previous key may belong to an
  // unrelated old main-agent turn.
  // Never fall back to convIdForStream — chat_output is keyed by per-run UUIDs,
  // so using the conversation id would miss every chunk until a full page refresh.
  const streamKey = awaitingNewRunStart
    ? null
    : awaitingNewRunOutput
      ? activeConvRunKey
      : activeRunContent
        ? activeConvRunKey
        : prevRunContent && !activeRunPersonaDriven
          ? prevConvRunKey
          : (activeConvRunKey ?? null);
  // The streaming renderer is keyed by a run UUID, while the canonical
  // transcript renderer is keyed by its persisted message id. This ref bridges
  // that deliberate renderer swap without relying on either id to match.
  const streamingInnerScrollStateRef = useRef<InnerScrollState | null>(null);
  // isStreamingCompleted stays in parent — it's a boolean that changes once per run
  // and is needed by the renderedMessages dedup logic and the queue-flush effect.
  const isStreamingCompleted = useStore(
    useCallback(
      (s: { chatStreamingCompleted: Record<string, boolean> }) =>
        streamKey ? (s.chatStreamingCompleted[streamKey] ?? false) : false,
      [streamKey],
    ),
  );
  // Boolean selector: only changes twice per run (false→true on first chunk,
  // true→false on cleanup) — does NOT cause a re-render on every chunk.
  // The actual streaming text is owned by the StreamingBubble child component.
  const hasStreamingContent = useStore(
    useCallback(
      (s: { chatStreamingOutput: Record<string, string> }) =>
        streamKey ? !!s.chatStreamingOutput[streamKey] : false,
      [streamKey],
    ),
  );

  const currentStreamContent =
    streamKey === activeConvRunKey
      ? activeRunContent
      : streamKey === prevConvRunKey
        ? prevRunContent
        : '';
  if (stoppedStreamKey === streamKey && currentStreamContent) {
    // The completion refetch clears chatStreamingOutput after the canonical
    // row arrives. Retain the newest live snapshot so a user-stopped response
    // can keep its existing DOM owner through that store handoff.
    stoppedStreamContentRef.current = {
      streamKey,
      content: currentStreamContent,
    };
  }
  const stoppedStreamContent =
    stoppedStreamKey === streamKey &&
    stoppedStreamContentRef.current.streamKey === streamKey
      ? stoppedStreamContentRef.current.content
      : '';
  const streamPresentation = useStore(
    useCallback(
      (s: {
        chatStreamPresentation: Record<
          string,
          {
            personaDriven?: boolean;
            canonicalPersonaTurns?: boolean;
            virtualSender?: Pick<
              AiUser,
              'id' | 'name' | 'identity' | 'avatarUrl'
            > | null;
          }
        >;
      }) => (streamKey ? s.chatStreamPresentation[streamKey] : undefined),
      [streamKey],
    ),
  );
  // Prefer the immutable run snapshot. Use the mutable conversation fallback
  // only when there is no prior run key (brand-new composition) or the stream
  // already has content (restart/older-server recovery). Immediately after a
  // completed run is cleared, its stale active key briefly remains until the
  // next chat_started event. Falling back in that empty window rendered the
  // conversation persona, removed it when the new run snapshot arrived, then
  // rendered it again with the first output chunk.
  const streamVirtualSender =
    streamPresentation?.virtualSender !== undefined
      ? streamPresentation.virtualSender
      : !activeConvRunKey || currentStreamContent
        ? displayedMainAiUser
        : null;
  const streamPersonaDriven =
    streamPresentation?.personaDriven ?? chatPersonaDriven;
  const pendingStreamPresentationReady =
    !awaitingNewRunStart &&
    (!activeConvRunKey ||
      streamPresentation !== undefined ||
      Boolean(currentStreamContent));
  const canonicalPersonaTurns =
    streamPresentation?.canonicalPersonaTurns === true;
  // Only Persona Live voice-delays the main response. Work Live streams the
  // main response (text, tools and narration) like an ordinary chat.
  const isPersonaLiveDiscussion =
    liveModeEnabled && liveModeKind === 'personas' && streamPersonaDriven;
  const chatRunning = useStore(
    useCallback(
      (s: { chatRunningByConv: Record<string, boolean> }) =>
        convIdForStream
          ? (s.chatRunningByConv[convIdForStream] ?? false)
          : false,
      [convIdForStream],
    ),
  );
  const memoryPreparing = useStore(
    useCallback(
      (s: { memoryPreparingByConv: Record<string, boolean> }) =>
        convIdForStream
          ? (s.memoryPreparingByConv[convIdForStream] ?? false)
          : false,
      [convIdForStream],
    ),
  );
  const personaLiveOwnershipRef = useRef<{
    conversationId: string | null;
    streamKey: string | null;
    active: boolean;
  }>({ conversationId: activeConvId, streamKey: null, active: false });
  if (personaLiveOwnershipRef.current.conversationId !== activeConvId) {
    personaLiveOwnershipRef.current = {
      conversationId: activeConvId,
      streamKey: null,
      active: false,
    };
  }
  if (isPersonaLiveDiscussion && streamKey) {
    personaLiveOwnershipRef.current.streamKey = streamKey;
    personaLiveOwnershipRef.current.active = true;
  } else if (
    personaLiveOwnershipRef.current.active &&
    streamKey &&
    personaLiveOwnershipRef.current.streamKey !== streamKey
  ) {
    // A subsequent ordinary run must not inherit the ownership policy from a
    // completed Persona Live run in the same conversation.
    personaLiveOwnershipRef.current.active = false;
    personaLiveOwnershipRef.current.streamKey = null;
  }
  if (
    personaLiveOwnershipRef.current.active &&
    personaLiveOwnershipRef.current.streamKey === streamKey &&
    isStreamingCompleted &&
    !hasStreamingContent &&
    !chatRunning &&
    !sending
  ) {
    // Once the canonical snapshot has settled, the old live run no longer
    // needs to reserve the configured-main renderer.
    personaLiveOwnershipRef.current.active = false;
  }
  // A configured main persona is voice-delayed and renders through its
  // per-speaker transcript row. The default agent is not voice-delayed merely
  // because an invited persona will receive the talking stick afterward.
  // Keep that ownership decision only while this live run is settling: the
  // conversation's persona run kind can outlive the stream key, but a later
  // ordinary run must be allowed to use its generic streaming owner.
  const configuredMainPersonaRun =
    liveModeKind === 'personas' &&
    streamPersonaDriven &&
    personaLiveOwnershipRef.current.active &&
    Boolean(streamVirtualSender);
  const isVoiceDelayedMainPersona =
    (isPersonaLiveDiscussion || configuredMainPersonaRun) &&
    Boolean(streamVirtualSender);
  const persistedStreamedMessageId = useMemo(() => {
    // The main participant can finish while invited personas keep the overall
    // run active. Detect persistence from content instead of waiting for the
    // final chat_completed event, otherwise the generic streaming deduper
    // hides every invited persona bubble until the human presses Stop.
    if (!currentStreamContent || !ownershipStableTranscriptEntries?.length) {
      return null;
    }
    const expected = comparableAssistantContent(currentStreamContent);
    if (!expected) return null;
    const expectedSenderUserId = streamVirtualSender
      ? `ai:${streamVirtualSender.id}`
      : null;
    // This ownership probe runs even while a large transcript is being
    // windowed. Inspect raw assistant entries directly so a 700-response
    // turn does not trigger a full transcript-to-render conversion on every
    // query update.
    //
    // A steered run is persisted as multiple assistant rows around the user
    // boundary (`A1`, `P`, `A2`), while the live stream deliberately retains
    // the whole run (`A1 + A2`). Looking only for one row equal to the live
    // buffer therefore leaves the old stream bubble mounted after reconnect.
    // Compare each turn's ordered assistant segments as one response and
    // retain the newest matching final row as the canonical owner. Checking
    // completed turns matters when the following user prompt is already in
    // the transcript before this stream hands off.
    // The transcript endpoint returns the formatted flat message shape here;
    // TranscriptEntry also models the raw provider-event union, so use the
    // runtime-shaped records for this already-discriminated probe.
    const entries = ownershipStableTranscriptEntries;
    const assistantSegments: Array<{ content: string; id?: string }> = [];
    let persistedId: string | null = null;
    const recordMatchingTurn = () => {
      if (
        assistantSegments.length > 0 &&
        comparableAssistantContent(
          assistantSegments.map((entry) => entry.content).join(''),
        ) === expected
      ) {
        persistedId = assistantSegments.at(-1)?.id ?? null;
      }
      assistantSegments.length = 0;
    };
    for (const entry of entries) {
      if (
        entry.type === 'system_milestone' ||
        (entry.type === 'message' &&
          entry.role === 'user' &&
          (entry as any).steeringDelivery !== 'steered')
      ) {
        // Historical task milestones are response boundaries. Otherwise
        // adjacent assistant turns around an old milestone are concatenated.
        persistedId = null;
        recordMatchingTurn();
      } else if (entry.type === 'message' && entry.role === 'assistant') {
        // Another speaker ends this response. With "Continue automatically"
        // the main participant speaks again after invited personas, and those
        // follow-ups must not be joined to the streamed reply.
        if (personaSenderId(entry as any) === expectedSenderUserId) {
          assistantSegments.push(entry as any);
        } else {
          recordMatchingTurn();
        }
      }
    }
    recordMatchingTurn();
    return persistedId;
  }, [
    currentStreamContent,
    streamVirtualSender,
    ownershipStableTranscriptEntries,
  ]);
  const persistedStreamedResponse = persistedStreamedMessageId !== null;
  const persistedMainPersonaMessageIds = useMemo(() => {
    const ids = new Set<string>();
    const senderId = streamVirtualSender
      ? `ai:${streamVirtualSender.id}`
      : null;
    if (!senderId) return ids;
    for (const entry of ownershipStableTranscriptEntries ?? []) {
      if (
        entry.type === 'message' &&
        entry.role === 'assistant' &&
        entry.id &&
        personaSenderId(entry as any) === senderId
      ) {
        ids.add(entry.id);
      }
    }
    return ids;
  }, [ownershipStableTranscriptEntries, streamVirtualSender]);

  // Show streaming bubble as long as there is streaming content.
  // Content persists in the Zustand store until a new chat_started fires for
  // this conversation (which sets a new activeStreamKeyByConv, making the old
  // key unreferenced), the user navigates away, or handleServerRestarted clears
  // everything. Per-run UUID keys ensure a new chat_started never wipes a
  // still-visible previous run's output.
  // Persona Live Mode owns the empty pending state through its per-speaker
  // transcript rows, but active main-agent output still belongs in the generic
  // streaming bubble. Once persisted, the transcript takes over for replay.
  // Keep the default agent's live bubble mounted while an invited persona is
  // taking over, regardless of whether the conversation is in Persona Live
  // mode. Otherwise ordinary persona conversations can deduplicate the saved
  // main row while the generic bubble is already hidden, leaving neither
  // renderer to own that response. Once the outer run finishes, the canonical
  // transcript takes over in the same commit.
  const keepDefaultMainStreamForHandoff =
    mainResponseOwner({
      personaDriven: streamPersonaDriven,
      hasVirtualSender: Boolean(streamVirtualSender),
      mainPersonaIsVoiceDelayed: isVoiceDelayedMainPersona,
      hasPersistedResponse: persistedStreamedResponse,
      chatRunning,
      sending,
      streamIsActive: streamKey === activeConvRunKey,
    }) === 'generic-stream';
  const preserveStoppedStreamingBubble = Boolean(
    stoppedStreamKey === streamKey &&
    !stoppedStreamCanonicalSteeringAvailable &&
    (hasStreamingContent || stoppedStreamContent),
  );
  const shouldShowStreamingBubble =
    !canonicalPersonaTurns &&
    !isVoiceDelayedMainPersona &&
    (hasStreamingContent || preserveStoppedStreamingBubble) &&
    (!persistedStreamedResponse ||
      keepDefaultMainStreamForHandoff ||
      preserveStoppedStreamingBubble) &&
    !(
      isStreamingCompleted &&
      persistedStreamedResponse &&
      canonicalSteeringMessageIds.size > 0
    );
  const completedTranscriptBaselineRef = useRef<{
    streamKey: string | null;
    entries: TranscriptEntry[] | undefined;
  } | null>(null);
  useLayoutEffect(() => {
    if (!isStreamingCompleted) {
      completedTranscriptBaselineRef.current = null;
      return;
    }
    const baseline = completedTranscriptBaselineRef.current;
    if (
      !baseline ||
      baseline.streamKey !== streamKey ||
      baseline.entries !== transcriptEntries
    ) {
      completedTranscriptBaselineRef.current = {
        streamKey,
        entries: transcriptEntries,
      };
      return;
    }
    if (
      !activeConvId ||
      (!persistedStreamedResponse &&
        (!hasCurrentTurnDefaultAgentResponse ||
          planArtifactFromMessage(currentStreamContent) !== null)) ||
      preserveStoppedStreamingBubble ||
      chatRunning ||
      sending
    ) {
      return;
    }
    clearCompletedStreamingForConversation(activeConvId, false, true);
  }, [
    activeConvId,
    chatRunning,
    currentStreamContent,
    hasCurrentTurnDefaultAgentResponse,
    isStreamingCompleted,
    ownershipStableTranscriptEntries,
    transcriptEntries,
    persistedStreamedResponse,
    preserveStoppedStreamingBubble,
    sending,
    streamKey,
  ]);
  // lingering "sending" state for this conversation. This covers the case where
  // the HTTP fetch never resolves (e.g. reverse-proxy / browser TCP timeout)
  // so the finally block never ran — without this the Thinking badge stays
  // visible forever even though the run finished.
  useEffect(() => {
    // Do not clear on "not running" alone: for brand-new conversations there is
    // a short window before chat_started arrives where chatRunning is still false.
    // Clearing there causes the Thinking badge to flash and disappear.
    if (!chatRunning && isStreamingCompleted && convIdForStream) {
      setSendingByConv((prev) => {
        if (!prev[convIdForStream]) return prev;
        const next = { ...prev };
        delete next[convIdForStream];
        return next;
      });
    }
  }, [chatRunning, isStreamingCompleted, convIdForStream]);

  // Whether we are showing the previous run's content as a fallback (the new
  // run hasn't produced output yet). Used to adjust transcript deduplication.
  const isShowingPrevRun = !!prevRunContent && streamKey === prevConvRunKey;

  // Cache for stabilizing RenderItem object references across transcript refetches.
  // When content is identical, reuse the same object so React.memo() on
  // ChatMessageBubble can skip re-rendering unchanged messages.
  const itemCacheRef = useRef<Map<string, RenderItem>>(new Map());

  // Only deduplicate transcript vs streaming bubble while a run is actually
  // in flight (or the send just went out). After restart/completion,
  // stale isStreamingCompleted + prev-run fallback must not hide committed
  // transcript messages — the JSONL still has them.
  //
  // The `chatRunning || sending` clause used to gate dedup, but that flips
  // false the instant the run finishes — BEFORE the streaming bubble is
  // unmounted (it is cleared in a later effect, only after the transcript
  // refetch arrives). For a tick or two the user saw both the transcript's
  // trailing assistant item AND the streaming bubble (duplicate), then the
  // bubble vanished and `useSmartScroll` snapped to the new bottom — visible
  // as a layout shift / page jump after streaming ends.
  //
  // `shouldShowStreamingBubble` already reflects "bubble is mounted" because
  // it reads the same `chatStreamingOutput[streamKey]` boolean. Including it
  // in the gate keeps dedup active until the bubble is actually gone.
  const shouldDedupStreaming =
    !canonicalPersonaTurns &&
    (hasStreamingContent || preserveStoppedStreamingBubble) &&
    ((!isPersonaLiveDiscussion &&
      ((chatRunning && !persistedStreamedResponse) ||
        (sending && !awaitingNewRunPresentation))) ||
      shouldShowStreamingBubble) &&
    // An ordinary previous-run fallback is not a mounted response owner. Its
    // canonical row must remain until the new run owns its own output.
    !(isShowingPrevRun && !keepDefaultMainStreamForHandoff) &&
    // An empty persona-phase stream owns no text after the default response
    // has already become canonical.
    !(
      hasCurrentTurnDefaultAgentResponse &&
      !hasStreamingContent &&
      !preserveStoppedStreamingBubble
    ) &&
    // Submission state commits before React Query publishes the optimistic
    // prompt. In that render the completed stream is already being retired,
    // so its canonical response remains the only valid owner.
    !(
      sending &&
      isStreamingCompleted &&
      !keepDefaultMainStreamForHandoff &&
      !preserveStoppedStreamingBubble
    );

  const TRANSCRIPT_RENDER_BATCH = 80;
  const transcriptEntryCount = ownershipStableTranscriptEntries?.length ?? 0;
  const transcriptEntryKey = (entry: TranscriptEntry | undefined) =>
    entry
      ? `${entry.type ?? 'message'}:${'id' in entry ? (entry.id ?? '') : ''}`
      : null;
  const transcriptTailKey = JSON.stringify(
    ownershipStableTranscriptEntries?.at(-1) ?? null,
  );
  const [transcriptWindow, setTranscriptWindow] = useState(() => ({
    conversationId: activeConvId,
    rowCount: TRANSCRIPT_RENDER_BATCH,
    entryCount: transcriptEntryCount,
    tailKey: transcriptTailKey,
    revealed: false,
    anchorActive: false,
    anchorStart: Math.max(0, transcriptEntryCount - TRANSCRIPT_RENDER_BATCH),
    anchorEnd: transcriptEntryCount,
    anchorKey: transcriptEntryKey(
      ownershipStableTranscriptEntries?.at(-TRANSCRIPT_RENDER_BATCH),
    ),
  }));
  const countHiddenTranscriptRows = (
    window: typeof transcriptWindow,
    length: number,
  ) => {
    if (!(window.revealed || window.anchorActive)) {
      return Math.max(0, length - Math.min(length, window.rowCount));
    }
    const latestStart = Math.max(0, length - TRANSCRIPT_RENDER_BATCH);
    const mounted =
      Math.min(length, Math.max(0, window.anchorEnd - window.anchorStart)) +
      Math.max(0, length - latestStart) -
      Math.max(
        0,
        Math.min(window.anchorEnd, length) -
          Math.max(window.anchorStart, latestStart),
      );
    return Math.max(0, length - mounted);
  };
  let effectiveTranscriptWindow = transcriptWindow;
  if (transcriptWindow.conversationId !== activeConvId) {
    // Derive the new conversation's bounded window during render. A passive
    // reset allows one paint with the previous conversation's expanded count.
    effectiveTranscriptWindow = {
      conversationId: activeConvId,
      rowCount: TRANSCRIPT_RENDER_BATCH,
      entryCount: transcriptEntryCount,
      tailKey: transcriptTailKey,
      revealed: false,
      anchorActive: false,
      anchorStart: Math.max(0, transcriptEntryCount - TRANSCRIPT_RENDER_BATCH),
      anchorEnd: transcriptEntryCount,
      anchorKey: transcriptEntryKey(
        ownershipStableTranscriptEntries?.at(-TRANSCRIPT_RENDER_BATCH),
      ),
    };
    setTranscriptWindow(effectiveTranscriptWindow);
  } else if (
    transcriptWindow.entryCount !== transcriptEntryCount ||
    transcriptWindow.tailKey !== transcriptTailKey
  ) {
    const grew = Math.max(
      0,
      transcriptEntryCount - transcriptWindow.entryCount,
    );
    const tailChanged = transcriptTailKey !== transcriptWindow.tailKey;
    const transcriptViewportUnpinned = (() => {
      const el = scrollRef.current;
      if (!el) return false;
      return el.scrollHeight - el.scrollTop - el.clientHeight > 80;
    })();
    const preserveInitialAnchor =
      !transcriptWindow.revealed &&
      transcriptWindow.anchorActive === false &&
      tailChanged &&
      grew > 0 &&
      transcriptWindow.entryCount > 0 &&
      transcriptViewportUnpinned;
    // Once a reader has revealed history, keep that anchored range mounted and
    // add only the bounded latest tail range below it. Never grow rowCount for
    // each streaming response; doing so would eventually remount the entire
    // persona burst.
    const anchorIndex =
      (transcriptWindow.revealed || transcriptWindow.anchorActive) &&
      transcriptWindow.anchorKey
        ? (ownershipStableTranscriptEntries ?? []).findIndex(
            (entry) => transcriptEntryKey(entry) === transcriptWindow.anchorKey,
          )
        : -1;
    const anchoredStart =
      anchorIndex >= 0 ? anchorIndex : transcriptWindow.anchorStart;
    const anchoredLength =
      transcriptWindow.anchorEnd - transcriptWindow.anchorStart;
    const nextAnchorStart =
      !transcriptWindow.revealed && !preserveInitialAnchor
        ? Math.max(0, transcriptEntryCount - TRANSCRIPT_RENDER_BATCH)
        : anchorIndex >= 0
          ? anchoredStart
          : transcriptWindow.anchorStart;
    const nextAnchorEnd =
      !transcriptWindow.revealed && !preserveInitialAnchor
        ? transcriptEntryCount
        : anchorIndex >= 0
          ? anchoredStart + anchoredLength
          : transcriptWindow.anchorEnd;
    effectiveTranscriptWindow = {
      ...transcriptWindow,
      // Tail growth preserves the bounded mounted window and any visible anchor.
      entryCount: transcriptEntryCount,
      tailKey: transcriptTailKey,
      revealed: transcriptWindow.revealed,
      anchorActive: transcriptWindow.anchorActive || preserveInitialAnchor,
      anchorStart: nextAnchorStart,
      anchorEnd: nextAnchorEnd,
      anchorKey:
        transcriptWindow.revealed ||
        transcriptWindow.anchorActive ||
        preserveInitialAnchor
          ? transcriptWindow.anchorKey
          : transcriptEntryKey(
              ownershipStableTranscriptEntries?.at(-TRANSCRIPT_RENDER_BATCH),
            ),
    };
    // A pure prepend while nothing was hidden is a freshly loaded older page
    // (scroll-up fetches only at hidden 0). Keep it mounted, up to one batch,
    // so the reader can keep paginating instead of clicking "Show earlier".
    const loadedOlderPage =
      !tailChanged &&
      grew > 0 &&
      transcriptWindow.entryCount > 0 &&
      countHiddenTranscriptRows(
        transcriptWindow,
        transcriptWindow.entryCount,
      ) === 0 &&
      (transcriptWindow.revealed ||
        transcriptWindow.anchorActive ||
        transcriptEntryCount > TRANSCRIPT_RENDER_BATCH);
    if (loadedOlderPage) {
      const previousFirstIndex = anchorIndex >= 0 ? anchorIndex : grew;
      const olderStart = Math.max(
        0,
        previousFirstIndex - Math.min(grew, TRANSCRIPT_RENDER_BATCH),
      );
      effectiveTranscriptWindow = {
        ...effectiveTranscriptWindow,
        revealed: true,
        anchorStart: olderStart,
        anchorEnd: transcriptEntryCount,
        anchorKey: transcriptEntryKey(
          ownershipStableTranscriptEntries?.at(olderStart),
        ),
      };
    }
    setTranscriptWindow(effectiveTranscriptWindow);
  }
  const visibleTranscriptRows = effectiveTranscriptWindow.rowCount;
  const anchorStart = effectiveTranscriptWindow.anchorStart;
  const anchorEnd = effectiveTranscriptWindow.anchorEnd;
  const transcriptRevealed = effectiveTranscriptWindow.revealed;
  const transcriptAnchored =
    transcriptRevealed || effectiveTranscriptWindow.anchorActive;
  const transcriptLength = ownershipStableTranscriptEntries?.length ?? 0;
  const hiddenTranscriptRowCount = countHiddenTranscriptRows(
    effectiveTranscriptWindow,
    transcriptLength,
  );
  const windowedOwnershipEntries = useMemo(() => {
    const entries = ownershipStableTranscriptEntries;
    if (!entries?.length) return entries;
    const start = Math.max(0, Math.min(anchorStart, entries.length));
    const end = Math.max(start, Math.min(anchorEnd, entries.length));
    const latestStart = Math.max(0, entries.length - TRANSCRIPT_RENDER_BATCH);
    if (!transcriptAnchored) {
      return entries
        .slice(Math.max(0, entries.length - visibleTranscriptRows))
        .filter((entry, index, visible) => {
          if (entry.type !== 'message' || entry.role !== 'user' || !entry.id)
            return true;
          return (
            'id' in entry &&
            visible.findIndex(
              (candidate) => 'id' in candidate && candidate.id === entry.id,
            ) === index
          );
        });
    }
    const anchored = entries.slice(start, end);
    const latest = entries.slice(latestStart);
    const keyOf = (entry: (typeof entries)[number]) =>
      `${entry.type ?? 'message'}:${'id' in entry ? (entry.id ?? '') : ''}`;
    const seen = new Set(anchored.map(keyOf));
    return anchored.concat(latest.filter((entry) => !seen.has(keyOf(entry))));
  }, [
    ownershipStableTranscriptEntries,
    visibleTranscriptRows,
    anchorStart,
    anchorEnd,
    transcriptAnchored,
  ]);

  const transcriptTurnContext = useMemo(() => {
    const assistantForkAnchors = new Map<string, string>();
    let lastUserId: string | null = null;
    let lastUserPrompt: TranscriptEntry | null = null;
    let hasUser = false;
    for (const entry of ownershipStableTranscriptEntries ?? []) {
      if (entry.type !== 'message' || !('id' in entry)) continue;
      if (!entry.id) continue;
      if (entry.role === 'user') {
        hasUser = true;
        lastUserId = entry.id;
        lastUserPrompt = entry;
      } else if (entry.role === 'assistant' && lastUserId) {
        assistantForkAnchors.set(entry.id, lastUserId);
      }
    }
    return { hasUser, lastUserId, lastUserPrompt, assistantForkAnchors };
  }, [ownershipStableTranscriptEntries]);

  const renderedMessages = useMemo(() => {
    if (!windowedOwnershipEntries || windowedOwnershipEntries.length === 0) {
      itemCacheRef.current.clear();
      return [];
    }

    const items = transcriptToRenderItems(windowedOwnershipEntries, {
      preserveEmptyStreaming: isPersonaLiveDiscussion || canonicalPersonaTurns,
    });
    // Apply dedup when streaming is active or completed — the streaming bubble
    // stays visible until a new run starts, so we always need to trim the
    // transcript's trailing assistant items to avoid duplicates.
    if (shouldDedupStreaming) {
      // Collect indices of all user messages in order.
      const userIndices: number[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].role === 'user') userIndices.push(i);
      }

      if (
        isShowingPrevRun &&
        sending &&
        shouldShowStreamingBubble &&
        keepDefaultMainStreamForHandoff &&
        userIndices.length >= 2
      ) {
        // User just sent a new message while the previous run's bubble is still
        // visible. Only then trim the prior turn's assistant text from the
        // transcript — NOT during post-restart recovery (chatRunning without
        // sending), which would hide committed history.
        const prevUserIdx = userIndices[userIndices.length - 2];
        const currUserIdx = userIndices[userIndices.length - 1];
        if (currUserIdx - prevUserIdx > 1) {
          if (isPersonaLiveDiscussion) {
            // Persona Live replies render as their own voice-paced bubbles;
            // the generic streaming bubble does not replace them, so the prior
            // turn's persona rows must stay in the transcript when the next
            // prompt is sent.
            items.splice(
              prevUserIdx + 1,
              currUserIdx - prevUserIdx - 1,
              ...items
                .slice(prevUserIdx + 1, currUserIdx)
                .filter(
                  (item) =>
                    item.role === 'system' ||
                    (item.role === 'assistant' &&
                      personaSenderId(item) !== null),
                ),
            );
          } else {
            items.splice(prevUserIdx + 1, currUserIdx - prevUserIdx - 1);
          }
        }
      } else {
        // Standard case: the streaming bubble shows the current run's output.
        // Trim the generic/main assistant item to avoid a duplicate, but retain
        // invited persona turns. Those have their own bubbles and are not part
        // of the generic stream, even while the overall autonomous run remains
        // active between participants.
        const lastUserIdx =
          userIndices.length > 0 ? userIndices[userIndices.length - 1] : -1;
        if (lastUserIdx >= 0 && lastUserIdx < items.length - 1) {
          const mainSenderId = streamVirtualSender
            ? `ai:${streamVirtualSender.id}`
            : null;
          const invitedPersonaItems = items
            .slice(lastUserIdx + 1)
            .filter(
              (item) =>
                item.role === 'system' ||
                (item.role === 'assistant' &&
                  personaSenderId(item) !== null &&
                  (personaSenderId(item) !== mainSenderId ||
                    item.streaming === true ||
                    (persistedMainPersonaMessageIds.has(item.id) &&
                      !shouldShowStreamingBubble))),
            );
          items.splice(
            lastUserIdx + 1,
            items.length - lastUserIdx - 1,
            ...invitedPersonaItems,
          );
        } else if (lastUserIdx < 0 && transcriptTurnContext.hasUser) {
          const mainSenderId = streamVirtualSender
            ? `ai:${streamVirtualSender.id}`
            : null;
          items.splice(
            0,
            items.length,
            ...items.filter(
              (item) =>
                item.role === 'system' ||
                (item.role === 'assistant' &&
                  personaSenderId(item) !== null &&
                  (personaSenderId(item) !== mainSenderId ||
                    item.streaming === true ||
                    (persistedMainPersonaMessageIds.has(item.id) &&
                      !shouldShowStreamingBubble))),
            ),
          );
        }
      }
    }

    // Stabilize object references only while render-relevant terminal metadata
    // is unchanged. Telemetry and completion arrive after the final text, so
    // comparing content alone leaves the completed bubble stuck with the
    // earlier telemetry-less streaming object until a full page reload.
    const newCache = new Map<string, RenderItem>();
    const stabilized = items.map((item) => {
      const cached = itemCacheRef.current.get(item.id);
      if (
        cached &&
        cached.content === item.content &&
        cached.role === item.role &&
        cached.telemetry === item.telemetry &&
        cached.streaming === item.streaming &&
        cached.steeringDelivery === item.steeringDelivery
      ) {
        newCache.set(item.id, cached);
        return cached;
      }
      newCache.set(item.id, item);
      return item;
    });
    itemCacheRef.current = newCache;

    return stabilized;
  }, [
    windowedOwnershipEntries,
    shouldDedupStreaming,
    shouldShowStreamingBubble,
    keepDefaultMainStreamForHandoff,
    isShowingPrevRun,
    streamVirtualSender,
    persistedMainPersonaMessageIds,
    isPersonaLiveDiscussion,
    ownershipStableTranscriptEntries,
    canonicalPersonaTurns,
    transcriptTurnContext,
  ]);

  const renderedMessagesWithSteering = useMemo(() => {
    const steeringByTarget = new Map<string, InFlightSteeringMessage[]>();
    for (const message of visibleInFlightSteeringMessages) {
      if (!message.targetMessageId) continue;
      const messages = steeringByTarget.get(message.targetMessageId) ?? [];
      messages.push(message);
      steeringByTarget.set(message.targetMessageId, messages);
    }
    if (steeringByTarget.size === 0) return renderedMessages;

    return renderedMessages.flatMap((item): RenderItem[] => {
      const steeringMessages = steeringByTarget.get(item.id);
      if (item.role !== 'assistant' || !steeringMessages?.length) return [item];
      steeringMessages.sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      );
      const assistantSegments = splitToolAwareAssistantContent(
        item.content,
        steeringMessages.map(
          (message) => message.splitOffset ?? item.content.length,
        ),
      );

      const parts: RenderItem[] = [];
      for (const [index, steeringMessage] of steeringMessages.entries()) {
        const assistantSegment = assistantSegments[index];
        if (assistantSegment) {
          parts.push({
            ...item,
            id: `${item.id}:${steeringMessage.localId}:before`,
            content: assistantSegment,
            telemetry: null,
          });
        }
        parts.push({
          id: steeringMessage.serverId ?? steeringMessage.localId,
          role: 'user',
          content: steeringMessage.content,
          attachments: steeringMessage.attachments,
          created_at: steeringMessage.createdAt,
          source: 'web',
          sender_name: currentSenderName,
          senderUserId: currentSenderUserId,
          steeringDelivery: steeringMessage.delivery,
        });
      }
      const finalSegment = assistantSegments.at(-1);
      if (finalSegment) {
        parts.push({ ...item, content: finalSegment });
      }
      return parts;
    });
  }, [
    currentSenderName,
    currentSenderUserId,
    visibleInFlightSteeringMessages,
    renderedMessages,
  ]);

  // Fork divider: sits after the last inherited item (created at or before the
  // fork). Optimistic, streaming and steering items are always post-fork, so
  // client clock skew cannot push the divider below the fork prompt.
  const forkDividerAfterId = useMemo(() => {
    if (!activeConversation?.forked_from) return null;
    const forkedAtMs = Date.parse(activeConversation.created_at);
    if (Number.isNaN(forkedAtMs)) return null;
    let lastInheritedId: string | null = null;
    for (const item of renderedMessagesWithSteering) {
      const itemCreatedAt = item.created_at ?? item.entryCreatedAt;
      if (
        !itemCreatedAt ||
        item.id.startsWith('temp-') ||
        item.streaming ||
        item.steeringDelivery
      )
        continue;
      const createdAtMs = Date.parse(itemCreatedAt);
      if (!Number.isNaN(createdAtMs) && createdAtMs <= forkedAtMs)
        lastInheritedId = item.id;
    }
    return lastInheritedId;
  }, [activeConversation, renderedMessagesWithSteering]);
  const forkSourceId = forkDividerAfterId
    ? (activeConversation?.forked_from ?? null)
    : null;
  const forkSourceFromList = forkSourceId
    ? conversations.find((conversation) => conversation.id === forkSourceId)
    : undefined;
  const { data: independentlyLoadedForkSource, isError: forkSourceLoadFailed } =
    useQuery({
      queryKey: ['conversation-detail', project_id, forkSourceId],
      queryFn: () => fetchConversation(project_id, forkSourceId!),
      enabled: !!forkSourceId && !forkSourceFromList,
      staleTime: 10_000,
      retry: false,
    });
  // A refetch that 404s (source deleted) keeps the last successful data, so
  // ignore it once the load has failed.
  const forkSource =
    forkSourceFromList ??
    (forkSourceLoadFailed ? undefined : independentlyLoadedForkSource);
  const forkSourceLabel = forkSource
    ? forkSource.title || forkSource.preview || 'New conversation'
    : null;
  const openForkSource = useCallback(() => {
    if (forkSourceId) setActiveConvId(forkSourceId);
  }, [forkSourceId, setActiveConvId]);

  const beforePersonaIds = useMemo(
    () =>
      new Set(
        invitedAiUsers
          .filter((aiUser) => aiUser.turn === 'before')
          .map((aiUser) => `ai:${aiUser.id}`),
      ),
    [invitedAiUsers],
  );
  const hasCurrentTurnPersonaResponse = useMemo(
    () => hasPersonaResponseAfterLastUser(renderedMessages),
    [renderedMessages],
  );
  // Persona rows enter the transcript list while the default agent can still
  // own the separate generic stream. Anchor that stream at its speaker turn in
  // every persona-driven chat, not only Persona Live, so an after-persona can
  // never render above the main response while it is streaming.
  const inlineDefaultAgentStream =
    (streamPersonaDriven || hasCurrentTurnPersonaResponse) &&
    !canonicalPersonaTurns &&
    // A voice-delayed main persona renders through its own transcript row.
    // Otherwise (including a main persona in Work Live) the generic stream
    // must sit at its speaker turn, before later persona rows.
    !isVoiceDelayedMainPersona &&
    !isShowingPrevRun &&
    ((shouldShowStreamingBubble &&
      (chatRunning || sending || isStreamingCompleted)) ||
      preserveStoppedStreamingBubble);
  const inlineStreamingAnchorId = useMemo(
    () =>
      inlineDefaultAgentStream
        ? defaultAgentStreamAnchorId(renderedMessages, beforePersonaIds)
        : null,
    [inlineDefaultAgentStream, renderedMessages, beforePersonaIds],
  );

  // Keep a ref to the latest rendered messages so stable callbacks (the fork
  // handler) can read the current list without depending on `renderedMessages`.
  // Putting renderedMessages in those callbacks' deps would re-create them
  // whenever the transcript changes, busting React.memo on every
  // ChatMessageBubble and re-rendering the whole list on unrelated state flips
  // (e.g. the composer's clear-button visibility toggling `hasText`).
  const renderedMessagesRef = useRef(renderedMessages);
  renderedMessagesRef.current = renderedMessages;

  // Pre-compute the id of the last assistant message so the map below doesn't
  // need an O(n) .slice().some() call per item to determine `isLastAssistant`.
  // Only the latest reply's run reports when the provider's prompt cache expires.
  const cacheExpiresAtMs = useMemo(() => {
    for (let i = renderedMessages.length - 1; i >= 0; i--) {
      if (renderedMessages[i].role !== 'assistant') continue;
      const value = renderedMessages[i].telemetry?.cache_expires_at_ms;
      return typeof value === 'number' ? value : null;
    }
    return null;
  }, [renderedMessages]);

  const lastAssistantId = useMemo(() => {
    for (let i = renderedMessages.length - 1; i >= 0; i--) {
      if (renderedMessages[i].role === 'assistant')
        return renderedMessages[i].id;
    }
    return null;
  }, [renderedMessages]);

  // Pre-compute, for each assistant message, the content of the next user
  // message that follows it (used to render the "answer" highlight on
  // question cards). Without this the render loop did renderedMessages
  // .slice(idx+1).find() for every item — O(n²) per parent re-render.
  const nextUserContentByAssistantId = useMemo(() => {
    const map = new Map<string, string>();
    let pendingAssistantIds: string[] = [];
    for (const item of renderedMessages) {
      if (item.role === 'assistant') {
        pendingAssistantIds.push(item.id);
      } else if (item.role === 'user' && pendingAssistantIds.length > 0) {
        for (const id of pendingAssistantIds) map.set(id, item.content);
        pendingAssistantIds = [];
      }
    }

    // Codex's native answer control stays inside the active app-server run,
    // whose raw assistant output is appended to the transcript only at run
    // completion. Match its persisted answer metadata by request id instead
    // of relying on chronological user/assistant transcript ordering.
    const answersByRequestId = new Map<string, string>();
    for (const entry of transcriptEntries ?? []) {
      if (
        (entry as any).type === 'codex_user_input' &&
        typeof (entry as any).request_id === 'string' &&
        typeof (entry as any).content === 'string'
      ) {
        answersByRequestId.set(
          (entry as any).request_id,
          (entry as any).content,
        );
      }
    }
    if (answersByRequestId.size > 0) {
      for (const item of renderedMessages) {
        if (item.role !== 'assistant') continue;
        const requestId = codexQuestionRequestId(item.content);
        const answer = requestId
          ? answersByRequestId.get(requestId)
          : undefined;
        if (answer !== undefined) map.set(item.id, answer);
      }
    }
    return map;
  }, [renderedMessages, transcriptEntries]);

  const isLoading = isLoadingTranscript;
  // Scroll height before loading older messages, used to restore position after prepend
  const prevScrollHeightRef = useRef(0);

  // Outer scroll: reacts to message list growth and streaming start/stop (boolean),
  // not to individual chunks — per-chunk scrolling is handled inside StreamingBubble.
  const {
    scrollToBottom,
    scrollToBottomIfPinned,
    scrollToBottomIfPinnedNow,
    settleToBottom,
  } = useSmartScroll(
    scrollRef,
    [renderedMessages.length, hasStreamingContent],
    activeConvId,
    messagesContentRef,
  );
  useEffect(() => {
    if (transcriptTailKey) scrollToBottomIfPinned();
  }, [transcriptTailKey, scrollToBottomIfPinned]);

  // A conversation stays hidden (previous one dimmed on a switch, blank on first
  // load) until its transcript has loaded and stopped moving.
  const { gated: transcriptGated, previous: previousTranscript } =
    useTranscriptRevealGate({
      transcriptKey: activeConvId,
      enabled: true,
      // isPending, not isLoading: a paused (offline) first fetch is not settled.
      ready: !isTranscriptPending,
      mounted: true,
      scrollRef,
      exemptKey: freshConversationIdRef.current,
    });
  useEffect(() => {
    if (activeConvId === freshConversationIdRef.current) {
      freshConversationIdRef.current = null;
    }
  }, [activeConvId]);

  // Set just before sending so the optimistic turn is positioned before paint.
  const justSentRef = useRef(false);
  const pendingCompletedStreamHandoffRef = useRef<{
    conversationId: string;
    createdAt: string;
  } | null>(null);
  const settledConversationRef = useRef<string | null>(null);

  // React Query publishes setQueryData notifications asynchronously. Keep the
  // completed stream renderer mounted until its following optimistic prompt is
  // demonstrably in this render, then remove it from a layout effect. React
  // flushes that update before paint, so a steered live tree cannot disappear
  // into a canonical replay frame on its own between the two states.
  useLayoutEffect(() => {
    const pending = pendingCompletedStreamHandoffRef.current;
    if (!pending || pending.conversationId !== activeConvId) return;
    const optimisticPromptIsRendered = renderedMessages.some(
      (message) =>
        message.role === 'user' && message.created_at === pending.createdAt,
    );
    if (!optimisticPromptIsRendered) return;
    pendingCompletedStreamHandoffRef.current = null;
    clearCompletedStreamingForConversation(pending.conversationId);
  }, [activeConvId, renderedMessages]);

  // The first visible message and its offset before older messages are
  // prepended. A scroll-height delta alone drifts when Markdown above the
  // reader renders lazily and changes height after the prepend, so the anchor
  // is re-applied for a short settle window (or until the reader scrolls).
  const olderAnchorRef = useRef<{
    id: string;
    offset: number;
    settleUntil: number;
  } | null>(null);
  const captureOlderAnchor = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const top = container.getBoundingClientRect().top;
    for (const el of container.querySelectorAll<HTMLElement>(
      '[data-message-id]',
    )) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom > top + 1) {
        olderAnchorRef.current = {
          id: el.dataset.messageId ?? '',
          offset: rect.top - top,
          settleUntil: 0,
        };
        return;
      }
    }
  }, []);
  const applyOlderAnchor = useCallback(() => {
    const container = scrollRef.current;
    const anchor = olderAnchorRef.current;
    if (!container || !anchor?.id) return;
    const el = container.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(anchor.id)}"]`,
    );
    if (!el) return;
    const delta =
      el.getBoundingClientRect().top -
      container.getBoundingClientRect().top -
      anchor.offset;
    if (Math.abs(delta) >= 1) container.scrollTop += delta;
  }, []);

  // After older messages are prepended, restore scroll position so the user
  // stays at the same visual spot instead of jumping to the top.
  useLayoutEffect(() => {
    if (prevScrollHeightRef.current > 0 && scrollRef.current) {
      scrollRef.current.scrollTop =
        scrollRef.current.scrollHeight - prevScrollHeightRef.current;
      prevScrollHeightRef.current = 0;
      if (olderAnchorRef.current) {
        applyOlderAnchor();
        olderAnchorRef.current.settleUntil = performance.now() + 1000;
      }
    }
  }, [transcriptEntries?.length, visibleTranscriptRows, applyOlderAnchor]);
  useEffect(() => {
    const container = scrollRef.current;
    const content = messagesContentRef.current;
    if (!container || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const anchor = olderAnchorRef.current;
      if (anchor && performance.now() < anchor.settleUntil) applyOlderAnchor();
    });
    observer.observe(content);
    // Any deliberate reader input ends the settle window.
    const release = () => {
      olderAnchorRef.current = null;
    };
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
      container.addEventListener(type, release, { passive: true });
    }
    return () => {
      observer.disconnect();
      for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
        container.removeEventListener(type, release);
      }
    };
  }, [activeConvId, applyOlderAnchor]);

  // Load older messages when the user scrolls near the top.
  const handleScrollUpLoad = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (hiddenTranscriptRowCount > 0) return;
      if (
        e.currentTarget.scrollTop < 100 &&
        hasOlderTranscript &&
        !isFetchingOlderTranscript
      ) {
        prevScrollHeightRef.current = e.currentTarget.scrollHeight;
        captureOlderAnchor();
        fetchOlderTranscript();
      }
    },
    [
      hiddenTranscriptRowCount,
      hasOlderTranscript,
      isFetchingOlderTranscript,
      fetchOlderTranscript,
      captureOlderAnchor,
    ],
  );

  // Reset scroll position when switching conversations.
  useLayoutEffect(() => {
    prevScrollHeightRef.current = 0;
    settledConversationRef.current = null;
    scrollToBottom();
  }, [activeConvId, scrollToBottom]);

  // The transcript's first paint is not its final height: Markdown is code
  // split, highlighting mutates code blocks, and media loads asynchronously.
  // Force-follow those changes once per conversation load so the viewport
  // reliably settles on the latest bubble. useSmartScroll cancels the settle
  // window immediately if the user interacts with the scroll container.
  useLayoutEffect(() => {
    if (
      !activeConvId ||
      isLoadingTranscript ||
      renderedMessages.length === 0 ||
      settledConversationRef.current === activeConvId
    ) {
      return;
    }
    settledConversationRef.current = activeConvId;
    settleToBottom();
  }, [
    activeConvId,
    isLoadingTranscript,
    renderedMessages.length,
    settleToBottom,
  ]);

  // Put the optimistic turn at its final bottom position before paint. The old
  // nearest-scroll + suppressed auto-scroll + double-rAF handoff exposed the
  // next speaker roughly one bubble lower, then visibly jumped when streaming
  // began. Remaining pinned lets chat_started and the first chunk follow in
  // useSmartScroll's layout effect without an intermediate frame.
  useLayoutEffect(() => {
    if (!justSentRef.current) return;
    justSentRef.current = false;
    scrollToBottom();
  }, [
    inFlightSteeringMessages.length,
    renderedMessages.length,
    scrollToBottom,
  ]);

  // Restore persisted draft when the project or active conversation changes,
  // or when the draft is updated externally (e.g. from a share action).
  //
  // This is intentionally NOT a reactive useStore() subscription. Subscribing
  // to the live draft value would re-render the entire ChatPage (and the whole
  // message list) on every keystroke, because autoResize() writes the typed
  // text into this same store entry. The textarea is uncontrolled, so live
  // typing is already reflected in the DOM without React. We only need to
  // (a) load the stored draft when the conversation/project switches, and
  // (b) passively pick up external updates (share action). The subscribe
  // callback no-ops when the store value matches what the user already typed,
  // so keystrokes cost nothing.
  useEffect(() => {
    const key = currentDraftKey;
    const stored = useStore.getState().draftByKey[key];
    if (
      textareaRef.current &&
      stored !== undefined &&
      stored !== textareaRef.current.value
    ) {
      textareaRef.current.value = stored || '';
      autoResize();
    }
    const unsub = useStore.subscribe((state) => {
      const value = state.draftByKey[key];
      if (
        textareaRef.current &&
        value !== undefined &&
        value !== textareaRef.current.value
      ) {
        textareaRef.current.value = value || '';
        autoResize();
      }
    });
    return unsub;
  }, [currentDraftKey, autoResize]);

  const lastMarkedReadIdRef = useRef<string | null>(null);
  const [markingAllFinished, setMarkingAllFinished] = useState(false);

  const markConversationAsRead = useCallback(
    async (conversationId: string) => {
      queryClient.setQueryData<ConversationsData>(convsQueryKey, (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((page) =>
            page.map((conversation) =>
              conversation.id === conversationId &&
              (conversation.status === 'finished' ||
                conversation.status === 'failed')
                ? { ...conversation, status: 'idle' }
                : conversation,
            ),
          ),
        };
      });
      queryClient.setQueryData<AttentionResponse>(
        queryKeys.attention.all,
        (old) => markConversationViewedInAttention(old, conversationId),
      );
      try {
        await apiMarkRead(conversationId);
      } catch (error) {
        // Network-level failures (fetch TypeError, e.g. board restart or a
        // dropped connection) are transient: the refetch below restores the
        // server state, and selecting the conversation again retries.
        if (error instanceof TypeError) {
          await queryClient.invalidateQueries({ queryKey: convsQueryKey });
          return;
        }
        // The conversation is gone (deleted elsewhere) or not in this
        // project: nothing to mark, and nothing the user can act on.
        if (error instanceof ApiError && error.status === 404) {
          if (
            useStore.getState().activeConvByProject[folderKey] ===
            conversationId
          ) {
            clearDeadActiveConversation();
          }
          await queryClient.invalidateQueries({ queryKey: convsQueryKey });
          return;
        }
        const cachedConversation = queryClient
          .getQueryData<ConversationsData>(convsQueryKey)
          ?.pages.flat()
          .find((conversation) => conversation.id === conversationId);
        const conversationName =
          cachedConversation?.title?.trim() ||
          cachedConversation?.preview?.trim() ||
          `Conversation ${conversationId.slice(-8)}`;
        const projectName = project?.name.trim() || project_id;
        toast.error(
          `Could not mark conversation "${conversationName}" as viewed in project "${projectName}": ${error instanceof Error ? error.message : String(error)}`,
        );
        await queryClient.invalidateQueries({ queryKey: convsQueryKey });
      } finally {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.attention.all }),
          queryClient.invalidateQueries({
            queryKey: queryKeys.projects.statusSummary,
          }),
        ]);
      }
    },
    [
      apiMarkRead,
      clearDeadActiveConversation,
      convsQueryKey,
      folderKey,
      project?.name,
      project_id,
      queryClient,
    ],
  );

  const markAllFinishedConversationsAsRead = useCallback(async () => {
    if (
      !conversations.some(
        (conversation) =>
          conversation.status === 'finished' ||
          conversation.status === 'failed',
      ) ||
      markingAllFinished
    )
      return;

    setMarkingAllFinished(true);
    queryClient.setQueryData<ConversationsData>(
      convsQueryKey,
      (old) =>
        old && {
          ...old,
          pages: old.pages.map((page) =>
            page.map((conversation) =>
              conversation.status === 'finished' ||
              conversation.status === 'failed'
                ? { ...conversation, status: 'idle' }
                : conversation,
            ),
          ),
        },
    );
    try {
      await apiMarkAllRead();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: convsQueryKey }),
        queryClient.invalidateQueries({ queryKey: queryKeys.attention.all }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.projects.statusSummary,
        }),
      ]);
    } catch (error) {
      toast.error(
        `Could not mark conversations as viewed: ${error instanceof Error ? error.message : String(error)}`,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: convsQueryKey }),
        queryClient.invalidateQueries({ queryKey: queryKeys.attention.all }),
      ]);
    } finally {
      setMarkingAllFinished(false);
    }
  }, [
    apiMarkAllRead,
    convsQueryKey,
    conversations,
    markingAllFinished,
    queryClient,
  ]);

  // Auto-mark conversation as read when switching or loading. Wait until the
  // project's own conversation list or detail query has returned it: a
  // remembered (localStorage) or deep-linked selection can be deleted or belong
  // to another project, and the server rejects those with 404.
  useEffect(() => {
    if (
      activeConvId &&
      activeConversationConfirmed &&
      activeConvId !== lastMarkedReadIdRef.current
    ) {
      lastMarkedReadIdRef.current = activeConvId;
      void markConversationAsRead(activeConvId);
    }
  }, [activeConvId, activeConversationConfirmed, markConversationAsRead]);

  // Keep the backend aware of the conversation visible on this device so a
  // completion does not create a redundant Android system notification here.
  useEffect(() => {
    const publishPresence = () => {
      setViewedConversationPresence(
        document.visibilityState === 'visible' ? activeConvId : null,
      );
    };
    publishPresence();
    document.addEventListener('visibilitychange', publishPresence);
    return () => {
      document.removeEventListener('visibilitychange', publishPresence);
      setViewedConversationPresence(null);
    };
  }, [activeConvId]);

  // Auto-navigate to a new conversation as soon as chat_started fires.
  // Without this, activeConvId stays null until the HTTP response returns
  // (after the full agent run), leaving the user on "New conversation" with
  // their prompt bubble invisible and no way to see the conversation.
  //
  // Skip while composingNewConv is set: pendingStreamKey is non-null for the
  // whole lifetime of a run (set on chat_started, cleared on chat_completed), so
  // without this guard the effect re-fires the moment activeConvId goes back to
  // null while a run is live — e.g. when the user clicks "New" mid-stream —
  // instantly snapping them back to the streaming conversation and making it
  // impossible to start a new one until the run finishes.
  useEffect(() => {
    const deliberatelyBlank =
      useStore.getState().composingNewConversationByProject[folderKey] === true;
    if (pendingStreamKey && !activeConvId && !deliberatelyBlank) {
      // Transfer the sending state from NEW_CHAT_KEY to the real conversation ID
      // so the "Thinking…" badge stays visible after auto-navigation changes
      // activeConvId (which shifts the sending lookup key).
      // Also handles the post-refresh case: pendingStreamKey is restored from the
      // replayed chat_started WS event but activeConvId (Zustand, in-memory) is
      // lost — without this branch the transcript query stays disabled and all
      // previous messages are invisible until the user navigates away and back.
      if (sendingByConv[NEW_CHAT_KEY]) {
        setSendingByConv((prev) => {
          const next = { ...prev, [pendingStreamKey]: true };
          delete next[NEW_CHAT_KEY];
          return next;
        });
      }
      setActiveConvId(pendingStreamKey);
    }
  }, [
    pendingStreamKey,
    activeConvId,
    composingNewConv,
    folderKey,
    sendingByConv,
    setActiveConvId,
  ]);

  // Fork state — per-message fork UI
  const [forkFromMessageId, setForkFromMessageId] = useState<string | null>(
    null,
  );
  const hasSendableComposerContent =
    hasText || pendingAttachments.length > 0 || Boolean(forkFromMessageId);
  // When true, the fork is anchored on a USER message but should ALSO include the
  // assistant reply that follows it (forking "after an assistant turn"). The
  // anchor id stays the user message's resolvable id; this flag tells the
  // backend to extend the slice through the following assistant turn.
  const [forkIncludeAssistantTurn, setForkIncludeAssistantTurn] =
    useState(false);
  const [isForkPending, setIsForkPending] = useState(false);

  // Reset fork state when the user switches conversations so a stale
  // forkFromMessageId from a previous conversation doesn't linger.
  useEffect(() => {
    setForkFromMessageId(null);
    setForkIncludeAssistantTurn(false);
  }, [activeConvId]);

  // Worktree selection for new conversations (only relevant when project has a repo).
  // use_worktree = on/off; worktreeBranch = null → new worktree (chat-{id}),
  // a branch string → run in that existing worktree.
  const hasRepo = !!project?.settings?.repositoryLocation;
  const supportsConversationWorktrees =
    project?.settings?.taskCheckoutMode === 'worktree';
  const showWorktreeSelector =
    !activeConvId && !objective_id && hasRepo && supportsConversationWorktrees;
  const isAndroid =
    Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  const isMobileViewport = useMediaQuery('(max-width: 639px)');
  const [use_worktree, setUseWorktree] = useState(false);
  const [worktreeBranch, setWorktreeBranch] = useState<string | null>(null);
  const {
    open: artifactsPanelOpen,
    setOpen: setArtifactsPanelOpen,
    setOpenAfterLeaveCheck: closeArtifactsPanelAfterLeave,
    width: artifactsPanelWidth,
    layoutRef: chatLayoutRef,
    startResize: startArtifactsResize,
    cancelResize: cancelArtifactsResize,
  } = useProjectWorkspacePane(project_id, {
    restoreOpen: !isMobileViewport,
    persistOpen: !isMobileViewport,
    openStateKey: workspacePane?.openStateKey,
    defaultOpen: workspacePane?.defaultOpen,
  });
  useWorkspacePaneReveal(project_id, setArtifactsPanelOpen);
  // A deep link keeps the pane open (also on narrow layouts) until the user
  // dismisses it, instead of applying the usual mobile "start closed" rule.
  const openRequest = workspacePane?.openRequest;
  const keepPaneOpenRef = useRef(openRequest !== undefined);
  const handledOpenRequestRef = useRef(openRequest);
  useEffect(() => {
    if (openRequest === undefined) {
      // Leaving the deep link makes the same value a new request next time.
      handledOpenRequestRef.current = undefined;
      return;
    }
    if (handledOpenRequestRef.current === openRequest) return;
    handledOpenRequestRef.current = openRequest;
    keepPaneOpenRef.current = true;
    setArtifactsPanelOpen(true);
  }, [openRequest, setArtifactsPanelOpen]);
  const dismissWorkspacePane = useCallback(() => {
    keepPaneOpenRef.current = false;
    closeArtifactsPanelAfterLeave(false);
  }, [closeArtifactsPanelAfterLeave]);
  const workspacePaneAvailable = !objective_id || workspacePane !== undefined;
  useRegisterWorkspaceToggle(
    artifactsPanelOpen,
    () => {
      keepPaneOpenRef.current = false;
      setArtifactsPanelOpen((v) => !v);
    },
    workspacePaneAvailable,
  );
  const mobilePanelTransitionAuthorizedRef = useRef(false);
  // Runs `run` once the active preview may be left; only the narrow layout
  // (where the pane covers the chat and the transition closes it) consults its
  // guard.
  const authorizeMobilePanelTransition = useCallback(
    (run: () => void) => {
      if (!isMobileViewport) {
        run();
        return;
      }
      void canLeaveActivePreview(project_id).then((allowed) => {
        if (!allowed) return;
        mobilePanelTransitionAuthorizedRef.current = true;
        run();
      });
    },
    [isMobileViewport, project_id],
  );
  const openPlanArtifact = useCallback(
    (
      artifactPath: string,
      fallbackContent?: string,
      source: 'group' | 'repo' = 'group',
    ) => {
      const filename = artifactPath.split('/').at(-1) || 'plan.md';
      const opened = useStore.getState().openPreviewTab(project_id, {
        id:
          source === 'repo'
            ? `repo:${activeConvId ?? 'main'}:${artifactPath}`
            : `group:${artifactPath}`,
        title: filename,
        kind: 'file',
        source,
        path: artifactPath,
        ...(source === 'repo'
          ? {
              conversation_id: activeConvId ?? undefined,
              repoContext: activeConvId
                ? ('conversation' as const)
                : ('main' as const),
            }
          : {}),
        openFileContextConversationId: activeConvId,
        ...(fallbackContent != null ? { fallbackContent } : {}),
      });
      applyIfLeaveAllowed(opened, () => {
        onOpenArtifactPanel?.();
        setArtifactsPanelOpen(true);
      });
    },
    [activeConvId, onOpenArtifactPanel, project_id, setArtifactsPanelOpen],
  );
  /** Open a saved meeting transcript or recording in the workspace pane. */
  const openMeetingFile = useCallback(
    (relPath: string, mimetype?: string) => {
      const opened = useStore.getState().openPreviewTab(project_id, {
        id: `group:${relPath}`,
        title: relPath.split('/').at(-1) || relPath,
        kind: 'file',
        source: 'group',
        path: relPath,
        ...(mimetype ? { mimetype } : {}),
      });
      applyIfLeaveAllowed(opened, () => {
        onOpenArtifactPanel?.();
        setArtifactsPanelOpen(true);
      });
    },
    [onOpenArtifactPanel, project_id, setArtifactsPanelOpen],
  );
  const planHydrationRef = useRef<{
    conversationId: string | null;
    hasBeenSelected: boolean;
    initialized: boolean;
    seen: Set<string>;
    baselineMessageIds: Set<string> | null;
    baselinePlanKeys: Set<string>;
    planEventKeysByPath: Map<string, string>;
  }>({
    conversationId: null,
    hasBeenSelected: false,
    initialized: false,
    seen: new Set(),
    baselineMessageIds: null,
    baselinePlanKeys: new Set(),
    planEventKeysByPath: new Map(),
  });
  useEffect(() => {
    const state = planHydrationRef.current;
    if (state.conversationId !== activeConvId) {
      const firstSelection = !state.hasBeenSelected;
      state.conversationId = activeConvId;
      state.hasBeenSelected = true;
      state.initialized = false;
      state.seen = new Set();
      state.baselinePlanKeys = new Set();
      state.planEventKeysByPath = new Map();
      // A cached transcript is already available when switching into a
      // conversation. Treat only the message IDs present at that moment as
      // historical; later transcript updates may contain a newly completed
      // plan from a run that is now visible.
      state.baselineMessageIds =
        firstSelection || transcriptData === undefined
          ? null
          : new Set(
              (ownershipStableTranscriptEntries ?? []).flatMap((entry) =>
                entry.type === 'message' && 'id' in entry && entry.id
                  ? [entry.id]
                  : [],
              ),
            );
      if (
        firstSelection ||
        isLoadingTranscript ||
        (activeConvId !== null && transcriptData === undefined)
      )
        return;
    }
    // The first complete transcript render is historical state. Plans found
    // there must not be treated as newly produced plans (especially on Android).
    if (
      !state.initialized &&
      !isLoadingTranscript &&
      (activeConvId === null || transcriptData !== undefined)
    ) {
      const historicalMessageIds =
        state.baselineMessageIds ??
        new Set(
          (ownershipStableTranscriptEntries ?? []).flatMap((entry) =>
            entry.type === 'message' && 'id' in entry && entry.id
              ? [entry.id]
              : [],
          ),
        );
      state.baselineMessageIds = historicalMessageIds;
      const planEventKey = (
        message: (typeof renderedMessages)[number],
        artifactPath: string,
      ) => {
        const existing = state.planEventKeysByPath.get(artifactPath);
        const currentRunProducedPlan = Boolean(
          activeConvRunKey &&
          planArtifactFromMessage(activeRunContent)?.artifactPath ===
            artifactPath,
        );
        if (existing && !currentRunProducedPlan) return existing;
        const key = currentRunProducedPlan
          ? `run:${activeConvRunKey}:${artifactPath}`
          : `message:${message.id}:${artifactPath}`;
        state.planEventKeysByPath.set(artifactPath, key);
        return key;
      };
      let newlyProducedPlan: ReturnType<typeof planArtifactFromMessage> = null;
      for (const message of renderedMessages) {
        if (message.role !== 'assistant') continue;
        const plan = planArtifactFromMessage(message.content);
        if (plan) {
          const baselineKey = `${message.id}:${plan.artifactPath}`;
          if (historicalMessageIds.has(message.id)) {
            state.baselinePlanKeys.add(baselineKey);
            state.seen.add(`history:${baselineKey}`);
          } else {
            const key = planEventKey(message, plan.artifactPath);
            if (!state.seen.has(key)) {
              state.seen.add(key);
              newlyProducedPlan = plan;
            }
          }
        }
      }
      state.initialized = true;
      if (newlyProducedPlan) {
        openPlanArtifact(
          newlyProducedPlan.artifactPath,
          newlyProducedPlan.fallbackContent,
        );
      }
      return;
    }
    if (!state.initialized) return;
    for (let i = renderedMessages.length - 1; i >= 0; i--) {
      const message = renderedMessages[i];
      if (message.role !== 'assistant') continue;
      const plan = planArtifactFromMessage(message.content);
      if (!plan) continue;
      const baselineKey = `${message.id}:${plan.artifactPath}`;
      if (
        state.baselinePlanKeys.has(baselineKey) &&
        !state.planEventKeysByPath.has(plan.artifactPath)
      )
        continue;
      const existing = state.planEventKeysByPath.get(plan.artifactPath);
      const currentRunProducedPlan = Boolean(
        activeConvRunKey &&
        planArtifactFromMessage(activeRunContent)?.artifactPath ===
          plan.artifactPath,
      );
      // Transcript pagination/refetch can add older plan-bearing messages
      // after the initial snapshot. They are historical unless this visible
      // run is carrying the plan, or the message was appended after the
      // baseline rather than prepended as an older page.
      if (!existing && !currentRunProducedPlan) continue;
      const key = currentRunProducedPlan
        ? `run:${activeConvRunKey}:${plan.artifactPath}`
        : existing!;
      if (!existing || currentRunProducedPlan)
        state.planEventKeysByPath.set(plan.artifactPath, key);
      if (state.seen.has(key)) continue;
      state.seen.add(key);
      openPlanArtifact(plan.artifactPath, plan.fallbackContent);
      break;
    }
  }, [
    activeConvId,
    activeConvRunKey,
    activeRunContent,
    isLoadingTranscript,
    openPlanArtifact,
    renderedMessages,
    ownershipStableTranscriptEntries,
    transcriptData,
  ]);
  // Narrow layouts, where the pane covers the chat, close it on conversation
  // transitions. A transition may explicitly authorize closing it after the
  // active preview guard has passed. Wider Android layouts show the pane beside
  // the chat and keep it open (Android still starts closed via the pane hook).
  useEffect(() => {
    if (keepPaneOpenRef.current) {
      setArtifactsPanelOpen(true);
      return;
    }
    if (isMobileViewport) {
      if (mobilePanelTransitionAuthorizedRef.current) {
        mobilePanelTransitionAuthorizedRef.current = false;
        closeArtifactsPanelAfterLeave(false);
      } else {
        setArtifactsPanelOpen(false);
      }
      return;
    }
  }, [
    activeConvId,
    closeArtifactsPanelAfterLeave,
    composingNewConv,
    isMobileViewport,
    setArtifactsPanelOpen,
  ]);
  // Opens the `?file=` deep link once per link (the param stays in the URL so a
  // reload reopens it). Leaving the link makes the same value a new request.
  const handledFileLinkRef = useRef<string | undefined>(undefined);
  const fileLinkKey = route_file
    ? `${route_file.source}:${route_file.path}:${route_conversation_id ?? ''}`
    : undefined;
  useEffect(() => {
    if (!route_file || !fileLinkKey) {
      handledFileLinkRef.current = undefined;
      return;
    }
    if (handledFileLinkRef.current === fileLinkKey) return;
    handledFileLinkRef.current = fileLinkKey;
    const { source, path } = route_file;
    const conversationId =
      source === 'repo' ? (route_conversation_id ?? null) : null;
    const id =
      source === 'repo'
        ? `repo:${conversationId ?? 'main'}:${path}`
        : `group:${path}`;
    applyIfLeaveAllowed(
      useStore.getState().openPreviewTab(project_id, {
        id,
        title: path.split('/').at(-1) ?? path,
        kind: 'file',
        source,
        path,
        ...(source === 'repo'
          ? {
              conversation_id: conversationId ?? undefined,
              repoContext: conversationId
                ? ('conversation' as const)
                : ('main' as const),
            }
          : {}),
        openFileContextConversationId: conversationId,
      }),
      () => {
        void hydratePreviewTab(
          project_id,
          source,
          path,
          conversationId,
          id,
          useStore.getState().updatePreviewTab,
        );
        keepPaneOpenRef.current = true;
        onOpenArtifactPanel?.();
        setArtifactsPanelOpen(true);
      },
    );
  }, [
    fileLinkKey,
    onOpenArtifactPanel,
    project_id,
    route_conversation_id,
    route_file,
    setArtifactsPanelOpen,
  ]);
  const { data: repoWorktrees } = useQuery({
    queryKey: ['project-worktrees', project_id],
    queryFn: () => fetchProjectWorktrees(project_id),
    enabled: hasRepo && supportsConversationWorktrees && !objective_id,
    staleTime: 30_000,
  });

  // A configured folder may still need Git setup. Check the shared checkout
  // for the blank composer even when the Changes pane has never been opened.
  const canSetUpProject =
    !objective_id &&
    !!project &&
    project.accessLevel !== 'viewer' &&
    projectUsesCode(project);
  const { data: setupRepositoryDiff, isSuccess: setupRepositoryChecked } =
    useQuery({
      queryKey: [...queryKeys.conversationDiff.shared(project_id), 0],
      queryFn: () => getConversationDiff(project_id, null),
      enabled: canSetUpProject && !activeConvId && hasRepo,
      staleTime: 0,
    });
  const needsGitInitialization =
    !activeConvId &&
    hasRepo &&
    setupRepositoryChecked &&
    setupRepositoryDiff?.reason === 'not-initialized';

  // Drag & drop
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (
      e.dataTransfer.types.includes(KNOWLEDGE_DRAG_TYPE) ||
      e.dataTransfer.types.includes(FILE_DRAG_TYPE) ||
      e.dataTransfer.types.includes(PREVIEW_SELECTION_DRAG_TYPE)
    ) {
      // Path / selection drop from the Files tab or preview pane — allow the
      // drop but don't show the upload overlay (it isn't an upload).
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      return;
    }
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  }, []);

  const insertKnowledgeReference = useCallback(
    (reference: KnowledgeReference) => {
      const el = textareaRef.current;
      if (!el) return;
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? start;
      const prefix = start > 0 && !/\s/.test(el.value[start - 1]) ? ' ' : '';
      const insert = prefix + knowledgeReferenceMarkdown(reference) + ' ';
      el.value = el.value.slice(0, start) + insert + el.value.slice(end);
      el.setSelectionRange(start + insert.length, start + insert.length);
      autoResize();
      setKnowledgePickerOpen(false);
      if (isAndroid || isMobileViewport) closeArtifactsPanelAfterLeave(false);
      requestAnimationFrame(() => el.focus());
    },
    [autoResize, isAndroid, isMobileViewport, closeArtifactsPanelAfterLeave],
  );
  const prepareProjectSetup = (prompt: string) => {
    const input = textareaRef.current;
    if (!input) return;
    input.value = input.value.trim() ? `${input.value}\n\n${prompt}` : prompt;
    autoResize();
    if (isAndroid || isMobileViewport) closeArtifactsPanelAfterLeave(false);
    requestAnimationFrame(() => input.focus());
  };

  const knowledgeComposer = useMemo(
    () => ({ projectId: project_id, insert: insertKnowledgeReference }),
    [project_id, insertKnowledgeReference],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);

      const knowledgeRaw = e.dataTransfer.getData(KNOWLEDGE_DRAG_TYPE);
      if (knowledgeRaw) {
        try {
          const reference = JSON.parse(knowledgeRaw);
          if (
            typeof reference.kbId === 'string' &&
            typeof reference.filename === 'string'
          ) {
            insertKnowledgeReference({
              kbId: reference.kbId,
              filename: reference.filename,
              kbName:
                typeof reference.kbName === 'string'
                  ? reference.kbName
                  : undefined,
            });
          }
        } catch {
          /* Ignore malformed drag payloads. */
        }
        return;
      }

      // A text selection dragged out of the preview pane inserts a file
      // reference (`@<path> (lines a-b)` when line numbers are available)
      // followed by the selected text in a fenced code block.
      const selectionRaw = e.dataTransfer.getData(PREVIEW_SELECTION_DRAG_TYPE);
      if (selectionRaw) {
        let payload: PreviewSelectionPayload | null = null;
        try {
          payload = JSON.parse(selectionRaw) as PreviewSelectionPayload;
        } catch {
          payload = null;
        }
        if (payload && payload.text) {
          const el = textareaRef.current;
          if (el) {
            const insert = formatSelectionInsert(payload);
            const start = el.selectionStart ?? el.value.length;
            const end = el.selectionEnd ?? el.value.length;
            el.value = el.value.slice(0, start) + insert + el.value.slice(end);
            const caret = start + insert.length;
            el.setSelectionRange(caret, caret);
            autoResize();
            el.focus();
          }
        }
        return;
      }

      // A file dragged from the Files tab or the preview tab strip inserts an
      // @-mention at the cursor instead of being treated as an upload.
      const droppedPath = e.dataTransfer.getData(FILE_DRAG_TYPE);
      if (droppedPath) {
        const el = textareaRef.current;
        if (el) {
          const mention = `@${droppedPath} `;
          const start = el.selectionStart ?? el.value.length;
          const end = el.selectionEnd ?? el.value.length;
          el.value = el.value.slice(0, start) + mention + el.value.slice(end);
          const caret = start + mention.length;
          el.setSelectionRange(caret, caret);
          autoResize();
          el.focus();
        }
        return;
      }

      if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
    },
    [addFiles, autoResize, insertKnowledgeReference],
  );

  const buildMessagePayload = useCallback(
    async (
      text: string,
      filesToUpload: File[],
      durations?: Array<number | undefined>,
      conversationId?: string,
    ) => {
      // Upload files first, get back container-visible paths + browser URLs
      let uploaded: {
        name: string;
        containerPath: string;
        browserUrl: string;
        mimetype: string;
        path: string;
        durationSeconds: number | undefined;
      }[] = [];
      const failedUploads: FailedUpload[] = [];
      if (filesToUpload.length > 0) {
        const results = await Promise.allSettled(
          filesToUpload.map((f, index) =>
            uploadAttachment(
              project_id,
              f,
              conversationId ?? activeConvId ?? undefined,
            ).then((r) => ({
              name: f.name,
              containerPath: r.containerPath,
              browserUrl: r.browserUrl,
              mimetype: f.type,
              path: r.absolutePath,
              durationSeconds: durations?.[index],
            })),
          ),
        );
        uploaded = results.flatMap((result) =>
          result.status === 'fulfilled' ? [result.value] : [],
        );
        results.forEach((result, index) => {
          if (result.status !== 'rejected') return;
          const reason: unknown = result.reason;
          failedUploads.push({
            name: filesToUpload[index].name,
            message:
              reason instanceof Error ? reason.message.trim() : undefined,
          });
        });
      }

      // Build final message content — text + file path references
      const parts: string[] = [];
      if (text) parts.push(text);
      if (uploaded.length > 0) {
        parts.push(
          '[Attached files]\n' +
            uploaded.map((u) => `- ${u.name}: ${u.containerPath}`).join('\n'),
        );
      }
      const content = parts.join('\n\n');

      // Attachments render from their metadata, so keep the optimistic message
      // text free of a redundant paperclip/filename label.
      const bubbleContent = text;

      // Build attachment metadata for visual rendering in message bubble
      const attachments: ChatMessageAttachment[] = uploaded.map((u) => {
        const isImage =
          u.mimetype.startsWith('image/') ||
          /\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(u.name);
        const isAudio =
          u.mimetype.startsWith('audio/') ||
          /\.(mp3|wav|ogg|m4a|weba|webm)$/i.test(u.name);
        const isVideo =
          u.mimetype.startsWith('video/') ||
          /\.(mp4|webm|mov|mkv|avi)$/i.test(u.name);
        return {
          type: isImage
            ? ('image' as const)
            : isAudio
              ? ('audio' as const)
              : isVideo
                ? ('video' as const)
                : ('document' as const),
          url: u.browserUrl,
          mimetype:
            u.mimetype ||
            (isImage
              ? 'image/png'
              : isAudio
                ? 'audio/mpeg'
                : isVideo
                  ? 'video/mp4'
                  : 'application/octet-stream'),
          filename: u.name,
          path: u.path,
          durationSeconds: u.durationSeconds,
        };
      });

      return {
        content,
        bubbleContent,
        attachments: attachments.length > 0 ? attachments : undefined,
        failedUploads,
      };
    },
    [project_id, activeConvId],
  );

  const handleBrowserAnnotationSubmitted = useCallback(
    (submission: BrowserAnnotationSubmission) => {
      const files: File[] = [];
      for (const [index, frame] of submission.frames.entries()) {
        try {
          const encoded = frame.data.includes(',')
            ? frame.data.slice(frame.data.indexOf(',') + 1)
            : frame.data;
          const binary = atob(encoded);
          const bytes = Uint8Array.from(binary, (character) =>
            character.charCodeAt(0),
          );
          const title = frame.title
            ?.replace(/[^a-z0-9]+/gi, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 40);
          files.push(
            new File(
              [bytes],
              `browser-annotation-${index + 1}${title ? `-${title}` : ''}.png`,
              { type: 'image/png' },
            ),
          );
        } catch {
          // Ignore malformed frames; the valid screenshots can still reach
          // the composer and the user can attach a replacement manually.
        }
      }
      if (files.length > 0) addFiles(files);

      const feedback = submission.feedback.trim();
      if (feedback) {
        const currentDraft = readDraft().trim();
        setDraftMessage(
          [currentDraft, `UI review feedback:\n${feedback}`]
            .filter(Boolean)
            .join('\n\n'),
        );
      }
      if (files.length > 0 || feedback) {
        toast.success(
          `Added ${files.length} annotated screenshot${files.length === 1 ? '' : 's'}${feedback ? ' and feedback' : ''} to the composer`,
        );
      }
    },
    [addFiles, readDraft, setDraftMessage],
  );

  /** Inject an optimistic user message into the transcript query cache. */
  const injectOptimisticEntry = useCallback(
    (convId: string, entry: TranscriptEntry) => {
      queryClient.setQueryData<InfiniteData<TranscriptResponse>>(
        transcriptKey(convId),
        (old) => {
          if (!old) {
            return {
              pages: [
                {
                  _source: 'transcript' as const,
                  entries: [entry],
                  total: 1,
                  hasMore: false,
                  nextOffset: 1,
                },
              ],
              pageParams: [0],
            };
          }
          // Append to pages[0] — the most recent page (offset=0 = last N messages).
          // pages are stored newest-first, so pages[0] is the tail of the conversation.
          const pages = [...old.pages];
          pages[0] = { ...pages[0], entries: [...pages[0].entries, entry] };
          return { ...old, pages };
        },
      );
    },
    [queryClient, transcriptKey],
  );

  const reconcileOptimisticEntry = useCallback(
    (convId: string, optimisticMessageId: string, message: ChatMessage) => {
      const canonicalEntry: TranscriptEntry = {
        id: message.id,
        type: 'message',
        role: 'user',
        content: message.content,
        created_at: message.created_at,
        sender_name: message.sender_name ?? undefined,
        senderUserId: message.senderUserId ?? undefined,
        attachments: message.attachments ?? undefined,
        deepLinks: message.deepLinks ?? undefined,
        steeringDelivery: message.steeringDelivery,
        steeringStreamKey: message.steeringStreamKey,
      };
      queryClient.setQueryData<InfiniteData<TranscriptResponse>>(
        transcriptKey(convId),
        (old) => {
          if (!old) return old;
          const canonicalAlreadyCached = old.pages.some((page) =>
            page.entries.some(
              (entry) =>
                (entry as { id?: string }).id === message.id &&
                !(
                  entry.type === 'message' &&
                  entry.role === 'user' &&
                  entry.optimistic === true &&
                  entry.id === optimisticMessageId
                ),
            ),
          );
          const pages = old.pages.map((page) => ({
            ...page,
            entries: page.entries.flatMap((entry) => {
              if (
                entry.type === 'message' &&
                entry.role === 'user' &&
                entry.optimistic === true &&
                entry.id === optimisticMessageId
              ) {
                if (canonicalAlreadyCached) return [];
                return [
                  {
                    ...entry,
                    ...canonicalEntry,
                    optimistic: undefined,
                    clientSubmissionIds: entry.clientSubmissionIds,
                    attachments:
                      canonicalEntry.attachments ?? entry.attachments,
                    deepLinks: canonicalEntry.deepLinks ?? entry.deepLinks,
                  },
                ];
              }
              return [entry];
            }),
          }));
          return {
            ...old,
            pages,
          };
        },
      );
    },
    [queryClient, transcriptKey],
  );

  const clearCompletedStreamingForConv = clearCompletedStreamingForConversation;

  // Keep a completed stream as the visible final bubble. Replacing it with the
  // canonical transcript immediately after chat_completed remounted the same
  // response, then clearing the stream caused a second render. The next send
  // clears it synchronously before inserting the optimistic user row; refresh
  // naturally starts from the canonical transcript.

  const createAndSeedConversation = useCallback(
    async (
      agent_cmd?: string,
      runtime_selection?: RuntimeSelection,
      chat_mode?: ChatModeOverride | null,
      initialTranscriptEntry?: TranscriptEntry,
    ) => {
      const conv = await apiCreateConv(hasRepo && use_worktree, worktreeBranch);
      useStore
        .getState()
        .promotePreviewTabOpenFileContext(project_id, null, conv.id);
      const startsInLiveMode = draftLiveModeEnabled;
      const startingLiveModeKind = resolvedDraftLiveModeKind;
      setDraftAiUsers({
        mainSelection: { mode: 'inherit' },
        invitedAiUserIds: [],
        invitedAiUserIdsProvided: false,
      });
      setDraftContinuousPersonaLoop(false);
      setDraftPromptCache1h(false);
      setDraftLiveModeEnabled(false);
      setDraftLiveModeKind('work');
      if (startsInLiveMode) {
        const store = useStore.getState();
        store.setConversationLiveModeEnabled(conv.id, true);
        store.setConversationLiveModeSession(conv.id, liveModeSessionId);
        store.setConversationLiveModeKind(conv.id, startingLiveModeKind);
        store.setLiveModeEnabled(true);
        store.setLiveModeFocus(conv.id, project_id);
        // Carry the draft microphone state over to the new conversation.
        const draftMicrophoneKey = `project:${project_id}:new`;
        store.setLiveModeMicrophoneEnabled(
          conv.id,
          store.liveModeMicrophoneEnabledByConversation[draftMicrophoneKey] ===
            true,
        );
        store.setLiveModeMicrophoneEnabled(draftMicrophoneKey, false);
        // Same for the speech language chosen before the first turn.
        const draftLanguage =
          store.liveModeLanguageByConversation[draftMicrophoneKey];
        if (draftLanguage) {
          store.setLiveModeLanguage(conv.id, draftLanguage);
          store.setLiveModeLanguage(draftMicrophoneKey, null);
        }
      }
      if (chat_mode) {
        const modeStore = useStore.getState();
        modeStore.setChatModeForComposer(`${folderKey}:${conv.id}`, chat_mode);
        // The draft mode now belongs to the created conversation; don't let
        // it leak into the next new chat.
        modeStore.setChatModeForComposer(`${folderKey}:${NEW_CHAT_KEY}`, null);
      }
      // Transfer sending state immediately so the Thinking badge survives
      // the activeConvId key change (don't wait for the auto-navigate effect).
      setSendingByConv((prev) => {
        if (!prev[NEW_CHAT_KEY]) return prev;
        const next = { ...prev, [conv.id]: true };
        delete next[NEW_CHAT_KEY];
        return next;
      });
      queryClient.setQueryData<ConversationsData>(convsQueryKey, (old) => {
        // Seed last_agent_cmd with the user's picker choice so the
        // auto-select effect reads back the same runtime after navigation.
        const seededConv = agent_cmd
          ? {
              ...conv,
              last_agent_cmd: agent_cmd,
              runtimeSelection: runtime_selection ?? runtimeSelection,
            }
          : conv;
        if (!old) {
          return { pages: [[seededConv]], pageParams: [0] };
        }
        const pages = [...old.pages];
        pages[0] = [seededConv, ...(pages[0] ?? [])];
        return { ...old, pages };
      });
      queryClient.setQueryData<InfiniteData<TranscriptResponse>>(
        transcriptKey(conv.id),
        {
          pages: [
            {
              _source: 'transcript',
              entries: initialTranscriptEntry ? [initialTranscriptEntry] : [],
              total: initialTranscriptEntry ? 1 : 0,
              hasMore: false,
              nextOffset: initialTranscriptEntry ? 1 : undefined,
            },
          ],
          pageParams: [0],
        },
      );
      // Publish the new selection only after its transcript cache is ready.
      // Otherwise the enabled query can fetch the still-empty server transcript
      // and replace the optimistic first prompt during conversation startup.
      freshConversationIdRef.current = conv.id;
      setActiveConvId(conv.id);
      return conv;
    },
    [
      apiCreateConv,
      hasRepo,
      use_worktree,
      worktreeBranch,
      folderKey,
      setActiveConvId,
      setSendingByConv,
      queryClient,
      convsQueryKey,
      runtimeSelection,
      transcriptKey,
      setDraftAiUsers,
      draftLiveModeEnabled,
      resolvedDraftLiveModeKind,
      liveModeSessionId,
      project_id,
    ],
  );

  // A send proved that the selected conversation no longer exists (deleted
  // elsewhere, or never belonged to this chat). Drop the dead selection so the
  // next send starts a fresh conversation instead of failing the same way.
  const forgetMissingConversation = useCallback(
    (conversationId: string): boolean => {
      if (
        (useStore.getState().activeConvByProject[folderKey] ?? null) !==
        conversationId
      ) {
        return false;
      }
      setComposingNewConv(true);
      // Preserve the harness/model/reasoning the composer had at send time:
      // seed the picker-sync refs so the auto-select effect treats this
      // transition as already synced (same pattern as
      // handleNewConversationWithSameSettings) instead of resetting the picker
      // to the project default.
      lastSyncedConvIdRef.current = null;
      lastSyncedWithCatalogRef.current = !!runtimeCatalog;
      setActiveConvId(null);
      queryClient.setQueryData<ConversationsData>(convsQueryKey, (old) =>
        old
          ? {
              ...old,
              pages: old.pages.map((page) =>
                page.filter(
                  (conversation) => conversation.id !== conversationId,
                ),
              ),
            }
          : old,
      );
      queryClient.removeQueries({ queryKey: transcriptKey(conversationId) });
      return true;
    },
    [
      folderKey,
      setComposingNewConv,
      setActiveConvId,
      queryClient,
      convsQueryKey,
      runtimeCatalog,
      transcriptKey,
    ],
  );

  const sendPreparedMessage = useCallback(
    async (
      content: string,
      bubbleContent: string,
      conversation_id?: string,
      attachments?: ChatMessageAttachment[],
      agent_cmd?: string,
      chat_mode?: ChatModeOverride | null,
      runtime_selection?: RuntimeSelection,
      skipInjection?: boolean,
      delivery?: 'steer' | 'queue',
      deepLinks?: ChatDeepLink[],
      memoryContextLevel: MemoryContextLevel = 'off',
      liveModeOverride?: boolean,
      liveModeSessionIdOverride?: string,
      liveModeKindOverride?: 'personas' | 'work',
      queuedFallbackBatch?: QueuedPrompt[],
      openFileContext?: OpenFileContext,
      clientSubmissionIdOverride?: string,
      onConversationMissing?: (staleSelectionCleared: boolean) => void,
      onSendRejected?: () => void,
    ) => {
      let activeConvIdToUse = conversation_id;
      let wasAutoCreated = false;

      const optimisticCreatedAt = new Date().toISOString();
      const optimisticMessageId =
        clientSubmissionIdOverride ??
        queuedFallbackBatch?.[0]?.id ??
        crypto.randomUUID();
      const optimisticEntry: TranscriptEntry = {
        id: optimisticMessageId,
        clientSubmissionIds: queuedFallbackBatch?.flatMap((prompt) =>
          prompt.id ? [prompt.id] : [],
        ),
        optimistic: true,
        type: 'message' as const,
        role: 'user' as const,
        content: bubbleContent,
        created_at: optimisticCreatedAt,
        attachments: attachments,
        senderUserId: currentSenderUserId,
        deepLinks,
      };

      if (!activeConvIdToUse && !skipInjection) {
        // Reserve the fresh-conversation transition for this submission so a
        // second send cannot race the optimistic transfer and start a second
        // new conversation.
        pendingSelectionValidationRef.current.delete(NEW_CHAT_KEY);
        setPendingNewConversationEntry(optimisticEntry);
      }

      if (!activeConvIdToUse) {
        try {
          const conv = await createAndSeedConversation(
            agent_cmd,
            runtime_selection,
            chat_mode,
            skipInjection ? undefined : optimisticEntry,
          );
          activeConvIdToUse = conv.id;
          wasAutoCreated = true;
          setPendingNewConversationEntry(null);
        } catch (err) {
          console.error('Failed to create conversation on send:', err);
        }
      }

      const conversationKey = activeConvIdToUse ?? NEW_CHAT_KEY;
      const selectedConversationId =
        useStore.getState().activeConvByProject[folderKey] ?? null;
      if (
        shouldEndNewConversationComposition(
          conversation_id,
          selectedConversationId,
        )
      ) {
        setComposingNewConv(false);
      }

      // Track resolved conv ID so finally can clear transferred sending state
      let resolvedKey: string | undefined;
      let keepSendingUntilCompletion = false;
      // Keep the completed stream mounted while an in-flight transcript refetch
      // is reconciled. A queued prompt flushes immediately after chat_completed;
      // cancelling that event's refetch before it commits would leave the cache
      // with only the optimistic prompt, then clearing the stream would make the
      // completed assistant response disappear. Ensure the canonical response is
      // present before inserting the next prompt.
      if (activeConvIdToUse && !skipInjection) {
        const streamState = useStore.getState();
        const completedStreamKey =
          streamState.activeStreamKeyByConv[activeConvIdToUse];
        if (
          completedStreamKey &&
          streamState.chatStreamingCompleted[completedStreamKey]
        ) {
          await queryClient.refetchQueries({
            queryKey: transcriptKey(activeConvIdToUse),
            exact: true,
            type: 'all',
          });
        }
        await queryClient.cancelQueries({
          queryKey: transcriptKey(activeConvIdToUse),
        });
      }
      // Steering continues the current run and must not enter the new-run
      // presentation lifecycle. Doing so can hide the pre-steer stream segment
      // while waiting for a chat_started event that steering never emits.
      if (activeConvIdToUse && delivery !== 'steer') {
        pendingRunPresentationRef.current = {
          conversationId: activeConvIdToUse,
          previousStreamKey:
            useStore.getState().activeStreamKeyByConv[activeConvIdToUse] ??
            null,
        };
      }
      setSendingByConv((prev) => ({ ...prev, [conversationKey]: true }));
      if (activeConvIdToUse && !skipInjection && !wasAutoCreated) {
        injectOptimisticEntry(activeConvIdToUse, optimisticEntry);
        pendingCompletedStreamHandoffRef.current = {
          conversationId: activeConvIdToUse,
          createdAt: optimisticCreatedAt,
        };
      } else if (activeConvIdToUse && delivery !== 'steer') {
        clearCompletedStreamingForConversation(activeConvIdToUse);
      }

      try {
        const conversationIdLearnedFromResponse = !activeConvIdToUse;
        const apiResult = await apiSendMsg(
          content,
          activeConvIdToUse,
          attachments,
          agent_cmd,
          chat_mode ?? null,
          runtime_selection ?? runtimeSelection ?? undefined,
          delivery,
          deepLinks,
          memoryContextLevel,
          liveModeOverride,
          liveModeSessionIdOverride,
          liveModeKindOverride,
          clientSubmissionIdOverride ??
            queuedFallbackBatch?.[0]?.id ??
            optimisticMessageId,
          queuedFallbackBatch?.flatMap((prompt) =>
            prompt.id ? [prompt.id] : [],
          ),
          openFileContext ?? queuedFallbackBatch?.[0]?.openFileContext,
        );
        const { conversation_id: resolvedConvId, memoryCapsule } = apiResult;
        // A normal run acknowledges before its independent chat_started event.
        // Keep composer ownership on the new run until chat_completed so a
        // second submission cannot slip through the idle-send path. Queued and
        // steered deliveries do not own a new completion boundary.
        keepSendingUntilCompletion =
          !('delivery' in apiResult) || !apiResult.delivery;
        resolvedKey = resolvedConvId || activeConvIdToUse;
        const targetConvId = resolvedConvId || activeConvIdToUse;
        if (apiResult.liveModeRejected && targetConvId)
          clearRejectedLiveModeOwnership(targetConvId);
        if (
          'delivery' in apiResult &&
          apiResult.delivery === 'queued' &&
          targetConvId
        ) {
          // The backend detected an active run that the browser had not yet
          // observed. Remove the optimistic owner and retain the queue owner.
          discardFailedOptimisticEntry(targetConvId, optimisticMessageId);
          if (!apiResult.queueOwner || apiResult.queueOwner === 'browser') {
            if (queuedFallbackBatch?.length) {
              useStore.setState((state) => ({
                queuedPromptsByConv: {
                  ...state.queuedPromptsByConv,
                  [targetConvId]: releaseQueuedPromptBatchForDrain(
                    state.queuedPromptsByConv[targetConvId] ?? [],
                    queuedFallbackBatch,
                  ).map((prompt) =>
                    queuedFallbackBatch.some(
                      (queued) => queued.id === prompt.id,
                    )
                      ? { ...prompt, serverReleased: true }
                      : prompt,
                  ),
                },
              }));
            } else {
              useStore.getState().enqueuePrompt(targetConvId, {
                id: apiResult.userMessage?.id ?? optimisticMessageId,
                contextKey: folderKey,
                content,
                bubbleContent,
                draftContent: bubbleContent,
                conversation_id: targetConvId,
                attachments,
                agent_cmd,
                chat_mode: chat_mode ?? undefined,
                runtimeSelection: runtime_selection,
                deepLinks,
                memoryContextLevel,
                openFileContext,
                liveMode: liveModeOverride ?? effectiveLiveModeEnabled,
                liveModeSessionId:
                  liveModeSessionIdOverride ?? liveModeSessionId,
                liveModeKind: liveModeKindOverride ?? liveModeKind,
              });
            }
          } else if (apiResult.queueOwner === 'persona') {
            const serverOwnedPrompt: QueuedPrompt = {
              id: apiResult.queuedMessageId,
              contextKey: folderKey,
              content,
              bubbleContent,
              draftContent: bubbleContent,
              conversation_id: targetConvId,
              attachments,
              agent_cmd,
              chat_mode: chat_mode ?? undefined,
              runtimeSelection: runtime_selection,
              deepLinks,
              memoryContextLevel,
              openFileContext,
              serverOwned: true,
              serverQueueOwner: 'persona',
              liveMode: liveModeOverride ?? effectiveLiveModeEnabled,
              liveModeSessionId: liveModeSessionIdOverride ?? liveModeSessionId,
              liveModeKind: liveModeKindOverride ?? liveModeKind,
            };
            useStore.setState((state) => ({
              queuedPromptsByConv: {
                ...state.queuedPromptsByConv,
                [targetConvId]: replaceQueuedPromptBatchWithServerOwned(
                  state.queuedPromptsByConv[targetConvId] ?? [],
                  queuedFallbackBatch ?? [],
                  serverOwnedPrompt,
                ),
              },
            }));
          } else if (
            apiResult.queueOwner === 'direct' &&
            queuedFallbackBatch?.length
          ) {
            useStore.setState((state) => ({
              queuedPromptsByConv: {
                ...state.queuedPromptsByConv,
                [targetConvId]: removeAcknowledgedQueuedPromptBatch(
                  state.queuedPromptsByConv[targetConvId] ?? [],
                  queuedFallbackBatch,
                ),
              },
            }));
          }
          await queryClient.refetchQueries({
            queryKey: transcriptKey(targetConvId),
            exact: true,
            type: 'all',
          });
        } else if (
          targetConvId &&
          'delivery' in apiResult &&
          apiResult.delivery === 'pending' &&
          apiResult.queueOwner === 'direct'
        ) {
          const serverOwnedPrompt: QueuedPrompt = {
            id: apiResult.userMessage?.id,
            contextKey: folderKey,
            content,
            bubbleContent,
            draftContent: bubbleContent,
            conversation_id: targetConvId,
            attachments,
            agent_cmd,
            chat_mode: chat_mode ?? undefined,
            runtimeSelection: runtime_selection,
            deepLinks,
            memoryContextLevel,
            openFileContext,
            serverOwned: true,
            serverQueueOwner: 'direct',
            liveMode: liveModeOverride ?? effectiveLiveModeEnabled,
            liveModeSessionId: liveModeSessionIdOverride ?? liveModeSessionId,
            liveModeKind: liveModeKindOverride ?? liveModeKind,
          };
          useStore.setState((state) => ({
            queuedPromptsByConv: {
              ...state.queuedPromptsByConv,
              [targetConvId]: replaceQueuedPromptBatchWithServerOwned(
                state.queuedPromptsByConv[targetConvId] ?? [],
                queuedFallbackBatch ?? [],
                serverOwnedPrompt,
              ),
            },
          }));
        } else if (targetConvId && queuedFallbackBatch?.length) {
          useStore.setState((state) => ({
            queuedPromptsByConv: {
              ...state.queuedPromptsByConv,
              [targetConvId]: removeAcknowledgedQueuedPromptBatch(
                state.queuedPromptsByConv[targetConvId] ?? [],
                queuedFallbackBatch,
              ),
            },
          }));
        }
        if (
          targetConvId &&
          apiResult.userMessage &&
          (!('delivery' in apiResult) || apiResult.delivery !== 'queued') &&
          !skipInjection
        ) {
          reconcileOptimisticEntry(
            targetConvId,
            optimisticMessageId,
            apiResult.userMessage,
          );
        }
        if (targetConvId) {
          const store = useStore.getState();
          if (memoryContextLevel === 'off') {
            store.clearMemoryCapsule(targetConvId);
          } else if (
            memoryCapsule !== undefined ||
            ('delivery' in apiResult && !!apiResult.delivery)
          ) {
            store.setMemoryCapsule(targetConvId, {
              level: memoryContextLevel,
              capsule: memoryCapsule ?? '',
            });
          }
        }

        // For new conversations, seed the transcript cache with the optimistic entry
        // only if the transcript cache is still empty (auto-navigation may have
        // already triggered a fetch that populated the cache with the server's copy,
        // in which case injecting would produce a duplicate user prompt).
        if ((wasAutoCreated || !conversation_id) && targetConvId) {
          const cached = queryClient.getQueryData(transcriptKey(targetConvId));
          if (!cached) {
            injectOptimisticEntry(targetConvId, optimisticEntry);
          }
        }

        queryClient.invalidateQueries({ queryKey: convsQueryKey });

        // Navigate to the auto-created conversation if user hasn't moved away
        if (conversationIdLearnedFromResponse && targetConvId) {
          const currentConvId =
            useStore.getState().activeConvByProject[folderKey] ?? null;
          const deliberatelyBlank =
            useStore.getState().composingNewConversationByProject[folderKey] ===
            true;
          if (
            !deliberatelyBlank &&
            (currentConvId === null || currentConvId === targetConvId)
          ) {
            setPendingNewConversationEntry(null);
            freshConversationIdRef.current = targetConvId;
            setActiveConvId(targetConvId);
          }
        }
        return apiResult;
      } catch (err) {
        // Other 404s (Objective/Project not found) are ordinary API errors.
        const conversationMissing = isConversationNotFoundError(err);
        // Remove the optimistic entry on failure by invalidating the transcript
        if (activeConvIdToUse && delivery !== 'steer') {
          discardFailedOptimisticEntry(activeConvIdToUse, optimisticMessageId);
        }
        const staleSelectionCleared =
          conversationMissing && !!activeConvIdToUse
            ? forgetMissingConversation(activeConvIdToUse)
            : false;
        if (
          activeConvIdToUse &&
          delivery !== 'steer' &&
          !staleSelectionCleared
        ) {
          queryClient.invalidateQueries({
            queryKey: transcriptKey(activeConvIdToUse),
          });
        }
        // An HTTP error response means the server refused the message, so the
        // caller can hand the text back to the composer. A network error or
        // timeout may still have delivered it and is never restored.
        const sendRejected =
          !conversationMissing && !!onSendRejected && err instanceof ApiError;
        // Only show toast for API errors (e.g. 409 conflict), not network timeouts.
        // The POST is long-running and may timeout while streaming works fine via WebSocket.
        if (conversationMissing && onConversationMissing) {
          onConversationMissing(staleSelectionCleared);
        } else if (conversationMissing) {
          toast.error(
            missingConversationPromptNotice(queuedFallbackBatch?.length),
          );
        } else if (err instanceof Error && !(err instanceof TypeError)) {
          toast.error(err.message);
        }
        if (sendRejected) onSendRejected();
        if (activeConvIdToUse && queuedFallbackBatch?.length) {
          useStore.setState((state) => {
            const current = state.queuedPromptsByConv[activeConvIdToUse] ?? [];
            // A rejected send returns to the composer, which now owns the
            // text; keeping the browser queue copy would send it twice.
            const reconciled =
              conversationMissing || sendRejected
                ? discardQueuedPromptBatch(current, queuedFallbackBatch)
                : releaseQueuedPromptBatchForDrain(
                    current,
                    queuedFallbackBatch,
                  );
            const nextQueues = { ...state.queuedPromptsByConv };
            if (reconciled.length > 0) {
              nextQueues[activeConvIdToUse] = reconciled;
            } else {
              delete nextQueues[activeConvIdToUse];
            }
            return { queuedPromptsByConv: nextQueues };
          });
        }
        if (!conversation_id) setPendingNewConversationEntry(null);
        return conversationMissing ? CONVERSATION_MISSING_FAILURE : undefined;
      } finally {
        if (!keepSendingUntilCompletion) {
          setSendingByConv((prev) => {
            const next = { ...prev };
            delete next[conversationKey];
            // If this send originated from the New composer, clear the temporary
            // key too in case WS auto-navigation never transferred it.
            delete next[NEW_CHAT_KEY];
            // Also clear the real conversation ID in case auto-navigation
            // transferred the sending state from NEW_CHAT_KEY.
            if (resolvedKey && resolvedKey !== conversationKey) {
              delete next[resolvedKey];
            }
            return next;
          });
        }
        setStopping(false);
        if (!isNative) {
          textareaRef.current?.focus();
        }
      }
    },
    [
      project_id,
      folderKey,
      queryClient,
      apiSendMsg,
      createAndSeedConversation,
      transcriptKey,
      convsQueryKey,
      setActiveConvId,
      injectOptimisticEntry,
      reconcileOptimisticEntry,
      discardFailedOptimisticEntry,
      forgetMissingConversation,
      clearCompletedStreamingForConv,
      runtimeSelection,
      currentSenderUserId,
      setPendingNewConversationEntry,
      effectiveLiveModeEnabled,
      liveModeSessionId,
      liveModeKind,
    ],
  );

  const insertDictatedPhrase = useCallback(
    (phrase: string) => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const insertion = dictatedTextInsertion(
        textarea.value,
        textarea.selectionStart ?? textarea.value.length,
        textarea.selectionEnd ??
          textarea.selectionStart ??
          textarea.value.length,
        phrase,
      );
      if (!insertion) return;
      textarea.setRangeText(
        insertion.text,
        insertion.start,
        insertion.end,
        'end',
      );
      autoResize();
    },
    [autoResize],
  );
  // Per-composer override of the account dictation language ('' = default).
  const [dictationLanguage, setDictationLanguage] = useState('');
  const dictationLanguageOptions = useSpeechLanguageOptions();
  // Microphone level for the recording animation; a ref so audio frames do
  // not re-render the composer.
  const micLevelRef = useRef(0);
  const setMicLevel = useCallback((rms: number) => {
    micLevelRef.current = rms;
  }, []);
  const dictation = useLiveVoice(false, insertDictatedPhrase, {
    useAccountDictationLanguage: true,
    language: dictationLanguage || undefined,
    onLevel: setMicLevel,
    minSpeechMs: DICTATION_MIN_SPEECH_MS,
  });
  useDictationFailureToast(dictation);
  // A model that takes audio gets the recording itself as a voice message
  // attachment; every other model gets dictated text.
  const selectedRuntimeHearsAudio = (
    selectedRuntimeModel?.bindings.find(
      (binding) => binding.harnessId === runtimeSelection?.harnessId,
    )?.capabilities ??
    selectedRuntimeModel?.capabilities ??
    []
  ).includes('audio');
  const voiceRecorder = useVoiceRecorder(setMicLevel);
  const voiceRecorderError = voiceRecorder.error;
  useEffect(() => {
    if (voiceRecorderError) toast.error(voiceRecorderError);
  }, [voiceRecorderError]);
  const stopVoiceRecording = voiceRecorder.stop;
  const finishVoiceMessage = useCallback(async () => {
    const recorded = await stopVoiceRecording();
    if (recorded) addFiles([recorded.file], [recorded.durationSeconds]);
  }, [stopVoiceRecording, addFiles]);
  const cancelVoiceRecording = voiceRecorder.cancel;
  useEffect(
    () => cancelVoiceRecording,
    [composerModeKey, cancelVoiceRecording],
  );
  const isRecordingVoice = voiceRecorder.recording;
  const isVoiceRecording = voiceRecorder.isRecording;
  // Changing the language stops capture (the hook restarts on option change);
  // resume it so the picker works mid-dictation.
  const resumeDictationRef = useRef(false);
  const dictationStart = dictation.start;
  useEffect(() => {
    if (!resumeDictationRef.current) return;
    resumeDictationRef.current = false;
    void dictationStart();
  }, [dictationLanguage, dictationStart]);
  const stopDictation = dictation.stop;
  useEffect(() => stopDictation, [composerModeKey, stopDictation]);
  const isDictating = dictation.capturing;
  const isDictationPending =
    !dictation.capturing && dictation.status === 'transcribing';
  const {
    state: meetingRecordingState,
    startRecording: startMeetingRecording,
    resumeRecording: resumeMeetingRecording,
    stopRecording: stopMeetingRecording,
    cancelRecording: cancelMeetingRecording,
    clearSession: clearMeetingSession,
  } = useMeetingRecording(project_id, activeConvId);
  const [showMeetingPanel, setShowMeetingPanel] = useState(false);

  const meetingLanguages = config?.meetingLanguages ?? [];
  // The server decides who may record (project owners and editors, and board
  // admins who bypass the project; viewers and chat-only users are refused), so
  // the composer follows its current answer rather than the cached project
  // list or auth user. Start and Resume wait for a response from a request that
  // began after the latest project change (board-role changes emit one too).
  const { data: serverAllowsMeeting, error: meetingAccessError } =
    useMeetingAccess(project_id, user?.id, !!user);
  // A 403 from the access check (removed from the project) is a definitive
  // refusal too; network and 5xx errors are not. TanStack keeps the previous
  // `data` beside a failed refetch, so the refusal must override a stale true.
  const meetingAccessLost =
    !!user &&
    (serverAllowsMeeting === false ||
      (meetingAccessError as { status?: unknown } | null)?.status === 403);
  const canRecordMeeting =
    !user || (serverAllowsMeeting === true && !meetingAccessLost);
  // Release the microphone when the server says access was lost mid-recording.
  useEffect(() => {
    if (meetingAccessLost && meetingRecordingState.isRecording) {
      void cancelMeetingRecording();
    }
  }, [
    meetingAccessLost,
    meetingRecordingState.isRecording,
    cancelMeetingRecording,
  ]);

  const handleStartMeetingRecording = useCallback(
    async (language: string) => {
      saveMeetingLanguage(language);
      let convId = activeConvId;
      if (!convId) {
        try {
          const conv = await apiCreateConv(
            hasRepo && use_worktree,
            worktreeBranch,
          );
          convId = conv.id;
          freshConversationIdRef.current = conv.id;
          setActiveConvId(conv.id);
          setComposingNewConv(false);
          queryClient.setQueryData<ConversationsData>(convsQueryKey, (old) => {
            if (!old) return { pages: [[conv]], pageParams: [0] };
            const pages = [...old.pages];
            pages[0] = [conv, ...(pages[0] ?? [])];
            return { ...old, pages };
          });
          queryClient.setQueryData<InfiniteData<TranscriptResponse>>(
            transcriptKey(conv.id),
            {
              pages: [
                {
                  _source: 'transcript',
                  entries: [],
                  total: 0,
                  hasMore: false,
                  nextOffset: undefined,
                },
              ],
              pageParams: [undefined],
            },
          );
        } catch (err) {
          console.error('Failed to create conversation for meeting:', err);
          toast.error('Failed to create conversation.');
          return;
        }
      }
      setShowMeetingPanel(true);
      await startMeetingRecording(convId, { language });
    },
    [
      activeConvId,
      apiCreateConv,
      hasRepo,
      use_worktree,
      worktreeBranch,
      setActiveConvId,
      queryClient,
      convsQueryKey,
      transcriptKey,
      startMeetingRecording,
      config?.meetingLanguages,
    ],
  );

  const handleNewConversationWithSameSettings = useCallback(() => {
    if (!activeConvId) return;

    const store = useStore.getState();
    const copiedLiveModeEnabled =
      store.liveModeEnabledByConversation[activeConvId] ?? liveModeEnabled;

    setComposingNewConv(true);
    const copiedMainSelection =
      activeConversation?.mainAiUserMode === 'persona' &&
      activeConversation.mainAiUserId
        ? {
            mode: 'persona' as const,
            aiUserId: activeConversation.mainAiUserId,
          }
        : activeConversation?.mainAiUserMode === 'none' ||
            activeConversation?.mainAiUserMode === 'persona'
          ? { mode: 'none' as const }
          : { mode: 'inherit' as const };
    setDraftAiUsers({
      mainSelection: copiedMainSelection,
      invitedAiUserIds: invitedAiUsers.map((aiUser) => aiUser.id),
      invitedAiUserIdsProvided: true,
    });
    setDraftContinuousPersonaLoop(
      activeConversation?.continuousPersonaLoop === true,
    );
    setDraftLiveModeEnabled(copiedLiveModeEnabled);
    setDraftLiveModeKind(liveModeKind);
    if (runtimeSelection) setRuntimeSelection({ ...runtimeSelection });

    // Keep the copied runtime when the active conversation becomes the blank
    // composer; the normal conversation-switch effect resets a plain New chat
    // to the project default.
    lastSyncedConvIdRef.current = null;
    lastSyncedWithCatalogRef.current = !!runtimeCatalog;
    setActiveConvId(null);
    store.setMemoryLevelForComposer(`${folderKey}:${NEW_CHAT_KEY}`, 'off');
    setUseWorktree(false);
    setWorktreeBranch(null);
    setDraftPromptCache1h(false);
    setShowMeetingPanel(false);
    clearMeetingSession();
  }, [
    activeConvId,
    clearMeetingSession,
    folderKey,
    invitedAiUsers,
    activeConversation,
    liveModeEnabled,
    liveModeKind,
    runtimeCatalog,
    runtimeSelection,
    setActiveConvId,
  ]);

  const handleStopMeetingRecording = useCallback(async () => {
    await stopMeetingRecording();
    queryClient.invalidateQueries({
      queryKey: queryKeys.artifacts.all(project_id),
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.artifacts.explorer(project_id),
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.artifacts.search(project_id),
    });
  }, [stopMeetingRecording, queryClient, project_id]);

  const handleResumeMeetingRecording = useCallback(async () => {
    if (!activeConvId || !canRecordMeeting) return;
    setShowMeetingPanel(true);
    await resumeMeetingRecording();
  }, [activeConvId, canRecordMeeting, resumeMeetingRecording]);

  const handleDismissMeetingPanel = useCallback(() => {
    setShowMeetingPanel(false);
    if (meetingRecordingState.isRecording) {
      void cancelMeetingRecording();
    } else {
      clearMeetingSession();
    }
  }, [
    cancelMeetingRecording,
    clearMeetingSession,
    meetingRecordingState.isRecording,
  ]);

  const handleMeetingAgentPrompt = useCallback(
    (prompt: string) => {
      setDraftMessage(prompt);
      setShowMeetingPanel(false);
    },
    [setDraftMessage],
  );

  // Also show the stop button when the DB conversation status is "working" but
  // chatRunningByConv has no entry (e.g., after a page refresh where the
  // chat_started WS event was never received, or when recovery failed without
  // emitting chat_completed). The stop endpoint force-clears orphaned DB rows
  // and broadcasts chat_completed, unblocking the conversation.
  const activeConvStatus = activeConvId
    ? activeConversation?.status
    : undefined;
  const hasWorkingLiveActivity = useStore(
    useCallback(
      (s) =>
        activeConvId
          ? s.liveModeRegistry.some(
              (item) =>
                item.projectId === project_id &&
                item.conversationId === activeConvId &&
                item.state === 'working',
            )
          : false,
      [activeConvId, project_id],
    ),
  );
  const isAgentRunning =
    chatRunning ||
    (hasStreamingContent && !isStreamingCompleted) ||
    activeConvStatus === 'working' ||
    // liveModeRegistry is an auxiliary, eventually-consistent surface. A
    // stale `working` activity must not keep the normal-chat Stop control
    // alive after the authoritative chat_completed event cleared the run.
    (liveModeEnabled && hasWorkingLiveActivity);
  const canSteerActiveTurn = Boolean(
    isAgentRunning && activeConvRunKey && !isStreamingCompleted,
  );

  const forkedMessage = useMemo(
    () =>
      forkFromMessageId
        ? (renderedMessages.find((m) => m.id === forkFromMessageId) ?? null)
        : null,
    [forkFromMessageId, renderedMessages],
  );

  // Puts a submitted composer back (text, attachments, deep links, memory
  // level) after the submission could not go through. Text typed meanwhile is
  // kept after the restored text; a memory level or deep links chosen meanwhile
  // win over the submitted ones.
  const restoreComposerContent = useCallback(
    (
      submission: {
        text: string;
        files: File[];
        durations: Array<number | undefined>;
        memoryContextLevel: MemoryContextLevel;
        deepLinks?: ChatDeepLink[];
      },
      target?: { draftKey: string; modeKey: string },
    ) => {
      const draftKey = target?.draftKey ?? draftKeyRef.current;
      const modeKey = target?.modeKey ?? composerModeKey;
      const store = useStore.getState();
      const currentDraft = (
        draftKey === draftKeyRef.current
          ? readDraft()
          : (store.draftByKey[draftKey] ?? '')
      ).trim();
      setDraftMessage(
        [submission.text, currentDraft]
          .filter((part) => part.length > 0)
          .join('\n\n'),
        draftKey,
      );
      addFiles(submission.files, submission.durations);
      const currentMemoryContextLevel =
        store.memoryLevelByComposerKey[modeKey] ?? 'off';
      const currentDeepLinks = store.draftDeepLinksByKey[draftKey];
      if (currentMemoryContextLevel === 'off' && !currentDeepLinks?.length) {
        store.setMemoryLevelForComposer(modeKey, submission.memoryContextLevel);
        if (submission.deepLinks?.length) {
          store.setDraftDeepLinksByKey(draftKey, submission.deepLinks);
        }
      }
    },
    [composerModeKey, readDraft, setDraftMessage, addFiles],
  );

  const forkSubmissionInFlightRef = useRef(false);

  const handleFork = useCallback(async () => {
    if (!activeConvId || !forkFromMessageId) return;
    // The composer keeps its content until the fork is created, so a repeat
    // submit while uploads or the fork request run must not start a second fork.
    if (forkSubmissionInFlightRef.current) return;
    // Reuse the normal composer: the fork prompt is whatever is in the draft,
    // with the user's selected agent, mode, and attachments. This fixes forks
    // replying with the wrong agent (the previous fork form ignored the agent
    // picker entirely) and lets the user attach files / switch mode for the fork.
    const text = readDraft().trim();
    if (!text && pendingAttachments.length === 0) return;

    forkSubmissionInFlightRef.current = true;
    setIsForkPending(true);
    try {
      const memoryContextLevel =
        useStore.getState().memoryLevelByComposerKey[composerModeKey] ?? 'off';
      const deepLinks =
        useStore.getState().draftDeepLinksByKey[draftKeyRef.current];
      const filesToUpload = pendingAttachments.map((a) => a.file);
      const attachmentDurations = pendingAttachments.map(
        (a) => a.durationSeconds,
      );
      // The user may switch conversations while uploads run; restore into the
      // composer this submission was typed under.
      const target = {
        draftKey: draftKeyRef.current,
        modeKey: composerModeKey,
      };
      const restoreSubmission = () =>
        restoreComposerContent(
          {
            text,
            files: filesToUpload,
            durations: attachmentDurations,
            memoryContextLevel,
            deepLinks,
          },
          target,
        );
      useStore.getState().setMemoryLevelForComposer(composerModeKey, 'off');
      clearDraft();
      clearAttachments();

      let payload: Awaited<ReturnType<typeof buildMessagePayload>>;
      try {
        payload = await buildMessagePayload(
          text,
          filesToUpload,
          attachmentDurations,
        );
        if (payload.failedUploads.length > 0) {
          throw new Error(
            describeFailedUploads(payload.failedUploads, filesToUpload.length),
          );
        }
      } catch (error) {
        // No fork is created when any attachment is missing.
        toast.error(
          `Failed to upload attachment${filesToUpload.length === 1 ? '' : 's'}: ${error instanceof Error ? error.message : String(error)}`,
        );
        restoreSubmission();
        return;
      }

      let forkCreated = false;
      try {
        const result = await apiForkConv(
          activeConvId,
          forkFromMessageId,
          forkIncludeAssistantTurn || undefined,
        );
        forkCreated = true;

        // Seed the new conversation's transcript cache with the inherited history.
        // This prevents a blank screen during the first fetch and ensures the
        // prompt appears immediately in the correct context.
        const sourceData = queryClient.getQueryData<
          InfiniteData<TranscriptResponse>
        >(transcriptKey(activeConvId));
        if (sourceData) {
          let foundForkPoint = false;
          const slicedPages = sourceData.pages.map((page) => {
            if (foundForkPoint) return page;

            const idx = page.entries.findIndex((e) => {
              if ('id' in e && e.id === forkFromMessageId) return true;
              if (
                forkedMessage &&
                'role' in e &&
                e.role === forkedMessage.role &&
                'created_at' in e &&
                e.created_at === forkedMessage.created_at
              )
                return true;
              return false;
            });
            if (idx === -1) {
              return { ...page, entries: [] };
            }

            foundForkPoint = true;
            // Forking "after an assistant turn" anchors on the preceding USER
            // message and includes the assistant reply that follows it. Extend
            // the in-page slice through the consecutive assistant entries after
            // the anchor until the next user message.
            let end = idx;
            if (forkIncludeAssistantTurn) {
              for (let i = idx + 1; i < page.entries.length; i++) {
                const e = page.entries[i] as any;
                const role = (e && 'role' in e && e.role) || '';
                if (role === 'assistant') end = i;
                else if (role === 'user') break;
              }
            }
            return {
              ...page,
              entries: page.entries.slice(0, end + 1),
            };
          });

          // Filter out empty pages
          const activePages = slicedPages.filter((p) => p.entries.length > 0);

          if (activePages.length > 0) {
            // Append the fork prompt optimistically so it shows immediately in
            // the new conversation, alongside the inherited history.
            const optimisticEntry: TranscriptEntry = {
              id: `temp-${Date.now()}`,
              type: 'message' as const,
              role: 'user' as const,
              content: payload.bubbleContent,
              created_at: new Date().toISOString(),
              attachments: payload.attachments,
              senderUserId: currentSenderUserId,
            };
            activePages[0] = {
              ...activePages[0],
              entries: [...activePages[0].entries, optimisticEntry],
            };
            // The source pages' offsets count turns from the source's newest
            // turn, which the fork drops. Older inherited turns stay reachable by
            // paging from the number of turns seeded here (the server counts a
            // turn per user entry).
            const lastPage = activePages[activePages.length - 1];
            activePages[activePages.length - 1] = {
              ...lastPage,
              nextOffset: activePages.reduce(
                (turns, page) =>
                  turns +
                  page.entries.filter((e) => 'role' in e && e.role === 'user')
                    .length,
                0,
              ),
            };

            queryClient.setQueryData(transcriptKey(result.id), {
              pages: activePages,
              pageParams: sourceData.pageParams.slice(0, activePages.length),
            });
          }
        }

        queryClient.invalidateQueries({ queryKey: convsQueryKey });
        setActiveConvId(result.id);
        setForkFromMessageId(null);
        setForkIncludeAssistantTurn(false);

        // Send the first message to the forked conversation using the agent +
        // mode the user selected in the normal composer. We already injected the
        // optimistic entry above, so skip injection inside sendPreparedMessage.
        await sendPreparedMessage(
          payload.content,
          payload.bubbleContent,
          result.id,
          payload.attachments,
          agentCmdOverride,
          effectiveChatModeOverride,
          runtimeSelection ?? undefined,
          true,
          undefined,
          undefined,
          memoryContextLevel,
        );
      } catch (err) {
        toast.error(
          `Failed to fork: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Once the fork exists the prompt belongs to the new conversation.
        if (!forkCreated) restoreSubmission();
      }
    } finally {
      forkSubmissionInFlightRef.current = false;
      setIsForkPending(false);
    }
  }, [
    activeConvId,
    forkFromMessageId,
    forkIncludeAssistantTurn,
    forkedMessage,
    apiForkConv,
    queryClient,
    transcriptKey,
    convsQueryKey,
    setActiveConvId,
    sendPreparedMessage,
    readDraft,
    clearDraft,
    pendingAttachments,
    clearAttachments,
    restoreComposerContent,
    buildMessagePayload,
    currentSenderUserId,
    agentCmdOverride,
    effectiveChatModeOverride,
    composerModeKey,
  ]);

  const handleSend = useCallback(
    async (
      delivery?: 'steer' | 'queue',
      attachmentOverride?: PendingAttachment[],
      textOverride?: string,
    ) => {
      // Sending ends dictation so a late phrase cannot land in the next draft.
      if (isDictating || isDictationPending) stopDictation();
      // Sending while a voice message records sends that recording too.
      if (isVoiceRecording()) {
        const recorded = await stopVoiceRecording();
        if (recorded && forkFromMessageId) {
          addFiles([recorded.file], [recorded.durationSeconds]);
          return;
        }
        if (recorded) {
          attachmentOverride = [
            ...(attachmentOverride ?? pendingAttachments),
            {
              file: recorded.file,
              previewUrl: URL.createObjectURL(recorded.file),
              durationSeconds: recorded.durationSeconds,
            },
          ];
        }
      }
      // If a fork point is selected, the normal composer submit triggers a fork
      // instead of a regular send — same form, but the drafted text becomes the
      // fork prompt and the selected agent / attachments / mode apply to the fork.
      if (forkFromMessageId) {
        await handleFork();
        return;
      }
      const text = (textOverride ?? readDraft()).trim();
      const attachmentsToSend = attachmentOverride ?? pendingAttachments;
      if (!text && attachmentsToSend.length === 0) return;

      const codexThreadId =
        !objective_id && attachmentsToSend.length === 0
          ? codexThreadIdFromDeepLink(text)
          : null;
      if (codexThreadId) {
        setSendingByConv((previous) => ({
          ...previous,
          [NEW_CHAT_KEY]: true,
        }));
        try {
          const result = await importCodexThread(project_id, text);
          clearDraft();
          setComposingNewConv(false);
          setActiveConvId(result.conversation.id);
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: convsQueryKey }),
            queryClient.invalidateQueries({
              queryKey: transcriptKey(result.conversation.id),
            }),
          ]);
          toast.success(
            result.imported
              ? 'Codex conversation imported'
              : 'Opened the previously imported Codex conversation',
          );
        } catch (error) {
          toast.error(
            error instanceof Error
              ? error.message
              : `Could not import Codex thread ${codexThreadId}`,
          );
        } finally {
          setSendingByConv((previous) => {
            const next = { ...previous };
            delete next[NEW_CHAT_KEY];
            return next;
          });
        }
        return;
      }

      // Conversation selection lives in Zustand and changes synchronously, while
      // this callback is replaced only on React's next render. Read the current
      // selection at submit time so a quick conversation/project switch followed
      // by Enter cannot send through the previous render's conversation ID.
      const selectedConversationId =
        useStore.getState().activeConvByProject[folderKey] ?? null;
      // Until the first conversation has an ID, another submission would be
      // interpreted as a second new chat. Keep the typed follow-up in the
      // composer until the optimistic first turn has been transferred. The
      // same reservation applies while a prior submission is still awaiting
      // dead-selection validation or creating its fresh conversation.
      if (
        (!selectedConversationId &&
          (pendingNewConversationEntry ||
            pendingSelectionValidationRef.current.has(NEW_CHAT_KEY))) ||
        (selectedConversationId &&
          pendingSelectionValidationRef.current.has(selectedConversationId))
      )
        return;
      const memoryContextLevel =
        useStore.getState().memoryLevelByComposerKey[composerModeKey] ?? 'off';
      const openFileContext = snapshotOpenFileContext(selectedConversationId);

      const deepLinks =
        useStore.getState().draftDeepLinksByKey[draftKeyRef.current];
      const filesToUpload = attachmentsToSend.map((a) => a.file);
      const attachmentDurations = attachmentsToSend.map(
        (a) => a.durationSeconds,
      );
      // Tracks whether this submission owns the fresh-conversation
      // reservation (NEW_CHAT_KEY). Only the owner may release it; a restore
      // triggered while another submission holds the reservation must leave
      // that reservation intact.
      let ownsFreshConversationReservation = false;
      // Restores into the current composer by default. After a dead
      // conversation selection was reset, the blank composer is a different
      // draft/mode key than the one this submission was typed under.
      const restoreComposerSubmission = (target?: {
        draftKey: string;
        modeKey: string;
      }) => {
        // A submission restored here gives up the fresh-conversation
        // reservation it may have held — but only its own. Another
        // submission's reservation must survive this restore.
        if (ownsFreshConversationReservation) {
          pendingSelectionValidationRef.current.delete(NEW_CHAT_KEY);
          ownsFreshConversationReservation = false;
        }
        restoreComposerContent(
          {
            text,
            files: filesToUpload,
            durations: attachmentDurations,
            memoryContextLevel,
            deepLinks,
          },
          target,
        );
      };
      useStore.getState().setMemoryLevelForComposer(composerModeKey, 'off');
      // A spoken phrase must not discard text the user is typing meanwhile.
      if (textOverride === undefined) clearDraft();
      clearAttachments();

      let conversation_id = selectedConversationId ?? undefined;
      // A remembered (localStorage) or deep-linked selection that this page
      // session has not yet seen live could be dead (e.g. after a board
      // reload). Do not submit the raw id while its validation is still in
      // flight: await the same detail query the validation effect uses, and
      // on a 404 silently drop the dead selection and send as a new
      // conversation instead of producing the dead-conversation fallback on
      // a chat that looks brand-new. Selections already seen live keep their
      // send-time fallback (typed-text restore + toast). Non-404 failures
      // keep the previous behavior: the send proceeds and the server decides.
      if (
        conversation_id &&
        seenActiveConvInListRef.current !== conversation_id
      ) {
        // Reserve the validation so a concurrent submission cannot race the
        // dead-selection transition while this await is in flight.
        pendingSelectionValidationRef.current.add(conversation_id);
        try {
          await queryClient.fetchQuery({
            queryKey: ['conversation-detail', project_id, conversation_id],
            queryFn: () => fetchConversation(project_id, conversation_id!),
            staleTime: 10_000,
            retry: false,
          });
          seenActiveConvInListRef.current = conversation_id;
          pendingSelectionValidationRef.current.delete(conversation_id);
        } catch (error) {
          if (error instanceof ApiError && isConversationNotFoundError(error)) {
            const selectionAtValidation =
              useStore.getState().activeConvByProject[folderKey] ?? null;
            if (
              (selectionAtValidation &&
                selectionAtValidation !== conversation_id) ||
              (!selectionAtValidation &&
                (pendingNewConversationEntry ||
                  pendingSelectionValidationRef.current.has(NEW_CHAT_KEY)))
            ) {
              // This submission no longer owns the selection transition: the
              // user switched to another conversation while validation was in
              // flight, or another submission already owns the fresh
              // conversation. Do not clobber that state; restore this message
              // into the current composer instead.
              pendingSelectionValidationRef.current.delete(conversation_id);
              restoreComposerSubmission();
              return;
            }
            // Preserve the picker selection and the composer content across
            // this automatic transition (same pattern as the automatic-clear
            // effect and forgetMissingConversation); this submission's typed
            // text is carried by the new-conversation optimistic entry below.
            pendingSelectionValidationRef.current.delete(conversation_id);
            pendingSelectionValidationRef.current.add(NEW_CHAT_KEY);
            ownsFreshConversationReservation = true;
            lastSyncedConvIdRef.current = null;
            lastSyncedWithCatalogRef.current = !!runtimeCatalog;
            useStore
              .getState()
              .saveDraftByKey(newConversationDraftKey, readDraft());
            setComposingNewConv(true);
            setActiveConvId(null);
            seenActiveConvInListRef.current = null;
            conversation_id = undefined;
          } else {
            // Non-404 failures keep the previous behavior: the send proceeds
            // and the server decides.
            pendingSelectionValidationRef.current.delete(conversation_id);
          }
        }
      }
      if (!conversation_id && filesToUpload.length > 0) {
        try {
          const conv = await createAndSeedConversation(
            agentCmdOverride,
            runtimeSelection ?? undefined,
            effectiveChatModeOverride,
          );
          conversation_id = conv.id;
          pendingSelectionValidationRef.current.delete(NEW_CHAT_KEY);
          ownsFreshConversationReservation = false;
        } catch (err) {
          console.error('Failed to create conversation for attachments:', err);
          toast.error('Failed to create conversation.');
          restoreComposerSubmission();
          return;
        }
      }

      let payload: {
        content: string;
        bubbleContent: string;
        attachments?: ChatMessageAttachment[];
        failedUploads: FailedUpload[];
      };
      try {
        payload = await buildMessagePayload(
          text,
          filesToUpload,
          attachmentDurations,
          conversation_id,
        );
        if (payload.failedUploads.length > 0) {
          throw new Error(
            describeFailedUploads(payload.failedUploads, filesToUpload.length),
          );
        }
      } catch (error) {
        toast.error(
          `Failed to upload attachment${filesToUpload.length === 1 ? '' : 's'}: ${error instanceof Error ? error.message : String(error)}`,
        );
        restoreComposerSubmission();
        return;
      }

      const conversationKey = conversation_id ?? NEW_CHAT_KEY;

      // If the agent is still running, steer the active harness by default. The
      // server falls back to queueing only when that harness cannot accept an
      // in-flight update.
      const storeAtSubmit = useStore.getState();
      const selectedStreamKey = conversation_id
        ? storeAtSubmit.activeStreamKeyByConv[conversation_id]
        : undefined;
      const selectedStreamHasContent = selectedStreamKey
        ? !!storeAtSubmit.chatStreamingOutput[selectedStreamKey]
        : false;
      const selectedStreamCompleted = selectedStreamKey
        ? !!storeAtSubmit.chatStreamingCompleted[selectedStreamKey]
        : false;
      const selectedConversationStatus =
        conversation_id && activeConversation?.id === conversation_id
          ? activeConversation.status
          : undefined;
      const selectedAgentRunning =
        !!conversation_id &&
        (!!sendingByConv[conversationKey] ||
          !!storeAtSubmit.chatRunningByConv[conversation_id] ||
          (selectedStreamHasContent && !selectedStreamCompleted) ||
          selectedConversationStatus === 'working');
      const activeDelivery =
        delivery ?? (effectiveLiveModeEnabled ? 'steer' : 'queue');
      if (selectedAgentRunning) {
        if (activeDelivery === 'steer') {
          const steeringSubmissionKey = `${folderKey}:${conversation_id}`;
          if (
            steeringSubmissionInFlightRef.current.has(steeringSubmissionKey)
          ) {
            // The composer is cleared before the running-turn branch is known.
            // Restore this repeat submission instead of creating another local
            // bubble and another browser-owned queued prompt.
            restoreComposerSubmission();
            return;
          }
          const localSteeringId = crypto.randomUUID();
          const steeringStreamKey = selectedStreamKey ?? activeConvRunKey;
          if (!steeringStreamKey) {
            toast.error(
              'The active turn is not ready to receive steering yet.',
            );
            restoreComposerSubmission();
            return;
          }
          steeringSubmissionInFlightRef.current.add(steeringSubmissionKey);
          const currentTurnMessages = renderedMessagesRef.current;
          const lastUserIndex = currentTurnMessages.findLastIndex(
            (item) => item.role === 'user',
          );
          // Only a persona response of the current turn (after the latest
          // human message) may own steering. A stale streaming row from an
          // earlier round must never receive new human messages.
          const activePersonaTarget = currentTurnMessages
            .slice(lastUserIndex + 1)
            .findLast(
              (item) =>
                item.role === 'assistant' &&
                item.streaming === true &&
                personaSenderId(item) !== null,
            );
          // Once the active response has reconciled into the transcript, its
          // generic stream owner is deliberately hidden. Anchor steering to
          // that visible canonical assistant so the pending acknowledgement
          // never disappears with the hidden stream.
          const steeringTarget =
            activePersonaTarget ??
            (!shouldShowStreamingBubble && lastUserIndex >= 0
              ? currentTurnMessages
                  .slice(lastUserIndex + 1)
                  .findLast((item) => item.role === 'assistant')
              : undefined);
          const steeringSplitOffset =
            steeringTarget?.content.length ??
            storeAtSubmit.chatStreamingOutput[steeringStreamKey]?.length ??
            0;
          setInFlightSteeringMessages((current) => [
            ...current,
            {
              localId: localSteeringId,
              conversationId: conversation_id!,
              streamKey: steeringStreamKey,
              content: payload.bubbleContent,
              attachments: payload.attachments,
              createdAt: new Date().toISOString(),
              delivery: 'pending',
              splitOffset: steeringSplitOffset,
              targetMessageId: steeringTarget?.id,
            },
          ]);
          justSentRef.current = true;
          let result;
          let steerRejected = false;
          try {
            result = await sendPreparedMessage(
              payload.content,
              payload.bubbleContent,
              conversation_id,
              payload.attachments,
              agentCmdOverride,
              effectiveChatModeOverride,
              runtimeSelection ?? undefined,
              true,
              'steer',
              deepLinks,
              'off',
              undefined,
              undefined,
              undefined,
              undefined,
              openFileContext,
              localSteeringId,
              undefined,
              () => {
                steerRejected = true;
                restoreComposerSubmission();
              },
            );
          } finally {
            steeringSubmissionInFlightRef.current.delete(steeringSubmissionKey);
          }
          setInFlightSteeringMessages((current) =>
            current.flatMap((message) => {
              if (message.localId !== localSteeringId) return message;
              // The server refused the steer; the text is back in the composer.
              if (steerRejected) return [];
              const steeringBoundary = (
                result as
                  | {
                      steeringBoundary?: {
                        streamKey: string;
                        contentOffset: number;
                        targetMessageId?: string;
                      };
                    }
                  | undefined
              )?.steeringBoundary;
              const resolvedDelivery = (
                result as
                  | { delivery?: 'pending' | 'steered' | 'queued' }
                  | undefined
              )?.delivery;
              // A rejected steering attempt is owned by the normal queue that
              // sendPreparedMessage restored. Do not leave a second footer
              // bubble claiming that queued prompt as steering state.
              if (resolvedDelivery === 'queued') return [];
              return {
                ...message,
                serverId: result?.userMessage?.id,
                streamKey: steeringBoundary?.streamKey ?? message.streamKey,
                delivery: steeringDeliveryFromResponse(resolvedDelivery),
                splitOffset:
                  steeringBoundary?.contentOffset ?? message.splitOffset,
                targetMessageId:
                  steeringBoundary?.targetMessageId ?? message.targetMessageId,
              };
            }),
          );
          return;
        }
        if (
          effectiveLiveModeEnabled &&
          streamPersonaDriven &&
          conversation_id
        ) {
          // Autonomous persona discussions do not reach an idle flush point.
          // Establish stable browser ownership before asking the server to
          // take the turn at the next persona boundary. Suppressing optimistic
          // transcript injection keeps it below the in-flight response; a lost
          // acknowledgement leaves this exact ID available for safe retry.
          const pendingPersonaSubmission: QueuedPrompt = {
            id: crypto.randomUUID(),
            contextKey: folderKey,
            content: payload.content,
            bubbleContent: payload.bubbleContent,
            draftContent: text,
            conversation_id,
            attachments: payload.attachments,
            agent_cmd: agentCmdOverride,
            chat_mode: effectiveChatModeOverride ?? undefined,
            runtimeSelection: runtimeSelection ?? undefined,
            deepLinks,
            memoryContextLevel,
            openFileContext,
            awaitingAcknowledgement: true,
            liveMode: effectiveLiveModeEnabled,
            liveModeSessionId,
            liveModeKind,
          };
          useStore
            .getState()
            .enqueuePrompt(conversation_id, pendingPersonaSubmission);
          await sendPreparedMessage(
            payload.content,
            payload.bubbleContent,
            conversation_id,
            payload.attachments,
            agentCmdOverride,
            effectiveChatModeOverride,
            runtimeSelection ?? undefined,
            true,
            'queue',
            deepLinks,
            memoryContextLevel,
            effectiveLiveModeEnabled,
            liveModeSessionId,
            liveModeKind,
            [pendingPersonaSubmission],
            openFileContext,
          );
          return;
        }
        useStore.getState().enqueuePrompt(conversationKey, {
          id: crypto.randomUUID(),
          contextKey: folderKey,
          content: payload.content,
          bubbleContent: payload.bubbleContent,
          draftContent: text,
          conversation_id,
          attachments: payload.attachments,
          agent_cmd: agentCmdOverride,
          chat_mode: effectiveChatModeOverride ?? undefined,
          runtimeSelection: runtimeSelection ?? undefined,
          deepLinks,
          memoryContextLevel,
          openFileContext,
        });
        return;
      }

      // Mark actual sends as pending. Queuing is only a local store update and must
      // leave the composer available for more queued prompts or steering messages.
      setSendingByConv((prev) => ({ ...prev, [conversationKey]: true }));
      justSentRef.current = true;

      // Retain one stable browser-owned copy until the server acknowledges
      // ownership. If the POST is processed but its response is lost, the
      // completion path can safely retry this same submission ID; the route
      // recognizes an already-canonical turn and will not start it twice.
      const pendingSubmission: QueuedPrompt | undefined =
        conversation_id && !objective_id
          ? {
              id: crypto.randomUUID(),
              contextKey: folderKey,
              content: payload.content,
              bubbleContent: payload.bubbleContent,
              draftContent: text,
              conversation_id,
              attachments: payload.attachments,
              agent_cmd: agentCmdOverride,
              chat_mode: effectiveChatModeOverride ?? undefined,
              runtimeSelection: runtimeSelection ?? undefined,
              deepLinks,
              memoryContextLevel,
              awaitingAcknowledgement: true,
              openFileContext,
            }
          : undefined;
      if (pendingSubmission) {
        useStore.getState().enqueuePrompt(conversation_id!, pendingSubmission);
      }

      await sendPreparedMessage(
        payload.content,
        payload.bubbleContent,
        conversation_id,
        payload.attachments,
        agentCmdOverride,
        effectiveChatModeOverride,
        runtimeSelection ?? undefined,
        undefined,
        undefined,
        deepLinks,
        memoryContextLevel,
        undefined,
        undefined,
        undefined,
        pendingSubmission ? [pendingSubmission] : undefined,
        openFileContext,
        pendingSubmission?.id,
        (staleSelectionCleared) => {
          // The server refused the conversation, so nothing was sent. Return
          // the text to the composer rather than silently starting another
          // conversation: auto-resending could duplicate a message whose
          // response was lost.
          restoreComposerSubmission(
            staleSelectionCleared
              ? {
                  draftKey: newConversationDraftKey,
                  modeKey: `${folderKey}:${NEW_CHAT_KEY}`,
                }
              : undefined,
          );
          toast.error(
            'That conversation no longer exists — your message was restored; send again to start a new conversation.',
          );
        },
        restoreComposerSubmission,
      );
    },
    [
      readDraft,
      clearDraft,
      pendingAttachments,
      clearAttachments,
      addFiles,
      restoreComposerContent,
      buildMessagePayload,
      createAndSeedConversation,
      activeConvId,
      folderKey,
      activeConversation,
      setSendingByConv,
      sendingByConv,
      isAgentRunning,
      streamPersonaDriven,
      sendPreparedMessage,
      scrollToBottom,
      agentCmdOverride,
      effectiveChatModeOverride,
      runtimeSelection,
      liveModeEnabled,
      effectiveLiveModeEnabled,
      liveModeSessionId,
      liveModeKind,
      objective_id,
      forkFromMessageId,
      handleFork,
      composerModeKey,
      isDictating,
      isDictationPending,
      stopDictation,
      isVoiceRecording,
      stopVoiceRecording,
      activeConvRunKey,
      setDraftMessage,
      shouldShowStreamingBubble,
      project_id,
      queryClient,
      convsQueryKey,
      transcriptKey,
      setComposingNewConv,
      setActiveConvId,
      pendingNewConversationEntry,
      fetchConversation,
      runtimeCatalog,
    ],
  );

  // Stable ref so handleQuestionAnswer doesn't need isAgentRunning in its dep array.
  // Without this, isAgentRunning changing (e.g. when streaming starts/stops) creates
  // a new handleQuestionAnswer reference on every chunk, breaking React.memo() on all
  // ChatMessageBubbles that receive it as the onSendMessage prop.
  const isAgentRunningRef = useRef(isAgentRunning);

  isAgentRunningRef.current = isAgentRunning;

  // The transcript is not an aria-live region (per-token announcements would
  // be unreadable); announce only when a response starts and finishes.
  const [runAnnouncement, setRunAnnouncement] = useState('');
  const wasAgentRunningRef = useRef(false);
  useEffect(() => {
    if (isAgentRunning && !wasAgentRunningRef.current) {
      setRunAnnouncement('Assistant is responding');
    } else if (!isAgentRunning && wasAgentRunningRef.current) {
      setRunAnnouncement('Response complete');
    }
    wasAgentRunningRef.current = isAgentRunning;
  }, [isAgentRunning]);

  // The agent that asked a pending question is the one that last ran in this
  // conversation (persisted as last_agent_cmd at run start). Track it in a ref
  // so answering a question card resumes that exact agent/session, regardless of
  // the agent picker — which the auto-select effect may have reset to the
  // default. Using a ref keeps handleQuestionAnswer referentially stable (see
  // the note above) so it doesn't churn React.memo on every message bubble.
  const askingAgentRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    askingAgentRef.current = activeConversation?.last_agent_cmd || undefined;
  }, [activeConversation]);

  /** Send a text answer from an interactive question card */
  const handleQuestionAnswer = useCallback(
    (text: string, submission?: QuestionSubmission) => {
      const conversation_id = activeConvId ?? undefined;
      if (conversation_id && submission?.codexRequestId && submission.answers) {
        return apiAnswerCodexInput(
          conversation_id,
          submission.codexRequestId,
          submission.answers,
          text,
        )
          .then(() => clearStalledWarning(conversation_id))
          .catch((err) => {
            if (err instanceof ApiError && err.status === 409) {
              // Compatibility/recovery path: an older Board or a restart may
              // have closed the pending turn. Submit the answer as a new turn;
              // the native Codex thread and Plan mode still resume normally.
              clearStalledWarning(conversation_id);
              void sendPreparedMessage(
                text,
                text,
                conversation_id,
                undefined,
                askingAgentRef.current ?? agentCmdOverride,
                'plan',
              );
              return;
            }
            toast.error(err instanceof Error ? err.message : String(err));
            // Rethrow so the question card unlocks and the user can resend.
            throw err;
          });
      }
      void sendPreparedMessage(
        text,
        text,
        conversation_id,
        undefined,
        askingAgentRef.current ?? agentCmdOverride,
        effectiveChatModeOverride,
      );
    },
    [
      activeConvId,
      apiAnswerCodexInput,
      sendPreparedMessage,
      clearStalledWarning,
      agentCmdOverride,
      effectiveChatModeOverride,
    ],
  );

  const handleImplementPlan = useCallback(
    (artifactPath: string) => {
      const conversation_id = activeConvId ?? undefined;
      if (!conversation_id) return;
      const prompt =
        `The plan was saved to @${artifactPath}. The user approved this plan. ` +
        'Implement it now. Follow it as the implementation specification, make the required changes, and run the relevant checks.';
      setChatModeOverride('code');
      queryClient.invalidateQueries({
        queryKey: queryKeys.artifacts.all(project_id),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.artifacts.explorer(project_id),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.artifacts.search(project_id),
      });
      void sendPreparedMessage(
        prompt,
        `Start implementing @${artifactPath}`,
        conversation_id,
        undefined,
        askingAgentRef.current ?? agentCmdOverride,
        'code',
      );
    },
    [
      activeConvId,
      agentCmdOverride,
      project_id,
      queryClient,
      sendPreparedMessage,
      setChatModeOverride,
    ],
  );

  const handleSendPlanToKanban = useCallback(
    async ({ artifactPath, planTitle, planText }: PlanKanbanAction) => {
      try {
        const savedPlan = await fetchPlanArtifactText(project_id, artifactPath);
        const resolvedPlanText = savedPlan.trim() || planText?.trim() || '';
        if (!resolvedPlanText) {
          throw new Error('The saved plan is empty');
        }
        const taskInput = planKanbanTask({
          artifactPath,
          planTitle,
          planText: resolvedPlanText,
        });
        const task = await createTask(project_id, {
          ...taskInput,
          author: 'user',
          custom_values: { planArtifactPath: artifactPath },
        });
        if (activeConvId) {
          await apiResolvePending(activeConvId);
          queryClient.setQueryData<ConversationsData>(convsQueryKey, (old) =>
            old
              ? {
                  ...old,
                  pages: old.pages.map((page) =>
                    page.map((conversation) =>
                      conversation.id === activeConvId
                        ? {
                            ...conversation,
                            status: 'idle',
                            lastAssistantOutcome: 'success',
                          }
                        : conversation,
                    ),
                  ),
                }
              : old,
          );
          queryClient.setQueryData<AttentionResponse>(
            queryKeys.attention.all,
            (old) => markConversationViewedInAttention(old, activeConvId),
          );
        }
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: queryKeys.tasks.all(project_id),
          }),
          queryClient.invalidateQueries({ queryKey: convsQueryKey }),
          queryClient.invalidateQueries({ queryKey: queryKeys.attention.all }),
          queryClient.invalidateQueries({
            queryKey: queryKeys.projects.statusSummary,
          }),
          ...(objective_id
            ? [
                queryClient.invalidateQueries({
                  queryKey: queryKeys.objectives.all(project_id),
                }),
              ]
            : []),
        ]);
        toast.success(`Added “${task.title}” to Kanban`);
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : 'Could not create task',
        );
        throw error;
      }
    },
    [
      activeConvId,
      apiResolvePending,
      convsQueryKey,
      objective_id,
      project_id,
      queryClient,
    ],
  );

  // ─── Retry last prompt on error ──────────────────────────────────────────
  // The most recent user message in the transcript — re-sent verbatim when the
  // last response failed.
  const lastUserPrompt = useMemo(() => {
    for (let i = renderedMessages.length - 1; i >= 0; i--) {
      if (renderedMessages[i].role === 'user') return renderedMessages[i];
    }
    return transcriptTurnContext.lastUserPrompt
      ? ({
          id: transcriptTurnContext.lastUserPrompt.id,
          role: 'user' as const,
          content: transcriptTurnContext.lastUserPrompt.content,
        } as RenderItem)
      : null;
  }, [renderedMessages, transcriptTurnContext.lastUserPrompt]);

  // Error responses are emitted with a leading "⚠️" marker. After a failed run
  // the error sits in the (completed) streaming bubble, so retain its content
  // to determine whether a model-availability error followed partial output.
  const streamedErrorContent = useStore(
    useCallback(
      (s: { chatStreamingOutput: Record<string, string> }) =>
        streamKey ? s.chatStreamingOutput[streamKey] || '' : '',
      [streamKey],
    ),
  );
  const streamEndedInError = isErrorMessageContent(streamedErrorContent);
  const persistedLastResponse = renderedMessages.at(-1);
  const lastErrorContent = streamEndedInError
    ? streamedErrorContent
    : persistedLastResponse?.role === 'assistant' &&
        persistedLastResponse.isError
      ? persistedLastResponse.content
      : '';
  const shouldContinueAfterPartialResponse =
    hasPartialResponseBeforeSandboxError(lastErrorContent);
  const shouldContinueAfterTimeout = isPersistentTurnTimeout(lastErrorContent);
  const shouldContinueFailedResponse =
    shouldContinueAfterPartialResponse || shouldContinueAfterTimeout;

  // The last response failed and the agent is idle: either the streaming bubble
  // holds the error, or (no bubble) the trailing transcript message is an error.
  const lastResponseIsError =
    !isAgentRunning &&
    !sending &&
    !!lastUserPrompt &&
    (streamEndedInError ||
      (!shouldShowStreamingBubble &&
        renderedMessages.length > 0 &&
        renderedMessages[renderedMessages.length - 1].role === 'assistant' &&
        !!renderedMessages[renderedMessages.length - 1].isError));

  /** Continue resumable failed turns; otherwise resend the original prompt. */
  const handleRetryLast = useCallback(() => {
    if (!lastUserPrompt) return;
    const text = shouldContinueFailedResponse
      ? 'Continue from where you stopped. Do not repeat completed work.'
      : lastUserPrompt.content;
    const conversation_id = activeConvId ?? undefined;
    justSentRef.current = true;
    void sendPreparedMessage(
      text,
      text,
      conversation_id,
      undefined,
      agentCmdOverride,
      effectiveChatModeOverride,
      runtimeSelection ?? undefined,
    );
  }, [
    lastUserPrompt,
    activeConvId,
    sendPreparedMessage,
    agentCmdOverride,
    effectiveChatModeOverride,
    runtimeSelection,
    shouldContinueFailedResponse,
  ]);

  useEffect(() => {
    for (const [conversationId, prompts] of Object.entries(
      queuedPromptsByConv,
    )) {
      if (
        conversationId === NEW_CHAT_KEY ||
        !prompts.some((prompt) => prompt.serverOwned) ||
        !prompts.every((prompt) => prompt.contextKey === folderKey)
      ) {
        continue;
      }
      void reconcileQueuedChatMessages(folderKey, conversationId).then(
        ({ consumed, released, withdrawn, queueOwners }) => {
          useStore.setState((state) => {
            const current = state.queuedPromptsByConv[conversationId] ?? [];
            const reconciled = reconcileQueuedPromptReceipts(current, {
              consumed,
              released,
              withdrawn,
              queueOwners,
            });
            if (reconciled === current) return state;
            const nextQueues = { ...state.queuedPromptsByConv };
            if (reconciled.length > 0) nextQueues[conversationId] = reconciled;
            else delete nextQueues[conversationId];
            return { queuedPromptsByConv: nextQueues };
          });
        },
        () => {
          // Authentication may still be reconnecting. Persisted state remains
          // intact and a later render/reconnect can retry reconciliation.
        },
      );
    }
  }, [folderKey, queuedPromptsByConv]);

  useEffect(() => {
    const conversationKeys = Object.keys(queuedPromptsByConv);
    for (const conversationKey of conversationKeys) {
      const queuedPrompts = queuedPromptsByConv[conversationKey] ?? [];
      if (queuedPrompts.length === 0) continue;
      // Queues persist across route navigation. Only their originating project
      // or objective may flush them.
      const belongsToThisContext = queuedPrompts.every(
        (prompt) => prompt.contextKey === folderKey,
      );
      if (!belongsToThisContext) continue;
      if (sendingByConv[conversationKey]) continue;
      let batch = queuedPrompts.filter(
        (prompt) =>
          !prompt.serverOwned &&
          !prompt.consumedByServer &&
          !prompt.awaitingAcknowledgement &&
          (!prompt.id || !queuedPromptActionInFlightRef.current.has(prompt.id)),
      );
      if (batch.some((prompt) => prompt.openFileContext))
        batch = batch.slice(0, 1);
      // A server-owned mirror has no browser work to flush. Filter before
      // acquiring the per-conversation lock so a stale mirror cannot block a
      // later browser-owned prompt.
      if (batch.length === 0) continue;
      const storeState = useStore.getState();
      const flushActiveKey = storeState.activeStreamKeyByConv[conversationKey];
      const flushStreamDone = flushActiveKey
        ? storeState.chatStreamingCompleted[flushActiveKey]
        : false;
      // Wait until the backend run has finished. chatRunning can be true before any
      // stream content arrives (agent starting/thinking), so guard on it directly —
      // otherwise we'd flush into a still-active run and the prompt would be ignored.
      if (storeState.chatRunningByConv[conversationKey]) continue;
      // On hydration/reconnect the tab-scoped stream state is intentionally
      // absent. Retry each persisted batch once through the backend's atomic
      // ownership decision: idle starts it, active returns it to this queue
      // until an authoritative completion arrives.
      if (!flushActiveKey || !flushStreamDone) {
        const signature = batch
          .map(
            (prompt) => prompt.id ?? `${prompt.content}:${prompt.contextKey}`,
          )
          .join('|');
        if (
          idleQueueRecoveryAttemptRef.current.get(conversationKey) === signature
        ) {
          continue;
        }
        idleQueueRecoveryAttemptRef.current.set(conversationKey, signature);
      } else {
        idleQueueRecoveryAttemptRef.current.delete(conversationKey);
      }
      if (flushingQueueRef.current.has(conversationKey)) continue;

      flushingQueueRef.current.add(conversationKey);
      useStore.setState((state) => {
        return {
          queuedPromptsByConv: {
            ...state.queuedPromptsByConv,
            [conversationKey]: markQueuedPromptBatchAwaitingAcknowledgement(
              state.queuedPromptsByConv[conversationKey] ?? [],
              batch,
            ),
          },
        };
      });
      const conversation_id =
        conversationKey === NEW_CHAT_KEY ? undefined : conversationKey;
      const content = batch.map((q) => q.content).join('\n\n');
      const bubble = batch.map((q) => q.bubbleContent).join('\n\n');
      const allAttachments = batch.flatMap((q) => q.attachments ?? []);
      const allDeepLinks = batch.flatMap((q) => q.deepLinks ?? []);
      // Use the agent from the first queued prompt if available, fallback to current override
      const agentToUse = batch[0]?.agent_cmd || agentCmdOverride;
      const modeToUse = batch[0]?.chat_mode ?? effectiveChatModeOverride;
      const memoryContextLevel = batch.reduce<MemoryContextLevel>(
        (highest, prompt) => {
          const queuedLevel = prompt.memoryContextLevel ?? 'off';
          const currentIndex = MEMORY_LEVELS.indexOf(queuedLevel);
          return currentIndex > MEMORY_LEVELS.indexOf(highest)
            ? queuedLevel
            : highest;
        },
        'off',
      );
      void sendPreparedMessage(
        content,
        bubble,
        conversation_id,
        allAttachments.length > 0 ? allAttachments : undefined,
        agentToUse,
        modeToUse,
        batch[0]?.runtimeSelection,
        undefined,
        undefined,
        allDeepLinks.length > 0 ? allDeepLinks : undefined,
        memoryContextLevel,
        batch[0]?.liveMode,
        batch[0]?.liveModeSessionId,
        batch[0]?.liveModeKind,
        batch,
        batch[0]?.openFileContext,
      )
        .then((result) => {
          if (result === CONVERSATION_MISSING_FAILURE || result !== undefined) {
            return;
          }
          useStore.setState((state) => ({
            queuedPromptsByConv: {
              ...state.queuedPromptsByConv,
              [conversationKey]: restoreFailedQueuedPromptBatch(
                state.queuedPromptsByConv[conversationKey] ?? [],
                batch,
              ),
            },
          }));
        })
        .finally(() => {
          flushingQueueRef.current.delete(conversationKey);
        });
    }
  }, [
    queuedPromptsByConv,
    folderKey,
    sendingByConv,
    chatRunningByConv,
    sendPreparedMessage,
    isStreamingCompleted,
    agentCmdOverride,
    effectiveChatModeOverride,
  ]);

  const queuedPrompts = queuedPromptsByConv[activeConversationKey] ?? [];
  const hiddenQueuedPromptIds = useMemo(
    () =>
      new Set(
        queuedPrompts
          .filter(
            (prompt) =>
              prompt.id &&
              !prompt.serverReleased &&
              !isPendingDirectQueuedPrompt(prompt) &&
              ownershipStableTranscriptEntries?.some(
                (entry) =>
                  entry.type === 'message' &&
                  entry.role === 'user' &&
                  (entry.id === prompt.id ||
                    entry.clientSubmissionIds?.includes(prompt.id ?? '') ===
                      true),
              ),
          )
          .flatMap((prompt) => (prompt.id ? [prompt.id] : [])),
      ),
    [ownershipStableTranscriptEntries, queuedPrompts],
  );
  useEffect(() => {
    if (hiddenQueuedPromptIds.size === 0) return;
    useStore.setState((state) => {
      const current = state.queuedPromptsByConv[activeConversationKey] ?? [];
      const remaining = current.filter(
        (prompt) =>
          (!prompt.serverOwned && !prompt.consumedByServer) ||
          !prompt.id ||
          !hiddenQueuedPromptIds.has(prompt.id),
      );
      if (remaining.length === current.length) return state;
      const nextQueues = { ...state.queuedPromptsByConv };
      if (remaining.length > 0) nextQueues[activeConversationKey] = remaining;
      else delete nextQueues[activeConversationKey];
      return { queuedPromptsByConv: nextQueues };
    });
  }, [activeConversationKey, hiddenQueuedPromptIds]);

  const removeQueuedPromptForAction = useCallback(
    (prompt: QueuedPrompt, fallbackIndex: number) => {
      const current =
        useStore.getState().queuedPromptsByConv[activeConversationKey] ?? [];
      const index = prompt.id
        ? current.findIndex((candidate) => candidate.id === prompt.id)
        : fallbackIndex;
      if (index >= 0) {
        useStore.getState().removeQueuedPrompt(activeConversationKey, index);
      }
    },
    [activeConversationKey],
  );

  const takeQueuedPromptForAction = useCallback(
    async (
      prompt: QueuedPrompt,
      index: number,
      deleting = false,
    ): Promise<QueuedPrompt | undefined> => {
      if (!prompt.serverOwned) {
        removeQueuedPromptForAction(prompt, index);
        return prompt;
      }
      if (
        !(deleting
          ? isDeletableQueuedPrompt(prompt)
          : isMutableQueuedPrompt(prompt)) ||
        objective_id ||
        !activeConvId ||
        !prompt.id
      ) {
        return undefined;
      }
      queuedPromptActionInFlightRef.current.add(prompt.id);
      useStore.setState((state) => ({
        queuedPromptsByConv: {
          ...state.queuedPromptsByConv,
          [activeConversationKey]: (
            state.queuedPromptsByConv[activeConversationKey] ?? []
          ).map((candidate) =>
            candidate.id === prompt.id
              ? { ...candidate, awaitingAcknowledgement: true }
              : candidate,
          ),
        },
      }));
      try {
        const result = await withdrawQueuedChatMessage(
          project_id,
          activeConvId,
          prompt.id,
        );
        removeQueuedPromptForAction(prompt, index);
        if (!result.withdrawn && !result.released) {
          void queryClient.invalidateQueries({
            queryKey: transcriptKey(activeConvId),
          });
          toast.error(
            prompt.serverQueueOwner === 'direct'
              ? 'This message was already sent.'
              : 'This queued prompt is no longer pending.',
          );
          return undefined;
        }
        if (prompt.serverQueueOwner === 'direct' && result.withdrawn) {
          // The server hides a withdrawn Direct prompt's canonical row; remove
          // it locally too so the follow-up ownership merge cannot restore it.
          discardWithdrawnTranscriptEntry(activeConvId, prompt.id);
          void queryClient.invalidateQueries({
            queryKey: transcriptKey(activeConvId),
          });
        }
        const {
          awaitingAcknowledgement: _,
          consumedByServer: _consumed,
          serverOwned: _serverOwned,
          serverQueueOwner: _serverQueueOwner,
          ...browserOwnedPrompt
        } = prompt;
        return browserOwnedPrompt;
      } catch (error) {
        useStore.setState((state) => ({
          queuedPromptsByConv: {
            ...state.queuedPromptsByConv,
            [activeConversationKey]: (
              state.queuedPromptsByConv[activeConversationKey] ?? []
            ).map((candidate) =>
              candidate.id === prompt.id
                ? { ...candidate, awaitingAcknowledgement: false }
                : candidate,
            ),
          },
        }));
        toast.error(
          error instanceof Error
            ? error.message
            : 'Failed to update the queued prompt.',
        );
        return undefined;
      } finally {
        queuedPromptActionInFlightRef.current.delete(prompt.id);
      }
    },
    [
      activeConvId,
      activeConversationKey,
      discardWithdrawnTranscriptEntry,
      objective_id,
      project_id,
      queryClient,
      removeQueuedPromptForAction,
      transcriptKey,
    ],
  );

  const handleDeleteQueuedPrompt = useCallback(
    (prompt: QueuedPrompt, index: number) => {
      void takeQueuedPromptForAction(prompt, index, true);
    },
    [takeQueuedPromptForAction],
  );

  const handleEditQueuedPrompt = useCallback(
    async (prompt: QueuedPrompt, index: number) => {
      const sourceDraftKey = draftKeyRef.current;
      const sourceComposerModeKey = composerModeKey;
      const editablePrompt = await takeQueuedPromptForAction(prompt, index);
      if (!editablePrompt) return;
      setDraftMessage(
        editablePrompt.draftContent ??
          (editablePrompt.attachments?.length
            ? editablePrompt.content.replace(
                /\n\n\[Attached files\]\n[\s\S]*$/,
                '',
              )
            : editablePrompt.content),
        sourceDraftKey,
      );
      useStore
        .getState()
        .setMemoryLevelForComposer(
          sourceComposerModeKey,
          editablePrompt.memoryContextLevel ?? 'off',
        );
    },
    [composerModeKey, setDraftMessage, takeQueuedPromptForAction],
  );

  const handleSteerQueuedPrompt = useCallback(
    async (prompt: QueuedPrompt, index: number) => {
      if (!activeConvId) return;
      if (
        !(
          useStore.getState().activeStreamKeyByConv[activeConvId] ??
          activeConvRunKey
        )
      ) {
        toast.error('The active turn is not ready to receive steering yet.');
        return;
      }
      const queuedPrompt = await takeQueuedPromptForAction(prompt, index);
      if (!queuedPrompt) return;
      const storeAtSteer = useStore.getState();
      const steeringStreamKey =
        storeAtSteer.activeStreamKeyByConv[activeConvId] ?? activeConvRunKey;
      if (!steeringStreamKey) {
        toast.error('The active turn is not ready to receive steering yet.');
        return;
      }
      const currentTurnMessages = renderedMessagesRef.current;
      const lastUserIndex = currentTurnMessages.findLastIndex(
        (item) => item.role === 'user',
      );
      // Only a persona response of the current turn (after the latest
      // human message) may own steering. A stale streaming row from an
      // earlier round must never receive new human messages.
      const activePersonaTarget = currentTurnMessages
        .slice(lastUserIndex + 1)
        .findLast(
          (item) =>
            item.role === 'assistant' &&
            item.streaming === true &&
            personaSenderId(item) !== null,
        );
      const steeringTarget =
        activePersonaTarget ??
        (!shouldShowStreamingBubble && lastUserIndex >= 0
          ? currentTurnMessages
              .slice(lastUserIndex + 1)
              .findLast((item) => item.role === 'assistant')
          : undefined);
      const steeringSplitOffset =
        steeringTarget?.content.length ??
        storeAtSteer.chatStreamingOutput[steeringStreamKey]?.length ??
        0;
      const localSteeringId = queuedPrompt.id ?? crypto.randomUUID();
      setInFlightSteeringMessages((current) => [
        ...current,
        {
          localId: localSteeringId,
          conversationId: activeConvId,
          streamKey: steeringStreamKey,
          content: queuedPrompt.bubbleContent,
          attachments: queuedPrompt.attachments,
          createdAt: new Date().toISOString(),
          delivery: 'pending',
          splitOffset: steeringSplitOffset,
          targetMessageId: steeringTarget?.id,
        },
      ]);
      justSentRef.current = true;
      try {
        const result = await sendPreparedMessage(
          queuedPrompt.content,
          queuedPrompt.bubbleContent,
          activeConvId,
          queuedPrompt.attachments,
          queuedPrompt.agent_cmd || agentCmdOverride,
          queuedPrompt.chat_mode ?? effectiveChatModeOverride,
          queuedPrompt.runtimeSelection,
          true,
          'steer',
          undefined,
          'off',
          undefined,
          undefined,
          undefined,
          [queuedPrompt],
          queuedPrompt.openFileContext,
          localSteeringId,
        );
        const steeringResult = result as
          | {
              userMessage?: { id?: string };
              delivery?: 'pending' | 'steered' | 'queued' | 'followup';
              steeringBoundary?: {
                streamKey: string;
                contentOffset: number;
                targetMessageId?: string;
              };
            }
          | undefined;
        const steeringBoundary = steeringResult?.steeringBoundary;
        setInFlightSteeringMessages((current) =>
          current.flatMap((message) => {
            if (message.localId !== localSteeringId) return message;
            if (steeringResult?.delivery === 'queued') return [];
            return {
              ...message,
              serverId: steeringResult?.userMessage?.id,
              streamKey: steeringBoundary?.streamKey ?? message.streamKey,
              delivery: steeringDeliveryFromResponse(steeringResult?.delivery),
              splitOffset:
                steeringBoundary?.contentOffset ?? message.splitOffset,
              targetMessageId:
                steeringBoundary?.targetMessageId ?? message.targetMessageId,
            };
          }),
        );
      } catch {
        setInFlightSteeringMessages((current) =>
          current.map((message) =>
            message.localId === localSteeringId
              ? { ...message, delivery: 'unconfirmed' }
              : message,
          ),
        );
      }
    },
    [
      activeConvId,
      activeConvRunKey,
      sendPreparedMessage,
      agentCmdOverride,
      effectiveChatModeOverride,
      shouldShowStreamingBubble,
      takeQueuedPromptForAction,
    ],
  );

  // streamKey / hasStreamingContent / isStreamingCompleted / shouldShowStreamingBubble
  // are declared earlier (before renderedMessages) to enable transcript dedup.

  // Per-chunk streaming auto-scroll is handled inside StreamingBubble via its own
  // useSmartScroll call; the outer scroll only reacts to the boolean hasStreamingContent.

  // Reset stopping flag when the agent is no longer running (e.g. streaming completed)
  useEffect(() => {
    if (!isAgentRunning && stopping) setStopping(false);
  }, [isAgentRunning, stopping]);
  const handleStop = useCallback(async () => {
    if (!isAgentRunning || stopping) return;
    stoppedStreamContentRef.current = {
      streamKey,
      content: streamKey
        ? (useStore.getState().chatStreamingOutput[streamKey] ?? '')
        : '',
    };
    setStoppedStreamKey(streamKey);
    setStopping(true);
    const convId = activeConvId ?? undefined;
    try {
      const result = await stopChatAgent(project_id, convId);
      if (!result.stopped && convId) {
        // Backend had nothing to kill — clear phantom running state locally.
        const storeState = useStore.getState();
        storeState.setChatRunning(convId, false);
        const streamKey = storeState.activeStreamKeyByConv[convId];
        if (streamKey) {
          storeState.markChatOutputCompleted(streamKey);
        }
        setSendingByConv((prev) => {
          if (!prev[convId]) return prev;
          const next = { ...prev };
          delete next[convId];
          return next;
        });
      }
    } catch {
      stoppedStreamContentRef.current = { streamKey: null, content: '' };
      setStoppedStreamKey(null);
      setStopping(false);
    }
  }, [isAgentRunning, stopping, streamKey, project_id, activeConvId]);

  const handleSelectForkMessage = useCallback(
    (messageId: string, includeAssistantTurn = false) => {
      useStore.getState().setMemoryLevelForComposer(composerModeKey, 'off');
      setForkFromMessageId(messageId);
      setForkIncludeAssistantTurn(includeAssistantTurn);
      // Focus the normal composer so the user can type the fork prompt, pick
      // the agent, add attachments, etc. — same form as a regular send.
      if (!isNative) {
        setTimeout(() => textareaRef.current?.focus(), 0);
      }
    },
    [composerModeKey],
  );

  // Stable fork handler for the streaming bubble's just-completed assistant
  // turn: anchor on the last user message in the rendered list and include
  // the reply. Same ref-based pattern so StreamingBubble's onFork prop stays
  // referentially stable.
  const handleForkStreamingReply = useCallback(() => {
    const msgs = renderedMessagesRef.current;
    for (let j = msgs.length - 1; j >= 0; j--) {
      if (msgs[j].role === 'user') {
        handleSelectForkMessage(msgs[j].id, true);
        return;
      }
    }
    if (transcriptTurnContext.lastUserId) {
      handleSelectForkMessage(transcriptTurnContext.lastUserId, true);
    }
  }, [handleSelectForkMessage, transcriptTurnContext.lastUserId]);

  // Whether the streaming reply is forkable (a preceding user message exists).
  // Stable across unrelated re-renders so the onFork prop passed to
  // StreamingBubble doesn't churn React.memo.
  const streamingReplyForkable = useMemo(() => {
    const msgs = renderedMessages;
    for (let j = msgs.length - 1; j >= 0; j--) {
      if (msgs[j].role === 'user') return true;
    }
    return Boolean(transcriptTurnContext.lastUserId);
  }, [renderedMessages, transcriptTurnContext.lastUserId]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const hasPhysicalKeyboard = noteKeyboardEvent(e);
    if (slashVisible && filteredSlashCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashSelectedIndex((i) =>
          Math.min(i + 1, filteredSlashCommands.length - 1),
        );
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        selectSlashCommand(filteredSlashCommands[slashSelectedIndex]);
        return;
      }
      if (e.key === 'Escape') {
        setSlashVisible(false);
        return;
      }
    }
    if (
      e.key === 'Enter' &&
      !e.shiftKey &&
      (!isNative || hasPhysicalKeyboard)
    ) {
      e.preventDefault();
      handleSend();
    }
  };

  // Running conversations whose live output ends with a question card are
  // waiting for the user. The selector returns a string so chunks that do not
  // change the set do not re-render the page.
  const awaitingAnswerKey = useStore((s) =>
    Object.keys(s.chatRunningByConv)
      .filter((convId) => {
        const streamKey = s.activeStreamKeyByConv[convId];
        return (
          !!streamKey &&
          endsWithOpenQuestion(s.chatStreamingOutput[streamKey] ?? '')
        );
      })
      .join('\n'),
  );
  const awaitingAnswerIds = useMemo(
    () => new Set(awaitingAnswerKey ? awaitingAnswerKey.split('\n') : []),
    [awaitingAnswerKey],
  );

  // Public conversations stay most visible, followed by manually pinned ones.
  // Preserve the server's latest-assistant-response order for unpinned rows.
  const sortedConvs = useMemo(() => {
    const publiclyShared = conversations.filter((c) => c.publiclyShared);
    const pinned = conversations.filter((c) => !c.publiclyShared && c.pinned);
    const unpinned = conversations.filter(
      (c) => !c.publiclyShared && !c.pinned,
    );
    return [...publiclyShared, ...pinned, ...unpinned].map((c) => ({
      ...c,
      status: chatRunningByConv[c.id]
        ? awaitingAnswerIds.has(c.id)
          ? ('pending' as const)
          : ('working' as const)
        : c.status,
    }));
  }, [conversations, chatRunningByConv, awaitingAnswerIds]);

  const visibleConvs = useMemo(() => {
    const search = conversationSearch.trim().toLowerCase();
    if (!search) return sortedConvs;

    return sortedConvs.filter((conversation) =>
      [conversation.id, conversation.title, conversation.preview].some(
        (value) => value?.toLowerCase().includes(search),
      ),
    );
  }, [sortedConvs, conversationSearch]);
  const isFilteringConversations = conversationSearch.trim().length > 0;
  // A search only sees loaded pages, so keep paging until a match appears or
  // the list is exhausted. A failed page stops the loop (the sentinel offers
  // Retry); the effect re-arms when the search text or loaded rows change.
  const isSearchingMoreConvs =
    isFilteringConversations &&
    visibleConvs.length === 0 &&
    !!hasMoreConvs &&
    !didFailFetchingMoreConvs;
  const loadedPinnedConversationCount = useMemo(
    () =>
      sortedConvs.filter(
        (conversation) => !conversation.publiclyShared && conversation.pinned,
      ).length,
    [sortedConvs],
  );
  const {
    publiclyShared: visiblePublicConvs,
    pinned: visiblePinnedConvs,
    unpinned: visibleUnpinnedConvs,
  } = useMemo(
    () => ({
      publiclyShared: visibleConvs.filter(
        (conversation) => conversation.publiclyShared,
      ),
      pinned: visibleConvs.filter(
        (conversation) => !conversation.publiclyShared && conversation.pinned,
      ),
      unpinned: visibleConvs.filter(
        (conversation) => !conversation.publiclyShared && !conversation.pinned,
      ),
    }),
    [visibleConvs],
  );
  const pinnedConversationsExpanded = useStore(
    (s) => s.pinnedConversationsExpandedByProject[project_id] ?? true,
  );
  const setPinnedConversationsExpanded = useCallback(
    (expanded: boolean) =>
      useStore
        .getState()
        .setPinnedConversationsExpandedForProject(project_id, expanded),
    [project_id],
  );

  // Shared by the conversation list's New button and the header pen button
  // shown while the list is hidden.
  const beginNewConversation = () => {
    // Blank composer: the conversation (and its worktree) is created on
    // the first message. Reset the worktree selection for a clean start.
    setComposingNewConv(true);
    setActiveConvId(null);
    setDraftAiUsers({
      mainSelection: { mode: 'inherit' },
      invitedAiUserIds: [],
      invitedAiUserIdsProvided: false,
    });
    setDraftContinuousPersonaLoop(false);
    setDraftPromptCache1h(false);
    setDraftLiveModeEnabled(false);
    setDraftLiveModeKind('work');
    useStore
      .getState()
      .setMemoryLevelForComposer(`${folderKey}:${NEW_CHAT_KEY}`, 'off');
    setUseWorktree(false);
    setWorktreeBranch(null);
    setShowMeetingPanel(false);
    clearMeetingSession();
  };
  const startNewConversation = () => {
    if (activeConvId !== null || !composingNewConv)
      authorizeMobilePanelTransition(beginNewConversation);
    else beginNewConversation();
  };

  // Projects a blank new conversation can be moved to from the header picker.
  const chatProjectIds = useMemo(
    () =>
      new Set(
        projects
          .filter((p) => availableProjectModes(p, config).includes('chat'))
          .map((p) => p.id),
      ),
    [projects, config],
  );

  // Move the blank new-conversation composer (and its typed draft) to another
  // project. ChatPage is keyed by project, so this remounts in the target.
  const moveNewConversationToProject = (targetProjectId: string) => {
    if (targetProjectId === project_id) return;
    const store = useStore.getState();
    const draft = store.draftByKey[draftKeyRef.current] ?? '';
    const targetDraftKey = `${targetProjectId}:__new__`;
    if (draft.trim() && !(store.draftByKey[targetDraftKey] ?? '').trim()) {
      store.saveDraftByKey(targetDraftKey, draft);
      store.clearDraftByKey(draftKeyRef.current);
    }
    store.setActiveConvForProject(targetProjectId, null);
    store.setComposingNewConversationForProject(targetProjectId, true);
    navigate({
      to: '/chat/$projectId',
      params: { projectId: targetProjectId },
    });
  };

  // Inline rename for the active conversation from the header actions menu.
  const [headerRenaming, setHeaderRenaming] = useState(false);
  useEffect(() => setHeaderRenaming(false), [activeConvId]);

  const chatSidebarOpen = useStore((s) => s.chatSidebarOpen);
  const setChatSidebarOpen = useStore((s) => s.setChatSidebarOpen);
  const desktopChatSidebarCollapsed = useStore(
    (s) => s.desktopChatSidebarCollapsed,
  );
  const setDesktopChatSidebarCollapsed = useStore(
    (s) => s.setDesktopChatSidebarCollapsed,
  );
  const isDesktopSidebar = useMediaQuery('(min-width: 768px)');
  const conversationSidebarResize = useConversationSidebarResize();
  const desktopSidebarCollapsed = useStore((s) => s.desktopSidebarCollapsed);

  // Showing the conversation list or project sidebar again closes the
  // workspace pane when the chat would otherwise drop below its minimum width.
  const previousSidebarsCollapsedRef = useRef({
    list: desktopChatSidebarCollapsed,
    project: desktopSidebarCollapsed,
  });
  useEffect(() => {
    const previous = previousSidebarsCollapsedRef.current;
    previousSidebarsCollapsedRef.current = {
      list: desktopChatSidebarCollapsed,
      project: desktopSidebarCollapsed,
    };
    if (!isDesktopSidebar || !artifactsPanelOpen) return;
    // Widths of the `md:w-52` list (or its dragged width) and `md:w-72` sidebar.
    const addedWidth =
      (previous.list && !desktopChatSidebarCollapsed
        ? (conversationSidebarResize.width ?? 208)
        : 0) + (previous.project && !desktopSidebarCollapsed ? 288 : 0);
    const chatWidth = chatLayoutRef.current
      ?.querySelector('[data-ui="chat-project-surface"]')
      ?.getBoundingClientRect().width;
    // The sidebar width transitions in, so the chat has not shrunk yet.
    if (
      addedWidth &&
      chatWidth !== undefined &&
      chatWidth - addedWidth < CHAT_MIN_WIDTH
    )
      setArtifactsPanelOpen(false);
  }, [
    artifactsPanelOpen,
    chatLayoutRef,
    conversationSidebarResize.width,
    desktopChatSidebarCollapsed,
    desktopSidebarCollapsed,
    isDesktopSidebar,
    setArtifactsPanelOpen,
  ]);

  useEffect(() => {
    const sentinel = convLoadMoreRef.current;
    const root = convListRef.current;
    if (!sentinel || !root || !hasMoreConvs) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !isFetchingMoreConvsRef.current) {
          // Lock synchronously. Query state is updated on the next render, and
          // multiple observer callbacks can otherwise start the same page.
          isFetchingMoreConvsRef.current = true;
          void fetchNextConversationsPageRef.current().finally(() => {
            isFetchingMoreConvsRef.current = false;
          });
        }
      },
      { root, rootMargin: '0px 0px 120px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMoreConvs]);

  useEffect(() => {
    if (!isSearchingMoreConvs || isFetchingMoreConvsRef.current) return;
    isFetchingMoreConvsRef.current = true;
    void fetchNextConversationsPageRef.current().finally(() => {
      isFetchingMoreConvsRef.current = false;
    });
  }, [isSearchingMoreConvs, isFetchingMoreConvs, conversations.length]);

  const renderedSteeringTargetIds = new Set(
    renderedMessages
      .filter((item) => item.role === 'assistant')
      .map((item) => item.id),
  );
  const hasUnanchoredSteeringForStream = visibleInFlightSteeringMessages.some(
    (message) =>
      message.streamKey === streamKey &&
      (!message.targetMessageId ||
        !renderedSteeringTargetIds.has(message.targetMessageId)),
  );
  const visibleStreamingKey =
    !canonicalPersonaTurns &&
    (shouldShowStreamingBubble ||
      hasUnanchoredSteeringForStream ||
      (!isVoiceDelayedMainPersona &&
        (chatRunning || sending) &&
        !hasCurrentTurnDefaultAgentResponse &&
        !persistedStreamedResponse))
      ? streamKey
      : null;
  const steeringForCurrentStream = visibleInFlightSteeringMessages
    .filter(
      (message) =>
        message.streamKey === visibleStreamingKey &&
        (!message.targetMessageId ||
          !renderedSteeringTargetIds.has(message.targetMessageId)),
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const fallbackSteeringMessages = visibleInFlightSteeringMessages
    .filter(
      (message) =>
        message.streamKey !== visibleStreamingKey &&
        (!message.targetMessageId ||
          !renderedSteeringTargetIds.has(message.targetMessageId)),
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const streamingBubble =
    steeringForCurrentStream.length === 0 ? (
      <StreamingBubble
        projectId={project_id}
        conversationId={activeConvId}
        key={streamKey ?? 'pending-chat-stream'}
        streamKey={visibleStreamingKey}
        contentOverride={
          !hasStreamingContent && preserveStoppedStreamingBubble
            ? stoppedStreamContent
            : undefined
        }
        isRunning={
          pendingStreamPresentationReady &&
          !canonicalPersonaTurns &&
          !isVoiceDelayedMainPersona &&
          !hasCurrentTurnAssistantResponse &&
          (chatRunning || sending) &&
          !persistedStreamedResponse
        }
        virtualSender={streamVirtualSender}
        assistantName={config?.assistantName}
        preparingMemory={memoryPreparing}
        onSendMessage={handleQuestionAnswer}
        onContentGrow={scrollToBottomIfPinned}
        onFinalContentCommit={scrollToBottomIfPinnedNow}
        onImplementPlan={handleImplementPlan}
        onSendPlanToKanban={handleSendPlanToKanban}
        onOpenArtifact={openPlanArtifact}
        onFork={streamingReplyForkable ? handleForkStreamingReply : undefined}
        innerScrollStateRef={streamingInnerScrollStateRef}
        toolCallDisplay={toolCallDisplay}
      />
    ) : (
      <div
        data-ui="chat-steered-turn"
        data-stream-key={visibleStreamingKey ?? undefined}
        className="space-y-4"
      >
        {(() => {
          const parts: ReactNode[] = [];
          const assistantSegments = splitToolAwareAssistantContent(
            currentStreamContent,
            steeringForCurrentStream.map(
              (message) => message.splitOffset ?? currentStreamContent.length,
            ),
          );
          for (const [
            index,
            steeringMessage,
          ] of steeringForCurrentStream.entries()) {
            const assistantSegment = assistantSegments[index];
            parts.push(
              <StreamingBubble
                projectId={project_id}
                conversationId={activeConvId}
                key={`${steeringMessage.localId}:before`}
                streamKey={visibleStreamingKey}
                bubbleId={`${visibleStreamingKey}:${steeringMessage.localId}:before`}
                contentOverride={assistantSegment}
                completedOverride
                showStreamAttachments={false}
                isRunning={
                  pendingStreamPresentationReady &&
                  !canonicalPersonaTurns &&
                  !assistantSegment &&
                  steeringMessage.delivery !== 'steered' &&
                  chatRunning
                }
                virtualSender={streamVirtualSender}
                assistantName={config?.assistantName}
                onSendMessage={handleQuestionAnswer}
                onContentGrow={scrollToBottomIfPinned}
                onFinalContentCommit={scrollToBottomIfPinnedNow}
                onImplementPlan={handleImplementPlan}
                onSendPlanToKanban={handleSendPlanToKanban}
                onOpenArtifact={openPlanArtifact}
                innerScrollStateRef={streamingInnerScrollStateRef}
                toolCallDisplay={toolCallDisplay}
              />,
            );
            parts.push(
              <div
                key={steeringMessage.localId}
                data-ui="chat-steering-message"
                data-steering-status={steeringMessage.delivery}
                className="space-y-1"
              >
                <ChatMessageBubble
                  id={steeringMessage.serverId ?? steeringMessage.localId}
                  role="user"
                  content={steeringMessage.content}
                  attachments={steeringMessage.attachments}
                  steeringDeliveryStatus={
                    <div
                      data-ui="chat-steering-acknowledgement"
                      data-steering-status={steeringMessage.delivery}
                    >
                      <SteeringDeliveryStatus
                        delivery={steeringMessage.delivery}
                      />
                    </div>
                  }
                  created_at={steeringMessage.createdAt}
                  source="web"
                  sender_name={currentSenderName}
                  senderUserId={currentSenderUserId}
                  senderAvatarUrl={currentSenderAvatarUrl}
                />
              </div>,
            );
          }
          const finalSegment = assistantSegments.at(-1) ?? '';
          if (
            finalSegment ||
            steeringForCurrentStream.at(-1)?.delivery === 'steered'
          ) {
            parts.push(
              <StreamingBubble
                projectId={project_id}
                conversationId={activeConvId}
                key={`${steeringForCurrentStream.at(-1)!.localId}:after`}
                streamKey={visibleStreamingKey}
                bubbleId={`${visibleStreamingKey}:${steeringForCurrentStream.at(-1)!.localId}:after`}
                contentOverride={finalSegment}
                completedOverride={isStreamingCompleted}
                isRunning={
                  pendingStreamPresentationReady &&
                  !canonicalPersonaTurns &&
                  !isVoiceDelayedMainPersona &&
                  !hasCurrentTurnAssistantResponse &&
                  (chatRunning || sending) &&
                  !persistedStreamedResponse
                }
                virtualSender={streamVirtualSender}
                assistantName={config?.assistantName}
                onSendMessage={handleQuestionAnswer}
                onContentGrow={scrollToBottomIfPinned}
                onFinalContentCommit={scrollToBottomIfPinnedNow}
                onImplementPlan={handleImplementPlan}
                onSendPlanToKanban={handleSendPlanToKanban}
                onOpenArtifact={openPlanArtifact}
                innerScrollStateRef={streamingInnerScrollStateRef}
                toolCallDisplay={toolCallDisplay}
                onFork={
                  streamingReplyForkable ? handleForkStreamingReply : undefined
                }
              />,
            );
          }
          return parts;
        })()}
      </div>
    );

  const conversationActions = (conv: Conversation) => ({
    onDelete: () =>
      apiDeleteConv(conv.id).then(() => {
        queryClient.removeQueries({
          queryKey: ['conversation-detail', project_id, conv.id],
        });
        queryClient.invalidateQueries({ queryKey: convsQueryKey });
        if (activeConvId === conv.id) {
          // Select next conversation or null (new chat)
          const remaining = conversations.filter((c) => c.id !== conv.id);
          setActiveConvId(remaining.length > 0 ? remaining[0].id : null);
        }
      }),
    onPin: (pinned: boolean) => {
      apiUpdateConv(conv.id, { pinned })
        .then(() => {
          queryClient.invalidateQueries({ queryKey: convsQueryKey });
        })
        .catch((err: unknown) => {
          toast.error(
            `Could not pin conversation: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    },
    /** Resolves true when the title was saved, false after reporting a failure. */
    onRename: async (title: string | null): Promise<boolean> => {
      try {
        await apiUpdateConv(conv.id, { title });
      } catch (err) {
        toast.error(
          `Could not rename conversation: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      }
      queryClient.invalidateQueries({ queryKey: convsQueryKey });
      // The sidebar "Now" rows carry the conversation title too.
      queryClient.invalidateQueries({ queryKey: queryKeys.attention.all });
      return true;
    },
    onAgentRename: async () => {
      try {
        const result = await generateConversationTitle(project_id, conv.id);
        await queryClient.invalidateQueries({ queryKey: convsQueryKey });
        toast.success(`Conversation renamed to “${result.title}”`);
      } catch (err) {
        toast.error(
          `Failed to name conversation: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    onFork: () => {
      apiForkConv(conv.id)
        .then((result) => {
          queryClient.invalidateQueries({ queryKey: convsQueryKey });
          useStore
            .getState()
            .setMemoryLevelForComposer(`${folderKey}:${result.id}`, 'off');
          setActiveConvId(result.id);
        })
        .catch((err: unknown) => {
          toast.error(
            `Failed to fork conversation: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    },
  });

  const availableWorktreeBranches = repoWorktrees
    ? new Set(repoWorktrees.map((worktree) => worktree.branch))
    : undefined;
  const renderConversationItems = (items: Conversation[]) =>
    items.map((conv) => (
      <ConversationItem
        key={conv.id}
        conv={conv}
        worktreeAvailable={
          conv.use_worktree
            ? conv.worktree_path
              ? true
              : availableWorktreeBranches?.has(
                  conv.branch_name || `chat-${conv.id}`,
                )
            : undefined
        }
        projectId={project_id}
        currentUserId={currentSenderUserId}
        currentUsername={user?.username}
        active={conv.id === activeConvId}
        onClick={() => {
          const select = () => {
            if (
              conv.id === activeConvId &&
              (conv.status === 'finished' || conv.status === 'failed')
            ) {
              void markConversationAsRead(conv.id);
            }
            setComposingNewConv(false);
            setActiveConvId(conv.id);
            setShowMeetingPanel(false);
            clearMeetingSession();
            // Auto-close on mobile
            if (window.innerWidth < 768) {
              setChatSidebarOpen(false);
            }
          };
          if (conv.id !== activeConvId) authorizeMobilePanelTransition(select);
          else select();
        }}
        {...conversationActions(conv)}
      />
    ));

  const renderConversationGroups = (
    items: Conversation[],
    sectionKey: string,
  ) => {
    const grouped = new Map<ConversationDateGroup, Conversation[]>();
    for (const conversation of items) {
      const group = conversationDateGroup(conversation);
      const conversationsInGroup = grouped.get(group) ?? [];
      conversationsInGroup.push(conversation);
      grouped.set(group, conversationsInGroup);
    }

    return CONVERSATION_DATE_GROUPS.filter(([group]) => grouped.has(group)).map(
      ([group, label]) => (
        <section
          key={`${sectionKey}:${group}`}
          data-ui="conversation-date-group"
          data-date-group={group}
        >
          <h3 className="border-b border-border/50 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
            {label}
          </h3>
          {renderConversationItems(grouped.get(group) ?? [])}
        </section>
      ),
    );
  };

  return (
    <KnowledgeComposer
      value={knowledgeComposer}
      ref={chatLayoutRef}
      className="flex-1 flex overflow-hidden relative"
    >
      {knowledgePickerOpen && (
        <KnowledgePicker
          projectId={project_id}
          open={knowledgePickerOpen}
          onOpenChange={setKnowledgePickerOpen}
          onPreview={() => {
            setKnowledgePickerOpen(false);
            setArtifactsPanelOpen(true);
          }}
        />
      )}
      {/* Backdrop for mobile */}
      {chatSidebarOpen && (
        <div
          // bg-black/50 stays in both themes: a modal scrim dims the page.
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setChatSidebarOpen(false)}
        />
      )}

      {/* Conversations sidebar */}
      <div
        id="conversation-sidebar"
        data-ui="conversation-sidebar"
        ref={conversationSidebarResize.sidebarRef}
        className={cn(
          'w-52 border-r border-border bg-sidebar flex flex-col flex-shrink-0 transition-all duration-300 z-40',
          'fixed inset-y-0 left-0 w-3/4 max-w-[280px] md:w-52 md:relative md:translate-x-0',
          chatSidebarOpen
            ? 'translate-x-0'
            : '-translate-x-full md:translate-x-0',
          desktopChatSidebarCollapsed &&
            'md:!w-0 md:!border-r-0 md:!invisible md:!pointer-events-none',
        )}
        style={
          isDesktopSidebar && !desktopChatSidebarCollapsed
            ? {
                width: conversationSidebarResize.width ?? undefined,
                transition: conversationSidebarResize.isResizing
                  ? 'none'
                  : undefined,
              }
            : undefined
        }
      >
        <div className="p-2 border-b border-border flex gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="flex-1 gap-1.5"
            onClick={startNewConversation}
          >
            <Plus className="size-3.5" />
            New
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="hidden md:inline-flex shrink-0"
            title="Hide conversations"
            aria-label="Hide conversations"
            aria-expanded={!desktopChatSidebarCollapsed}
            aria-controls="conversation-sidebar"
            data-ui="conversation-sidebar-collapse"
            onClick={() => {
              setDesktopChatSidebarCollapsed(true);
              requestAnimationFrame(() => {
                document
                  .querySelector<HTMLElement>(
                    '[data-ui="conversation-sidebar-expand"]',
                  )
                  ?.focus();
              });
            }}
          >
            <PanelLeftClose className="size-4" />
          </Button>
          {conversations.some(
            (conversation) =>
              conversation.status === 'finished' ||
              conversation.status === 'failed',
          ) && (
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0 gap-1 px-2 text-xs"
              onClick={() => void markAllFinishedConversationsAsRead()}
              disabled={markingAllFinished}
              title="Mark all completed conversations as viewed"
              data-ui="mark-all-conversations-viewed"
            >
              {markingAllFinished ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Check className="size-3.5" />
              )}
              <span className="sr-only">
                Mark all completed conversations as viewed
              </span>
            </Button>
          )}
        </div>

        <div className="p-2 border-b border-border">
          <SearchInput
            compact
            id="conversation-search"
            data-ui="conversation-search"
            type="search"
            placeholder="Search conversations..."
            value={conversationSearch}
            onChange={(event) => setConversationSearch(event.target.value)}
            onClear={() => setConversationSearch('')}
            clearLabel="Clear conversation search"
          />
        </div>
        {!objective_id && hasSharedProject && (
          <div className="flex gap-1 border-b border-border p-2">
            <Select
              compact
              data-ui="conversation-owner-filter"
              data-project-id={project_id}
              aria-label="Owner"
              className="min-w-0 flex-1"
              value={conversationOwnerUserId}
              onValueChange={(nextValue) =>
                setConversationOwnerUserId(nextValue)
              }
            >
              <SelectItem value="">All owners</SelectItem>
              {attributionMembers.map((member) => (
                <SelectItem key={member.user_id} value={member.user_id}>
                  {member.username}
                </SelectItem>
              ))}
            </Select>
            <Select
              compact
              data-ui="conversation-trigger-filter"
              data-project-id={project_id}
              aria-label="Triggered by"
              className="min-w-0 flex-1"
              value={conversationTriggeredByUserId}
              onValueChange={(nextValue) =>
                setConversationTriggeredByUserId(nextValue)
              }
            >
              <SelectItem value="">All triggerers</SelectItem>
              {attributionMembers.map((member) => (
                <SelectItem key={member.user_id} value={member.user_id}>
                  {member.username}
                </SelectItem>
              ))}
            </Select>
          </div>
        )}

        <div
          ref={convListRef}
          className="flex-1 overflow-y-auto md:mr-1"
          data-ui="conversations-list"
        >
          {renderConversationGroups(visiblePublicConvs, 'public')}

          {loadedPinnedConversationCount > 0 && (
            <section data-ui="pinned-conversations-section">
              <button
                type="button"
                data-ui="pinned-conversations-toggle"
                aria-expanded={pinnedConversationsExpanded}
                aria-controls="pinned-conversations-list"
                className="flex w-full items-center gap-1.5 border-b border-border/50 px-3 py-2 text-left transition-colors hover:bg-muted/60"
                onClick={() =>
                  setPinnedConversationsExpanded(!pinnedConversationsExpanded)
                }
              >
                {pinnedConversationsExpanded ? (
                  <ChevronDown className="size-3 flex-shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-3 flex-shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
                  Pinned
                </span>
                <span className="inline-flex h-4 shrink-0 items-center rounded-full bg-secondary px-1.5 text-[10px] font-medium leading-none text-secondary-foreground">
                  {loadedPinnedConversationCount}
                </span>
              </button>
              {(pinnedConversationsExpanded || isFilteringConversations) && (
                <div
                  id="pinned-conversations-list"
                  data-ui="pinned-conversations-list"
                >
                  {renderConversationGroups(visiblePinnedConvs, 'pinned')}
                </div>
              )}
            </section>
          )}

          {renderConversationGroups(visibleUnpinnedConvs, 'unpinned')}

          {hasMoreConvs && (
            <div
              ref={convLoadMoreRef}
              className="flex min-h-10 items-center justify-center px-3 py-2 text-xs text-muted-foreground"
              data-ui="conversations-load-more-sentinel"
              aria-label={
                isFetchingMoreConvs
                  ? 'Loading more conversations'
                  : didFailFetchingMoreConvs
                    ? 'Could not load more conversations'
                    : 'Load more conversations'
              }
            >
              {isFetchingMoreConvs ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : didFailFetchingMoreConvs ? (
                <button
                  type="button"
                  className="hover:text-foreground"
                  onClick={() => void fetchNextConversationsPage()}
                >
                  Could not load more. Retry
                </button>
              ) : null}
            </div>
          )}

          <ConversationListEmptyState
            conversationCount={conversations.length}
            status={convsStatus}
            onRetry={() => void refetchConversations()}
          />

          {conversations.length > 0 &&
            isFilteringConversations &&
            visibleConvs.length === 0 &&
            (isSearchingMoreConvs ? (
              <p
                className="px-3 py-4 text-xs text-muted-foreground"
                data-ui="conversation-search-loading"
              >
                Searching...
              </p>
            ) : (
              !hasMoreConvs && (
                <p className="px-3 py-4 text-xs text-muted-foreground">
                  No matching conversations.
                </p>
              )
            ))}
        </div>

        {/* Scheduled tasks collapsible section — chat mode only */}
        {!objective_id && (
          <ScheduledTasksSidebarSection project_id={project_id} />
        )}
        <div
          data-ui="conversation-sidebar-resize"
          onPointerDown={conversationSidebarResize.startResize}
          className="absolute -right-px top-0 z-10 hidden h-full w-1 touch-none cursor-col-resize bg-border transition-colors hover:bg-primary/50 md:block [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:inset-y-0 [@media(pointer:coarse)]:after:-inset-x-2"
          title="Drag to resize"
        />
      </div>

      {/* Main chat area — drag & drop target */}
      <div
        data-ui="chat-project-surface"
        data-project-id={project_id}
        className={cn(
          'flex flex-col flex-1 min-w-0 relative',
          isDragOver && 'bg-primary/5',
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Drag overlay */}
        {isDragOver && (
          <div className="absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed border-primary/50 rounded pointer-events-none">
            <p className="text-sm text-primary font-medium">
              Drop files to attach
            </p>
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between px-3 md:px-4 py-2 md:py-3 border-b border-border flex-shrink-0 min-h-[57px]">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <Button
              variant="ghost"
              size="icon-xs"
              className="md:hidden shrink-0"
              onClick={() => setChatSidebarOpen(true)}
              title="Show conversations"
            >
              <MessageSquare className="size-5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn(
                'shrink-0',
                desktopChatSidebarCollapsed ? 'inline-flex' : 'md:hidden',
              )}
              title="New conversation"
              aria-label="New conversation"
              data-ui="conversation-new-collapsed"
              onClick={startNewConversation}
            >
              <SquarePen className="size-4" />
            </Button>
            {desktopChatSidebarCollapsed && (
              <Button
                variant="ghost"
                size="icon-xs"
                className="hidden md:inline-flex shrink-0"
                title="Show conversations"
                aria-label="Show conversations"
                aria-expanded={false}
                aria-controls="conversation-sidebar"
                data-ui="conversation-sidebar-expand"
                onClick={() => setDesktopChatSidebarCollapsed(false)}
              >
                <PanelLeftOpen className="size-4" />
              </Button>
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div data-ui="chat-conversation-name-row" className="min-w-0">
                {objective_id && (
                  <div
                    data-ui="chat-objective-kind"
                    data-objective-id={objective_id}
                    title="Runs in the objective's folder with its rules; cost counts to the objective."
                    className="flex min-w-0 items-center gap-1 text-sm font-semibold"
                  >
                    <Target className="size-3.5 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 truncate">
                      {activeConvId ? 'Objective chat' : 'New objective chat'}
                    </span>
                  </div>
                )}
                {!objective_id &&
                  (() => {
                    const isParent = Boolean(project?.settings?.isParent);
                    const ProjectIcon = isParent ? Layers : Folder;
                    const projectName = project?.name ?? project_id;
                    return (
                      <div
                        data-ui="chat-project-name"
                        data-project-id={project_id}
                        title={
                          activeConvId
                            ? `Project: ${projectName}`
                            : `New conversation will start in ${projectName}`
                        }
                        className="flex min-w-0 items-center gap-1 text-[11px] leading-4 text-muted-foreground"
                      >
                        <ProjectIcon
                          className={cn(
                            'size-3 shrink-0',
                            isParent && 'text-violet-600 dark:text-violet-400',
                          )}
                          aria-hidden="true"
                        />
                        {activeConvId ? (
                          <span className="truncate">{projectName}</span>
                        ) : (
                          <ProjectPicker
                            projects={projects}
                            value={project_id}
                            onValueChange={moveNewConversationToProject}
                            allowedProjectIds={chatProjectIds}
                            placeholder={projectName}
                            size="sm"
                            aria-label="Project for new conversation"
                            data-ui="chat-new-conversation-project-picker"
                            className="h-4 min-w-0 max-w-full gap-0.5 rounded-sm border-0 bg-transparent px-0 has-[>svg]:px-0 text-[11px] leading-4 text-muted-foreground shadow-none hover:bg-transparent hover:text-foreground dark:bg-transparent dark:hover:bg-transparent"
                            contentClassName="w-72"
                          />
                        )}
                      </div>
                    );
                  })()}
                {headerRenaming && activeConversation ? (
                  <Input
                    compact
                    data-ui="chat-conversation-title-input"
                    type="text"
                    autoFocus
                    defaultValue={activeConversation.title || ''}
                    placeholder={
                      activeConversation.preview ?? 'Conversation name'
                    }
                    onFocus={(e) => e.currentTarget.select()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        e.currentTarget.blur();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        e.currentTarget.value = activeConversation.title || '';
                        e.currentTarget.blur();
                      }
                    }}
                    onBlur={(e) => {
                      const title = e.currentTarget.value.trim();
                      setHeaderRenaming(false);
                      if (title !== (activeConversation.title || ''))
                        void conversationActions(activeConversation).onRename(
                          title || null,
                        );
                    }}
                    className="w-full font-medium"
                  />
                ) : (
                  <p
                    data-ui="chat-conversation-title"
                    className={cn(
                      'text-xs text-muted-foreground truncate',
                      !objective_id && 'text-sm font-medium',
                    )}
                  >
                    {activeConvId
                      ? activeConversation?.title ||
                        activeConversation?.preview ||
                        'Conversation'
                      : 'New conversation'}
                  </p>
                )}
              </div>
              {activeConversation && (
                <div
                  data-ui="chat-attribution-row"
                  className="flex min-w-0 items-center gap-1 overflow-hidden text-[10px] leading-4 text-muted-foreground"
                >
                  <span
                    data-ui="chat-owner-badge"
                    data-conversation-id={activeConversation.id}
                    data-user-id={activeConversation.owner?.id ?? ''}
                    title={
                      activeConversation.owner
                        ? `Owner: ${activeConversation.owner.displayName?.trim() || activeConversation.owner.username}`
                        : 'Owner unavailable'
                    }
                    className="min-w-0 max-w-1/2 truncate"
                  >
                    Owner:{' '}
                    {activeConversation.owner?.displayName?.trim() ||
                      activeConversation.owner?.username ||
                      'Unknown'}
                  </span>
                  <span
                    data-ui="chat-trigger-badge"
                    data-conversation-id={activeConversation.id}
                    data-user-id={
                      activeConversation.latestTrigger?.user?.id ?? ''
                    }
                    title={`Triggered by: ${
                      activeConversation.latestTrigger?.user?.displayName?.trim() ||
                      activeConversation.latestTrigger?.user?.username ||
                      'Automation'
                    }`}
                    className="min-w-0 max-w-1/2 truncate"
                  >
                    {activeConversation.latestTrigger?.user?.displayName?.trim() ||
                      activeConversation.latestTrigger?.user?.username ||
                      'Automation'}
                  </span>
                </div>
              )}
              {activeConvId && (
                <div
                  data-ui="chat-technical-metadata-row"
                  className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground/60"
                >
                  {(() => {
                    const conv = activeConversation;
                    const hasRemoteSession =
                      conv?.session_id && conv.session_id !== activeConvId;
                    const session_id = hasRemoteSession
                      ? conv.session_id
                      : null;
                    const sessionIdentity = session_id || activeConvId;
                    const shortId = activeConvId.slice(-6);
                    const copyLabel = session_id
                      ? 'Copy full session ID'
                      : 'Copy conversation ID';
                    return (
                      <span
                        className="flex min-w-0 items-center gap-0.5 font-mono"
                        title={
                          session_id
                            ? `Session ID: ${session_id}`
                            : `Conversation ID: ${activeConvId}`
                        }
                      >
                        <span className="truncate">
                          session:{' '}
                          {session_id
                            ? session_id.length > 10
                              ? session_id.substring(0, 8) + '…'
                              : session_id
                            : shortId}
                        </span>
                        <button
                          type="button"
                          data-ui="copy-conversation-session"
                          className="inline-flex shrink-0 rounded p-0.5 transition-colors hover:bg-muted hover:text-foreground"
                          title={copyLabel}
                          aria-label={copyLabel}
                          onClick={() => {
                            void copyToClipboard(sessionIdentity).then(
                              (copied) => {
                                if (copied)
                                  toast.success(
                                    session_id
                                      ? 'Session ID copied'
                                      : 'Conversation ID copied',
                                  );
                              },
                            );
                          }}
                        >
                          <Copy className="size-2.5" />
                        </button>
                      </span>
                    );
                  })()}
                  {cacheExpiresAtMs !== null && !isAgentRunning && (
                    <PromptCacheCountdown expiresAtMs={cacheExpiresAtMs} />
                  )}
                  {(() => {
                    const conv = activeConversation;
                    if (!conv?.use_worktree) return null;
                    const branch = conv.branch_name || `chat-${activeConvId}`;
                    const unavailable = Boolean(conv.worktreeMissing);
                    return (
                      <span
                        className="flex min-w-0 max-w-[200px] items-center gap-1 truncate font-mono"
                        title={
                          unavailable
                            ? `Worktree "${branch}" is unavailable and will be recreated on resume`
                            : conv.worktree_path
                              ? `Worktree: ${branch} (${conv.worktree_path})`
                              : `Worktree: ${branch}`
                        }
                      >
                        <GitBranch className="size-3 shrink-0" />
                        <span className="truncate">{branch}</span>
                        {unavailable && (
                          <span className="text-muted-foreground/50">
                            (unavailable)
                          </span>
                        )}
                        <button
                          type="button"
                          data-ui="copy-conversation-worktree"
                          className="inline-flex shrink-0 rounded p-0.5 transition-colors hover:bg-muted hover:text-foreground"
                          title="Copy worktree branch"
                          aria-label="Copy worktree branch"
                          onClick={() => {
                            void copyToClipboard(branch).then((copied) => {
                              if (copied)
                                toast.success('Worktree branch copied');
                            });
                          }}
                        >
                          <Copy className="size-2.5" />
                        </button>
                      </span>
                    );
                  })()}
                  {renderedMessages.length > 0 && (
                    <span
                      className="tabular-nums"
                      title="Estimated tokens in current conversation"
                    >
                      ~
                      {Math.round(
                        renderedMessages.reduce(
                          (s, m) =>
                            s + Math.max(1, Math.round(m.content.length / 4)),
                          0,
                        ),
                      ).toLocaleString()}{' '}
                      tokens
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {activeConvId &&
              (() => {
                const conversation = activeConversation;
                const costUsd = conversation?.costUsd;
                return costUsd != null ? (
                  <span
                    className={`hidden text-xs tabular-nums sm:inline ${COST_TEXT_CLASS}`}
                    title={
                      conversation?.costEstimated
                        ? 'Estimated conversation cost; some historical turns only recorded output tokens'
                        : 'Total measured cost for this conversation'
                    }
                  >
                    {conversation?.costEstimated ? '~$' : '$'}
                    {costUsd.toFixed(4)}
                  </span>
                ) : null;
              })()}
            {activeConversation && (
              <ConversationActionsMenu
                conv={activeConversation}
                projectId={project_id}
                {...conversationActions(activeConversation)}
                onStartRename={() => setHeaderRenaming(true)}
                dataUi="chat-header-conversation-actions"
              />
            )}
            {/* Mode switcher and settings are now in the top-level Header */}
          </div>
        </div>

        {/* Messages */}
        {previousTranscript && (
          <PreviousTranscriptLayer
            previous={previousTranscript}
            dataUi="chat-previous-transcript"
          />
        )}
        <div
          ref={scrollRef}
          data-ui="chat-transcript-scroll"
          data-transcript-revealed={String(!transcriptGated)}
          aria-busy={transcriptGated || undefined}
          role="log"
          aria-label="Conversation"
          aria-live="off"
          className={cn(
            'relative min-h-0 flex-1 overflow-y-auto px-3 py-5 sm:px-4',
            transcriptGated && 'opacity-0',
          )}
          onScroll={handleScrollUpLoad}
        >
          {isFetchingOlderTranscript && !isLoading && (
            // Zero-height overlay: a spinner in the flow shifts the list down
            // by its own height while loading and back up when it goes away.
            <div
              className="pointer-events-none sticky top-0 z-10 flex h-0 justify-center"
              role="status"
              aria-label="Loading earlier messages"
            >
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          )}
          {!isLoading && renderedMessages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center gap-4">
              <div>
                <p className="text-muted-foreground text-sm">
                  No messages yet.
                </p>
                <p className="text-muted-foreground text-xs mt-1">
                  Send a message to start chatting.
                </p>
              </div>
              {showWorktreeSelector && (
                <div className="flex flex-col items-center gap-1.5">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="sm"
                        variant={use_worktree ? 'default' : 'outline'}
                        className="gap-1.5 max-w-[260px]"
                      >
                        <GitBranch className="size-3.5 shrink-0" />
                        <span className="truncate">
                          {use_worktree
                            ? (worktreeBranch ?? 'New worktree')
                            : 'No worktree'}
                        </span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="center" className="w-64">
                      <DropdownMenuLabel>
                        Run this chat in a worktree
                      </DropdownMenuLabel>
                      <DropdownMenuItem
                        onClick={() => {
                          setUseWorktree(false);
                          setWorktreeBranch(null);
                        }}
                      >
                        <Check
                          className={cn(
                            'size-3.5',
                            !use_worktree ? 'opacity-100' : 'opacity-0',
                          )}
                        />
                        No worktree
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => {
                          setUseWorktree(true);
                          setWorktreeBranch(null);
                        }}
                      >
                        <Check
                          className={cn(
                            'size-3.5',
                            use_worktree && !worktreeBranch
                              ? 'opacity-100'
                              : 'opacity-0',
                          )}
                        />
                        New worktree
                      </DropdownMenuItem>
                      {(repoWorktrees?.length ?? 0) > 0 && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuLabel className="text-xs text-muted-foreground">
                            Existing worktrees
                          </DropdownMenuLabel>
                          {repoWorktrees!.map((wt) => (
                            <DropdownMenuItem
                              key={wt.branch}
                              onClick={() => {
                                setUseWorktree(true);
                                setWorktreeBranch(wt.branch);
                              }}
                              title={wt.path}
                            >
                              <Check
                                className={cn(
                                  'size-3.5',
                                  worktreeBranch === wt.branch
                                    ? 'opacity-100'
                                    : 'opacity-0',
                                )}
                              />
                              <span className="truncate">{wt.branch}</span>
                            </DropdownMenuItem>
                          ))}
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  {use_worktree && (
                    <p className="text-[10px] text-muted-foreground">
                      The worktree is created on the first message.
                    </p>
                  )}
                </div>
              )}
              {(project?.settings?.starterPrompts ?? []).length > 0 && (
                <div className="flex flex-wrap justify-center gap-2 max-w-lg">
                  {(project?.settings?.starterPrompts ?? []).map((sp, i) => (
                    <button
                      key={i}
                      type="button"
                      className="rounded-full border border-border bg-background px-3 py-1.5 text-sm text-foreground hover:bg-muted transition-colors"
                      onClick={() => {
                        if (textareaRef.current) {
                          textareaRef.current.value = sp.prompt;
                          autoResize();
                          textareaRef.current.focus();
                        }
                      }}
                    >
                      {sp.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {!isLoading &&
            canSetUpProject &&
            (!projectHasRepository(project!) || needsGitInitialization) && (
              <RepositorySetupPrompt
                reason={needsGitInitialization ? 'not-initialized' : 'no-repo'}
                onSetup={() =>
                  prepareProjectSetup(
                    needsGitInitialization
                      ? GIT_INITIALIZATION_SETUP_PROMPT
                      : REPOSITORY_SETUP_PROMPT,
                  )
                }
                onSettings={() => setSettingsProjectId(project_id)}
              />
            )}
          <div
            ref={messagesContentRef}
            data-ui="chat-mounted-transcript-window"
            data-conversation-id={activeConvId ?? undefined}
            data-hidden-row-count={hiddenTranscriptRowCount}
            inert={transcriptGated}
            className={cn(CHAT_COLUMN_CLASS, 'space-y-6')}
          >
            {hiddenTranscriptRowCount > 0 && (
              <button
                type="button"
                data-ui="chat-load-older-rendered-messages"
                className="mx-auto block rounded-full border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground"
                onClick={() => {
                  const latestTailStart = Math.max(
                    0,
                    (ownershipStableTranscriptEntries?.length ?? 0) -
                      TRANSCRIPT_RENDER_BATCH,
                  );
                  const fillsMiddleGap =
                    transcriptRevealed && latestTailStart > anchorEnd;
                  if (scrollRef.current && !fillsMiddleGap) {
                    prevScrollHeightRef.current =
                      scrollRef.current.scrollHeight;
                    captureOlderAnchor();
                  }
                  setTranscriptWindow((window) => {
                    const hasMiddleGap =
                      window.revealed && latestTailStart > window.anchorEnd;
                    const nextStart = hasMiddleGap
                      ? window.anchorStart
                      : Math.max(
                          0,
                          window.anchorStart - TRANSCRIPT_RENDER_BATCH,
                        );
                    const nextEnd = hasMiddleGap
                      ? Math.min(
                          ownershipStableTranscriptEntries?.length ??
                            window.anchorEnd,
                          window.anchorEnd + TRANSCRIPT_RENDER_BATCH,
                        )
                      : window.anchorEnd;
                    return {
                      ...window,
                      rowCount: window.rowCount + TRANSCRIPT_RENDER_BATCH,
                      revealed: true,
                      anchorStart: nextStart,
                      anchorEnd: nextEnd,
                      anchorKey: hasMiddleGap
                        ? window.anchorKey
                        : transcriptEntryKey(
                            ownershipStableTranscriptEntries?.at(nextStart),
                          ),
                    };
                  });
                }}
              >
                Show earlier responses ({hiddenTranscriptRowCount})
              </button>
            )}
            {(() => {
              // Transcript pages can briefly retain multiple ephemeral persona
              // rows marked `streaming` while the canonical messages/refetch
              // catch up. Only the newest assistant row is actually live;
              // completed rows must never keep the pulsing telemetry dot.
              const activeStreamingMessageId = [...renderedMessagesWithSteering]
                .reverse()
                .find(
                  (entry) => entry.role === 'assistant' && entry.streaming,
                )?.id;
              const renderKeyOccurrences = new Map<string, number>();
              return renderedMessagesWithSteering.map((item, index) => {
                const renderKeyBase = `${item.role}:${simpleHash(
                  stripTalkingStickControl(item.content).trim(),
                )}`;
                const renderKeyOccurrence =
                  renderKeyOccurrences.get(renderKeyBase) ?? 0;
                renderKeyOccurrences.set(
                  renderKeyBase,
                  renderKeyOccurrence + 1,
                );
                const renderKey = stableMessageRenderKey(
                  item,
                  renderKeyOccurrence,
                );
                // Find the user's answer to any question in this assistant message
                let questionAnswerText: string | undefined;
                let sendMessageHandler: ((text: string) => void) | undefined;

                if (item.role === 'assistant') {
                  const nextUserContent = nextUserContentByAssistantId.get(
                    item.id,
                  );
                  if (nextUserContent !== undefined) {
                    // This assistant message has been answered — show the answer highlight
                    questionAnswerText = nextUserContent;
                  } else if (item.id === lastAssistantId) {
                    // This is the last assistant message with no answer yet — keep interactive
                    sendMessageHandler = handleQuestionAnswer;
                  }
                }

                const senderName = item.sender_name?.trim();
                const aiSenderId = item.senderUserId?.startsWith('ai:')
                  ? item.senderUserId
                  : item.agent_name?.startsWith('ai:')
                    ? item.agent_name
                    : item.agent_name?.startsWith('ai-main:')
                      ? `ai:${item.agent_name.slice('ai-main:'.length)}`
                      : undefined;
                const aiUser = aiSenderId
                  ? aiUsersBySenderId.get(aiSenderId)
                  : undefined;
                const aiUserId = aiSenderId?.slice(3);
                const virtualSenderAvatarUrl = personaAvatarUrl(
                  item,
                  aiUserId,
                  aiUser,
                );
                const virtualSenderAvatarFallbackUrl =
                  item.emote && aiUserId
                    ? (aiUser?.avatarUrl ?? aiUserAvatarUrl(aiUserId))
                    : undefined;
                const isOtherUser =
                  item.role === 'user' &&
                  (item.source === 'agent' ||
                    (item.senderUserId
                      ? item.senderUserId !== currentSenderUserId
                      : Boolean(
                          senderName &&
                          !['web', 'you'].includes(senderName.toLowerCase()) &&
                          senderName.toLowerCase() !==
                            currentSenderName.toLowerCase(),
                        )));

                const forkDivider =
                  forkDividerAfterId === item.id &&
                  activeConversation?.created_at ? (
                    <ChatForkDivider
                      forkedAt={activeConversation.created_at}
                      sourceLabel={forkSourceLabel}
                      onOpenSource={openForkSource}
                    />
                  ) : null;

                if (item.role === 'system')
                  return (
                    <Fragment key={renderKey}>
                      <HistoricalTaskMilestone item={item} />
                      {forkDivider}
                    </Fragment>
                  );

                return (
                  <Fragment key={renderKey}>
                    <ChatMessageBubble
                      id={item.id}
                      suppressInnerMessageId
                      dataUi={
                        item.role === 'assistant'
                          ? aiSenderId
                            ? item.streaming
                              ? 'chat-invited-persona-stream'
                              : 'chat-canonical-persona-transcript-message'
                            : 'chat-canonical-main-transcript-message'
                          : undefined
                      }
                      project_id={project_id}
                      conversation_id={activeConvId ?? undefined}
                      stream_key={item.streaming ? streamKey : undefined}
                      role={item.role}
                      content={stripTalkingStickControl(item.content)}
                      created_at={item.created_at}
                      source={item.source}
                      sender_name={
                        item.role === 'user'
                          ? isOtherUser
                            ? item.sender_name
                            : currentSenderName
                          : undefined
                      }
                      senderUserId={aiSenderId ?? item.senderUserId}
                      senderAvatarUrl={
                        item.role === 'user'
                          ? item.senderUserId === currentSenderUserId
                            ? currentSenderAvatarUrl
                            : item.senderAvatarUrl
                          : undefined
                      }
                      agent_name={item.agent_name}
                      assistantSenderName={
                        item.role === 'assistant' && !aiSenderId
                          ? (item.sender_name ??
                            config?.assistantName ??
                            'Agent')
                          : undefined
                      }
                      virtualSenderName={
                        aiUser?.name ??
                        (aiSenderId ? item.sender_name : undefined)
                      }
                      virtualSenderIdentity={aiUser?.identity}
                      virtualSenderAvatarUrl={virtualSenderAvatarUrl}
                      virtualSenderAvatarFallbackUrl={
                        virtualSenderAvatarFallbackUrl
                      }
                      speechText={item.speechText}
                      speechVoice={aiUser?.voiceId}
                      speechLang={aiUser?.voiceLang}
                      isOtherUser={isOtherUser}
                      thinking={item.thinking}
                      isStreaming={
                        item.streaming === true &&
                        item.id === activeStreamingMessageId &&
                        (chatRunning || sending)
                      }
                      onContentGrow={
                        item.id === lastAssistantId
                          ? scrollToBottomIfPinnedNow
                          : undefined
                      }
                      attachments={item.attachments}
                      deepLinks={item.deepLinks}
                      steeringDeliveryStatus={
                        item.role === 'user' && item.steeringDelivery ? (
                          <div
                            data-ui="chat-steering-acknowledgement"
                            data-steering-status={item.steeringDelivery}
                          >
                            <SteeringDeliveryStatus
                              delivery={item.steeringDelivery}
                            />
                          </div>
                        ) : undefined
                      }
                      isError={item.isError}
                      toolCallDisplay={toolCallDisplay}
                      onSendMessage={sendMessageHandler}
                      onImplementPlan={
                        item.role === 'assistant' && item.id === lastAssistantId
                          ? handleImplementPlan
                          : undefined
                      }
                      onSendPlanToKanban={
                        item.role === 'assistant' && item.id === lastAssistantId
                          ? handleSendPlanToKanban
                          : undefined
                      }
                      onOpenArtifact={openPlanArtifact}
                      questionAnswer={questionAnswerText}
                      onFork={
                        // "Fork from here" anchors on a USER message's stable id
                        // (the chat_message row id written to the transcript, e.g.
                        // `chat-<ts>-<rand>` — the only reliably resolvable id).
                        //
                        // On a USER bubble: fork up to and including that message;
                        // the fork prompt replaces the assistant reply (flag=false).
                        //
                        // On an ASSISTANT bubble: fork AFTER that turn — anchor on
                        // the preceding user message and INCLUDE the assistant reply
                        // that follows it (flag=true). We pass the preceding user
                        // id (not the assistant bubble's reconstructed id, which
                        // doesn't map to any chat_message row) so the backend can
                        // slice deterministically instead of copying the whole
                        // conversation.
                        item.role === 'user'
                          ? () => handleSelectForkMessage(item.id, false)
                          : (() => {
                              let anchor: string | null = null;
                              for (let j = index - 1; j >= 0; j--) {
                                if (
                                  renderedMessagesWithSteering[j].role ===
                                  'user'
                                ) {
                                  anchor = renderedMessagesWithSteering[j].id;
                                  break;
                                }
                              }
                              return anchor
                                ? () => handleSelectForkMessage(anchor, true)
                                : transcriptTurnContext.assistantForkAnchors.has(
                                      item.id,
                                    )
                                  ? () =>
                                      handleSelectForkMessage(
                                        transcriptTurnContext.assistantForkAnchors.get(
                                          item.id,
                                        )!,
                                        true,
                                      )
                                  : undefined;
                            })()
                      }
                      telemetry={item.telemetry}
                      pinInnerToBottom={item.id === lastAssistantId}
                      observeInnerScroll={item.id === lastAssistantId}
                      deferMarkdown={item.id !== lastAssistantId}
                      innerScrollStateRef={
                        item.id === persistedStreamedMessageId
                          ? streamingInnerScrollStateRef
                          : undefined
                      }
                    />
                    {forkDivider}
                    {inlineStreamingAnchorId === item.id && streamingBubble}
                  </Fragment>
                );
              });
            })()}
            {/*
             * StreamingBubble owns the entire "pending" render — both the
             * Thinking… placeholder AND the real assistant bubble — so the
             * message list never sees a sibling swap between two different
             * thinking elements. Previously the parent rendered a separate
             * inline Thinking… badge that was removed the moment the first
             * chunk arrived, causing a brief layout shift on every user send.
             * `isRunning` is passed in so the bubble can render its placeholder
             * during the "agent started, no chunks yet" window that the old
             * inline badge used to cover.
             */}
            {!inlineStreamingAnchorId && streamingBubble}
            {fallbackSteeringMessages.map((steeringMessage) => (
              <div
                key={steeringMessage.localId}
                data-ui="chat-steering-message"
                data-steering-status={steeringMessage.delivery}
                className="space-y-1"
              >
                <ChatMessageBubble
                  id={steeringMessage.serverId ?? steeringMessage.localId}
                  role="user"
                  content={steeringMessage.content}
                  attachments={steeringMessage.attachments}
                  steeringDeliveryStatus={
                    <div
                      data-ui="chat-steering-acknowledgement"
                      data-steering-status={steeringMessage.delivery}
                    >
                      <SteeringDeliveryStatus
                        delivery={steeringMessage.delivery}
                      />
                    </div>
                  }
                  created_at={steeringMessage.createdAt}
                  source="web"
                  sender_name={currentSenderName}
                  senderUserId={currentSenderUserId}
                  senderAvatarUrl={currentSenderAvatarUrl}
                />
              </div>
            ))}
            <StallWarningBanner conversationId={convIdForStream ?? null} />
            <BackgroundTasksBanner
              conversationId={convIdForStream ?? null}
              projectId={project_id}
            />
            <QueuedPromptList
              prompts={queuedPrompts}
              hiddenPromptIds={hiddenQueuedPromptIds}
              isAgentRunning={isAgentRunning}
              canSteer={canSteerActiveTurn}
              onSteer={handleSteerQueuedPrompt}
              onEdit={handleEditQueuedPrompt}
              onDelete={handleDeleteQueuedPrompt}
            />
            {/* Retry affordance — shown when the last response errored out */}
            {lastResponseIsError && (
              <div className="flex justify-start">
                <div
                  data-ui="chat-failure-recovery"
                  className="max-w-[75%] min-w-0 rounded-lg px-3 py-2 bg-destructive/10 border border-destructive/30"
                >
                  <p className="text-xs text-muted-foreground mb-2">
                    {shouldContinueFailedResponse
                      ? shouldContinueAfterTimeout
                        ? 'The previous turn timed out. Continue from where it stopped?'
                        : 'The previous turn stopped after a partial response. Continue from where it stopped?'
                      : 'The last response failed. Retry the last prompt?'}
                  </p>
                  <Button
                    data-ui="chat-failure-recovery-action"
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs border-destructive/40 hover:bg-destructive/20"
                    onClick={handleRetryLast}
                  >
                    <RotateCcw className="size-3.5 mr-1" />
                    {shouldContinueFailedResponse
                      ? 'Continue'
                      : 'Retry last prompt'}
                  </Button>
                </div>
              </div>
            )}
          </div>
          <ChatJumpToLatest
            scrollRef={scrollRef}
            contentRef={messagesContentRef}
            resetKey={activeConvId}
            onJump={scrollToBottom}
          />
        </div>
        <span className="sr-only" role="status" aria-live="polite">
          {runAnnouncement}
        </span>

        <div className="border-t border-border px-4 py-4 flex-shrink-0 bg-background/50 backdrop-blur-md">
          <div className={cn(CHAT_COLUMN_CLASS, 'space-y-2')}>
            <div className={cn(!effectiveLiveModeEnabled && 'hidden')}>
              <LiveModePanel
                ref={liveModePanelRef}
                projectId={project_id}
                activeConversationId={activeConvId}
                agentCmd={agentCmdOverride}
                runtimeSelection={runtimeSelection ?? undefined}
                personaDriven={chatPersonaDriven}
                draftEnabled={draftLiveModeEnabled}
                draftKind={draftLiveModeKind}
                onDraftEnabledChange={setDraftLiveModeEnabled}
                onDraftKindChange={setDraftLiveModeKind}
                onDraftTranscript={(text) =>
                  handleSend(undefined, undefined, text)
                }
              />
            </div>
            {activeConvId && memoryCapsuleByConv[activeConvId] && (
              <details
                data-ui="memory-capsule-preview"
                data-conversation-id={activeConvId}
                // Translucent violet fill reads on both themes; only the border tone is theme-swapped.
                className="rounded-lg border border-violet-600/30 bg-violet-500/5 px-3 py-2 text-xs dark:border-violet-500/20"
              >
                <summary className="flex cursor-pointer list-none items-center gap-2 font-medium text-violet-700 dark:text-violet-300">
                  <BrainCircuit className="size-3.5" />
                  {memoryCapsuleByConv[activeConvId].capsule
                    ? `${MEMORY_LEVEL_LABELS[memoryCapsuleByConv[activeConvId].level]} memory capsule used`
                    : `${MEMORY_LEVEL_LABELS[memoryCapsuleByConv[activeConvId].level]} requested · no capsule produced`}
                  <span className="ml-auto text-[10px] font-normal text-muted-foreground">
                    ephemeral · not in transcript
                  </span>
                </summary>
                {memoryCapsuleByConv[activeConvId].capsule && (
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-background/60 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                    {memoryCapsuleByConv[activeConvId].capsule}
                  </pre>
                )}
              </details>
            )}
            {/* Fork indicator — when a fork point is selected, the normal
                composer below becomes the fork form: type the prompt, pick the
                agent, add attachments, and press Send (or ↵) to fork. */}
            {forkFromMessageId && forkedMessage && (
              <div className="bg-muted/50 rounded-lg p-2 flex items-start gap-2 border border-primary/20">
                <GitFork className="size-3.5 mt-0.5 text-primary shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-primary">
                    Forking from here
                    {forkIncludeAssistantTurn ? ' (incl. assistant reply)' : ''}
                  </div>
                  <p className="text-[11px] text-muted-foreground line-clamp-1 italic">
                    &ldquo;{forkedMessage.content.substring(0, 160)}&rdquo;
                  </p>
                </div>
                <button
                  onClick={() => {
                    setForkFromMessageId(null);
                    setForkIncludeAssistantTurn(false);
                  }}
                  title="Cancel fork"
                  className="text-muted-foreground hover:text-foreground p-0.5 rounded shrink-0"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            )}
            {/* Pending file chips */}
            {pendingAttachments.length > 0 && (
              <AttachmentChips
                attachments={pendingAttachments}
                onRemove={removeAttachment}
              />
            )}

            {/* Slash command autocomplete dropdown */}
            {slashVisible && filteredSlashCommands.length > 0 && (
              <div className="bg-popover border border-border rounded-md shadow-md overflow-hidden">
                {filteredSlashCommands.slice(0, 8).map((cmd, i) => (
                  <button
                    key={cmd.name}
                    className={cn(
                      'w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-accent',
                      i === slashSelectedIndex && 'bg-accent',
                    )}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectSlashCommand(cmd);
                    }}
                  >
                    <span className="font-mono font-medium text-primary shrink-0">
                      /{cmd.name}
                    </span>
                    <span className="text-muted-foreground truncate text-xs">
                      {cmd.description}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {/* Unified Input Card. The wrapper is the container the card's
                layout adapts to, so the composer follows its own width (e.g.
                with the workspace pane open) rather than the viewport. */}
            <div className="@container">
              <div
                data-ui="chat-composer"
                className={cn(
                  composerCardClassName,
                  // From the @md container width up the input row is flattened
                  // into this grid: the textarea spans the card and the
                  // dictation/send cluster sits in the footer's row. Below it
                  // the row keeps its own wrap.
                  !(meetingRecordingState.isRecording || showMeetingPanel) &&
                    '@md:grid @md:grid-cols-[minmax(0,1fr)_auto]',
                )}
              >
                {(meetingRecordingState.isRecording || showMeetingPanel) && (
                  <MeetingRecordingOverlay
                    state={meetingRecordingState}
                    languages={meetingLanguages}
                    visible
                    onStop={handleStopMeetingRecording}
                    onDismiss={handleDismissMeetingPanel}
                    onResume={() => {
                      void handleResumeMeetingRecording();
                    }}
                    resumeDisabled={
                      !canRecordMeeting ||
                      meetingRecordingState.isStarting ||
                      meetingRecordingState.isStopping
                    }
                    onPromptAgent={handleMeetingAgentPrompt}
                    hearsAudio={selectedRuntimeHearsAudio}
                    onOpenFile={openMeetingFile}
                  />
                )}

                {!(meetingRecordingState.isRecording || showMeetingPanel) && (
                  <>
                    <div className="flex gap-2 items-end p-2 pb-1.5 @max-md:flex-wrap @max-md:justify-end @max-md:gap-y-0 @md:contents">
                      <input
                        ref={cameraInputRef}
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="hidden"
                        onChange={(e) =>
                          e.target.files && addFiles(e.target.files)
                        }
                      />
                      <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        className="hidden"
                        onChange={(e) =>
                          e.target.files && addFiles(e.target.files)
                        }
                      />
                      <div className="relative flex-1 group min-w-0 @max-md:contents @md:col-span-2 @md:row-start-1 @md:p-2 @md:pb-1.5">
                        <Textarea
                          ref={setComposerTextarea}
                          onKeyDown={handleKeyDown}
                          onPaste={handleAttachmentPaste}
                          onChange={autoResize}
                          onBlur={hideSlash}
                          placeholder={
                            forkFromMessageId
                              ? 'Describe how the fork should continue…'
                              : 'Message…'
                          }
                          rows={1}
                          className={cn(
                            composerTextareaClassName,
                            'flex-1 resize-none text-base @md:text-[17px] px-1 py-1.5 min-h-[42px] @md:min-h-[82px] @md:pr-8 break-all min-w-0 @max-md:basis-full',
                          )}
                          style={{ overflowY: 'hidden' }}
                        />
                        {hasText && (
                          <Button
                            data-ui="chat-stop-agent"
                            size="icon"
                            onClick={clearDraft}
                            title="Clear input"
                            aria-label="Clear input"
                            // White on the filled @md:bg-red-600 clear button
                            // keeps >= 4.5:1 in both themes.
                            className="size-9 rounded-xl bg-transparent text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5 hover:text-foreground @md:absolute @md:top-1 @md:right-1 @md:size-6 @md:rounded-full @md:bg-red-600 @md:text-white @md:shadow-lg @md:shadow-red-500/20 @md:hover:bg-red-700 @md:hover:text-white dark:@md:bg-red-500 dark:@md:hover:bg-red-600 animate-in fade-in zoom-in duration-200 border-none"
                          >
                            <X className="size-4 @md:size-3" />
                          </Button>
                        )}
                      </div>

                      <div className="relative flex items-center gap-1.5 @max-md:contents @md:col-start-2 @md:row-start-2 @md:border-t @md:border-black/5 @md:py-1.5 @md:pr-3 dark:@md:border-white/5">
                        {isDictating &&
                          !effectiveLiveModeEnabled &&
                          dictation.listening && (
                            <ListeningLanguagePicker
                              dataUi="composer-dictation-language"
                              selectDataUi="composer-dictation-language-select"
                              language={dictation.listening.language}
                              value={dictationLanguage}
                              options={dictationLanguageOptions}
                              title="Dictation language"
                              ariaLabel="Dictation language"
                              compactBelowMd
                              onChange={(code) => {
                                resumeDictationRef.current =
                                  code !== dictationLanguage;
                                setDictationLanguage(code);
                              }}
                            />
                          )}
                        {(isDictating || isRecordingVoice) &&
                          !effectiveLiveModeEnabled && (
                            <MicLevelMeter
                              levelRef={micLevelRef}
                              startedAt={voiceRecorder.startedAt}
                            />
                          )}
                        {!effectiveLiveModeEnabled &&
                          !meetingRecordingState.isRecording &&
                          !showMeetingPanel && (
                            <Button
                              data-ui="composer-dictation"
                              size="icon"
                              variant="ghost"
                              data-voice-mode={
                                isRecordingVoice ||
                                (selectedRuntimeHearsAudio && !isDictating)
                                  ? 'voice-message'
                                  : 'dictation'
                              }
                              onClick={() => {
                                // Stop keeps what was said: the open phrase is committed and
                                // inserted once transcribed (the button shows the pending
                                // spinner). Sending and unmounting still hard-stop.
                                if (isRecordingVoice) void finishVoiceMessage();
                                else if (isDictating) void dictation.finish();
                                else if (selectedRuntimeHearsAudio)
                                  void voiceRecorder.start();
                                else void dictation.start();
                              }}
                              title={
                                isRecordingVoice
                                  ? 'Stop and attach voice message'
                                  : isDictating
                                    ? 'Stop dictation'
                                    : selectedRuntimeHearsAudio
                                      ? 'Record voice message'
                                      : 'Start dictation'
                              }
                              aria-pressed={isDictating || isRecordingVoice}
                              disabled={isDictationPending}
                              className={cn(
                                'size-9 rounded-xl text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5 hover:text-foreground @md:size-8',
                                (isDictating || isRecordingVoice) &&
                                  // Translucent red fill + hover read on both themes; only the text tones are theme-swapped.
                                  'bg-red-500/10 text-red-600 hover:bg-red-500/20 hover:text-red-700 dark:text-red-500 dark:hover:text-red-400',
                              )}
                            >
                              {isDictationPending ? (
                                <Loader2 className="size-4 animate-spin" />
                              ) : isDictating || isRecordingVoice ? (
                                <Square className="size-4 fill-current" />
                              ) : (
                                <Mic className="size-5" />
                              )}
                            </Button>
                          )}

                        <div className="flex items-center gap-1.5">
                          {isAgentRunning && (
                            <Button
                              size="icon"
                              variant="outline"
                              onClick={handleStop}
                              disabled={stopping}
                              title="Stop running agent"
                              aria-label="Stop running agent"
                              className={composerStopButtonClassName}
                            >
                              {stopping ? (
                                <Loader2 className="size-4 animate-spin" />
                              ) : (
                                <Square className="size-4" />
                              )}
                            </Button>
                          )}
                          {hasSendableComposerContent && (
                            <Button
                              data-ui="chat-send-message"
                              size="icon"
                              onClick={() => handleSend()}
                              aria-label={
                                forkFromMessageId
                                  ? 'Fork and send'
                                  : isAgentRunning
                                    ? effectiveLiveModeEnabled
                                      ? 'Steer current turn'
                                      : 'Queue as next turn'
                                    : 'Send message'
                              }
                              title={
                                forkFromMessageId
                                  ? 'Fork & send (↵)'
                                  : isAgentRunning
                                    ? effectiveLiveModeEnabled
                                      ? 'Steer current turn (↵)'
                                      : 'Queue as next turn (↵)'
                                    : 'Send (↵)'
                              }
                              className={cn(
                                composerSendButtonClassName,
                                forkFromMessageId &&
                                  'bg-primary text-primary-foreground hover:bg-primary/90 shadow-primary/20',
                              )}
                              disabled={
                                isForkPending ||
                                (!activeConvId && !!pendingNewConversationEntry)
                              }
                            >
                              {isForkPending ? (
                                <Loader2 className="size-4 animate-spin" />
                              ) : forkFromMessageId ? (
                                <GitFork className="size-4" />
                              ) : (
                                <Send className="size-4" />
                              )}
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                    <span className="sr-only" role="status" aria-live="polite">
                      {isRecordingVoice
                        ? 'Recording voice message'
                        : isDictationPending
                          ? 'Dictation transcribing'
                          : isDictating
                            ? dictation.status === 'hearing'
                              ? 'Dictation hearing speech'
                              : 'Dictation listening'
                            : dictation.error || 'Dictation stopped'}
                    </span>
                  </>
                )}

                {/* Input Footer: Attachments, Agent Selector, and Shortcutting hints */}
                <div
                  className={cn(
                    composerFooterClassName,
                    '@md:col-start-1 @md:row-start-2 @md:min-w-0',
                  )}
                >
                  <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 @md:gap-2.5">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          data-ui="composer-add-menu"
                          size="icon"
                          variant="ghost"
                          title="Add"
                          className={composerFooterIconButtonClassName}
                        >
                          <Plus className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        data-ui="composer-add-menu-content"
                        align="start"
                        side="top"
                        className="w-64 sm:w-44"
                      >
                        <DropdownMenuItem
                          onSelect={() => cameraInputRef.current?.click()}
                        >
                          <Camera />
                          Take photo
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => fileInputRef.current?.click()}
                        >
                          <Paperclip />
                          Attach files
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          data-ui="composer-add-knowledge"
                          onSelect={() => setKnowledgePickerOpen(true)}
                        >
                          <BookOpen />
                          Add knowledge document
                        </DropdownMenuItem>
                        {!effectiveLiveModeEnabled && (
                          <>
                            <DropdownMenuItem
                              data-ui="start-live-mode-menu-item"
                              disabled={!chatPersonaDriven}
                              onSelect={() =>
                                liveModePanelRef.current?.start('personas')
                              }
                            >
                              <Radio />
                              <span className="flex flex-col">
                                Live Mode · Persona
                                {!chatPersonaDriven && (
                                  <span
                                    data-ui="start-live-mode-persona-hint"
                                    className="text-xs text-muted-foreground"
                                  >
                                    {PERSONA_LIVE_MODE_HINT}
                                  </span>
                                )}
                              </span>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              data-ui="start-live-mode-work-menu-item"
                              onSelect={() =>
                                liveModePanelRef.current?.start('work')
                              }
                            >
                              <Radio />
                              Live Mode · Work
                            </DropdownMenuItem>
                          </>
                        )}
                        {!objective_id && activeConvId && (
                          <DropdownMenuItem
                            data-ui="new-conversation-same-settings"
                            onSelect={handleNewConversationWithSameSettings}
                            disabled={
                              invitedAiUsersPending || mainAiUserPending
                            }
                          >
                            <Copy />
                            New conversation with same settings
                          </DropdownMenuItem>
                        )}
                        {!objective_id && activeConvId && (
                          <DropdownMenuSub>
                            <DropdownMenuSubTrigger disabled={handoffPending}>
                              {handoffPending ? (
                                <Loader2 className="animate-spin" />
                              ) : (
                                <ArrowRightLeft />
                              )}
                              Continue in project…
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent className="max-h-72 w-56 overflow-y-auto">
                              <DropdownMenuLabel>
                                Start a fresh session in
                              </DropdownMenuLabel>
                              {handoffProjectOptions.map((project) => {
                                const Icon = project.settings?.isParent
                                  ? Layers
                                  : Folder;
                                return (
                                  <DropdownMenuItem
                                    key={project.id}
                                    data-ui="continue-in-project-option"
                                    data-project-id={project.id}
                                    aria-level={project.depth + 1}
                                    style={{
                                      paddingLeft: `${0.5 + project.depth * 1.125}rem`,
                                    }}
                                    onSelect={() => {
                                      setHandoffPending(true);
                                      void handoffConversation(
                                        project_id,
                                        activeConvId,
                                        project.id,
                                        runtimeSelection,
                                      )
                                        .then((result) => {
                                          useStore
                                            .getState()
                                            .setActiveConvForProject(
                                              result.destinationProjectId,
                                              result.conversation.id,
                                            );
                                          queryClient.invalidateQueries({
                                            queryKey:
                                              queryKeys.conversations.all(
                                                result.destinationProjectId,
                                              ),
                                          });
                                          toast.success(
                                            `Continued in ${project.name}`,
                                          );
                                          navigate({
                                            to: '/chat/$projectId',
                                            params: {
                                              projectId:
                                                result.destinationProjectId,
                                            },
                                          });
                                        })
                                        .catch((error) => {
                                          toast.error(
                                            `Failed to create handoff: ${error instanceof Error ? error.message : String(error)}`,
                                          );
                                        })
                                        .finally(() =>
                                          setHandoffPending(false),
                                        );
                                    }}
                                  >
                                    <Icon
                                      className={cn(
                                        'size-3.5 shrink-0',
                                        project.settings?.isParent
                                          ? 'text-violet-600 dark:text-violet-400'
                                          : 'text-muted-foreground',
                                      )}
                                    />
                                    <span className="min-w-0 flex-1 truncate">
                                      {project.name}
                                    </span>
                                  </DropdownMenuItem>
                                );
                              })}
                              {handoffProjectOptions.length === 0 && (
                                <DropdownMenuItem disabled>
                                  No other projects available
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
                        )}
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger>
                            <Bot />
                            Mode
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent>
                            {modeOptions.map((mode) => (
                              <DropdownMenuItem
                                key={mode.id}
                                role="menuitemradio"
                                aria-checked={chatModeOverride === mode.id}
                                onSelect={() => setChatModeOverride(mode.id)}
                              >
                                <Check
                                  className={cn(
                                    'size-3.5 shrink-0',
                                    chatModeOverride === mode.id
                                      ? 'opacity-100'
                                      : 'opacity-0',
                                  )}
                                />
                                {mode.label}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                        {canRecordMeeting &&
                          !meetingRecordingState.isRecording && (
                            <DropdownMenuSub>
                              <DropdownMenuSubTrigger
                                disabled={
                                  showMeetingPanel ||
                                  meetingRecordingState.isStarting
                                }
                              >
                                {meetingRecordingState.isStarting ? (
                                  <Loader2 className="animate-spin" />
                                ) : (
                                  <Video />
                                )}
                                Record meeting
                              </DropdownMenuSubTrigger>
                              <DropdownMenuSubContent>
                                {meetingLanguages.map((lang) => (
                                  <DropdownMenuItem
                                    key={lang.code}
                                    onSelect={() => {
                                      void handleStartMeetingRecording(
                                        lang.code,
                                      );
                                    }}
                                  >
                                    {lang.label}
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuSubContent>
                            </DropdownMenuSub>
                          )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    {selectedModeOption && (
                      <span className="inline-flex h-7 items-center gap-1 rounded-lg border border-black/15 bg-black/10 px-2 text-[11px] font-medium text-foreground dark:border-white/15 dark:bg-white/10">
                        {selectedModeOption.label}
                        <button
                          type="button"
                          className="inline-flex size-4 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                          title="Clear mode"
                          onClick={() => setChatModeOverride(null)}
                        >
                          <X className="size-3" />
                        </button>
                      </span>
                    )}
                    <div
                      data-ui="runtime-memory-controls"
                      className="flex w-0 min-w-0 flex-1 items-center gap-1 @md:w-auto @md:flex-initial @md:gap-2"
                    >
                      {runtimeCatalog && runtimeSelection ? (
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button
                              data-ui="runtime-selector"
                              variant="ghost"
                              size="xs"
                              className={cn(
                                composerPillClassName,
                                'flex-1 @md:max-w-[12rem] @md:flex-initial @3xl:max-w-none',
                              )}
                            >
                              <RuntimeHarnessIcon
                                icon={selectedRuntimeHarness?.icon}
                                className="size-6 shrink-0 opacity-90"
                              />
                              <span className="truncate">{runtimeSummary}</span>
                              <ChevronDown className="size-2.5 shrink-0 opacity-50" />
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent
                            align="start"
                            side="top"
                            collisionPadding={8}
                            className="w-[min(266px,calc(100vw-1rem))]"
                          >
                            <RuntimePicker
                              projectId={project_id}
                              catalog={runtimeCatalog}
                              value={runtimeSelection}
                              onChange={(value) =>
                                value && applyRuntimeSelection(value)
                              }
                              allowClear={false}
                              presets={runtimeCatalog.presets}
                              presentation="panel"
                              promptCache1h={
                                objective_id ? undefined : promptCache1hEnabled
                              }
                              onPromptCache1hChange={
                                objective_id
                                  ? undefined
                                  : (enabled) =>
                                      promptCache1hMutation.mutate(enabled)
                              }
                            />
                          </PopoverContent>
                        </Popover>
                      ) : (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              data-ui="runtime-selector"
                              variant="ghost"
                              size="xs"
                              className={cn(
                                composerPillClassName,
                                'flex-1 @md:max-w-[12rem] @md:flex-initial @3xl:max-w-none',
                              )}
                            >
                              <RuntimeHarnessIcon
                                icon={selectedRuntimeHarness?.icon}
                                className="size-6 shrink-0 opacity-90"
                              />
                              <span className="truncate">{runtimeSummary}</span>
                              <ChevronDown className="size-2.5 shrink-0 opacity-50" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="start"
                            side="top"
                            className="w-[min(15rem,calc(100vw-2rem))] text-xs sm:w-[min(18rem,calc(100vw-2rem))] sm:text-sm"
                          >
                            <DropdownMenuLabel className="text-[11px] text-muted-foreground sm:text-xs">
                              Runtime
                            </DropdownMenuLabel>
                            {agentOptions.map((option) => (
                              <DropdownMenuItem
                                key={option.id}
                                onSelect={() => setAgentCmdOverride(option.id)}
                              >
                                {option.label}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            data-ui="participants-selector"
                            aria-label={
                              participantsSummary === 'Participants'
                                ? 'Participants'
                                : `Participants: ${participantsSummary}`
                            }
                            title={
                              participantsSummary === 'Participants'
                                ? 'Participants'
                                : `Participants: ${participantsSummary}`
                            }
                            variant="ghost"
                            size="xs"
                            className={cn(
                              composerPillClassName,
                              'max-w-[min(38vw,10rem)] shrink',
                            )}
                          >
                            {displayedMainAiUser?.avatarUrl ? (
                              <SecureImage
                                src={displayedMainAiUser.avatarUrl}
                                alt=""
                                className="size-6 shrink-0 rounded-full object-cover"
                              />
                            ) : displayedMainAiUser ? (
                              <Bot className="size-6 shrink-0 rounded-full bg-muted p-1" />
                            ) : (
                              <Users className="size-4 shrink-0" />
                            )}
                            <span className="hidden truncate sm:inline">
                              {participantsSummary}
                            </span>
                            {participantCount > 0 && (
                              // Light side uses blue-800: text-primary on bg-primary/20 over the composer pill is only ~3.6:1; dark keeps text-primary.
                              <span className="rounded-full bg-primary/20 px-1 text-[10px] text-blue-800 dark:text-primary">
                                +{participantCount}
                              </span>
                            )}
                            <ChevronDown className="size-2.5 shrink-0 opacity-50" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          data-ui="participants-menu"
                          align="start"
                          side="top"
                          className="w-[min(18rem,calc(100vw-2rem))]"
                        >
                          <AiUsersMenu
                            projectId={project_id}
                            conversationId={activeConvId}
                            draftAvailable={draftAvailableAiUsers}
                            draftSelection={draftAiUsers}
                            defaultMainAiUserId={
                              project?.settings?.defaultMainAiUserId
                            }
                            defaultInvitedAiUserIds={
                              project?.settings?.defaultInvitedAiUserIds
                            }
                            projectSettingsLoaded={project !== undefined}
                            continuousLoopEnabled={continuousPersonaLoopEnabled}
                            conversationRunning={chatRunning}
                            roundPending={personaRoundMutation.isPending}
                            onContinuousLoopChange={(enabled) =>
                              personaLoopMutation.mutate(enabled)
                            }
                            onStartRound={() => personaRoundMutation.mutate()}
                            onDraftSelectionChange={setDraftAiUsers}
                          />
                        </DropdownMenuContent>
                      </DropdownMenu>
                      <MemoryContextControl composerKey={composerModeKey} />
                    </div>
                  </div>
                  <p className={composerHintClassName}>
                    ↵ to send · ⇧↵ for newline
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {workspacePaneAvailable && artifactsPanelOpen && (
        <ProjectWorkspacePane
          projectId={project_id}
          conversationId={activeConvId}
          width={artifactsPanelWidth}
          onResize={startArtifactsResize}
          onResizeCancel={cancelArtifactsResize}
          onClose={dismissWorkspacePane}
          onFileOpen={() => setArtifactsPanelOpen(true)}
          onAnnotationSubmitted={handleBrowserAnnotationSubmitted}
          onProjectSetup={
            canSetUpProject
              ? () => prepareProjectSetup(GIT_INITIALIZATION_SETUP_PROMPT)
              : undefined
          }
          marker={workspacePane?.marker ?? 'chat-files-changes-panel'}
        >
          {workspacePane?.render({
            conversationId: activeConvId,
            onClose: dismissWorkspacePane,
            onFileOpen: () => setArtifactsPanelOpen(true),
          })}
        </ProjectWorkspacePane>
      )}
    </KnowledgeComposer>
  );
}

/** The per-conversation "..." actions, shared by the list item and header. */
function ConversationActionsMenu({
  conv,
  projectId,
  onPin,
  onStartRename,
  onAgentRename,
  onFork,
  onDelete,
  triggerClassName,
  onTriggerClick,
  dataUi,
}: {
  conv: Conversation;
  projectId: string;
  onPin: (pinned: boolean) => void;
  onStartRename: () => void;
  onAgentRename: () => Promise<void>;
  onFork: () => void;
  onDelete: () => Promise<unknown>;
  triggerClassName?: string;
  onTriggerClick?: (e: React.MouseEvent) => void;
  dataUi?: string;
}) {
  const [shareOpen, setShareOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [agentRenaming, setAgentRenaming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const exportingRef = useRef(false);
  // Start renaming only once the menu has closed: its focus scope would
  // otherwise pull focus away from the rename input back to the trigger.
  const renameSelectedRef = useRef(false);
  const isPinned = Boolean(conv.pinned);
  const exportConversation = async () => {
    if (exportingRef.current) return;
    if (Capacitor.isNativePlatform()) {
      toast.error('Export as HTML is not supported on this device');
      return;
    }
    exportingRef.current = true;
    setExporting(true);
    try {
      const { blob, filename } = await exportConversationHtml(
        projectId,
        conv.id,
      );
      saveBlobAsFile(blob, filename);
      setMenuOpen(false);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Could not export conversation',
      );
    } finally {
      exportingRef.current = false;
      setExporting(false);
    }
  };
  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Conversation actions"
            title="Conversation actions"
            data-ui={dataUi}
            onClick={onTriggerClick}
            className={triggerClassName}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-48"
          onClick={(e) => e.stopPropagation()}
          onCloseAutoFocus={(e) => {
            if (!renameSelectedRef.current) return;
            renameSelectedRef.current = false;
            e.preventDefault();
            onStartRename();
          }}
        >
          <DropdownMenuItem onSelect={() => onPin(!isPinned)}>
            {isPinned ? <PinOff /> : <Pin />}
            {isPinned ? 'Unpin conversation' : 'Pin conversation'}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              renameSelectedRef.current = true;
            }}
          >
            <Pencil />
            Rename conversation
          </DropdownMenuItem>
          <DropdownMenuItem
            data-ui="agent-rename-conversation"
            data-conversation-id={conv.id}
            disabled={agentRenaming}
            onSelect={() => {
              setAgentRenaming(true);
              void onAgentRename().finally(() => setAgentRenaming(false));
            }}
          >
            {agentRenaming ? <Loader2 className="animate-spin" /> : <Bot />}
            {agentRenaming ? 'Naming conversation…' : 'Ask agent to rename'}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setShareOpen(true)}>
            <Share2 />
            Share conversation
          </DropdownMenuItem>
          <DropdownMenuItem
            data-ui="export-conversation"
            data-conversation-id={conv.id}
            disabled={exporting}
            onSelect={(e) => {
              // Keep the menu open while the request runs; success closes it.
              e.preventDefault();
              void exportConversation();
            }}
          >
            {exporting ? <Loader2 className="animate-spin" /> : <Download />}
            {exporting ? 'Exporting…' : 'Export as HTML'}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onFork}>
            <GitFork />
            Fork conversation
          </DropdownMenuItem>
          <DropdownMenuItem
            data-ui="copy-conversation-id"
            data-conversation-id={conv.id}
            onSelect={() => {
              void copyToClipboard(conv.id).then((copied) => {
                if (copied) toast.success('Conversation ID copied');
                else toast.error('Could not copy conversation ID');
              });
            }}
          >
            <Copy />
            Copy conversation ID
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setDeleteOpen(true)}
          >
            <Trash2 />
            Delete conversation
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ShareDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        target={{
          kind: 'conversation',
          projectId,
          conversationId: conv.id,
          label: conv.title || conv.preview || undefined,
        }}
      />
      <DeleteConversationDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={conv.title || conv.preview || 'Untitled conversation'}
        onConfirm={onDelete}
      />
    </>
  );
}

function ConversationItem({
  conv,
  worktreeAvailable,
  projectId,
  currentUserId,
  currentUsername,
  active,
  onClick,
  onDelete,
  onPin,
  onRename,
  onAgentRename,
  onFork,
}: {
  conv: Conversation;
  worktreeAvailable?: boolean;
  projectId: string;
  currentUserId?: string;
  currentUsername?: string;
  active: boolean;
  onClick: () => void;
  onDelete: () => Promise<unknown>;
  onPin: (pinned: boolean) => void;
  onRename: (title: string | null) => Promise<boolean>;
  onAgentRename: () => Promise<void>;
  onFork: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Blur and Enter/Check both commit; ignore repeats while a save is pending or done.
  const renameSavingRef = useRef(false);

  const date = new Date(conv.created_at);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const label = isToday
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });

  const isPinned = Boolean(conv.pinned);
  const isPubliclyShared = Boolean(conv.publiclyShared);
  const displayName = conv.title || conv.preview;
  const ownerName =
    conv.owner?.displayName?.trim() || conv.owner?.username || 'Unknown';
  const worktreeBranch = conv.branch_name || `chat-${conv.id}`;
  const worktreeUnavailable = Boolean(
    conv.use_worktree && (conv.worktreeMissing || worktreeAvailable === false),
  );
  const worktreeTitle = conv.use_worktree
    ? worktreeUnavailable
      ? `Worktree unavailable: ${worktreeBranch} (recreated on resume)`
      : conv.worktree_path
        ? `Worktree: ${worktreeBranch} (${conv.worktree_path})`
        : `Worktree: ${worktreeBranch}`
    : undefined;
  const otherParticipants = (conv.participants ?? []).filter((participant) =>
    participant.userId
      ? participant.userId !== currentUserId
      : participant.name.toLowerCase() !== currentUsername?.toLowerCase(),
  );
  const visibleParticipants = otherParticipants.slice(0, 3);
  const remainingParticipants = Math.max(
    0,
    otherParticipants.length - visibleParticipants.length,
  );

  const startEditing = useCallback(() => {
    renameSavingRef.current = false;
    setEditing(true);
  }, []);

  // Focus once the input is actually mounted: the menu that started the
  // rename is still unmounting, and its focus return would otherwise win.
  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const commitRename = useCallback(async () => {
    if (renameSavingRef.current || !inputRef.current) return;
    const value = inputRef.current.value.trim();
    renameSavingRef.current = true;
    const saved = await onRename(value || null);
    // On failure keep the input open with the typed text; after success the
    // guard stays set so the closing input's blur cannot save a second time.
    if (saved) setEditing(false);
    else renameSavingRef.current = false;
  }, [onRename]);

  const cancelRename = useCallback(() => {
    setEditing(false);
  }, []);

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitRename();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelRename();
      }
      e.stopPropagation();
    },
    [commitRename, cancelRename],
  );

  return (
    <div
      data-ui="conversation-list-item"
      data-conversation-id={conv.id}
      data-publicly-shared={isPubliclyShared || undefined}
      data-worktree-available={
        conv.use_worktree ? String(!worktreeUnavailable) : undefined
      }
      role="button"
      tabIndex={0}
      onClick={editing ? undefined : onClick}
      onKeyDown={(e) => {
        if (
          e.currentTarget === e.target &&
          !editing &&
          (e.key === 'Enter' || e.key === ' ')
        ) {
          onClick();
        }
      }}
      className={cn(
        'group w-full px-2.5 py-1.5 text-left border-b border-border/50 transition-colors hover:bg-muted/60 cursor-pointer',
        // Translucent sky fills (/10, hover /15, active /20) read on both themes; only the border tone is theme-swapped.
        isPubliclyShared &&
          'border-l-2 border-l-sky-600 dark:border-l-sky-500 bg-sky-500/10 hover:bg-sky-500/15',
        active && (isPubliclyShared ? 'bg-sky-500/20' : 'bg-muted'),
        worktreeUnavailable && 'opacity-50',
      )}
    >
      <div className="flex items-center justify-between gap-1">
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {label}
          <span aria-hidden="true"> - </span>
          <span
            data-ui="conversation-owner-badge"
            data-conversation-id={conv.id}
            data-user-id={conv.owner?.id ?? ''}
            title={conv.owner ? `Owner: ${ownerName}` : 'Owner unavailable'}
          >
            {ownerName}
          </span>
        </p>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <ConversationStatus status={conv.status} />
          {isPubliclyShared && (
            <span
              data-ui="conversation-public-badge"
              title="Publicly shared conversation"
              className="inline-flex h-4 items-center gap-0.5 rounded border border-sky-600/40 bg-sky-500/10 px-1 text-[9px] font-medium leading-none text-sky-700 dark:border-sky-500/30 dark:text-sky-300"
            >
              <Globe2 className="size-3" />
              Public
            </span>
          )}
          {conv.use_worktree ? (
            <span
              title={worktreeTitle}
              aria-label="Worktree conversation"
              className={cn(
                'inline-flex h-4 items-center gap-0.5 rounded border px-1 text-[9px] font-medium leading-none',
                // Translucent emerald fill reads on both themes; border/text tones are theme-swapped.
                !worktreeUnavailable
                  ? 'border-emerald-600/40 bg-emerald-500/10 text-emerald-700 dark:border-emerald-500/30 dark:text-emerald-300'
                  : 'border-muted-foreground/30 bg-muted text-muted-foreground',
              )}
            >
              <GitBranch className="size-3" />
              WT
            </span>
          ) : null}
          {/* Pinned state is visible at a glance; actions live in the menu. */}
          {isPinned && (
            <Pin
              data-ui="conversation-pinned-indicator"
              className="size-3 text-muted-foreground/60"
              aria-label="Pinned conversation"
            />
          )}
          {editing ? (
            <span
              role="button"
              tabIndex={0}
              title="Save name"
              onClick={(e) => {
                e.stopPropagation();
                commitRename();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.stopPropagation();
                  commitRename();
                }
              }}
              className="opacity-100 text-muted-foreground hover:text-foreground p-0.5 rounded"
            >
              <Check className="size-3" />
            </span>
          ) : (
            <ConversationActionsMenu
              conv={conv}
              projectId={projectId}
              onPin={onPin}
              onStartRename={startEditing}
              onAgentRename={onAgentRename}
              onFork={onFork}
              onDelete={onDelete}
              triggerClassName="text-muted-foreground hover:text-foreground"
              onTriggerClick={(e) => e.stopPropagation()}
            />
          )}
          {/* Fork lineage indicator — non-interactive, shown when this conversation is itself a fork */}
          {conv.forked_from && (
            <span
              title="This conversation is a fork"
              className="text-[9px] leading-none text-muted-foreground/60 p-0.5 select-none"
              aria-label="Forked conversation"
            >
              ⎇
            </span>
          )}
        </div>
      </div>
      {editing ? (
        <Input
          compact
          ref={inputRef}
          type="text"
          defaultValue={conv.title || ''}
          onKeyDown={handleInputKeyDown}
          onBlur={commitRename}
          onClick={(e) => e.stopPropagation()}
          aria-label="Conversation title"
          placeholder={conv.preview ?? 'Conversation name'}
          className="w-full"
        />
      ) : (
        <div className="min-w-0">
          <p
            data-ui="conversation-title-row"
            className="text-xs md:text-[13.3333px] leading-snug line-clamp-2 break-words text-foreground"
          >
            {displayName ?? (
              <span className="italic text-muted-foreground">
                New conversation
              </span>
            )}
          </p>
          {otherParticipants.length > 0 && (
            <div
              data-ui="conversation-participants"
              data-conversation-id={conv.id}
              className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1"
            >
              {visibleParticipants.map((participant) => (
                <span
                  key={participant.userId || participant.name}
                  data-ui="conversation-human-participant"
                  data-sender-user-id={participant.userId}
                  className="inline-flex max-w-28 items-center gap-1 truncate rounded-full bg-violet-500/10 px-1.5 py-0.5 text-[9px] leading-none text-violet-700 dark:text-violet-300"
                >
                  {participant.avatarUrl ? (
                    <SecureImage
                      data-ui="conversation-human-participant-avatar"
                      src={participant.avatarUrl}
                      alt=""
                      className="size-3 rounded-full object-cover"
                    />
                  ) : (
                    <span
                      data-ui="conversation-human-participant-avatar-fallback"
                      aria-hidden="true"
                      // bg-violet-500/30 is a translucent fill that reads on both themes.
                      className="inline-flex size-3 items-center justify-center rounded-full bg-violet-500/30 text-[7px] font-medium"
                    >
                      {participant.name.slice(0, 1).toUpperCase()}
                    </span>
                  )}
                  <span className="truncate">{participant.name}</span>
                </span>
              ))}
              {remainingParticipants > 0 && (
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] leading-none text-muted-foreground">
                  +{remainingParticipants} others
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Counts down until the provider's prompt cache for this session expires. */
const PromptCacheCountdown = memo(function PromptCacheCountdown({
  expiresAtMs,
}: {
  expiresAtMs: number;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    setNowMs(Date.now());
    if (expiresAtMs <= Date.now()) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setNowMs(now);
      if (now >= expiresAtMs) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [expiresAtMs]);
  const remainingSec = Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000));
  const warm = remainingSec > 0;
  return (
    <span
      data-ui="chat-prompt-cache-countdown"
      data-state={warm ? 'warm' : 'cold'}
      className={warm ? 'font-mono tabular-nums' : 'text-muted-foreground/40'}
      title={
        warm
          ? 'Replies sent before this runs out reuse the cached conversation, which is faster and cheaper.'
          : 'The cached conversation has expired, so the next reply rebuilds the cache.'
      }
    >
      {warm
        ? `cache warm ${Math.floor(remainingSec / 60)}:${String(remainingSec % 60).padStart(2, '0')}`
        : 'cache cold'}
    </span>
  );
});

function ConversationStatus({ status }: { status?: Conversation['status'] }) {
  if (status === 'working') {
    return (
      <span
        data-ui="conversation-status-working"
        aria-label="Conversation working"
        title="Conversation working"
        className="inline-flex size-3 items-center justify-center text-blue-600"
      >
        <span
          aria-hidden="true"
          className="size-1.5 rounded-full bg-blue-600 dark:bg-blue-500 animate-pulse"
        />
      </span>
    );
  }
  if (status === 'finished') {
    return (
      <span
        data-ui="conversation-status-finished"
        aria-label="Conversation finished"
        title="Conversation finished"
        className="inline-flex size-3 items-center justify-center text-emerald-700 dark:text-emerald-600"
      >
        <span
          aria-hidden="true"
          className="size-1.5 rounded-full bg-emerald-600 dark:bg-emerald-500"
        />
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span
        data-ui="conversation-status-failed"
        aria-label="Conversation failed"
        title="Conversation failed"
        className="inline-flex items-center gap-1 text-[10px] text-red-600"
      >
        <span
          aria-hidden="true"
          className="size-1.5 rounded-full bg-red-600 dark:bg-red-500"
        />
        Oops!
      </span>
    );
  }
  if (status === 'pending') {
    return (
      <span
        data-ui="conversation-status-pending"
        aria-label="Conversation pending"
        title="Conversation pending"
        className="inline-flex items-center gap-1 text-[10px] text-amber-700 dark:text-amber-600"
      >
        <span
          aria-hidden="true"
          className="size-1.5 rounded-full bg-amber-600 dark:bg-amber-500"
        />
        pending
      </span>
    );
  }
  return null;
}
