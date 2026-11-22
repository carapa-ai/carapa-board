import { FieldTrigger, Select, SelectItem } from '@/components/ui/select';
import type { MarkdownFileOpenHandler } from '@/lib/project-file-links';
import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  useCallback,
  memo,
  lazy,
  Suspense,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { useSmartScroll } from '@/hooks/use-smart-scroll';
import {
  PreviousTranscriptLayer,
  useTranscriptRevealGate,
} from '@/components/chat/transcript-reveal-gate';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/ui/search-input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { COST_TEXT_CLASS } from '@/lib/cost-display';
import {
  Square,
  Trash2,
  Save,
  Send,
  Loader2,
  Timer,
  GitFork,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  RotateCcw,
  Copy,
  Check,
  Link as LinkIcon,
  X,
  Archive,
  ArchiveRestore,
  Filter,
  Pencil,
  RefreshCw,
  FolderInput,
  SkipForward,
  MessageCircle,
  Sparkles,
  Paperclip,
} from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { useStore } from '@/store';
import { resolveTaskPhase } from '@/lib/task-phase';
import { BackgroundTasksPanel } from '@/components/background-tasks-panel';
import { useTasks } from '@/hooks/use-tasks';
import { useProjects } from '@/hooks/use-projects';
import { showsChangesTab } from '@/lib/project-code';
import {
  useUpdateTask,
  useDeleteTask,
  useStopTask,
  useExecuteTask,
  useForkTask,
  useMoveTaskToProject,
} from '@/hooks/use-task-mutations';
import {
  cn,
  formatRelativeTime,
  formatDuration,
  copyToClipboard,
} from '@/lib/utils';
import {
  getEffectiveProjectStages,
  getActiveExecutionStages,
  findStage,
  getInitialStage,
  getActiveStage,
  sortTasksForStage,
} from '@/lib/stages';
import { useElapsedTime } from '@/hooks/use-elapsed-time';
import { TaskStageDurationSummary } from './task-stage-duration-summary';
import { TaskAiDescriptionPanel } from './task-ai-description-panel';
import { TaskRecordingLoading } from './task-recording-loading';
import {
  TaskReviewChips,
  TaskReviewTestingSummary,
} from './task-review-testing-summary';
import {
  fetchTaskOutput,
  fetchTaskMessages,
  fetchTaskRuns,
  updateTaskStageComment,
  fetchTaskRecordings,
  deleteTaskRecordings,
  getTaskDiff,
  getTaskDefaultBranch,
  mergeTaskDefaultBranch,
  ApiError,
  fetchTask,
  fetchTaskExternalIssue,
  syncTaskExternalIssue,
  sendTaskMessage,
  uploadAttachment,
  fetchRuntimeCatalog,
  createConversation,
  answerTaskCodexUserInput,
  getActiveRunLocation,
  stopTaskBackgroundTask,
  type TaskMessagesPage,
  type TaskOutputPage,
  type TaskRecording,
} from '@/lib/api';
import { taskChatConversationOptions, taskChatDraft } from '@/lib/task-chat';
import { RuntimePicker } from '@/components/chat/runtime-picker';
import { RuntimeStageScope } from '@/components/board/runtime-stage-scope';
import { AbComparisonPanel } from '@/components/board/ab-comparison-panel';
import { AbVariantSelect } from '@/components/board/ab-variant-select';
import {
  CoStageSelect,
  coStagesPayload,
  taskCoStages,
} from '@/components/board/co-stage-select';
import {
  abVariantsPayload,
  stageVariantPayload,
  taskVariantSelection,
  isAbParent,
  projectVariantSuffixes,
  sameVariantSelection,
  taskAbForkCommit,
  taskAbParentId,
  taskAbVariants,
  taskStageVariant,
  variantLabel,
} from '@/lib/ab';
import { ProjectPicker } from '@/components/layout/project-picker';
import type { RuntimeSelection } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import {
  useQuery,
  useInfiniteQuery,
  useQueryClient,
  useMutation,
} from '@tanstack/react-query';
import type {
  Task,
  TaskMessage,
  TaskRunLog,
  TaskRunStageDuration,
  ConversationDiff,
} from '@/types';
import {
  RunHistoryEntryHeader,
  TaskRunHistoryEntryFrame,
  TaskRunReviewScore,
  runHistoryStatus,
} from './task-run-history-entry';
import { ChangesView } from '@/components/chat/changes-view';
import {
  ChunkedMarkdownContent,
  MarkdownContent,
} from '@/components/markdown-content-lazy';
import type { QuestionSubmission } from '@/components/markdown-content';
import {
  createTaskOutputWindow,
  extractTaskVerdicts,
  hideTestingVerdictOutputEntries,
  mergeTaskOutputWindow,
  taskOutputWindowChunks,
  taskOutputWindowGaps,
  type TaskOutputGap,
  type TaskOutputWindowEntry,
  isDuplicateTestingFollowUp,
  reviewVerdictTone,
  isHiddenTaskMessage,
  isSupersededRunDivider,
  shouldDeferTaskMessage,
  STOPPED_BY_USER_MSG,
  streamAlreadySaved,
} from '@/lib/task-message-rendering';
import { usePasteAttachments } from '@/hooks/use-paste-attachments';
import { AttachmentChips } from '@/components/attachment-chips';
import { ChatMessageBubble } from '@/components/chat/chat-message-bubble';
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
import { toast } from 'sonner';
import { appendUploadedAttachments } from '@/lib/attachment-description';
import { confirmAction } from '@/components/confirm-dialog';

/**
 * No-period form of the stop sentinel (the trailing-period transcript form
 * is STOPPED_BY_USER_MSG from '@/lib/task-message-rendering'). Both mark the
 * same user-stop event; the UI renders it once, inline at the chronological
 * stop position, instead of also showing the bottom error banner (which
 * would duplicate it after any follow-up prompt).
 */
const STOPPED_BY_USER_ERROR = 'Stopped by user';

/** Background commands/agents the task's agent is still waiting on after its reply. */
function TaskBackgroundTasks({
  projectId,
  taskId,
}: {
  projectId: string;
  taskId: string;
}) {
  const tasks = useStore((s) => s.backgroundTasksByTask[taskId]);
  return (
    <BackgroundTasksPanel
      tasks={tasks}
      onStop={(backgroundTaskId) =>
        stopTaskBackgroundTask(projectId, taskId, backgroundTaskId)
      }
    />
  );
}

interface PersistentStageNoteProps {
  projectId: string;
  taskId: string;
  stageId: string;
  stageTitle: string;
  content: string;
  updatedAt: string;
}

const PersistentStageNote = memo(function PersistentStageNote({
  projectId,
  taskId,
  stageId,
  stageTitle,
  content,
  updatedAt,
}: PersistentStageNoteProps) {
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(content);

  useEffect(() => {
    if (!isEditing) setDraft(content);
  }, [content, isEditing]);

  const updateCommentMutation = useMutation({
    mutationFn: (nextContent: string) =>
      updateTaskStageComment(projectId, taskId, stageId, nextContent),
    onSuccess: (_data, nextContent) => {
      setIsEditing(false);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.runs.all(projectId, taskId),
      });
      toast.success(
        nextContent.trim() ? 'Stage note updated.' : 'Stage note cleared.',
      );
    },
    onError: () => toast.error('Could not update the stage note.'),
  });

  const cancelEditing = () => {
    setDraft(content);
    setIsEditing(false);
  };

  return (
    <div
      className="p-3 space-y-2"
      data-ui="persistent-stage-note"
      data-task-id={taskId}
      data-stage-id={stageId}
    >
      <div className="flex items-center justify-between gap-2">
        <Badge
          variant="outline"
          className="text-[9px] px-1 py-0 h-4"
          title={`Stage ID: ${stageId}`}
        >
          {stageTitle}
        </Badge>
        <div className="flex items-center gap-2">
          <span
            className="text-[10px] text-muted-foreground"
            title={new Date(updatedAt).toLocaleString()}
          >
            Updated {formatRelativeTime(updatedAt)}
          </span>
          {!isEditing && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label={`Edit ${stageTitle} persistent stage note`}
              onClick={() => setIsEditing(true)}
            >
              <Pencil className="size-3" />
            </Button>
          )}
        </div>
      </div>
      {isEditing ? (
        <div className="space-y-2" data-ui="persistent-stage-note-editor">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={4000}
            rows={4}
            className="resize-y"
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={cancelEditing}
              disabled={updateCommentMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => updateCommentMutation.mutate(draft)}
              disabled={
                updateCommentMutation.isPending || draft.trim() === content
              }
            >
              {updateCommentMutation.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Save className="size-3.5" />
              )}
              {draft.trim() ? 'Save' : 'Clear note'}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-xs text-foreground/90 whitespace-pre-wrap break-words">
          {content}
        </p>
      )}
    </div>
  );
});

interface PersistentStageNoteAdderProps {
  projectId: string;
  taskId: string;
  stages: { id: string; title: string }[];
  onSaved: () => void;
}

function PersistentStageNoteAdder({
  projectId,
  taskId,
  stages,
  onSaved,
}: PersistentStageNoteAdderProps) {
  const queryClient = useQueryClient();
  const [stageId, setStageId] = useState(stages[0]?.id ?? '');
  const [content, setContent] = useState('');
  useEffect(() => {
    setStageId((current) =>
      stages.some((stage) => stage.id === current)
        ? current
        : (stages[0]?.id ?? ''),
    );
  }, [stages]);
  const mutation = useMutation({
    mutationFn: () =>
      updateTaskStageComment(projectId, taskId, stageId, content),
    onSuccess: () => {
      setContent('');
      onSaved();
      void queryClient.invalidateQueries({
        queryKey: queryKeys.runs.all(projectId, taskId),
      });
      toast.success('Stage note saved.');
    },
    onError: () => toast.error('Could not save the stage note.'),
  });

  return (
    <form
      className="space-y-2 rounded-lg border border-dashed p-3"
      data-ui="persistent-stage-note-add-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (stageId && content.trim()) mutation.mutate();
      }}
    >
      <label className="sr-only" htmlFor="persistent-stage-note-stage">
        Stage for new persistent note
      </label>
      <Select
        compact
        id="persistent-stage-note-stage"
        data-ui="persistent-stage-note-stage-picker"
        value={stageId}
        onValueChange={(nextValue) => setStageId(nextValue)}
        className="w-full"
        disabled={mutation.isPending}
      >
        {stages.map((stage) => (
          <SelectItem key={stage.id} value={stage.id}>
            {stage.title}
          </SelectItem>
        ))}
      </Select>
      <label className="sr-only" htmlFor="persistent-stage-note-content">
        Persistent stage note
      </label>
      <Textarea
        id="persistent-stage-note-content"
        data-ui="persistent-stage-note-content"
        value={content}
        onChange={(event) => setContent(event.target.value)}
        maxLength={4000}
        rows={4}
        placeholder="Add a persistent note for this stage…"
        className="resize-y"
        disabled={mutation.isPending}
        autoFocus
      />
      {mutation.isError && (
        <p
          className="text-xs text-destructive"
          data-ui="persistent-stage-note-error"
        >
          Could not save the stage note.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onSaved}
          disabled={mutation.isPending}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={mutation.isPending || !stageId || !content.trim()}
        >
          {mutation.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Save className="size-3.5" />
          )}
          Save note
        </Button>
      </div>
    </form>
  );
}

interface HeaderDirty {
  title: boolean;
  runtime: boolean;
  dependsOn: boolean;
  skipStages: boolean;
  abVariants: boolean;
  coStages: boolean;
}

interface HeaderEditValues {
  title: string;
  runtime: RuntimeSelection | null;
  /** Stage the override is limited to; null when it applies to all stages. */
  runtimeStage: string | null;
  dependsOn: string[];
  skipStages: string[];
  abVariants: string[];
  coStages: string[];
  coStageOptions: string[];
}

/**
 * Clears the dirty flag of each sent field, unless the user changed that field
 * again after the save started (its latest value no longer matches what was sent).
 * Runtime and its stage share one flag, so it clears only when neither changed
 * since `submitted`, the edit values captured when the save started.
 */
function clearSentHeaderDirty(
  dirty: HeaderDirty,
  updates: Record<string, any>,
  current: HeaderEditValues,
  submitted: HeaderEditValues,
) {
  if ('title' in updates && updates.title === current.title.trim())
    dirty.title = false;
  if (
    ('runtimeSelection' in updates || 'runtimeSelectionStage' in updates) &&
    JSON.stringify(submitted.runtime) === JSON.stringify(current.runtime) &&
    submitted.runtimeStage === current.runtimeStage
  )
    dirty.runtime = false;
  if (
    'depends_on_ids' in updates &&
    JSON.stringify(updates.depends_on_ids) === JSON.stringify(current.dependsOn)
  )
    dirty.dependsOn = false;
  if (
    'skip_stages' in updates &&
    JSON.stringify([...updates.skip_stages].sort()) ===
      JSON.stringify([...current.skipStages].sort())
  )
    dirty.skipStages = false;
  const sentAbVariants = 'abVariants' in updates;
  const sentStageVariant = 'stageVariant' in updates;
  if (
    (sentAbVariants || sentStageVariant) &&
    (!sentAbVariants ||
      JSON.stringify(updates.abVariants) ===
        JSON.stringify(abVariantsPayload(current.abVariants))) &&
    (!sentStageVariant ||
      updates.stageVariant === stageVariantPayload(current.abVariants))
  )
    dirty.abVariants = false;
  if (
    'coStages' in updates &&
    JSON.stringify(updates.coStages) ===
      JSON.stringify(coStagesPayload(current.coStages, current.coStageOptions))
  )
    dirty.coStages = false;
}

/** Rough token estimate: ~4 chars per token */
function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

/** Format a token count compactly: 1234 → "1.2k", 42 → "42" */
function fmtTok(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString();
}

/** Context window limit (tokens) for a given model name, or null if unknown. */
function getContextWindowLimit(
  model: string | null | undefined,
): number | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.includes('claude')) return 200_000;
  if (m.includes('gpt-4')) return 128_000;
  if (m.includes('o1') || m.includes('o3')) return 200_000;
  if (m.includes('gemini')) return 1_000_000;
  return null;
}

/** Shorten a model name for badge display. */
function shortModel(model: string): string {
  return model
    .replace(/^claude-/, '')
    .replace(/^(models\/)?gemini-/, 'gemini-')
    .replace(/-\d{8}$/, ''); // strip date suffix like -20241022
}

/** Format context window usage: "ctx 52k/200k (26%)" */
function fmtCtx(tok: number, model: string | null | undefined): string {
  const limit = getContextWindowLimit(model);
  if (!limit) return `ctx ${fmtTok(tok)}`;
  return `ctx ${fmtTok(tok)}/${fmtTok(limit)} (${Math.round((tok / limit) * 100)}%)`;
}

/**
 * Resolve which execution path produced a run. The two paths have very
 * different prompt-cache semantics:
 *
 *   - **Direct LLM** (`agent_cmd` starts with `llm:`) — the board
 *     assembles the full system prompt itself and calls the model
 *     directly. When the backend is Anthropic, the board's
 *     `prompt-cache.ts` injects `cache_control` markers via
 *     `extra_body.system` so the Anthropic prompt cache can hit on
 *     the stable prefix. We treat the cache hit % as "our
 *     optimization at work" for this path.
 *
 *   - **Sandbox (CLI agent)** (everything else — `claude`, `codex`,
 *     `opencode`, etc.) — the CLI runs in the repo folder, the board
 *     injects only a minimal system prompt, and the CLI does its own
 *     tool discovery and its own API call to the model. Any cache
 *     stats the run reports are from the CLI's underlying call, NOT
 *     from anything the board set up. Showing them as "our cache
 *     hit" would be misleading.
 *
 * `isAnthropic` is a client-side heuristic that uses the model name
 * (any string containing `claude`, case-insensitive). It's accurate
 * for every real configuration: when the user picks `llm:claude-*`
 * in board_agents.jsonc, the model string is `claude-…` regardless
 * of whether the actual baseUrl is `api.anthropic.com` directly,
 * the api-relay, or any other Anthropic-compatible proxy.
 */
function getRunPath(run: TaskRunLog | null | undefined): {
  isDirectLlm: boolean;
  isAnthropic: boolean;
  cacheControlActive: boolean;
  label: 'Direct LLM' | 'CLI';
} {
  if (!run) {
    return {
      isDirectLlm: false,
      isAnthropic: false,
      cacheControlActive: false,
      label: 'CLI',
    };
  }
  const isDirectLlm = (run.agent_name ?? '').startsWith('llm:');
  // `model` is the configured model id, `model_name` is what the
  // agent reported in its own output. Either is a reliable proxy for
  // "is this Claude" — Claude model ids always start with `claude-`.
  const modelStr = `${run.model ?? ''} ${run.model_name ?? ''}`.toLowerCase();
  const isAnthropic = modelStr.includes('claude');
  return {
    isDirectLlm,
    isAnthropic,
    cacheControlActive: isDirectLlm && isAnthropic,
    label: isDirectLlm ? 'Direct LLM' : 'CLI',
  };
}

/**
 * Cache hit rate for a run, expressed as a 0–100 integer.
 *
 * The denominator is the total "cacheable input" — everything that
 * could in principle have been served from the cache. Anthropic
 * reports three input-side numbers per request:
 *
 *   - `tok_input`         — fresh tokens charged at full price
 *   - `tok_cache_write`   — tokens written into the cache this turn
 *                          (1.25× input price, then ~10× cheaper for
 *                          subsequent reads of the same region)
 *   - `tok_cache_read`    — tokens served from the cache this turn
 *                          (~10% of the equivalent input price)
 *
 * The "true" cache hit rate, the one the user actually pays against,
 * is `cache_read / (cache_read + cache_write + input)`. The CLI
 * agents (claude / codex / opencode) emit the same fields in their
 * stream-json output, so the same formula applies on both paths —
 * the only difference is the UI's interpretation (see `getRunPath`).
 *
 * Returns `null` when there is no cacheable input at all (denominator
 * is 0) so the caller can hide the badge instead of showing `NaN%`
 * or `100%` on a run that didn't touch the cache layer.
 */
function getCacheHitPct(run: TaskRunLog | null | undefined): number | null {
  if (!run) return null;
  const read = run.tok_cache_read ?? 0;
  const write = run.tok_cache_write ?? 0;
  const fresh = run.tok_input ?? 0;
  const denom = read + write + fresh;
  if (denom <= 0) return null;
  return Math.round((read / denom) * 100);
}

interface RunDividerProps {
  runId: string;
  runNumber: number;
  runLog: TaskRunLog | null;
  stageTitle?: string | null;
  created_at: string;
  agent_name?: string | null;
  model_name?: string | null;
  highlighted: boolean;
}

/**
 * Visual separator rendered between runs in the task chat. Backed by a
 * run_start transcript marker (entry_type='run_start', run_id set). The run's
 * live status/duration/tokens are joined from the Runs-tab data by run_id; the
 * marker itself carries agent/model/time as a fallback for old or forked data.
 */
function taskTabClass(active: boolean): string {
  return `px-2 sm:px-3 py-2 text-xs font-medium border-b-2 transition-colors ${active ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`;
}

const RunDivider = memo(function RunDivider({
  runId,
  runNumber,
  runLog,
  stageTitle,
  created_at,
  agent_name,
  model_name,
  highlighted,
}: RunDividerProps) {
  const status = runLog?.status ?? null;
  const model = runLog?.model ?? model_name ?? null;
  return (
    <div
      data-ui="task-run-divider"
      data-run-id={runId}
      className={cn(
        'flex items-center gap-2 my-1 transition-all rounded-md',
        highlighted && 'ring-2 ring-primary/70 bg-primary/5',
      )}
    >
      <div className="h-px flex-1 bg-border" />
      <div className="flex min-w-0 max-w-full flex-col items-center gap-y-0.5 px-2 py-0.5 rounded-xl sm:flex-row sm:gap-x-1.5 sm:rounded-full border border-border bg-muted/40 text-[11px] text-muted-foreground sm:whitespace-nowrap">
        <div className="flex min-w-0 max-w-full flex-wrap items-center justify-center gap-1.5 sm:flex-nowrap empty:hidden">
          <span className="font-semibold text-foreground">Run {runNumber}</span>
          {status && (
            <span
              className={cn(
                'size-1.5 rounded-full',
                status === 'success'
                  ? 'bg-green-600 dark:bg-green-500'
                  : status === 'running'
                    ? 'bg-blue-600 dark:bg-blue-500 animate-pulse'
                    : status === 'stopped'
                      ? 'bg-yellow-700 dark:bg-yellow-500'
                      : 'bg-red-600 dark:bg-red-500',
              )}
            />
          )}
          {status && <span className="capitalize">{status}</span>}
          <span>{formatRelativeTime(created_at)}</span>
        </div>
        <div className="flex min-w-0 max-w-full flex-wrap items-center justify-center gap-1.5 sm:flex-nowrap empty:hidden">
          {stageTitle && (
            <span
              className="inline-flex items-center px-1 py-0 rounded border border-border text-foreground/80 text-[11px] leading-none"
              style={{ height: 14 }}
              title={runLog?.stage ? `Stage ID: ${runLog.stage}` : undefined}
            >
              {stageTitle}
            </span>
          )}
          {(agent_name || runLog?.agent_name) && (
            <span className="text-foreground/80">
              {runLog?.agent_name ?? agent_name}
            </span>
          )}
          {model && (
            <span
              className="inline-flex items-center px-1 py-0 rounded bg-secondary text-secondary-foreground text-[11px] font-mono leading-none"
              style={{ height: 14 }}
            >
              {shortModel(model)}
            </span>
          )}
        </div>
        <div className="flex min-w-0 max-w-full flex-wrap items-center justify-center gap-1.5 sm:flex-nowrap empty:hidden">
          {runLog?.duration_ms != null && (
            <span className="tabular-nums">
              {formatDuration(runLog.duration_ms)}
            </span>
          )}
          {runLog?.tok_output != null && (
            <span
              className="tabular-nums"
              title={`output: ${runLog.tok_output.toLocaleString()}`}
            >
              {fmtTok(runLog.tok_output)} out
            </span>
          )}
          {(() => {
            // Compact cache % on the per-run divider. The same
            // path-aware colouring rule as the dialog summary: accent
            // for Direct LLM + Anthropic (board-driven), muted
            // otherwise (CLI's underlying call only).
            const pct = getCacheHitPct(runLog);
            if (pct === null) return null;
            const path = getRunPath(runLog);
            const cls = path.cacheControlActive
              ? 'inline-flex items-center gap-0.5 px-1 py-0 rounded bg-primary/15 text-primary font-medium'
              : 'inline-flex items-center gap-0.5 px-1 py-0 rounded border border-border text-muted-foreground';
            const title = path.cacheControlActive
              ? `${pct}% cache hit (Anthropic cache_control active)`
              : `${pct}% cache hit on a ${path.label} run — from the underlying API, not the board`;
            return (
              <span className={cls} title={title}>
                {pct}%
              </span>
            );
          })()}
          <span
            className="min-w-0 max-w-[200px] truncate font-mono text-muted-foreground"
            title={`Run id (on-disk dir: data/ipc/*/runs/${runId})`}
          >
            {runId}
          </span>
        </div>
      </div>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
});

/**
 * Defers mounting its heavy child (a ChatMessageBubble + MarkdownContent, which
 * lazy-loads highlight.js) until the wrapper scrolls near the chat viewport.
 * Off-screen messages render a cheap minHeight placeholder; the real bubble
 * mounts the first time it intersects and then stays mounted (no re-parse on
 * scroll-back). `eager` renders immediately — used for the newest messages so
 * the auto-scrolled bottom and the streaming bubble never flash a placeholder.
 *
 * The wrapper keeps `data-msg-id` whether hydrated or not, so the jump-to-run
 * anchor lookup and scroll-positioning still resolve to a stable element; when
 * the placeholder hydrates and grows, the jump effect's ResizeObserver
 * re-aligns it (it already tracks content-size shifts for async highlight.js).
 */
const LazyBubble = memo(function LazyBubble({
  msgId,
  taskId,
  runId,
  rootRef,
  eager = false,
  deferUntilOpened = false,
  deferredChars = 0,
  reserveHeight = 120,
  children,
}: {
  msgId: string;
  taskId: string;
  runId?: string | null;
  rootRef: RefObject<HTMLDivElement | null>;
  eager?: boolean;
  deferUntilOpened?: boolean;
  deferredChars?: number;
  reserveHeight?: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(eager && !deferUntilOpened);

  useEffect(() => {
    if (visible || deferUntilOpened) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    // Hydrate a bit before the bubble enters the viewport so the markdown
    // (async load + highlight) is ready by the time it's visible. Once it
    // intersects, disconnect — the bubble stays mounted for the session.
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { root: rootRef.current, rootMargin: '800px 0px 800px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible, rootRef, deferUntilOpened]);

  return (
    <div
      ref={ref}
      data-ui="task-transcript-message"
      data-msg-id={msgId}
      data-task-id={taskId}
      data-run-id={runId || undefined}
      style={visible ? undefined : { minHeight: reserveHeight }}
    >
      {visible ? (
        children
      ) : deferUntilOpened ? (
        <button
          type="button"
          onClick={() => setVisible(true)}
          className="flex min-h-[72px] w-full items-center justify-center rounded-xl border border-dashed border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        >
          Large historical message (
          {Math.max(1, Math.ceil(deferredChars / 1024)).toLocaleString()} KB) —
          click to render
        </button>
      ) : null}
    </div>
  );
});

const MESSAGES_PAGE_SIZE = 20;
const STREAM_RENDER_MIN_INTERVAL_MS = 100;
// Zustand snapshots must keep their identity while the store is unchanged.
const EMPTY_TASK_STREAM_SNAPSHOT = {
  content: '',
  startOffset: 0,
  entries: [] as TaskOutputWindowEntry[],
};

/**
 * Owns the high-frequency stream subscription so chunks do not re-render the
 * complete task dialog. Markdown rendering is throttled so the full accumulated
 * response is not re-parsed for every token while preserving identical live
 * and replay rendering.
 */
const TaskStreamingBubble = memo(function TaskStreamingBubble({
  taskId,
  projectId,
  messages,
  isRunning,
  onSendMessage,
  onOpenArtifact,
}: {
  taskId: string;
  projectId: string;
  messages: TaskMessage[];
  isRunning: boolean;
  onSendMessage: (text: string, submission?: QuestionSubmission) => void;
  onOpenArtifact: MarkdownFileOpenHandler;
}) {
  const streamSnapshot = useStore(
    useCallback(
      (s: {
        streamingOutputSnapshots: Record<
          string,
          {
            content: string;
            startOffset: number;
            entries: TaskOutputWindowEntry[];
          }
        >;
      }) => s.streamingOutputSnapshots[taskId] ?? EMPTY_TASK_STREAM_SNAPSHOT,
      [taskId],
    ),
  );
  const currentStreaming = streamSnapshot.content;
  const streamStartOffset = streamSnapshot.startOffset;
  const streamRunId = useStore(
    useCallback(
      (s: { taskStreamRunIds: Record<string, string> }) =>
        s.taskStreamRunIds[taskId],
      [taskId],
    ),
  );
  const transcriptReadyRunId = useStore(
    useCallback(
      (s: { readyTaskTranscriptRunIds: Record<string, string> }) =>
        s.readyTaskTranscriptRunIds[taskId],
      [taskId],
    ),
  );
  const [displayedSnapshot, setDisplayedSnapshot] = useState({
    content: currentStreaming,
    startOffset: streamStartOffset,
    entries: streamSnapshot.entries,
  });
  const displayedSnapshotRef = useRef(displayedSnapshot);
  const displayedContent = displayedSnapshot.content;
  const initialEntries =
    streamSnapshot.entries.length > 0
      ? streamSnapshot.entries
      : currentStreaming
        ? [
            {
              id: `live:${taskId}`,
              content: currentStreaming,
              startOffset: streamStartOffset,
              endOffset:
                streamStartOffset +
                new TextEncoder().encode(currentStreaming).byteLength,
            },
          ]
        : [];
  const [outputWindow, setOutputWindow] = useState(() =>
    createTaskOutputWindow(initialEntries),
  );
  const outputWindowRef = useRef(outputWindow);
  const [loadingGapEnd, setLoadingGapEnd] = useState<number | null>(null);
  const lastFlushRef = useRef(0);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const outputGenerationRef = useRef(0);
  const pageRequestRef = useRef(0);
  const bubbleRef = useRef<HTMLDivElement>(null);

  const commitOutputWindow = useCallback(
    (
      update: (current: typeof outputWindow) => typeof outputWindow,
    ): typeof outputWindow => {
      const next = update(outputWindowRef.current);
      outputWindowRef.current = next;
      setOutputWindow(next);
      return next;
    },
    [],
  );

  const resetOutputWindow = useCallback(
    (snapshot: typeof displayedSnapshot) => {
      outputGenerationRef.current += 1;
      pageRequestRef.current += 1;
      const entries =
        snapshot.entries.length > 0
          ? snapshot.entries
          : snapshot.content
            ? [
                {
                  id: `live:${taskId}`,
                  content: snapshot.content,
                  startOffset: snapshot.startOffset,
                  endOffset:
                    snapshot.startOffset +
                    new TextEncoder().encode(snapshot.content).byteLength,
                },
              ]
            : [];
      const next = createTaskOutputWindow(entries);
      outputWindowRef.current = next;
      setOutputWindow(next);
      setLoadingGapEnd(null);
    },
    [taskId],
  );

  const flushDisplayedSnapshot = useCallback(
    (nextSnapshot: typeof displayedSnapshot) => {
      const entries =
        nextSnapshot.entries.length > 0
          ? nextSnapshot.entries
          : nextSnapshot.content
            ? [
                {
                  id: `live:${taskId}`,
                  content: nextSnapshot.content,
                  startOffset: nextSnapshot.startOffset,
                  endOffset:
                    nextSnapshot.startOffset +
                    new TextEncoder().encode(nextSnapshot.content).byteLength,
                },
              ]
            : [];
      commitOutputWindow((current) =>
        mergeTaskOutputWindow(current, entries, {
          direction: 'newer',
          totalEndOffset: entries.at(-1)?.endOffset,
        }),
      );
      displayedSnapshotRef.current = nextSnapshot;
      setDisplayedSnapshot(nextSnapshot);
    },
    [commitOutputWindow, taskId],
  );

  useEffect(() => {
    const snapshot = {
      content: currentStreaming,
      startOffset: streamStartOffset,
      entries: streamSnapshot.entries,
    };
    displayedSnapshotRef.current = snapshot;
    setDisplayedSnapshot(snapshot);
    resetOutputWindow(snapshot);
  }, [resetOutputWindow, streamRunId, taskId, transcriptReadyRunId]);

  useEffect(() => {
    const displayed = displayedSnapshotRef.current;
    const displayedStarts = displayed.entries.map(
      (entry) => `${entry.id}:${entry.startOffset}`,
    );
    const currentStarts = streamSnapshot.entries.map(
      (entry) => `${entry.id}:${entry.startOffset}`,
    );
    const retainsDisplayedTopology = displayedStarts.every(
      (value, index) => currentStarts[index] === value,
    );
    if (
      streamStartOffset !== displayed.startOffset ||
      !retainsDisplayedTopology
    ) {
      // A retained live-entry eviction changes the addressable range. Reject
      // any response issued for the previous generation before the throttled
      // renderer catches up.
      outputGenerationRef.current += 1;
      pageRequestRef.current += 1;
      setLoadingGapEnd(null);
    }
  }, [currentStreaming, streamSnapshot.entries, streamStartOffset]);

  useEffect(() => {
    const now = performance.now();
    const elapsed = now - lastFlushRef.current;
    if (elapsed >= STREAM_RENDER_MIN_INTERVAL_MS) {
      lastFlushRef.current = now;
      flushDisplayedSnapshot({
        content: currentStreaming,
        startOffset: streamStartOffset,
        entries: streamSnapshot.entries,
      });
      return;
    }
    if (!pendingTimerRef.current) {
      pendingTimerRef.current = setTimeout(() => {
        pendingTimerRef.current = null;
        lastFlushRef.current = performance.now();
        const snapshot =
          useStore.getState().streamingOutputSnapshots[taskId] ??
          EMPTY_TASK_STREAM_SNAPSHOT;
        flushDisplayedSnapshot(snapshot);
      }, STREAM_RENDER_MIN_INTERVAL_MS - elapsed);
    }
  }, [
    currentStreaming,
    flushDisplayedSnapshot,
    streamSnapshot.entries,
    streamStartOffset,
    taskId,
  ]);
  useEffect(() => {
    return () => {
      if (pendingTimerRef.current) {
        clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = null;
      }
    };
  }, []);

  const outputChunks = useMemo(
    () => taskOutputWindowChunks(hideTestingVerdictOutputEntries(outputWindow)),
    [outputWindow],
  );
  const outputContent = useMemo(
    () => outputChunks.map((chunk) => chunk.content).join(''),
    [outputChunks],
  );
  const gaps = taskOutputWindowGaps(outputWindow);
  useSmartScroll(bubbleRef, [outputContent], taskId);

  const loadOlderOutput = useCallback(
    async (gap: TaskOutputGap) => {
      if (loadingGapEnd !== null) return;
      setLoadingGapEnd(gap.endOffset);
      const requestId = pageRequestRef.current + 1;
      pageRequestRef.current = requestId;
      const generation = outputGenerationRef.current;
      const requestedRunId = streamRunId;
      try {
        const page = await fetchTaskOutput(
          projectId,
          taskId,
          32768,
          0,
          streamRunId,
          gap.endOffset,
        );
        const currentGapStillExists = taskOutputWindowGaps(
          outputWindowRef.current,
        ).some(
          (candidate) =>
            candidate.startOffset === gap.startOffset &&
            candidate.endOffset === gap.endOffset,
        );
        if (
          generation !== outputGenerationRef.current ||
          requestId !== pageRequestRef.current ||
          !currentGapStillExists ||
          (!!page.runId && page.runId !== requestedRunId)
        ) {
          return;
        }
        if (page.content) {
          const pageEntries =
            page.entries?.length > 0
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
          commitOutputWindow((current) =>
            mergeTaskOutputWindow(current, pageEntries, {
              direction: 'older',
              totalEndOffset: page.total,
            }),
          );
        }
      } catch (error) {
        // The gap stays in the window, so the loader button doubles as Retry.
        if (requestId === pageRequestRef.current) {
          toast.error(
            error instanceof Error && error.message
              ? `Could not load earlier output: ${error.message}`
              : 'Could not load earlier output',
          );
        }
      } finally {
        if (requestId === pageRequestRef.current) setLoadingGapEnd(null);
      }
    },
    [commitOutputWindow, loadingGapEnd, projectId, streamRunId, taskId],
  );
  if (
    !outputContent ||
    (displayedContent &&
      streamAlreadySaved(
        displayedContent,
        messages,
        isRunning,
        streamRunId,
        transcriptReadyRunId,
      ))
  ) {
    return null;
  }

  return (
    <div
      className="flex flex-col items-start"
      data-ui="task-live-transcript"
      data-task-id={taskId}
      data-run-id={streamRunId || undefined}
    >
      <div className="max-w-[90%] min-w-0 rounded-xl rounded-tl-sm border border-border bg-muted/80 px-4 py-3 text-base leading-relaxed shadow-sm overflow-hidden break-words markdown-output markdown-output--inline dark:border-white/5">
        {gaps.length > 0 && (
          <button
            type="button"
            onClick={() => void loadOlderOutput(gaps[0])}
            disabled={loadingGapEnd !== null}
            data-ui="task-output-gap-loader"
            data-gap-start={gaps[0].startOffset}
            data-gap-end={gaps[0].endOffset}
            className="mb-2 w-full rounded-lg border border-border bg-background/30 px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-background/50 hover:text-foreground"
          >
            {loadingGapEnd !== null
              ? 'Loading earlier output…'
              : 'Load earlier output'}
          </button>
        )}
        <div
          ref={bubbleRef}
          className="prose prose-invert max-w-none max-h-[40vh] overflow-y-auto overflow-x-hidden break-words"
        >
          <ChunkedMarkdownContent
            chunks={outputChunks}
            onSendMessage={onSendMessage}
            onOpenArtifact={onOpenArtifact}
            projectFolder={projectId}
          />
        </div>
      </div>
    </div>
  );
});

interface TaskDetailDialogProps {
  project_id: string;
}

export function TaskChangesPanel({
  taskId,
  diff,
  isLoading,
  isError = false,
  onRetry,
  projectId,
  checkoutMode,
}: {
  taskId: string;
  diff: ConversationDiff | undefined;
  isLoading: boolean;
  isError?: boolean;
  onRetry?: () => void;
  projectId?: string;
  checkoutMode?: 'shared' | 'branch' | 'worktree';
}) {
  return (
    <div
      data-ui="task-changes-tab"
      data-task-id={taskId}
      className="animate-in fade-in slide-in-from-top-1 duration-200"
    >
      {projectId && checkoutMode === 'worktree' && (
        <TaskDefaultBranchSection
          key={`${projectId}:${taskId}`}
          projectId={projectId}
          taskId={taskId}
        />
      )}
      {isError ? (
        <div
          data-ui="task-changes-error"
          role="alert"
          className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-4 text-center"
        >
          <p className="text-sm font-medium">Could not load changes</p>
          {onRetry && (
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              Retry
            </Button>
          )}
        </div>
      ) : (
        <ChangesView diff={diff} isLoading={isLoading} />
      )}
    </div>
  );
}

function TaskDefaultBranchSection({
  projectId,
  taskId,
}: {
  projectId: string;
  taskId: string;
}) {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: queryKeys.taskDefaultBranch.all(projectId, taskId),
    queryFn: () => getTaskDefaultBranch(projectId, taskId),
    staleTime: 0,
    refetchOnMount: 'always',
    retry: false,
  });
  const pending = useRef(false);
  const refresh = async () => {
    await Promise.all([
      status.refetch(),
      queryClient.invalidateQueries({
        queryKey: queryKeys.taskDiff.all(projectId, taskId),
      }),
    ]);
  };
  const merge = useMutation({
    mutationFn: (expected: { sourceCommit: string; taskHead: string }) =>
      mergeTaskDefaultBranch(projectId, taskId, expected),
    retry: false,
    onSettled: async () => {
      await refresh();
      await queryClient.invalidateQueries({
        queryKey: queryKeys.messages.all(projectId, taskId),
      });
      pending.current = false;
    },
  });
  const data = status.data;
  const result = merge.data;
  return (
    <section
      data-ui="task-default-branch"
      data-task-id={taskId}
      className={cn(
        'mb-4 rounded-lg border text-sm',
        // A status that does not apply (e.g. a merged task without a
        // worktree) is context, not a card: keep it to one quiet line.
        data && !data.available && !status.isFetching
          ? 'space-y-1 px-3 py-2 text-xs'
          : 'space-y-3 p-4',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="min-w-0 break-all font-medium">
          Default branch{data ? `: ${data.defaultBranch}` : ''}
        </h3>
        <Button
          variant="outline"
          size="sm"
          disabled={status.isFetching || merge.isPending}
          onClick={() => void refresh()}
        >
          Refresh
        </Button>
      </div>
      <div
        role="status"
        data-ui="task-default-branch-status"
        className="break-words text-muted-foreground"
      >
        {status.isFetching ? (
          'Loading default-branch status…'
        ) : status.isError ? (
          `Status unavailable: ${status.error.message}`
        ) : !data ? (
          'Status unavailable.'
        ) : !data.available ? (
          data.reason
        ) : data.state === 'unresolved' ? (
          'An unresolved merge/rebase requires resolution before merging again.'
        ) : (
          <>
            {data.commitsBehind === 0
              ? 'Up to date.'
              : `${data.commitsBehind} commit${data.commitsBehind === 1 ? '' : 's'} from ${data.defaultBranch} missing from this task.`}
            {data.state === 'dirty' && (
              <p>
                Commit or move tracked, staged, and untracked changes out of the
                worktree before merging.
              </p>
            )}
          </>
        )}
      </div>
      {!status.isFetching &&
        !status.isError &&
        data?.available &&
        data.commitsBehind > 0 && (
          <Button
            size="sm"
            className="h-auto whitespace-normal break-all text-left"
            disabled={
              merge.isPending ||
              data.state !== 'ready' ||
              result?.delivery === 'failed'
            }
            onClick={() => {
              if (pending.current) return;
              pending.current = true;
              merge.mutate({
                sourceCommit: data.sourceCommit,
                taskHead: data.taskHead,
              });
            }}
          >
            {merge.isPending
              ? 'Merging…'
              : `Merge ${data.defaultBranch} into task`}
          </Button>
        )}
      {merge.isPending && <p role="status">Merging and notifying the agent…</p>}
      {merge.error && <p role="alert">{merge.error.message}</p>}
      {result && (
        <div
          role={result.error ? 'alert' : 'status'}
          data-ui="task-default-branch-result"
          className="space-y-2 break-words"
        >
          <p>
            {result.outcome === 'merged'
              ? 'Merged into task.'
              : result.outcome === 'conflicted'
                ? 'Merge conflicts require resolution.'
                : result.outcome === 'uncommitted'
                  ? 'Merge requires inspection and a merge commit.'
                  : result.outcome === 'interrupted'
                    ? 'Merge interrupted; inspect the task worktree before retrying.'
                    : result.outcome === 'up-to-date'
                      ? 'Already up to date; no notification sent.'
                      : 'Git merge failed.'}
          </p>
          {result.conflictedPaths.length > 0 && (
            <ul className="list-inside list-disc">
              {result.conflictedPaths.map((file) => (
                <li key={file}>{file}</li>
              ))}
            </ul>
          )}
          {result.delivery && result.delivery !== 'failed' && (
            <p>
              {result.delivery === 'steered'
                ? 'Agent notified through steering.'
                : 'Agent instruction queued for the next execution.'}
            </p>
          )}
          {result.error && <p>{result.error}</p>}
          {result.delivery === 'failed' && result.notification && (
            <pre className="whitespace-pre-wrap break-words text-xs">
              {result.notification}
            </pre>
          )}
        </div>
      )}
    </section>
  );
}

type TaskDetailTab = 'details' | 'chat' | 'history' | 'changes' | 'recordings';
type ScrollableTaskDetailTab = Exclude<TaskDetailTab, 'details'>;
interface SelectedTaskRecording {
  taskId: string;
  filename: string;
}

function getLatestScoredReviewRun(runs: TaskRunLog[]): TaskRunLog | null {
  return runs
    .filter((run) => run.reviewScore !== null)
    .reduce<TaskRunLog | null>((latest, run) => {
      if (!latest) return run;
      return new Date(run.run_at).getTime() > new Date(latest.run_at).getTime()
        ? run
        : latest;
    }, null);
}

const TaskRecordingPlayer = lazy(() => import('./task-recording-player'));

interface TaskRecordingsListProps {
  recordings: TaskRecording[];
  selectedFilename: string | null;
  onSelect: (filename: string | null) => void;
  onDelete: (filename: string) => void;
  deleteDisabled: boolean;
}

export function TaskRecordingsList({
  recordings,
  selectedFilename,
  onSelect,
  onDelete,
  deleteDisabled,
}: TaskRecordingsListProps) {
  return (
    <div className="space-y-4">
      {recordings.map((recording) => {
        const isSelected = selectedFilename === recording.filename;
        return (
          <div
            key={recording.filename}
            data-ui="task-recording"
            data-recording-filename={recording.filename}
            className="space-y-2 rounded-lg border border-border bg-muted/20 p-3"
          >
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                data-ui="task-recording-playback-trigger"
                data-recording-filename={recording.filename}
                aria-pressed={isSelected}
                aria-label={`${isSelected ? 'Stop' : 'Play'} recording ${recording.filename}`}
                className="min-w-0 flex-1 text-left"
                onClick={() => onSelect(isSelected ? null : recording.filename)}
              >
                <div
                  className="truncate text-xs font-medium"
                  title={recording.filename}
                >
                  {recording.filename}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {recording.size >= 1024 * 1024
                    ? `${(recording.size / (1024 * 1024)).toFixed(1)} MB`
                    : `${Math.max(1, Math.ceil(recording.size / 1024))} KB`}
                  {' · '}
                  {formatRelativeTime(recording.mtime)}
                </div>
              </button>
              <Button
                variant="ghost"
                size="icon-xs"
                className="shrink-0 text-destructive hover:text-destructive"
                aria-label={`Delete recording ${recording.filename}`}
                title="Delete recording"
                disabled={deleteDisabled}
                onClick={() => onDelete(recording.filename)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
            {isSelected && (
              <Suspense
                fallback={
                  <TaskRecordingLoading filename={recording.filename} />
                }
              >
                <TaskRecordingPlayer
                  key={recording.filename}
                  recording={recording}
                />
              </Suspense>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface TaskDescriptionSectionProps {
  description: string;
  editDescription: string;
  isEditing: boolean;
  onEditDescription: () => void;
  onChangeDescription: (value: string) => void;
  onCancelDescription: () => void;
  onSaveDescription: () => void;
  isSaving: boolean;
  onAiEditDescription: () => void;
}

function TaskDescriptionSection({
  description,
  editDescription,
  isEditing,
  onEditDescription,
  onChangeDescription,
  onCancelDescription,
  onSaveDescription,
  isSaving,
  onAiEditDescription,
}: TaskDescriptionSectionProps) {
  return (
    <section
      data-ui="task-description"
      data-editing={isEditing ? 'true' : 'false'}
      className="flex shrink-0 flex-col space-y-2 rounded-lg border border-border bg-muted/20 p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Description
        </h3>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(
              'h-7 px-2 text-xs',
              isEditing && 'text-primary bg-primary/10',
            )}
            onClick={onEditDescription}
            title={isEditing ? 'Cancel description edit' : 'Edit description'}
          >
            <Pencil className="size-3 mr-1" />
            {isEditing ? 'Cancel' : 'Edit desc'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={onAiEditDescription}
            title="Generate an AI draft of this description"
          >
            <Sparkles className="size-3 mr-1" />
            AI edit
          </Button>
        </div>
      </div>
      {isEditing ? (
        <div className="flex min-h-0 flex-col space-y-1.5">
          <Textarea
            value={editDescription}
            onChange={(e) => onChangeDescription(e.target.value)}
            placeholder="Describe the task…"
            rows={12}
            className="h-full min-h-64 flex-1 resize-none overflow-y-auto field-sizing-fixed"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Escape') onCancelDescription();
            }}
          />
          <div className="flex gap-2 justify-end">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={onCancelDescription}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-7 text-xs"
              onClick={onSaveDescription}
              disabled={isSaving}
            >
              <Save className="size-3 mr-1" />
              Save description
            </Button>
          </div>
        </div>
      ) : description.trim() ? (
        <div className="max-h-[40vh] min-h-0 overflow-y-auto text-sm markdown-output markdown-output--inline">
          <MarkdownContent>{description}</MarkdownContent>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground italic">
          No description provided.
        </p>
      )}
    </section>
  );
}

export function TaskDetailDialog({ project_id }: TaskDetailDialogProps) {
  const task_id = useStore((s) => s.detailTaskId);
  const setTaskId = useStore((s) => s.setDetailTaskId);
  const detailTaskTab = useStore((s) => s.detailTaskTab);
  const setDetailTaskTab = useStore((s) => s.setDetailTaskTab);
  const reviewRunIntent = useStore((s) => s.reviewRunIntent);
  const setReviewRunIntent = useStore((s) => s.setReviewRunIntent);
  const navigate = useNavigate();
  const hasCurrentStreaming = useStore(
    useCallback(
      (s: { streamingOutput: Record<string, string> }) =>
        task_id ? !!s.streamingOutput[task_id] : false,
      [task_id],
    ),
  );
  const currentTaskStreamRunId = useStore(
    useCallback(
      (s: { taskStreamRunIds: Record<string, string> }) =>
        task_id ? s.taskStreamRunIds[task_id] : undefined,
      [task_id],
    ),
  );

  const { data: tasks, isSuccess: tasksLoaded } = useTasks(project_id);
  const { data: projects } = useProjects();
  const project = projects?.find((p) => p.id === project_id);
  const moveDestinationIds = useMemo(
    () =>
      new Set(
        (projects ?? [])
          .filter((candidate) => {
            const modes = candidate.settings?.enabledModes ?? [
              'kanban',
              'chat',
            ];
            return modes.includes('kanban');
          })
          .map((candidate) => candidate.id),
      ),
    [projects],
  );
  const stages = useMemo(() => getEffectiveProjectStages(project), [project]);
  const activeStages = useMemo(
    () =>
      getEffectiveProjectStages(project).filter(
        (candidate) => !candidate.inactive,
      ),
    [project],
  );
  const executeStages = useMemo(
    () => getActiveExecutionStages(activeStages),
    [activeStages],
  );
  const task = tasks?.find((f) => f.id === task_id);
  // A forked A/B parent never runs, so it has nothing but Details to show.
  const isForkedParent = !!task && taskAbForkCommit(task) !== null;
  const [isCreatingTaskChat, setIsCreatingTaskChat] = useState(false);
  const stage = task ? findStage(stages, task.status) : undefined;
  const variantSuffixes = useMemo(
    () => projectVariantSuffixes(project),
    [project],
  );
  const coStageOptions = useMemo(
    () => project?.coStageOptions ?? [],
    [project],
  );
  const abParentId = task ? taskAbParentId(task) : null;
  const abParentTask = abParentId
    ? tasks?.find((candidate) => candidate.id === abParentId)
    : undefined;
  const abVariantTasks = useMemo(
    () =>
      task && isAbParent(task)
        ? (tasks ?? []).filter(
            (candidate) => taskAbParentId(candidate) === task.id,
          )
        : [],
    [task, tasks],
  );
  const initialStage = useMemo(
    () => getInitialStage(activeStages),
    [activeStages],
  );
  const activeStage = useMemo(
    () => getActiveStage(activeStages),
    [activeStages],
  );
  const stageTasks = useMemo(() => {
    if (!task || !stage || !tasks) return [];
    return sortTasksForStage(
      tasks.filter((candidate) => candidate.status === task.status),
      stage,
    );
  }, [stage, task, tasks]);
  const currentStageTaskIndex = useMemo(
    () => stageTasks.findIndex((candidate) => candidate.id === task_id),
    [stageTasks, task_id],
  );
  const previousTask =
    currentStageTaskIndex > 0
      ? stageTasks[currentStageTaskIndex - 1]
      : undefined;
  const nextTask =
    currentStageTaskIndex >= 0 && currentStageTaskIndex < stageTasks.length - 1
      ? stageTasks[currentStageTaskIndex + 1]
      : undefined;

  const {
    data: messagesData,
    isLoading: messagesLoading,
    isPending: messagesPending,
    fetchNextPage: fetchOlderMessages,
    hasNextPage: hasOlderMessages,
    isFetchingNextPage: isFetchingOlderMessages,
  } = useInfiniteQuery<TaskMessagesPage>({
    queryKey: task_id
      ? queryKeys.messages.all(project_id, task_id)
      : ['messages', 'none'],
    queryFn: ({ pageParam }) =>
      fetchTaskMessages(
        project_id,
        task_id!,
        MESSAGES_PAGE_SIZE,
        pageParam as number,
        true,
      ),
    initialPageParam: 0,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? lastPage.nextOffset : undefined,
    enabled: !!task_id,
  });

  // Flatten pages in chronological order (pages[0] = newest, so reverse).
  // The backend transcript reader already sorts by `created_at` ASC, but a
  // follow-up posted during the previous turn's completion gap can land on
  // a different page than the assistant turn it precedes. Stable-sorting
  // here on the merged list keeps the bubble order correct even when the
  // page boundary splits a turn: an assistant turn that finished before
  // the follow-up always renders before it, regardless of pagination
  // window. `Array.prototype.sort` is stable (ES2019+), so ties on
  // `created_at` preserve page/insertion order — no extra tiebreaker
  // needed (and an `id` tiebreaker would be wrong: ids carry a random
  // suffix that does not reflect issuance order).
  const messages = useMemo<TaskMessage[]>(() => {
    if (!messagesData) return [];
    const merged = [...messagesData.pages].reverse().flatMap((p) => p.messages);
    return merged.slice().sort((a, b) => {
      const aTs = a.created_at ?? '';
      const bTs = b.created_at ?? '';
      if (aTs < bTs) return -1;
      if (aTs > bTs) return 1;
      return 0;
    });
  }, [messagesData]);

  const {
    data: runHistory,
    refetch: refetchRunHistory,
    isError: isRunHistoryError,
    error: runHistoryError,
    isPending: isRunHistoryPending,
    isFetching: isRunHistoryFetching,
  } = useQuery<{
    runs: TaskRunLog[];
    latest_scored_review_run: TaskRunLog | null;
    total: number;
    stageDurations: TaskRunStageDuration[];
    persistent_comments: Array<{
      stage_id: string;
      content: string;
      updated_at: string;
      run_id: string | null;
    }>;
  }>({
    queryKey: task_id
      ? queryKeys.runs.all(project_id, task_id)
      : ['runs', 'none'],
    queryFn: () => fetchTaskRuns(project_id, task_id!),
    enabled: !!task_id,
  });
  // Error/loading only apply while nothing is loaded: a failed background
  // refetch keeps showing the previous data. `enabled: !!task_id` keeps a
  // disabled query "pending", so gate on task_id.
  const runHistoryLoadFailed = isRunHistoryError && !runHistory;
  const runHistoryLoading = !!task_id && isRunHistoryPending && !runHistory;
  const runLogs = runHistory?.runs ?? [];
  const runCount = runHistory?.total ?? runLogs.length;
  const persistentComments = runHistory?.persistent_comments ?? [];
  const notedStageIds = useMemo(
    () => new Set(persistentComments.map((comment) => comment.stage_id)),
    [persistentComments],
  );
  const noteableStages = useMemo(
    () => executeStages.filter((candidate) => !notedStageIds.has(candidate.id)),
    [executeStages, notedStageIds],
  );
  const [isAddingPersistentNote, setIsAddingPersistentNote] = useState(false);

  useEffect(() => {
    setIsAddingPersistentNote(false);
  }, [task_id]);
  const stageDurations = runHistory?.stageDurations ?? [];

  // Lookup run metadata by active_runs.id, and a stable 1-based chronological
  // run number, so run-start markers in the chat can render a divider with the
  // run's live status/duration/tokens.
  const runLogById = useMemo(() => {
    const m = new Map<string, TaskRunLog>();
    for (const r of runLogs) m.set(r.id, r);
    if (runHistory?.latest_scored_review_run) {
      m.set(
        runHistory.latest_scored_review_run.id,
        runHistory.latest_scored_review_run,
      );
    }
    return m;
  }, [runHistory?.latest_scored_review_run, runLogs]);
  const runNumberById = useMemo(() => {
    const m = new Map<string, number>();
    const asc = [...runLogs].sort(
      (a, b) => new Date(a.run_at).getTime() - new Date(b.run_at).getTime(),
    );
    const firstLoadedRunNumber = Math.max(1, runCount - asc.length + 1);
    asc.forEach((r, i) => m.set(r.id, firstLoadedRunNumber + i));
    return m;
  }, [runCount, runLogs]);

  // Keep this key stable while the task updates. Changing it briefly replaced
  // the list with [] during a refetch, which unmounted active video players.
  const {
    data: recordings = [],
    refetch: refetchRecordings,
    isPending: recordingsLoading,
    isError: recordingsError,
  } = useQuery<TaskRecording[]>({
    queryKey: task_id
      ? queryKeys.recordings.all(project_id, task_id)
      : ['recordings', 'none'],
    queryFn: () => fetchTaskRecordings(project_id, task_id!),
    enabled: !!task_id && !isForkedParent,
  });

  // Fetch the full task record to look up an id the board list lacks, so a
  // deleted task's stale deep link shows 404 (`fullTaskError`). Also enabled
  // for tasks without messages. The cached record is kept in sync with external
  // issue description updates (reconcileExternalTaskDescription in
  // websocket.ts); the finite staleTime and the task_updated invalidation there
  // keep it from staying permanently stale after an external task update.
  const { error: fullTaskError } = useQuery<Task>({
    queryKey: task_id
      ? queryKeys.fullTask.all(project_id, task_id)
      : ['fullTask', 'none'],
    queryFn: () => fetchTask(project_id, task_id!),
    // Also look up an id the loaded board list does not contain, regardless of
    // cached messages, so a deleted task's stale deep link can resolve to 404.
    enabled:
      !!task_id &&
      ((!messagesLoading && messages.length === 0) || (tasksLoaded && !task)),
    staleTime: 30_000,
  });

  const { data: externalIssue } = useQuery({
    queryKey: task_id
      ? queryKeys.externalIssue.all(project_id, task_id)
      : ['externalIssue', 'none'],
    queryFn: () => fetchTaskExternalIssue(project_id, task_id!),
    enabled: !!task_id,
    staleTime: Infinity,
  });

  const updateMutation = useUpdateTask(project_id);
  const { mutateAsync: updateTaskAsync } = updateMutation;
  const deleteMutation = useDeleteTask(project_id);
  const stopMutation = useStopTask(project_id);
  const executeMutation = useExecuteTask(project_id);
  const queryClient = useQueryClient();
  const issueHost = externalIssue?.provider === 'github' ? 'GitHub' : 'GitLab';
  const syncExternalIssueMutation = useMutation({
    mutationFn: () => syncTaskExternalIssue(project_id, task_id!),
    onSuccess: ({ task: syncedTask, comments }) => {
      queryClient.setQueryData(
        queryKeys.fullTask.all(project_id, syncedTask.id),
        syncedTask,
      );
      // The user may have navigated to another task before the sync returned.
      if (currentTaskIdRef.current === syncedTask.id) {
        setEditTitle(syncedTask.title);
        headerDirtyRef.current.title = false;
        setEditDescription(syncedTask.description || '');
      }
      void queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.all(project_id),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.messages.all(project_id, syncedTask.id),
      });
      toast.success(
        comments.length > 0
          ? `Synced ${issueHost} issue and ${comments.length} new comment${comments.length === 1 ? '' : 's'}.`
          : `${issueHost} issue is up to date.`,
      );
    },
    onError: (error) =>
      toast.error(
        error instanceof Error
          ? error.message
          : `Could not sync the ${issueHost} issue.`,
      ),
  });
  const [recordingDeleteTarget, setRecordingDeleteTarget] = useState<
    string | 'all' | null
  >(null);
  const [selectedRecording, setSelectedRecording] =
    useState<SelectedTaskRecording | null>(null);
  const deleteRecordingsMutation = useMutation({
    // The task is bound when the delete is requested so a completion after
    // Next/Prev updates the recordings of the task that was actually deleted.
    mutationFn: ({ taskId, filename }: { taskId: string; filename?: string }) =>
      deleteTaskRecordings(project_id, taskId, filename),
    onSuccess: ({ deletedCount, freedBytes }, { taskId, filename }) => {
      queryClient.setQueryData(
        queryKeys.recordings.all(project_id, taskId),
        (current: TaskRecording[] | undefined) =>
          filename
            ? (current ?? []).filter(
                (recording) => recording.filename !== filename,
              )
            : [],
      );
      setSelectedRecording((selected) =>
        filename === undefined ||
        (selected?.taskId === taskId && selected.filename === filename)
          ? null
          : selected,
      );
      setRecordingDeleteTarget(null);
      const freed =
        freedBytes >= 1024 * 1024
          ? `${(freedBytes / (1024 * 1024)).toFixed(1)} MB`
          : `${Math.ceil(freedBytes / 1024)} KB`;
      toast.success(
        `Deleted ${deletedCount} recording${deletedCount === 1 ? '' : 's'} and freed ${freed}.`,
      );
    },
    onError: () => toast.error('Could not delete the task recordings.'),
  });
  const { data: runtimeCatalog } = useQuery({
    queryKey: queryKeys.runtimeCatalog,
    queryFn: fetchRuntimeCatalog,
    staleTime: Infinity,
  });

  const [editTitle, setEditTitle] = useState('');
  const [editRuntimeSelection, setEditRuntimeSelection] =
    useState<RuntimeSelection | null>(null);
  const [editRuntimeStage, setEditRuntimeStage] = useState<string | null>(null);
  const [editDependsOn, setEditDependsOn] = useState<string[]>([]);
  const [editSkipStages, setEditSkipStages] = useState<string[]>([]);
  const [editAbVariants, setEditAbVariants] = useState<string[]>([]);
  const [editCoStages, setEditCoStages] = useState<string[]>([]);
  // Header fields the user has changed locally. Only dirty fields are written
  // back on save and kept when the task is updated externally.
  const headerDirtyRef = useRef<HeaderDirty>({
    title: false,
    runtime: false,
    dependsOn: false,
    skipStages: false,
    abVariants: false,
    coStages: false,
  });
  const headerEditRef = useRef<HeaderEditValues>({
    title: '',
    runtime: null,
    runtimeStage: null,
    dependsOn: [],
    skipStages: [],
    abVariants: [],
    coStages: [],
    coStageOptions: [],
  });
  headerEditRef.current = {
    title: editTitle,
    runtime: editRuntimeSelection,
    runtimeStage: editRuntimeSelection ? editRuntimeStage : null,
    dependsOn: editDependsOn,
    skipStages: editSkipStages,
    abVariants: editAbVariants,
    coStages: editCoStages,
    coStageOptions,
  };
  // Local choice that wins over the stored priority while a PATCH is pending.
  const [priorityOverride, setPriorityOverride] = useState<{
    taskId: string;
    mode: 'next' | 'top';
    requestId: number;
  } | null>(null);
  const priorityRequestSeqRef = useRef(0);
  // The task is "top priority" when it already leads the loaded queue
  // (priority <= every loaded priority, ties included).
  const storedPriorityMode: 'next' | 'top' =
    task && tasks?.every((other) => task.priority <= other.priority)
      ? 'top'
      : 'next';
  const editPriorityMode =
    priorityOverride && priorityOverride.taskId === task_id
      ? priorityOverride.mode
      : storedPriorityMode;
  const [isEditingDescription, setIsEditingDescription] = useState(false);
  const [editDescription, setEditDescription] = useState('');
  const [isAiEditOpen, setIsAiEditOpen] = useState(false);
  const [isAiApplyPending, setIsAiApplyPending] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const dependsSearchInputRef = useRef<HTMLInputElement>(null);
  const dependsListRef = useRef<HTMLDivElement>(null);
  const [showOnlyActive, setShowOnlyActive] = useState(true);
  const [forkFromMessageId, setForkFromMessageId] = useState<string | null>(
    null,
  );
  const [forkPrompt, setForkPrompt] = useState('');
  const [selectedTab, setActiveTab] = useState<TaskDetailTab>('chat');
  const showChanges = showsChangesTab(project);
  const activeTab: TaskDetailTab = isForkedParent
    ? 'details'
    : selectedTab === 'changes' && !showChanges
      ? 'chat'
      : selectedTab;
  const chatRef = useRef<HTMLDivElement>(null);
  const chatContentRef = useRef<HTMLDivElement>(null);
  const tabContentRef = useRef<HTMLDivElement>(null);
  const tabScrollPositionsRef = useRef<Record<ScrollableTaskDetailTab, number>>(
    {
      chat: 0,
      history: 0,
      changes: 0,
      recordings: 0,
    },
  );
  const scrollTaskIdRef = useRef(task_id);
  const needsInitialChatPositionRef = useRef(true);
  // Tracks when the dialog's chat tab viewport is actually mounted. Radix
  // presence defers mounting the content a frame after the dialog opens, so
  // effects keyed on task_id alone can run before `chatRef.current` exists.
  const [chatViewportReady, setChatViewportReady] = useState(false);
  const setTabContentNode = useCallback(
    (node: HTMLDivElement | null) => {
      tabContentRef.current = node;
      chatRef.current = activeTab === 'chat' ? node : null;
      setChatViewportReady(!!node && activeTab === 'chat');
    },
    [activeTab],
  );
  const runJumpSpacerRef = useRef<HTMLDivElement>(null);
  const {
    scrollToBottom,
    settleToBottom,
    suspendAutoScroll,
    resumeAutoScroll,
  } = useSmartScroll(
    chatRef,
    [messages.length],
    // The viewport mounts after the commit that sets task_id, so the hook must
    // re-attach its scroll listeners and content ResizeObserver once it exists;
    // otherwise late Markdown/output growth is never followed after the
    // initial settle window.
    `${task_id ?? ''}:${activeTab}:${chatViewportReady}`,
    chatContentRef,
  );
  const isLiveFromStore = useStore((s) =>
    task_id ? !!s.liveTaskIds[task_id] : false,
  );
  const isStalledFromStore = useStore((s) =>
    task_id ? !!s.stalledTaskIds[task_id] : false,
  );
  // Same phase the board card shows for this task and store state.
  const taskPhase = task
    ? resolveTaskPhase(task, {
        isLive: isLiveFromStore,
        isStalledFromStore,
        readOnly: false,
      })
    : 'idle';
  const isRunning = taskPhase === 'running';
  const latestOutputRun = useMemo(
    () =>
      runLogs.reduce<TaskRunLog | null>(
        (latest, run) =>
          !latest ||
          new Date(run.run_at).getTime() > new Date(latest.run_at).getTime()
            ? run
            : latest,
        null,
      ),
    [runLogs],
  );
  const outputRunIds = useMemo(
    () =>
      Array.from(
        new Set([
          ...messages
            .filter((message) => !!message.run_id)
            .map((message) => message.run_id!),
          ...(latestOutputRun ? [latestOutputRun.id] : []),
        ]),
      ),
    [latestOutputRun, messages],
  );
  const outputBootstrapRunIds = useMemo(
    () =>
      outputRunIds.filter(
        (runId) => !isRunning || runId !== currentTaskStreamRunId,
      ),
    [currentTaskStreamRunId, isRunning, outputRunIds],
  );
  const [outputPagesByRun, setOutputPagesByRun] = useState<
    Record<string, TaskOutputPage>
  >({});
  // Bootstrap whose requests have all settled (success or error), so the
  // transcript is not revealed before the sidecar output is spliced in.
  const outputBootstrapKey = `${task_id ?? ''}:${outputBootstrapRunIds.join(',')}`;
  const [outputSettledKey, setOutputSettledKey] = useState<string | null>(null);
  // Any new bootstrap (task or run list changed, dialog closed and reopened)
  // starts unsettled, even if an earlier one finished under the same key.
  const [trackedOutputKey, setTrackedOutputKey] = useState(outputBootstrapKey);
  if (trackedOutputKey !== outputBootstrapKey) {
    setTrackedOutputKey(outputBootstrapKey);
    setOutputSettledKey(null);
  }
  useEffect(() => {
    if (!task_id || outputBootstrapRunIds.length === 0) {
      setOutputPagesByRun((current) =>
        Object.keys(current).length === 0 ? current : {},
      );
      return;
    }
    let cancelled = false;
    // One failed run must not discard the pages that did load. Failed runs
    // stay out of the map, so their messages render the raw content until the
    // bootstrap key changes and the load is attempted again.
    Promise.allSettled(
      outputBootstrapRunIds.map(async (runId) => {
        const page = await fetchTaskOutput(
          project_id,
          task_id,
          32768,
          0,
          runId,
        );
        return page.runId === runId ? ([runId, page] as const) : null;
      }),
    )
      .then((results) => {
        if (!cancelled)
          setOutputPagesByRun(
            Object.fromEntries(
              results.flatMap((result) =>
                result.status === 'fulfilled' && result.value
                  ? [result.value]
                  : [],
              ),
            ),
          );
      })
      .finally(() => {
        if (!cancelled) setOutputSettledKey(outputBootstrapKey);
      });
    return () => {
      cancelled = true;
    };
  }, [outputBootstrapKey, outputBootstrapRunIds, project_id, task_id]);
  // The Chat tab stays hidden (previous task dimmed on a switch, blank on first
  // load) until the incoming transcript has loaded and stopped moving.
  const { gated: chatGated, previous: previousChat } = useTranscriptRevealGate({
    transcriptKey: task_id ?? null,
    enabled: activeTab === 'chat',
    ready:
      !messagesPending &&
      !runHistoryLoading &&
      (outputBootstrapRunIds.length === 0 ||
        outputSettledKey === outputBootstrapKey),
    mounted: chatViewportReady,
    scrollRef: chatRef,
  });
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  // Always points at the current task's draft key so stable callbacks can use it without deps
  const draftKeyRef = useRef(task_id ?? '');
  draftKeyRef.current = task_id ?? '';
  // An AI description PATCH can outlive the dialog view. Keep the current
  // task ID outside the async callback so a late response cannot update the
  // local description for a task opened afterward.
  const currentTaskIdRef = useRef(task_id);
  currentTaskIdRef.current = task_id;
  // Scroll height before loading older messages, used to restore position after prepend
  const prevScrollHeightRef = useRef(0);
  const [copiedTaskId, setCopiedTaskId] = useState(false);
  const recordingScrollAnchorRef = useRef<{
    filename: string;
    offset: number;
  } | null>(null);
  const [selectedQueueStageId, setSelectedQueueStageId] = useState('');
  // A stage picked for another project may not exist here; ignore it then.
  const validQueueStageId = executeStages.some(
    (s) => s.id === selectedQueueStageId,
  )
    ? selectedQueueStageId
    : '';
  // Matches the stage handleQueue falls back to when nothing is picked.
  const displayedQueueStageId =
    validQueueStageId || (activeStage?.id ?? executeStages[0]?.id);
  // Run a user clicked in the Runs tab that we still need to scroll to once the
  // chat tab is mounted; and the run whose divider should flash to confirm.
  const [pendingJumpRunId, setPendingJumpRunId] = useState<string | null>(null);
  const pendingJumpOwnerRef = useRef<{
    taskId: string | null;
    tab: TaskDetailTab;
  } | null>(null);
  const [highlightRunId, setHighlightRunId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedRecording(null);
  }, [task_id]);

  useEffect(() => {
    if (activeTab !== 'recordings') {
      setSelectedRecording(null);
    }
  }, [activeTab]);

  const selectedRecordingFilename =
    selectedRecording?.taskId === task_id ? selectedRecording.filename : null;

  useEffect(() => {
    if (
      selectedRecordingFilename &&
      !recordings.some(
        (recording) => recording.filename === selectedRecordingFilename,
      )
    ) {
      setSelectedRecording(null);
    }
  }, [recordings, selectedRecordingFilename]);

  const taskVerdicts = useMemo(() => extractTaskVerdicts(messages), [messages]);

  const selectTab = useCallback(
    (nextTab: TaskDetailTab) => {
      if (activeTab !== 'details' && tabContentRef.current) {
        tabScrollPositionsRef.current[activeTab] =
          tabContentRef.current.scrollTop;
      }
      setActiveTab(nextTab);
    },
    [activeTab],
  );

  // ARIA tabs keyboard model: arrows/Home/End move focus across the rendered
  // tabs and activate them (automatic activation) through `selectTab`.
  const handleTabListKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const tabs = Array.from(
        event.currentTarget.querySelectorAll<HTMLButtonElement>(
          '[role="tab"][data-tab]',
        ),
      );
      const current = (event.target as HTMLElement).closest<HTMLElement>(
        '[role="tab"]',
      );
      const index = current ? tabs.indexOf(current as HTMLButtonElement) : -1;
      if (index < 0) return;
      let nextIndex: number;
      switch (event.key) {
        case 'ArrowRight':
          nextIndex = (index + 1) % tabs.length;
          break;
        case 'ArrowLeft':
          nextIndex = (index - 1 + tabs.length) % tabs.length;
          break;
        case 'Home':
          nextIndex = 0;
          break;
        case 'End':
          nextIndex = tabs.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      const nextTab = tabs[nextIndex];
      nextTab.focus();
      selectTab(nextTab.dataset.tab as TaskDetailTab);
    },
    [selectTab],
  );

  useEffect(() => {
    if (!task_id || !detailTaskTab) return;
    selectTab(detailTaskTab);
    setDetailTaskTab(null);
  }, [detailTaskTab, selectTab, setDetailTaskTab, task_id]);

  // Use the same Files preview boundary for group and repository links.
  // The pending activation also reveals a previously hidden workspace pane.
  const openArtifact = useCallback(
    (
      artifactPath: string,
      fallbackContent?: string,
      source: 'group' | 'repo' = 'group',
    ) => {
      const filename = artifactPath.split('/').at(-1) || 'artifact.md';
      useStore.getState().openPreviewTab(project_id, {
        id:
          source === 'repo'
            ? `repo:main:${artifactPath}`
            : `group:${artifactPath}`,
        title: filename,
        kind: 'file',
        source,
        path: artifactPath,
        ...(source === 'repo' ? { repoContext: 'main' as const } : {}),
        ...(fallbackContent != null ? { fallbackContent } : {}),
      });
    },
    [project_id],
  );

  const handleDialogOpenAutoFocus = useCallback(() => {
    if (activeTab !== 'chat') return;
    needsInitialChatPositionRef.current = false;
    settleToBottom();
  }, [activeTab, settleToBottom]);

  useLayoutEffect(() => {
    const pendingJumpOwner = pendingJumpOwnerRef.current;
    if (
      pendingJumpOwner &&
      (pendingJumpOwner.taskId !== task_id ||
        activeTab !== pendingJumpOwner.tab)
    ) {
      pendingJumpOwnerRef.current = null;
      resumeAutoScroll();
      setPendingJumpRunId(null);
    }
    const taskChanged = scrollTaskIdRef.current !== task_id;
    if (taskChanged) {
      tabScrollPositionsRef.current = {
        chat: 0,
        history: 0,
        changes: 0,
        recordings: 0,
      };
      scrollTaskIdRef.current = task_id;
      needsInitialChatPositionRef.current = true;
    }
    // Fresh Chat tabs have no position to restore. Leave them for the bounded
    // initial settle below instead of restoring the default `0` after
    // smart-scroll has already moved them to the latest transcript content.
    if (
      activeTab !== 'details' &&
      tabContentRef.current &&
      !(activeTab === 'chat' && needsInitialChatPositionRef.current)
    ) {
      tabContentRef.current.scrollTop =
        tabScrollPositionsRef.current[activeTab];
    }
  }, [activeTab, resumeAutoScroll, task_id]);

  // A task may be selected while another tab is active. Position the first Chat
  // frame before paint, then let the bounded settle window follow delayed
  // Markdown/media layout. Saved positions still win on later tab switches.
  useLayoutEffect(() => {
    if (
      !task_id ||
      activeTab !== 'chat' ||
      !needsInitialChatPositionRef.current
    )
      return;
    needsInitialChatPositionRef.current = false;
    settleToBottom();
  }, [activeTab, task_id, settleToBottom]);

  // A completed run changes task metadata and can add recordings. Refetch with
  // the same query key so existing video elements stay mounted while the list
  // is refreshed.
  useEffect(() => {
    if (!task_id || isForkedParent) return;
    void refetchRecordings();
  }, [
    task_id,
    isForkedParent,
    task?.status,
    task?.completed_at,
    refetchRecordings,
  ]);

  // New recordings are prepended. Preserve the first visible existing row at
  // its current viewport offset, so a recording being watched does not jump
  // down when the refreshed list gains a newer item above it.
  useLayoutEffect(() => {
    if (activeTab !== 'recordings') {
      recordingScrollAnchorRef.current = null;
      return;
    }

    const container = tabContentRef.current;
    if (!container) return;
    const rows = Array.from(
      container.querySelectorAll<HTMLElement>('[data-ui="task-recording"]'),
    );
    const previousAnchor = recordingScrollAnchorRef.current;
    if (previousAnchor) {
      const anchor = rows.find(
        (row) => row.dataset.recordingFilename === previousAnchor.filename,
      );
      if (anchor) {
        const currentOffset =
          anchor.getBoundingClientRect().top -
          container.getBoundingClientRect().top;
        container.scrollTop += currentOffset - previousAnchor.offset;
      }
    }

    const containerBounds = container.getBoundingClientRect();
    const visibleRow = rows.find((row) => {
      const bounds = row.getBoundingClientRect();
      return (
        bounds.bottom > containerBounds.top &&
        bounds.top < containerBounds.bottom
      );
    });
    if (visibleRow?.dataset.recordingFilename) {
      recordingScrollAnchorRef.current = {
        filename: visibleRow.dataset.recordingFilename,
        offset: visibleRow.getBoundingClientRect().top - containerBounds.top,
      };
    }
  }, [activeTab, recordings]);

  // Jump from a Runs-tab row to the matching run divider in the chat.
  const handleJumpToRun = useCallback(
    (runId: string) => {
      // The target divider takes precedence over both fresh-open settling and
      // lazy-content auto-follow until its own ResizeObserver has finished.
      pendingJumpOwnerRef.current = { taskId: task_id, tab: 'chat' };
      suspendAutoScroll();
      needsInitialChatPositionRef.current = false;
      selectTab('chat');
      setPendingJumpRunId(runId);
    },
    [selectTab, suspendAutoScroll, task_id],
  );

  // A score badge requests one targeted review jump. The query can retain
  // invalidated cached data while a review completion refetch is in flight,
  // so explicitly await a fresh response before consuming the request. This
  // prevents an older cached review (or an explicit null from that cache)
  // from winning the one-shot navigation.
  useEffect(() => {
    if (!reviewRunIntent || reviewRunIntent.taskId !== task_id) return;

    let cancelled = false;
    void refetchRunHistory().then((result) => {
      if (cancelled) return;

      setReviewRunIntent(null);
      // Only a successful refetch is authoritative. A failed refetch can
      // resolve with cached data, and a successful response may still have no
      // payload; neither case should select an older review or leave the
      // one-shot intent armed for a later dialog open.
      if (!result.isSuccess || !result.data) {
        selectTab('chat');
        return;
      }

      const authoritativeRunHistory = result.data;
      const latestScoredRun = Object.prototype.hasOwnProperty.call(
        authoritativeRunHistory,
        'latest_scored_review_run',
      )
        ? authoritativeRunHistory.latest_scored_review_run
        : getLatestScoredReviewRun(authoritativeRunHistory.runs);
      if (latestScoredRun) {
        handleJumpToRun(latestScoredRun.id);
      } else {
        selectTab('chat');
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    handleJumpToRun,
    refetchRunHistory,
    reviewRunIntent,
    setReviewRunIntent,
    selectTab,
    task_id,
  ]);

  useEffect(() => {
    if (task_id && reviewRunIntent && reviewRunIntent.taskId !== task_id) {
      setReviewRunIntent(null);
    }
  }, [reviewRunIntent, setReviewRunIntent, task_id]);

  // A (task, run) deep link is one-shot per page session: it positions the
  // transcript when the dialog first opens for that link. Re-firing it on
  // every close/reopen would re-arm the run jump (suspended settling) and
  // strand the reopened chat mid-transcript instead of settling at the
  // latest content. A fresh page load resets the ref, so shared links still
  // navigate to their run on first open.
  const consumedDeepLinkRef = useRef<{ taskId: string; runId: string } | null>(
    null,
  );

  useEffect(() => {
    const runId = new URLSearchParams(window.location.search).get('runId');
    const deepLinkedTaskId = new URLSearchParams(window.location.search).get(
      'taskId',
    );
    if (!runId || !task_id || deepLinkedTaskId !== task_id) return;
    if (
      consumedDeepLinkRef.current?.taskId === task_id &&
      consumedDeepLinkRef.current.runId === runId
    )
      return;
    consumedDeepLinkRef.current = { taskId: task_id, runId };
    handleJumpToRun(runId);
  }, [handleJumpToRun, task_id]);

  // Position the chat on the run clicked in the Runs tab, anchored on the
  // run's `run_start` divider marker. If the anchor isn't in the loaded pages
  // yet, older pages are fetched and the effect re-runs.
  useEffect(() => {
    const pendingJumpOwner = pendingJumpOwnerRef.current;
    if (
      activeTab !== 'chat' ||
      !pendingJumpRunId ||
      pendingJumpOwner?.taskId !== task_id ||
      pendingJumpOwner.tab !== 'chat'
    )
      return;
    const runId = pendingJumpRunId;
    const container = chatRef.current;
    if (!container) {
      // The jump was armed before the dialog's chat viewport mounted (the
      // deep-link open race). Keep it pending — the effect re-runs when the
      // viewport is ready (chatViewportReady) — instead of discarding it,
      // which would leave the transcript stranded at the bottom of the first
      // page only. Closing the dialog or leaving the chat tab clears the
      // owner via the stale-owner check above.
      return;
    }

    const target: HTMLElement | null = container.querySelector(
      `[data-run-id="${runId}"]`,
    );

    if (!target) {
      if (messagesLoading || isFetchingOlderMessages) return;
      // Anchor not in loaded messages — pull older pages and retry on the
      // next `messages` update; an in-flight fetch keeps the jump pending
      // until it lands, and only an exhausted transcript gives the jump up.
      if (hasOlderMessages) {
        fetchOlderMessages();
      } else {
        pendingJumpOwnerRef.current = null;
        resumeAutoScroll();
        setPendingJumpRunId(null);
      }
      return;
    }

    const el = target;
    // MarkdownContent is React.lazy and code blocks are highlighted after
    // load, so on a freshly remounted chat tab the message bodies reflow
    // asynchronously — well after the initial commit — and shift the anchor.
    // Re-align the divider just below the top of the chat viewport on every
    // content-size change (ResizeObserver) until layout
    // goes quiet, then finalize. A hard cap guards against a never-settling
    // stream. This tracks shifts of any size/direction, so late reflow can't
    // leave the run separator partway down the viewport.
    const alignWithTopMargin = () => {
      const cRect = container.getBoundingClientRect();
      const eRect = el.getBoundingClientRect();
      const offsetTop = eRect.top - cRect.top + container.scrollTop;
      const targetScrollTop = Math.max(0, offsetTop - 5);
      // A short final run may not leave enough content below its divider for
      // the browser to scroll that divider up to its top margin. Add only
      // the temporary trailing space needed to make the requested position
      // reachable. The spacer is unmounted when leaving the Chat tab.
      const spacer = runJumpSpacerRef.current;
      if (spacer) {
        const contentHeightWithoutSpacer =
          container.scrollHeight - spacer.offsetHeight;
        const requiredHeight = Math.max(
          0,
          targetScrollTop -
            (contentHeightWithoutSpacer - container.clientHeight),
        );
        if (Math.abs(spacer.offsetHeight - requiredHeight) > 1) {
          spacer.style.height = `${Math.ceil(requiredHeight)}px`;
        }
      }
      container.scrollTo({
        top: targetScrollTop,
        behavior: 'auto',
      });
    };

    let ro: ResizeObserver | null = null;
    let quietTimer = 0;
    let hardTimer = 0;
    let finished = false;

    function finalize() {
      if (finished) return;
      finished = true;
      ro?.disconnect();
      ro = null;
      clearTimeout(quietTimer);
      clearTimeout(hardTimer);
      setHighlightRunId(runId);
      pendingJumpOwnerRef.current = null;
      resumeAutoScroll();
      setPendingJumpRunId(null);
    }

    function onResize() {
      if (finished) return;
      alignWithTopMargin();
      // If no further layout change for 300ms, consider it settled.
      clearTimeout(quietTimer);
      quietTimer = window.setTimeout(finalize, 300);
    }

    // Hard cap: finalize after 3s no matter what (covers slow chunk + highlight).
    hardTimer = window.setTimeout(finalize, 3000);

    const contentEl = container.firstElementChild as HTMLElement | null;
    if (contentEl && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(onResize);
      ro.observe(contentEl);
      alignWithTopMargin(); // immediate; the observer's initial fire also re-aligns
    } else {
      // No ResizeObserver — best-effort single alignment + short finalize.
      alignWithTopMargin();
      quietTimer = window.setTimeout(finalize, 300);
    }

    return () => {
      finished = true;
      ro?.disconnect();
      clearTimeout(quietTimer);
      clearTimeout(hardTimer);
    };
  }, [
    activeTab,
    chatViewportReady,
    pendingJumpRunId,
    messages,
    hasOlderMessages,
    isFetchingOlderMessages,
    fetchOlderMessages,
    messagesLoading,
    resumeAutoScroll,
  ]);

  // Flash the run divider briefly once a jump lands on it.
  useEffect(() => {
    if (!highlightRunId) return;
    const t = setTimeout(() => setHighlightRunId(null), 2000);
    return () => clearTimeout(t);
  }, [highlightRunId]);

  // Git diff of the task-owned checkout against its branch base, including
  // live edits while that checkout is active. Fetched only when the Changes
  // tab is open; re-keyed by status/completed_at so it refreshes as the task
  // progresses and commits per stage.
  const {
    data: taskDiff,
    isLoading: taskDiffLoading,
    isError: taskDiffError,
    refetch: refetchTaskDiff,
  } = useQuery<ConversationDiff>({
    queryKey: task_id
      ? [
          ...queryKeys.taskDiff.all(project_id, task_id),
          task?.status,
          task?.completed_at ?? null,
        ]
      : ['taskDiff', 'none'],
    queryFn: () => getTaskDiff(project_id, task_id!),
    enabled: !!task_id && activeTab === 'changes' && showChanges,
    staleTime: 0,
  });

  // The dialog stays mounted across tasks and projects: drop per-task fork mode
  // and the picked execute stage when switching or closing.
  useEffect(() => {
    setForkFromMessageId(null);
    setForkPrompt('');
    setSelectedQueueStageId('');
  }, [task_id, project_id]);

  // Sync fields when task changes (dialog opens or switches task)
  useEffect(() => {
    if (task) {
      setEditTitle(task.title);
      setEditRuntimeSelection(task.runtimeSelection ?? null);
      setEditRuntimeStage(task.runtimeSelectionStage ?? null);
      setEditDependsOn(task.depends_on_ids ?? []);
      setEditSkipStages(task.skip_stages ?? []);
      setEditAbVariants(taskVariantSelection(task));
      setEditCoStages(taskCoStages(task));
      headerDirtyRef.current = {
        title: false,
        runtime: false,
        dependsOn: false,
        skipStages: false,
        abVariants: false,
        coStages: false,
      };
      setPriorityOverride(null);
      setEditDescription(task.description || '');
      setIsEditingDescription(false);
      setIsAiEditOpen(false);
      setSearchQuery('');
    }
    prevScrollHeightRef.current = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id]);

  // Follow external edits (agent/MCP/other users) for header fields the user
  // has not touched; dirty fields keep the user's value.
  const serverRuntimeKey = JSON.stringify([
    task?.runtimeSelection ?? null,
    task?.runtimeSelectionStage ?? null,
  ]);
  const serverDependsOnKey = JSON.stringify(task?.depends_on_ids ?? []);
  const serverSkipKey = JSON.stringify(task?.skip_stages ?? []);
  const serverAbVariantsKey = JSON.stringify(
    task ? taskVariantSelection(task) : [],
  );
  const serverCoStagesKey = JSON.stringify(task ? taskCoStages(task) : []);
  useEffect(() => {
    if (!task) return;
    const dirty = headerDirtyRef.current;
    if (!dirty.title) setEditTitle(task.title);
    if (!dirty.runtime) {
      setEditRuntimeSelection(task.runtimeSelection ?? null);
      setEditRuntimeStage(task.runtimeSelectionStage ?? null);
    }
    if (!dirty.dependsOn) setEditDependsOn(task.depends_on_ids ?? []);
    if (!dirty.skipStages) setEditSkipStages(task.skip_stages ?? []);
    if (!dirty.abVariants) setEditAbVariants(taskVariantSelection(task));
    if (!dirty.coStages) setEditCoStages(taskCoStages(task));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    task?.title,
    serverRuntimeKey,
    serverDependsOnKey,
    serverSkipKey,
    serverAbVariantsKey,
    serverCoStagesKey,
  ]);

  // After older messages are prepended, restore the scroll position so the
  // user stays at the same visual spot instead of jumping to the top.
  useEffect(() => {
    if (prevScrollHeightRef.current > 0 && chatRef.current) {
      chatRef.current.scrollTop =
        chatRef.current.scrollHeight - prevScrollHeightRef.current;
      prevScrollHeightRef.current = 0;
    }
  }, [messages]);

  // Load older messages when the user scrolls near the top of the chat area.
  const handleChatScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (
        e.currentTarget.scrollTop < 100 &&
        hasOlderMessages &&
        !isFetchingOlderMessages
      ) {
        prevScrollHeightRef.current = e.currentTarget.scrollHeight;
        fetchOlderMessages();
      }
    },
    [hasOlderMessages, isFetchingOlderMessages, fetchOlderMessages],
  );

  const handleTabContentScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (activeTab === 'details') return;
      tabScrollPositionsRef.current[activeTab] = e.currentTarget.scrollTop;
      if (activeTab === 'chat') handleChatScroll(e);
    },
    [activeTab, handleChatScroll],
  );

  const buildHeaderUpdates = useCallback(() => {
    if (!task) return {};
    const updates: Record<string, any> = {};
    const dirty = headerDirtyRef.current;
    if (dirty.title && editTitle.trim() !== task.title)
      updates.title = editTitle.trim();
    if (dirty.runtime) {
      if (
        JSON.stringify(editRuntimeSelection) !==
        JSON.stringify(task.runtimeSelection ?? null)
      )
        updates.runtimeSelection = editRuntimeSelection;
      // Only a changed stage is sent, so saving a row whose stage was later
      // removed is not rejected.
      const nextRuntimeStage = editRuntimeSelection ? editRuntimeStage : null;
      if (nextRuntimeStage !== (task.runtimeSelectionStage ?? null))
        updates.runtimeSelectionStage = nextRuntimeStage;
    }

    // Check if depends_on_ids changed
    // (order-insensitive; the full edited list is sent so hidden entries are never dropped)
    const oldDeps = task.depends_on_ids ?? [];
    if (
      dirty.dependsOn &&
      JSON.stringify([...oldDeps].sort()) !==
        JSON.stringify([...editDependsOn].sort())
    ) {
      updates.depends_on_ids = editDependsOn;
    }

    // Check if skip_stages changed. Backend treats null / [] as "no
    // skipping"; we mirror that here by always sending the array
    // (possibly empty) and letting the server normalize. This keeps
    // the client semantically simple: "what you see is what's saved".
    const oldSkip = task.skip_stages ?? [];
    const oldSorted = [...oldSkip].sort();
    const newSorted = [...editSkipStages].sort();
    if (
      dirty.skipStages &&
      (oldSorted.length !== newSorted.length ||
        oldSorted.some((id, i) => id !== newSorted[i]))
    ) {
      updates.skip_stages = editSkipStages;
    }

    // Two or more variants are an experiment, exactly one non-A variant runs
    // the card on that stage alternative, anything else is a base task. Never
    // both fields: a field that changes is sent, so the other one is cleared.
    if (dirty.abVariants) {
      const nextAbVariants = abVariantsPayload(editAbVariants);
      const nextStageVariant = stageVariantPayload(editAbVariants);
      if (!sameVariantSelection(nextAbVariants ?? [], taskAbVariants(task))) {
        updates.abVariants = nextAbVariants;
      }
      if (nextStageVariant !== taskStageVariant(task)) {
        updates.stageVariant = nextStageVariant;
      }
    }

    // Send the extras in pipeline order; an empty list clears them.
    const nextCoStages = coStagesPayload(editCoStages, coStageOptions);
    if (
      dirty.coStages &&
      JSON.stringify(nextCoStages) !==
        JSON.stringify(coStagesPayload(taskCoStages(task), coStageOptions))
    ) {
      updates.coStages = nextCoStages;
    }

    return updates;
  }, [
    task,
    editTitle,
    editRuntimeSelection,
    editRuntimeStage,
    editDependsOn,
    editSkipStages,
    editAbVariants,
    editCoStages,
    coStageOptions,
  ]);

  // Resolves true when there was nothing to save or the save succeeded, false
  // when it failed (useUpdateTask reports the error) so callers can abort.
  const handleSaveHeader = useCallback(async (): Promise<boolean> => {
    if (!task_id) return false;
    const updates = buildHeaderUpdates();
    if (Object.keys(updates).length === 0) return true;
    const submitted = headerEditRef.current;
    try {
      await updateMutation.mutateAsync({ task_id, data: updates });
    } catch {
      // The optimistic update was rolled back; the user's edit must survive.
      return false;
    }
    clearSentHeaderDirty(
      headerDirtyRef.current,
      updates,
      headerEditRef.current,
      submitted,
    );
    return true;
  }, [task_id, buildHeaderUpdates, updateMutation]);

  // Save is the primary action of the Details tab only while there is
  // something to save.
  const headerHasChanges = Object.keys(buildHeaderUpdates()).length > 0;

  // Persists dirty header edits before leaving the task (navigate or close).
  // Resolves false when the save fails or another save is in flight, so the
  // caller stays on the task and the user can retry without losing the edit.
  const saveHeaderBeforeLeaving = useCallback(async (): Promise<boolean> => {
    if (!task_id || updateMutation.isPending) return false;
    const updates = buildHeaderUpdates();
    // An open description editor with a changed, non-empty draft is saved
    // with the header fields so leaving never silently discards it.
    if (
      isEditingDescription &&
      task &&
      editDescription.trim() &&
      editDescription !== (task.description || '')
    ) {
      updates.description = editDescription;
    }
    try {
      if (Object.keys(updates).length > 0) {
        await updateMutation.mutateAsync({ task_id, data: updates });
      }
      return true;
    } catch {
      // useUpdateTask reports the error and restores its optimistic update.
      return false;
    }
  }, [
    task_id,
    task,
    updateMutation,
    buildHeaderUpdates,
    isEditingDescription,
    editDescription,
  ]);

  const handleNavigateTask = useCallback(
    async (targetTaskId: string | undefined) => {
      if (!targetTaskId) return;
      if (await saveHeaderBeforeLeaving()) setTaskId(targetTaskId);
    },
    [saveHeaderBeforeLeaving, setTaskId],
  );

  const handleCloseDialog = useCallback(async () => {
    if (!(await saveHeaderBeforeLeaving())) return;
    setReviewRunIntent(null);
    setTaskId(null);
  }, [saveHeaderBeforeLeaving, setTaskId]);

  // The run lookup is async: read the latest save callback afterwards so edits
  // typed while it was pending are persisted, not discarded by the navigation.
  const saveHeaderRef = useRef(saveHeaderBeforeLeaving);
  saveHeaderRef.current = saveHeaderBeforeLeaving;

  const handleOpenSourceRun = useCallback(
    async (runId: string) => {
      const startedOnTaskId = currentTaskIdRef.current;
      try {
        const location = await getActiveRunLocation(runId);
        if (currentTaskIdRef.current !== startedOnTaskId) return;
        if (
          (location.taskId || location.conversationId) &&
          !(await saveHeaderRef.current())
        ) {
          return;
        }
        if (currentTaskIdRef.current !== startedOnTaskId) return;
        if (location.taskId) {
          setTaskId(location.taskId);
          await navigate({
            to: '/board/$projectId',
            params: { projectId: location.projectId },
            search: { taskId: location.taskId, runId } as never,
          });
          return;
        }
        if (location.conversationId) {
          setTaskId(null);
          await navigate({
            to: '/chat/$projectId',
            params: { projectId: location.projectId },
            search: { conversationId: location.conversationId, runId } as never,
          });
          return;
        }
        toast.error('The source run has no linked task or conversation.');
      } catch (error) {
        console.error('Failed to locate source run:', error);
        toast.error('Could not open the source run.');
      }
    },
    [navigate, setTaskId],
  );

  const handleChangePriority = useCallback(
    (mode: 'next' | 'top') => {
      if (!task_id || !tasks) return;
      const requestId = ++priorityRequestSeqRef.current;
      setPriorityOverride({ taskId: task_id, mode, requestId });
      let newPriority: number;
      if (mode === 'top') {
        const minPriority = tasks.reduce(
          (min, f) => Math.min(min, f.priority),
          0,
        );
        newPriority = minPriority - 1000;
      } else {
        const maxPriority = tasks.reduce(
          (max, f) => Math.max(max, f.priority),
          -1000,
        );
        newPriority = maxPriority + 1000;
      }
      // Hold the chosen value for the whole PATCH. On success the list cache
      // already carries the new priority; on failure it is rolled back (the
      // mutation's own onError shows the toast). Either way the select then
      // follows the stored priority again. The promise settles even if a later
      // save replaces the mutation observer, and only this request's override
      // is released.
      updateMutation
        .mutateAsync({ task_id, data: { priority: newPriority } })
        .catch(() => undefined)
        .finally(() =>
          setPriorityOverride((current) =>
            current?.requestId === requestId ? null : current,
          ),
        );
    },
    [task_id, tasks, updateMutation],
  );

  const handleSaveDescription = useCallback(() => {
    if (!task_id || !task) return;
    // Close the editor only once the PATCH succeeded: on a rejected update
    // (e.g. running-task 409) the typed text must stay editable for a retry.
    updateMutation.mutate(
      { task_id, data: { description: editDescription } },
      {
        onSuccess: () => {
          if (currentTaskIdRef.current === task_id) {
            setIsEditingDescription(false);
          }
        },
      },
    );
  }, [task_id, task, editDescription, updateMutation]);

  const handleApplyAiDescription = useCallback(
    async (draft: string) => {
      const appliedTaskId = task_id;
      if (!appliedTaskId) return;
      // Await persistence: the panel closes only after the PATCH succeeds
      // and surfaces (with retry) a failed update, e.g. a running-task 409.
      setIsAiApplyPending(true);
      try {
        await updateTaskAsync({
          task_id: appliedTaskId,
          data: { description: draft },
        });
        if (currentTaskIdRef.current === appliedTaskId) {
          setEditDescription(draft);
        }
      } finally {
        setIsAiApplyPending(false);
      }
    },
    [task_id, updateTaskAsync],
  );

  const handleCloseAiEdit = useCallback(() => setIsAiEditOpen(false), []);

  const handleChatAboutTask = useCallback(async () => {
    if (!task || isCreatingTaskChat) return;
    if (!(await saveHeaderBeforeLeaving())) return;
    const chatTask = {
      ...task,
      title: editTitle.trim() || task.title,
      description: editDescription,
    };
    const draft = taskChatDraft(chatTask);

    setIsCreatingTaskChat(true);
    try {
      // Create the conversation before navigating so this action always starts
      // in a fresh conversation, even when another conversation is selected.
      // Only bind to a worktree when both pieces of task metadata are present
      // and nonblank; incomplete metadata should retain the ordinary
      // project-chat fallback.
      const conversation = await createConversation(
        project_id,
        taskChatConversationOptions(chatTask),
      );
      const store = useStore.getState();
      store.setActiveConvForProject(project_id, conversation.id);
      store.saveDraftByKey(`${project_id}:${conversation.id}`, draft);
      queryClient.invalidateQueries({
        queryKey: queryKeys.conversations.all(project_id),
      });
      setTaskId(null);
      navigate({ to: '/chat/$projectId', params: { projectId: project_id } });
    } catch (error) {
      console.error('Failed to create task chat:', error);
      toast.error('Could not start a new chat for this task.');
    } finally {
      setIsCreatingTaskChat(false);
    }
  }, [
    task,
    editDescription,
    editTitle,
    project_id,
    queryClient,
    isCreatingTaskChat,
    saveHeaderBeforeLeaving,
    setTaskId,
    navigate,
  ]);

  const handleToggleDependency = (id: string) => {
    headerDirtyRef.current.dependsOn = true;
    setEditDependsOn((prev) =>
      prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id],
    );
  };

  const handleClearDependencies = () => {
    headerDirtyRef.current.dependsOn = true;
    setEditDependsOn([]);
  };

  const filteredTasks = useMemo(() => {
    return (tasks || [])
      .filter((f) => {
        if (f.id === task_id) return false;
        // A task that depends on this one would create a cycle. Keep it listed
        // only if it is already selected so it can still be removed.
        if (
          f.depends_on_ids?.includes(task_id!) &&
          !editDependsOn.includes(f.id)
        )
          return false;
        // An A/B experiment is listed by its parent only (the parent follows
        // the picked winner). Keep a variant listed if it is already selected.
        if (taskAbParentId(f) !== null && !editDependsOn.includes(f.id))
          return false;

        const matchesSearch =
          f.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          f.description?.toLowerCase().includes(searchQuery.toLowerCase());
        if (!matchesSearch) return false;

        if (showOnlyActive) {
          if (f.archived) return false;
          const stage = findStage(stages, f.status);
          if (stage?.type === 'done') return false;
        }

        return true;
      })
      .sort((a, b) => b.priority - a.priority);
  }, [tasks, searchQuery, showOnlyActive, stages, task_id, editDependsOn]);

  // Every selected dependency, falling back to its id when the task is not in
  // the loaded list, so no dependency is ever hidden from the user.
  const dependsOnItems = useMemo(
    () =>
      editDependsOn.map((id) => ({
        id,
        title: (tasks || []).find((f) => f.id === id)?.title ?? id,
      })),
    [tasks, editDependsOn],
  );

  // Stages the user can choose to skip during auto-advance. Skipping is only
  // meaningful for active / review stages — done/queue are terminal waypoints
  // (queue = where the task lands before run; done = end of pipeline), so we
  // hide them. `inactive` stages are excluded since they don't auto-advance
  // to themselves anyway.
  const skippableStages = useMemo(
    () =>
      activeStages.filter(
        (s) =>
          s.type === 'active' || s.type === 'testing' || s.type === 'review',
      ),
    [activeStages],
  );

  const handleToggleSkipStage = useCallback((stageId: string) => {
    headerDirtyRef.current.skipStages = true;
    setEditSkipStages((current) =>
      current.includes(stageId)
        ? current.filter((id) => id !== stageId)
        : [...current, stageId],
    );
  }, []);

  const {
    pending: pendingAttachments,
    removeAt: removeAttachment,
    clear: clearAttachments,
    addFiles,
    handlePaste: handleAttachmentPaste,
  } = usePasteAttachments();
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The composer textarea is uncontrolled and mounts after the task-change
  // effect (dialog reopen, Details -> Chat tab switch), so restore the saved
  // draft whenever it mounts. A non-empty value is user text; keep it.
  const setChatInput = useCallback((node: HTMLTextAreaElement | null) => {
    chatInputRef.current = node;
    if (node && !node.value) {
      node.value = useStore.getState().draftByKey[draftKeyRef.current] ?? '';
    }
  }, []);
  const readDraft = useCallback(() => chatInputRef.current?.value ?? '', []);
  const clearDraft = useCallback(() => {
    if (chatInputRef.current) {
      chatInputRef.current.value = '';
    }
  }, []);
  const sendMessageMutation = useMutation({
    // The target task is bound when the send starts: the dialog stays mounted
    // across Next/Prev, so a late upload or response must not reach another task.
    mutationFn: ({ taskId, content }: { taskId: string; content: string }) =>
      sendTaskMessage(project_id, taskId, content),
    onSuccess: (_, { taskId }) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.messages.all(project_id, taskId),
      });
      useStore.getState().clearDraftByKey(taskId);
      if (draftKeyRef.current === taskId) {
        clearDraft();
        clearAttachments();
      }
    },
    // Draft and attachment chips stay in place so the user can retry.
    onError: (err: Error) =>
      toast.error(
        err.message
          ? `Could not send the message: ${err.message}`
          : 'Could not send the message.',
      ),
  });

  // Clear the sent prompt (textarea, persisted draft and attachment chips) only
  // once the run was accepted; on error all stay so the user can retry.
  const startRerun = useCallback(
    (
      taskId: string,
      vars: Parameters<typeof executeMutation.mutate>[0],
      sentPrompt: boolean,
    ) => {
      executeMutation.mutate(
        vars,
        sentPrompt
          ? {
              onSuccess: () => {
                if (draftKeyRef.current === taskId) {
                  clearDraft();
                  clearAttachments();
                }
                useStore.getState().clearDraftByKey(taskId);
              },
            }
          : undefined,
      );
    },
    [executeMutation, clearDraft, clearAttachments],
  );

  // Restore persisted draft (or clear) when switching tasks / opening dialog
  useEffect(() => {
    const savedDraft = task_id
      ? (useStore.getState().draftByKey[task_id] ?? '')
      : '';
    if (chatInputRef.current) {
      chatInputRef.current.value = savedDraft;
    }
    clearAttachments();
  }, [task_id, clearAttachments]);

  const open = !!task_id;

  const isQueued = taskPhase === 'queued';
  const isPreparing = taskPhase === 'preparing';

  // Live elapsed timer for running tasks
  const elapsed = useElapsedTime(task?.started_at, isRunning);

  // Static duration for completed/failed tasks
  const completedDuration = useMemo(() => {
    if (!task?.started_at || !task?.completed_at) return null;
    const ms =
      new Date(task.completed_at).getTime() -
      new Date(task.started_at).getTime();
    return ms > 0 ? ms : null;
  }, [task?.started_at, task?.completed_at]);

  const handleDelete = async () => {
    if (!task_id) return;
    const confirmed = await confirmAction('This cannot be undone.', {
      title: 'Delete this task?',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!confirmed) return;
    deleteMutation.mutate(task_id);
    setTaskId(null);
  };

  const [moveOpen, setMoveOpen] = useState(false);
  const moveMutation = useMoveTaskToProject(project_id, (moved) => {
    setMoveOpen(false);
    setTaskId(null);
    void moved;
  });

  const handleMoveToProject = (targetId: string) => {
    if (!task_id) return;
    moveMutation.mutate({ task_id, target_project_id: targetId });
  };

  // The mutation callback outlives the render that created it; read the latest
  // save-first navigation so header edits made while forking are not lost.
  const navigateTaskRef = useRef(handleNavigateTask);
  navigateTaskRef.current = handleNavigateTask;
  const forkMutation = useForkTask(project_id, (newTask) => {
    setForkFromMessageId(null);
    setForkPrompt('');
    void navigateTaskRef.current(newTask.id);
  });

  const handleFork = () => {
    if (!task_id || !forkFromMessageId || !forkPrompt.trim()) return;
    forkMutation.mutate({
      task_id,
      messageId: forkFromMessageId,
      prompt: forkPrompt.trim(),
    });
  };

  const handleSelectForkMessage = useCallback((messageId: string) => {
    setForkFromMessageId(messageId);
    setForkPrompt('');
  }, []);

  /**
   * Upload pending attachments and append [Attached files] block to text.
   * Clears the chips unless `keepAttachments` is set (the caller then clears
   * them once its request succeeds). Resolves to `null` when any upload was
   * rejected: the user is told which files failed, the chips stay and the
   * caller must not send, queue or clear anything.
   */
  const buildDescriptionWithAttachments = useCallback(
    async (
      text: string,
      { keepAttachments = false }: { keepAttachments?: boolean } = {},
    ): Promise<string | null> => {
      const description = await appendUploadedAttachments(
        pendingAttachments,
        text,
        (file) => uploadAttachment(project_id, file),
      );
      if (description !== null && !keepAttachments) clearAttachments();
      return description;
    },
    [pendingAttachments, project_id, clearAttachments],
  );

  // Shared tail of Queue / Backlog: the draft is cleared and the dialog closed
  // only once the PATCH succeeded (useUpdateTask reports a failure itself), so
  // a rejected update keeps the typed prompt and chips for a retry.
  const finishQueueUpdate = useCallback(
    async (taskId: string, data: Record<string, unknown>) => {
      try {
        await updateMutation.mutateAsync({ task_id: taskId, data });
      } catch {
        return;
      }
      useStore.getState().clearDraftByKey(taskId);
      if (currentTaskIdRef.current === taskId) setTaskId(null);
    },
    [updateMutation, setTaskId],
  );

  // One guard for Queue, Backlog and their Enter shortcut: set before the
  // first await (header save, attachment upload), so a double Enter or click
  // cannot send the same prompt twice. The state mirrors it for the buttons.
  const queueInFlightRef = useRef(false);
  const [queueInFlight, setQueueInFlight] = useState(false);
  const runQueueAction = useCallback(async (action: () => Promise<void>) => {
    if (queueInFlightRef.current) return;
    queueInFlightRef.current = true;
    setQueueInFlight(true);
    try {
      await action();
    } finally {
      queueInFlightRef.current = false;
      setQueueInFlight(false);
    }
  }, []);

  const handleQueue = useCallback(
    (text: string) =>
      runQueueAction(async () => {
        if (!task_id) return;
        const targetStage =
          executeStages.find((s) => s.id === validQueueStageId) ??
          activeStage ??
          initialStage;
        const targetStageId = targetStage?.id;
        if (!targetStageId) return;
        // The header PATCH must land first: the status change makes
        // stage_variant / co_stages edits fail on the server.
        if (!(await handleSaveHeader())) return;
        const data: Record<string, unknown> = { status: targetStageId };
        if (text.trim() || pendingAttachments.length > 0) {
          const description = await buildDescriptionWithAttachments(text, {
            keepAttachments: true,
          });
          if (description === null) return;
          data.description = description;
        }
        await finishQueueUpdate(task_id, data);
      }),
    [
      runQueueAction,
      task_id,
      validQueueStageId,
      executeStages,
      activeStage,
      finishQueueUpdate,
      initialStage,
      buildDescriptionWithAttachments,
      handleSaveHeader,
      pendingAttachments,
    ],
  );

  const handleBacklog = useCallback(
    (text: string) =>
      runQueueAction(async () => {
        if (!task_id || !initialStage) return;
        if (!(await handleSaveHeader())) return;
        const data: Record<string, unknown> = { status: initialStage.id };
        if (text.trim() || pendingAttachments.length > 0) {
          const description = await buildDescriptionWithAttachments(text, {
            keepAttachments: true,
          });
          if (description === null) return;
          data.description = description;
        }
        await finishQueueUpdate(task_id, data);
      }),
    [
      runQueueAction,
      task_id,
      initialStage,
      finishQueueUpdate,
      buildDescriptionWithAttachments,
      handleSaveHeader,
      pendingAttachments,
    ],
  );

  // Re-run menu actions: the header edits are saved first so the run starts
  // with the runtime, co-stages and skip-stages the user just chose.
  const handleRerun = useCallback(
    async (mode: { freshSession?: true; reset?: true } = {}) => {
      if (!task_id) return;
      const taskId = task_id;
      const rawPrompt = readDraft().trim();
      const stage = validQueueStageId || undefined;
      if (!(await handleSaveHeader())) return;
      const prompt = await buildDescriptionWithAttachments(rawPrompt, {
        keepAttachments: true,
      });
      if (prompt === null) return;
      startRerun(
        taskId,
        prompt
          ? { task_id: taskId, prompt, ...mode, stage }
          : { task_id: taskId, ...mode, stage },
        !!prompt,
      );
    },
    [
      task_id,
      readDraft,
      validQueueStageId,
      handleSaveHeader,
      buildDescriptionWithAttachments,
      startRerun,
    ],
  );

  const queueBusy = queueInFlight || updateMutation.isPending;

  const last_run = runLogs[0] || null;
  const totalCostUsd = useMemo(() => {
    const measured = runLogs.filter((run) => run.cost_usd != null);
    return measured.length
      ? measured.reduce((sum, run) => sum + (run.cost_usd ?? 0), 0)
      : null;
  }, [runLogs]);
  const lastRunCtxLimit = useMemo(
    () => getContextWindowLimit(last_run?.model),
    [last_run?.model],
  );

  const total_tokens = useMemo(() => {
    return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  }, [messages]);

  // Guards the window between the first send and `isPending`, while
  // attachments are still uploading, so a double Enter sends only once.
  const sendInFlightRef = useRef(false);
  const handleSend = useCallback(
    async (text: string) => {
      if (!text.trim() && pendingAttachments.length === 0) return;
      if (sendInFlightRef.current) return;
      if (!task_id) return;
      sendInFlightRef.current = true;
      // Bind the target before the first await; the dialog may navigate away.
      const taskId = task_id;
      try {
        if (runJumpSpacerRef.current) {
          runJumpSpacerRef.current.style.height = '0px';
        }
        const content = await buildDescriptionWithAttachments(text, {
          keepAttachments: true,
        });
        if (content === null) {
          sendInFlightRef.current = false;
          return;
        }
        // Re-pin after attachment preparation so Android keyboard/viewport
        // movement cannot leave the upcoming response below the visible area.
        scrollToBottom();
        sendMessageMutation.mutate(
          { taskId, content },
          {
            onSettled: () => {
              sendInFlightRef.current = false;
            },
          },
        );
      } catch (error) {
        sendInFlightRef.current = false;
        throw error;
      }
    },
    [
      buildDescriptionWithAttachments,
      pendingAttachments.length,
      scrollToBottom,
      sendMessageMutation,
      task_id,
    ],
  );

  const handleQuestionAnswer = useCallback(
    (text: string, submission?: QuestionSubmission) => {
      if (submission?.codexRequestId && submission.answers && task_id) {
        answerTaskCodexUserInput(
          project_id,
          task_id,
          submission.codexRequestId,
          submission.answers,
          text,
        ).catch(() => {
          // If the waiting run has already ended, preserve the normal task
          // follow-up behavior so the answer is still available to the agent.
          void handleSend(text);
        });
        return;
      }
      void handleSend(text);
    },
    [handleSend, project_id, task_id],
  );

  // Keep completed question cards read-only after the transcript refreshes.
  // A later assistant turn causes the message list to be rebuilt, so relying
  // on QuestionCard's local submitted state alone would unlock earlier cards.
  const nextUserContentByAssistantId = useMemo(() => {
    const map = new Map<string, string>();
    let pendingAssistantIds: string[] = [];
    for (const message of messages) {
      if (message.role === 'assistant') {
        pendingAssistantIds.push(message.id);
      } else if (message.role === 'user' && pendingAssistantIds.length > 0) {
        for (const id of pendingAssistantIds) map.set(id, message.content);
        pendingAssistantIds = [];
      }
    }
    return map;
  }, [messages]);

  const lastAssistantId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'assistant') return messages[index].id;
    }
    return null;
  }, [messages]);

  // Last run errored and the task is idle — surface the error message.
  // A user-initiated stop is recorded as `task.error === 'Stopped by user'`
  // but is already rendered inline in the message stream at the stop point,
  // so it is intentionally excluded here to avoid a duplicate banner.
  const hasError = !!(
    task &&
    !isRunning &&
    !isQueued &&
    typeof task.error === 'string' &&
    task.error.length > 0 &&
    task.error !== STOPPED_BY_USER_ERROR
  );

  const forkedMessage = useMemo(
    () =>
      forkFromMessageId
        ? (messages.find((m) => m.id === forkFromMessageId) ?? null)
        : null,
    [forkFromMessageId, messages],
  );

  const renderedMessages = useMemo(() => {
    let markerFallback = 0;
    let currentTranscriptRunId: string | null = null;
    // The task description is auto-injected as the user prompt for each fresh
    // run. Once a run is marked by a run_start divider that description bubble
    // is redundant — the description lives in the task header and the divider
    // is the separator — so suppress it. Genuine new user input (questions,
    // answers) has different content and is still shown.
    const desc = task?.description?.trim();
    const isNeverStartedBacklog =
      !!task &&
      task.status === initialStage?.id &&
      !task.started_at &&
      !runHistoryLoadFailed &&
      runCount === 0;
    const renderMessages = messages.slice();
    for (const runId of outputRunIds) {
      const outputPage = outputPagesByRun[runId];
      if (!outputPage?.content || outputPage.runId !== runId) continue;
      const hasRunResult = renderMessages.some(
        (message) => message.role === 'assistant' && message.run_id === runId,
      );
      if (!hasRunResult) {
        const runStartedAt =
          renderMessages.find(
            (message) =>
              message.entry_type === 'run_start' && message.run_id === runId,
          )?.created_at ??
          runLogById.get(runId)?.run_at ??
          new Date(0).toISOString();
        const sidecarMessage: TaskMessage = {
          id: `sidecar-output:${runId}`,
          task_id: task_id!,
          role: 'assistant',
          content: outputPage.content,
          created_at: runStartedAt,
          run_id: runId,
          contentTruncated: true,
          contentTotalBytes: outputPage.total,
          contentStartBytes: outputPage.nextCursor,
        };
        const insertionIndex = renderMessages.findIndex(
          (message) => message.created_at > sidecarMessage.created_at,
        );
        if (insertionIndex >= 0)
          renderMessages.splice(insertionIndex, 0, sidecarMessage);
        else renderMessages.push(sidecarMessage);
      }
    }
    for (let idx = 0; idx < renderMessages.length - 1; idx += 1) {
      const marker = renderMessages[idx];
      const next = renderMessages[idx + 1];
      if (marker.entry_type !== 'run_start' || !marker.run_id) continue;
      const stageId = runLogById.get(marker.run_id)?.stage ?? '';
      const suffixIndex = stageId.lastIndexOf(':format-repair-');
      if (suffixIndex <= 0) continue;
      const baseStage = findStage(stages, stageId.slice(0, suffixIndex));
      if (
        baseStage?.type !== 'testing' ||
        next.role !== 'assistant' ||
        next.entry_type === 'run_start' ||
        next.run_id === marker.run_id
      ) {
        continue;
      }
      renderMessages[idx] = next;
      renderMessages[idx + 1] = marker;
      idx += 1;
    }

    const out: ReactNode[] = [];
    renderMessages.forEach((m, idx) => {
      if (m.entry_type === 'run_start') {
        currentTranscriptRunId = m.run_id ?? null;
      }
      if (isHiddenTaskMessage(m)) return;
      if (
        isDuplicateTestingFollowUp(renderMessages, idx) ||
        isSupersededRunDivider(renderMessages, idx)
      )
        return;
      if (m.entry_type === 'run_start' && m.run_id) {
        const runId = m.run_id;
        const runLog = runLogById.get(runId) ?? null;
        const numbered = runNumberById.has(runId);
        if (!numbered) markerFallback += 1;
        out.push(
          <RunDivider
            key={m.id}
            runId={runId}
            runNumber={numbered ? runNumberById.get(runId)! : markerFallback}
            runLog={runLog}
            stageTitle={
              runLog?.stage
                ? (findStage(stages, runLog.stage)?.title ?? runLog.stage)
                : null
            }
            created_at={m.created_at}
            agent_name={m.agent_name}
            model_name={m.model_name}
            highlighted={highlightRunId === runId}
          />,
        );
        return;
      }
      if (
        m.role === 'user' &&
        desc &&
        m.content.trim() === desc &&
        (isNeverStartedBacklog ||
          renderMessages[idx + 1]?.entry_type === 'run_start' ||
          renderMessages[idx - 1]?.entry_type === 'run_start')
      ) {
        return;
      }
      if (m.role === 'assistant' && m.content === STOPPED_BY_USER_MSG) {
        out.push(
          <div
            key={m.id}
            data-ui="task-transcript-message"
            data-msg-id={m.id}
            data-task-id={m.task_id}
            data-run-id={currentTranscriptRunId || undefined}
            className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2"
          >
            <div className="flex items-start gap-2">
              <RotateCcw className="size-3.5 mt-0.5 shrink-0 text-destructive" />
              <p className="text-xs text-destructive break-words flex-1">
                {STOPPED_BY_USER_ERROR}
              </p>
            </div>
          </div>,
        );
        return;
      }
      const outputPage = m.run_id ? outputPagesByRun[m.run_id] : undefined;
      const isSidecarMessage = m.id.startsWith('sidecar-output:');
      const isRunOutputOwner =
        m.role === 'assistant' && !!m.run_id && m.entry_type === 'run_result';
      const deferLargeMessage =
        !!m.contentTruncated ||
        shouldDeferTaskMessage(m.content) ||
        isRunOutputOwner;
      const outputDisplayContent =
        isRunOutputOwner && outputPage?.content
          ? outputPage.content
          : m.content;
      out.push(
        <LazyBubble
          key={m.id}
          msgId={m.id}
          taskId={m.task_id}
          runId={currentTranscriptRunId}
          rootRef={chatRef}
        >
          <ChatMessageBubble
            id={m.id}
            role={m.role}
            content={outputDisplayContent}
            created_at={m.created_at}
            verdictTone={reviewVerdictTone(m)}
            agent_name={m.agent_name}
            model_name={m.model_name}
            project_id={project_id}
            onOpenArtifact={openArtifact}
            taskOutputContext={
              m.role === 'assistant' && deferLargeMessage
                ? {
                    projectId: project_id,
                    taskId: m.task_id,
                    runId: m.run_id,
                    messageId: isSidecarMessage ? undefined : m.id,
                    initialBeforeOffset: outputPage?.nextCursor,
                    contentStartBytes: m.run_id
                      ? undefined
                      : m.contentStartBytes,
                    initialEntries: outputPage?.entries,
                    totalEndOffset: outputPage?.total,
                  }
                : undefined
            }
            onFork={handleSelectForkMessage}
            steeringDeliveryStatus={
              m.role === 'user' && m.steeringDelivery ? (
                <span
                  data-ui="task-steering-delivery"
                  data-message-id={m.id}
                  data-steering-status={m.steeringDelivery}
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1 text-[10px]',
                    m.steeringDelivery === 'steered'
                      ? 'text-emerald-700 dark:text-emerald-500'
                      : 'text-muted-foreground',
                  )}
                >
                  {m.steeringDelivery === 'steered' ? (
                    <>
                      <Check className="size-3" /> Message steered into the
                      current run.
                    </>
                  ) : (
                    'Message queued for the continuation.'
                  )}
                </span>
              ) : undefined
            }
            onSendMessage={
              m.role === 'assistant' &&
              !nextUserContentByAssistantId.has(m.id) &&
              m.id === lastAssistantId
                ? handleQuestionAnswer
                : undefined
            }
            questionAnswer={nextUserContentByAssistantId.get(m.id)}
          />
        </LazyBubble>,
      );
    });
    return out;
  }, [
    messages,
    task?.description,
    task?.status,
    task?.started_at,
    handleSelectForkMessage,
    handleQuestionAnswer,
    openArtifact,
    nextUserContentByAssistantId,
    lastAssistantId,
    runLogById,
    runNumberById,
    stages,
    initialStage,
    runCount,
    highlightRunId,
    outputPagesByRun,
    outputRunIds,
  ]);

  const activeStageTitle = useMemo(
    () => activeStage?.title || 'active',
    [activeStage],
  );

  // A stale deep link: the board list finished loading without this id and the
  // direct fetch says it does not exist. Other errors keep the normal dialog.
  const taskNotFound =
    !!task_id &&
    tasksLoaded &&
    !task &&
    fullTaskError instanceof ApiError &&
    fullTaskError.status === 404;

  if (taskNotFound) {
    return (
      <Dialog
        open
        onOpenChange={(o) => {
          if (!o) {
            setReviewRunIntent(null);
            setTaskId(null);
          }
        }}
      >
        <DialogContent
          data-ui="task-detail-not-found"
          data-task-id={task_id}
          showCloseButton={false}
          className="sm:max-w-md gap-4"
        >
          <DialogHeader>
            <DialogTitle>Task not found</DialogTitle>
            <DialogDescription>
              This task may have been deleted, archived or belong to another
              project.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Close
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        // Keep the dialog mounted while Apply is awaiting the PATCH. This
        // prevents closing and reopening another task over the same local
        // edit state while the request is still in flight.
        if (!o && !isAiApplyPending) void handleCloseDialog();
      }}
    >
      <DialogContent
        showCloseButton={false}
        onOpenAutoFocus={handleDialogOpenAutoFocus}
        onEscapeKeyDown={(e) => {
          // Escape while editing the description cancels the edit only.
          if (isEditingDescription) e.preventDefault();
        }}
        className={cn(
          'h-[85dvh] sm:max-w-4xl max-h-[85dvh] flex flex-col gap-0 p-0 overflow-hidden',
          // Phones: use the whole viewport instead of a 15% margin.
          'max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:max-w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:border-0',
        )}
      >
        <DialogClose
          disabled={isAiApplyPending}
          className="absolute right-2 top-2.5 z-20 inline-flex size-7 items-center justify-center rounded-md opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none"
          title={
            isAiApplyPending
              ? 'Wait for the description update to finish'
              : 'Close'
          }
        >
          <X className="size-4" />
          <span className="sr-only">Close</span>
        </DialogClose>
        {/* Header */}
        <DialogHeader className="contents">
          <div
            data-ui="task-detail-header"
            className="order-0 shrink-0 space-y-2 border-b border-border px-4 pt-4 pb-3"
          >
            <div className="flex items-center gap-2 pr-9">
              <DialogTitle className="flex min-w-0 items-center gap-2 text-sm font-medium text-muted-foreground">
                <span className="max-sm:sr-only">View Task</span>
                {task?.id && (
                  <span
                    data-ui="task-detail-id"
                    data-task-id={task.id}
                    className="flex min-w-0 items-center gap-0.5 text-xs text-muted-foreground"
                  >
                    <span
                      title={task.id}
                      className="min-w-0 truncate font-mono font-medium"
                    >
                      {task.id}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        copyToClipboard(task.id);
                        setCopiedTaskId(true);
                        setTimeout(() => setCopiedTaskId(false), 2000);
                      }}
                      title="Copy task ID"
                      aria-label="Copy task ID"
                      className="inline-flex size-6 shrink-0 items-center justify-center rounded hover:bg-muted transition-colors"
                    >
                      {copiedTaskId ? (
                        <Check className="size-3 text-green-700 dark:text-green-500" />
                      ) : (
                        <Copy className="size-3" />
                      )}
                    </button>
                  </span>
                )}
              </DialogTitle>
              <DialogDescription className="sr-only">
                Task details, description, stage and run transcript.
              </DialogDescription>
              {task && (
                <div className="flex items-center gap-1">
                  {task.sourceConversationId && (
                    <a
                      data-ui="task-source-conversation-link"
                      data-conversation-id={task.sourceConversationId}
                      data-project-id={
                        task.sourceConversationProjectId ?? project_id
                      }
                      href={`/chat/${encodeURIComponent(task.sourceConversationProjectId ?? project_id)}?conversationId=${encodeURIComponent(task.sourceConversationId)}`}
                      className="text-xs text-primary hover:underline"
                    >
                      Source conversation
                    </a>
                  )}
                  {task.sourceRunId && (
                    <button
                      type="button"
                      data-ui="task-source-run-link"
                      data-run-id={task.sourceRunId}
                      className="text-xs text-primary hover:underline"
                      onClick={() =>
                        void handleOpenSourceRun(task.sourceRunId!)
                      }
                    >
                      Source run
                    </button>
                  )}
                </div>
              )}
              <div
                data-ui="task-stage-navigation"
                className="ml-auto flex shrink-0 items-center gap-0.5"
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  data-ui="task-previous-navigation"
                  aria-label={
                    previousTask
                      ? `Open previous task: ${previousTask.title}`
                      : 'No previous task in this stage'
                  }
                  title={
                    previousTask
                      ? `Previous: ${previousTask.title}`
                      : 'No previous task in this stage'
                  }
                  disabled={!previousTask || updateMutation.isPending}
                  onClick={() => void handleNavigateTask(previousTask?.id)}
                >
                  <ChevronLeft />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  data-ui="task-next-navigation"
                  aria-label={
                    nextTask
                      ? `Open next task: ${nextTask.title}`
                      : 'No next task in this stage'
                  }
                  title={
                    nextTask
                      ? `Next: ${nextTask.title}`
                      : 'No next task in this stage'
                  }
                  disabled={!nextTask || updateMutation.isPending}
                  onClick={() => void handleNavigateTask(nextTask?.id)}
                >
                  <ChevronRight />
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <div className="flex min-w-0 basis-full items-start gap-2 sm:flex-1 sm:basis-0">
                <div
                  // Fallback dot: light uses the status token, dark keeps the
                  // exact pre-light-theme hex.
                  className="mt-3 size-2.5 shrink-0 rounded-full bg-[color:var(--status-backlog)] dark:bg-[#8B8FA3]"
                  style={
                    stage?.color ? { backgroundColor: stage.color } : undefined
                  }
                />
                {/* A textarea so a long title wraps instead of truncating;
                    Enter does not insert a newline. */}
                <Textarea
                  rows={1}
                  value={editTitle}
                  onChange={(e) => {
                    headerDirtyRef.current.title = true;
                    setEditTitle(e.target.value.replace(/\s*\n+\s*/g, ' '));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.preventDefault();
                  }}
                  aria-label="Task title"
                  className="min-h-8 resize-none overflow-hidden border-transparent px-1 py-1 text-base font-semibold leading-6 shadow-none md:text-base"
                  placeholder="Title"
                />
              </div>
              <Badge variant="outline" className="shrink-0 text-xs">
                {stage?.title ?? task?.status.replace('_', ' ')}
              </Badge>
              <TaskReviewChips customValues={task?.custom_values} />
            </div>
          </div>
          <div
            data-ui="task-detail-details-panel"
            id="task-detail-panel-details"
            role={activeTab === 'details' ? 'tabpanel' : undefined}
            aria-labelledby={
              activeTab === 'details' ? 'task-detail-tab-details' : undefined
            }
            className={
              activeTab === 'details'
                ? 'order-2 flex flex-1 min-h-0 flex-col overflow-y-auto px-4 py-3 space-y-2 text-left [&>*]:shrink-0'
                : 'hidden'
            }
          >
            <TaskReviewTestingSummary
              verdicts={taskVerdicts}
              onOpenChat={() => selectTab('chat')}
            />
            <TaskDescriptionSection
              description={task?.description ?? ''}
              editDescription={editDescription}
              isEditing={isEditingDescription}
              onEditDescription={() => {
                // Opening seeds the draft; closing (Cancel) discards it.
                setEditDescription(task?.description || '');
                setIsEditingDescription(!isEditingDescription);
              }}
              onChangeDescription={setEditDescription}
              onCancelDescription={() => {
                setEditDescription(task?.description || '');
                setIsEditingDescription(false);
              }}
              onSaveDescription={handleSaveDescription}
              isSaving={updateMutation.isPending}
              onAiEditDescription={() => setIsAiEditOpen(true)}
            />
            {isAiEditOpen && task && (
              <TaskAiDescriptionPanel
                projectId={project_id}
                taskId={task.id}
                currentDescription={editDescription}
                isRunning={isRunning}
                isUpdatePending={updateMutation.isPending}
                onApply={handleApplyAiDescription}
                onClose={handleCloseAiEdit}
                onOpenInChat={handleChatAboutTask}
              />
            )}

            {task && isAbParent(task) && (
              <AbComparisonPanel
                projectId={project_id}
                parent={task}
                variants={abVariantTasks}
                stages={stages}
                onOpenTask={(id) => void handleNavigateTask(id)}
              />
            )}
            <div className="flex shrink-0 flex-col gap-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <RuntimePicker
                  projectId={project_id}
                  catalog={runtimeCatalog}
                  value={editRuntimeSelection}
                  onChange={(next) => {
                    headerDirtyRef.current.runtime = true;
                    setEditRuntimeSelection(next);
                    if (!next) setEditRuntimeStage(null);
                  }}
                  allowClear
                />
                <RuntimeStageScope
                  projectId={project_id}
                  runtimeSelection={editRuntimeSelection}
                  value={editRuntimeStage}
                  onChange={(next) => {
                    headerDirtyRef.current.runtime = true;
                    setEditRuntimeStage(next);
                  }}
                  dataUi="task-runtime-stage-edit"
                  className="basis-full sm:max-w-64"
                />

                <Select
                  compact
                  value={editPriorityMode}
                  onValueChange={(nextValue) =>
                    handleChangePriority(nextValue as 'next' | 'top')
                  }
                  title="Priority"
                  className="w-[120px]"
                >
                  <SelectItem value="next">Next in line</SelectItem>
                  <SelectItem value="top">Top priority</SelectItem>
                </Select>

                {executeStages.length > 1 && (
                  <Select
                    compact
                    value={displayedQueueStageId}
                    onValueChange={(nextValue) =>
                      setSelectedQueueStageId(nextValue)
                    }
                    title="Execute in stage"
                    className="w-[130px]"
                  >
                    {executeStages.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.title}
                      </SelectItem>
                    ))}
                  </Select>
                )}

                <DropdownMenu
                  onOpenChange={(open) => {
                    if (!open) setSearchQuery('');
                  }}
                >
                  <DropdownMenuTrigger asChild>
                    <FieldTrigger compact className="w-[160px]">
                      <span
                        className={cn(
                          'flex items-center gap-1.5',
                          dependsOnItems.length === 0 &&
                            'text-muted-foreground',
                        )}
                      >
                        <LinkIcon className="size-3 shrink-0" />
                        <span className="truncate">
                          {dependsOnItems.length === 1
                            ? dependsOnItems[0].title
                            : dependsOnItems.length > 1
                              ? `Depends on ${dependsOnItems.length}`
                              : 'Depends on…'}
                        </span>
                      </span>
                    </FieldTrigger>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    className="w-80 max-h-[400px] flex flex-col"
                    // Radix omits onOpenAutoFocus from its public content type but forwards it
                    // at runtime; use it to focus the search input instead of the menu root.
                    {...{
                      onOpenAutoFocus: (e: Event) => {
                        e.preventDefault();
                        dependsSearchInputRef.current?.focus();
                      },
                    }}
                  >
                    <DropdownMenuLabel className="flex items-center justify-between pb-1">
                      <span>Project Tasks</span>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className={cn(
                          'size-6 h-6 w-6',
                          showOnlyActive && 'text-primary bg-primary/10',
                        )}
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowOnlyActive(!showOnlyActive);
                        }}
                        title={
                          showOnlyActive
                            ? 'Showing only current tasks'
                            : 'Showing all tasks'
                        }
                      >
                        <Filter className="size-3" />
                      </Button>
                    </DropdownMenuLabel>
                    <div className="px-2 pb-2 pt-0">
                      <SearchInput
                        compact
                        ref={dependsSearchInputRef}
                        placeholder="Search tasks..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'ArrowDown') {
                            e.preventDefault();
                            e.stopPropagation();
                            (
                              dependsListRef.current?.querySelector<HTMLElement>(
                                '[data-ui="dependency-task-option"]',
                              ) ??
                              dependsListRef.current?.querySelector<HTMLElement>(
                                '[role="menuitem"]',
                              )
                            )?.focus();
                          } else if (e.key !== 'Escape' && e.key !== 'Tab') {
                            e.stopPropagation();
                          }
                        }}
                      />
                    </div>
                    <DropdownMenuSeparator />
                    <div
                      ref={dependsListRef}
                      className="overflow-y-auto flex-1"
                    >
                      {editDependsOn.length > 0 && (
                        <DropdownMenuItem
                          onSelect={handleClearDependencies}
                          className="text-muted-foreground italic"
                        >
                          <X className="size-3 mr-1.5" />
                          Clear selection
                        </DropdownMenuItem>
                      )}
                      {filteredTasks.map((f) => (
                        <DropdownMenuItem
                          key={f.id}
                          data-ui="dependency-task-option"
                          aria-checked={editDependsOn.includes(f.id)}
                          onSelect={(e) => {
                            e.preventDefault();
                            handleToggleDependency(f.id);
                          }}
                          className={cn(
                            'gap-2',
                            editDependsOn.includes(f.id) &&
                              'bg-primary/15 text-primary',
                          )}
                        >
                          <span
                            className={cn(
                              'inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm border',
                              editDependsOn.includes(f.id)
                                ? 'border-primary bg-primary text-primary-foreground'
                                : 'border-border bg-field',
                            )}
                            aria-hidden
                          >
                            {editDependsOn.includes(f.id) && (
                              <Check className="size-2.5" />
                            )}
                          </span>
                          <div className="flex flex-col min-w-0">
                            <span className="w-full whitespace-normal break-words">
                              {f.title}
                            </span>
                            <span className="text-[10px] text-muted-foreground">
                              {f.status}
                            </span>
                          </div>
                        </DropdownMenuItem>
                      ))}
                      {filteredTasks.length === 0 && (
                        <div className="px-2 py-3 text-xs text-muted-foreground text-center italic">
                          No tasks found matching "{searchQuery}"
                          {showOnlyActive && (
                            <p className="mt-1 text-[10px]">
                              Try disabling "Current Only" filter
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  </DropdownMenuContent>
                </DropdownMenu>

                {/* Skip stages dropdown — per-task override that drops
                  selected stage IDs from the forward auto-advance scan.
                  Active / review stages only; done/queue are terminal so
                  skipping them is meaningless. Empty selection (the
                  default) means "no skipping", matching the backend
                  null/[] convention. */}
                {skippableStages.length > 0 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs gap-1.5 w-[160px]"
                      >
                        <SkipForward className="size-3 shrink-0" />
                        {editSkipStages.length > 0 ? (
                          <span className="truncate">
                            Skip {editSkipStages.length}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">
                            Skip stages…
                          </span>
                        )}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent className="w-56">
                      <DropdownMenuLabel className="pb-1">
                        <span>Skip during auto-advance</span>
                      </DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      {skippableStages.map((s) => {
                        const checked = editSkipStages.includes(s.id);
                        return (
                          <DropdownMenuItem
                            key={s.id}
                            onSelect={(e) => {
                              e.preventDefault();
                              handleToggleSkipStage(s.id);
                            }}
                            className={cn(
                              'gap-2',
                              checked && 'bg-primary/15 text-primary',
                            )}
                          >
                            <span
                              className={cn(
                                'inline-flex size-3.5 items-center justify-center rounded-sm border',
                                checked
                                  ? 'border-primary bg-primary text-primary-foreground'
                                  : 'border-border bg-field',
                              )}
                              aria-hidden
                            >
                              {checked && <Check className="size-2.5" />}
                            </span>
                            <div className="flex items-center gap-1.5 min-w-0">
                              <div
                                className="size-1.5 rounded-full shrink-0"
                                style={{ backgroundColor: s.color }}
                              />
                              <span className="truncate">{s.title}</span>
                            </div>
                          </DropdownMenuItem>
                        );
                      })}
                      {editSkipStages.length > 0 && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onSelect={() => {
                              headerDirtyRef.current.skipStages = true;
                              setEditSkipStages([]);
                            }}
                            className="text-muted-foreground italic"
                          >
                            <X className="size-3 mr-1.5" />
                            Clear all
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant={headerHasChanges ? 'default' : 'ghost'}
                  size="sm"
                  className="h-7 px-2 text-xs"
                  data-ui="task-header-save"
                  onClick={() => void handleSaveHeader()}
                >
                  <Save className="size-3 mr-1" />
                  Save
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={handleChatAboutTask}
                  disabled={isCreatingTaskChat}
                  title="Open a new chat with this task as context"
                >
                  {isCreatingTaskChat ? (
                    <Loader2 className="size-3 mr-1 animate-spin" />
                  ) : (
                    <MessageCircle className="size-3 mr-1" />
                  )}
                  Chat
                </Button>
                <div className="flex-1" />
                {externalIssue && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => syncExternalIssueMutation.mutate()}
                    disabled={syncExternalIssueMutation.isPending}
                    title={`Refresh the title, description, and comments from ${issueHost}`}
                  >
                    <RefreshCw
                      className={cn(
                        'size-3 mr-1',
                        syncExternalIssueMutation.isPending && 'animate-spin',
                      )}
                    />
                    Sync {issueHost}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={async () => {
                    if (!task_id) return;
                    const mayHaveWorktree =
                      !task?.archived &&
                      !task?.merge_commit &&
                      !!(task?.worktree_path || task?.branch_name);
                    if (
                      mayHaveWorktree &&
                      !(await confirmAction(
                        'Its worktree and any uncommitted changes in it will be removed.',
                        {
                          title: 'Archive this task?',
                          confirmLabel: 'Archive',
                          destructive: true,
                        },
                      ))
                    )
                      return;
                    updateMutation.mutate({
                      task_id,
                      data: { archived: !task?.archived },
                    });
                  }}
                >
                  {task?.archived ? (
                    <ArchiveRestore className="size-3 mr-1" />
                  ) : (
                    <Archive className="size-3 mr-1" />
                  )}
                  {task?.archived ? 'Restore' : 'Archive'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => setMoveOpen(true)}
                  disabled={moveMutation.isPending}
                  title="Move this task to a different project"
                >
                  <FolderInput className="size-3 mr-1" />
                  Move to project
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                  onClick={handleDelete}
                >
                  <Trash2 className="size-3 mr-1" />
                  Delete
                </Button>
              </div>
            </div>
            {task && !abParentId && (
              <AbVariantSelect
                suffixes={variantSuffixes}
                selected={editAbVariants}
                onChange={(next) => {
                  headerDirtyRef.current.abVariants = true;
                  setEditAbVariants(next);
                }}
                stageType={stage?.type}
                forked={taskAbForkCommit(task) !== null}
                checkoutMode={project?.settings?.taskCheckoutMode}
                hasTaskRuntime={editRuntimeSelection !== null}
              />
            )}
            {task && (
              <CoStageSelect
                options={coStageOptions}
                selected={editCoStages}
                onChange={(next) => {
                  headerDirtyRef.current.coStages = true;
                  setEditCoStages(next);
                }}
                // The server rejects changes while the task holds an execution
                // claim: running, or queued for a sandbox slot.
                disabled={taskPhase === 'running' || taskPhase === 'queued'}
              />
            )}
            {abParentId && task && (
              <div
                data-ui="task-ab-variant-header"
                data-task-id={task.id}
                className="flex flex-wrap items-center gap-2 text-xs"
              >
                <Badge variant="outline" className="text-xs font-semibold">
                  Variant {variantLabel(taskStageVariant(task) ?? '?')}
                </Badge>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  data-ui="task-ab-parent-link"
                  data-parent-task-id={abParentId}
                  className="h-auto min-w-0 p-0 text-xs"
                  onClick={() => void handleNavigateTask(abParentId)}
                >
                  <span className="truncate">
                    {abParentTask?.title ?? abParentId}
                  </span>
                </Button>
              </div>
            )}
            {dependsOnItems.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                <span className="mr-1 text-xs text-muted-foreground">
                  Depends on:
                </span>
                {dependsOnItems.map((dep) => (
                  <Badge
                    key={dep.id}
                    data-ui="task-dependency-chip"
                    data-task-id={dep.id}
                    variant="secondary"
                    className="h-6 gap-0.5 py-0 pr-0.5 pl-2 text-[11px]"
                  >
                    {dep.title}
                    <button
                      type="button"
                      aria-label={`Remove dependency ${dep.title}`}
                      className="inline-flex size-5 items-center justify-center rounded-full hover:bg-muted"
                      onClick={() => handleToggleDependency(dep.id)}
                    >
                      <X className="size-3 hover:text-destructive" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
            {editSkipStages.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                <span
                  className="text-[10px] text-muted-foreground mr-1"
                  title="These stages will be skipped during auto-advance. Manual moves and agent update_task stage changes still work normally."
                >
                  Skip on auto-advance:
                </span>
                {editSkipStages.map((stageId) => {
                  const stageDef = stages.find((s) => s.id === stageId);
                  const label = stageDef?.title ?? stageId;
                  return (
                    <Badge
                      key={stageId}
                      variant="secondary"
                      className="text-[9px] h-4 px-1.5 gap-1"
                    >
                      {label}
                      <button
                        onClick={() => handleToggleSkipStage(stageId)}
                        title="Remove from skip list"
                      >
                        <X className="size-2 hover:text-destructive" />
                      </button>
                    </Badge>
                  );
                })}
              </div>
            )}
            {task?.branch_name && (
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                <GitFork className="size-3" /> Branch:{' '}
                <span className="font-medium">{task.branch_name}</span>
              </div>
            )}
            <div
              data-ui="task-detail-meta-footer"
              className="space-y-1.5 border-t border-border pt-3"
            >
              {task && (
                <dl
                  data-ui="task-detail-attribution"
                  className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-xs text-muted-foreground"
                >
                  <dt className="font-medium text-foreground/80">Owner</dt>
                  <dd
                    data-ui="task-detail-owner-badge"
                    data-task-id={task.id}
                    data-user-id={task.owner?.id ?? ''}
                    title={
                      task.owner
                        ? `Owner: ${task.owner.username}`
                        : 'Owner unavailable'
                    }
                    className="min-w-0 truncate"
                  >
                    {task.owner?.username ?? 'Unknown'}
                  </dd>
                  <dt className="font-medium text-foreground/80">
                    Triggered by
                  </dt>
                  <dd
                    data-ui="task-detail-trigger-badge"
                    data-task-id={task.id}
                    data-user-id={task.latestTrigger?.user?.id ?? ''}
                    title={`Triggered by: ${
                      task.latestTrigger?.user?.username ?? 'Automation'
                    }`}
                    className="min-w-0 truncate"
                  >
                    {task.latestTrigger?.user?.username ?? 'Automation'}
                  </dd>
                </dl>
              )}
              {task && (
                <div
                  data-ui="task-detail-metadata"
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground"
                >
                  <span>Created {formatRelativeTime(task.created_at)}</span>
                  {task.started_at && (
                    <span>Last run {formatRelativeTime(task.started_at)}</span>
                  )}
                  {isRunning && elapsed > 0 && (
                    <span className="inline-flex items-center gap-1 text-primary font-medium tabular-nums">
                      <Timer className="size-3" />
                      {formatDuration(elapsed)}
                    </span>
                  )}
                  {!isRunning && completedDuration && (
                    <span
                      className="inline-flex items-center gap-1 tabular-nums"
                      title="Execution duration"
                    >
                      <Timer className="size-3" />
                      {formatDuration(completedDuration)}
                    </span>
                  )}
                  {messages.length > 0 &&
                  (last_run?.tok_output != null ||
                    last_run?.tok_total != null) ? (
                    <span
                      className="tabular-nums"
                      title={
                        last_run!.tok_output != null
                          ? [
                              `output: ${last_run!.tok_output.toLocaleString()}`,
                              last_run!.tok_input != null
                                ? `cumulative in: ${last_run!.tok_input.toLocaleString()}`
                                : null,
                              last_run!.tok_cache_write != null &&
                              last_run!.tok_cache_write > 0
                                ? `cache write: ${last_run!.tok_cache_write.toLocaleString()}`
                                : null,
                              last_run!.tok_cache_read != null &&
                              last_run!.tok_cache_read > 0
                                ? `cache read: ${last_run!.tok_cache_read.toLocaleString()}`
                                : null,
                              last_run!.tok_context_last != null
                                ? `active context: ${last_run!.tok_context_last.toLocaleString()}${lastRunCtxLimit ? `/${lastRunCtxLimit.toLocaleString()}` : ''}`
                                : null,
                            ]
                              .filter(Boolean)
                              .join(' · ')
                          : `~${last_run!.tok_total?.toLocaleString()} tokens (older estimate)`
                      }
                    >
                      {last_run!.tok_output != null ? (
                        <>
                          {fmtTok(last_run!.tok_output)} out
                          {last_run!.tok_input != null && (
                            <span
                              className="text-muted-foreground"
                              title="Total cumulative input tokens across this run"
                            >
                              {' '}
                              · {fmtTok(last_run!.tok_input)} in
                            </span>
                          )}
                          {/* Cache write + read (the numbers that drive the
                          hit-rate badge below). Showing both keeps the
                          user oriented: a run with high read but no
                          write is pure cache re-use; a run with high
                          write and low read is a fresh cache miss. */}
                          {(last_run!.tok_cache_read != null &&
                            last_run!.tok_cache_read > 0) ||
                          (last_run!.tok_cache_write != null &&
                            last_run!.tok_cache_write > 0) ? (
                            <span
                              className="text-muted-foreground"
                              title={
                                getRunPath(last_run!).cacheControlActive
                                  ? "Anthropic prompt cache — the board's cache_control markers are active for this run"
                                  : "Cache stats from the underlying API call. Not driven by the board's cache_control markers on CLI runs."
                              }
                            >
                              {' '}
                              ·{' '}
                              {last_run!.tok_cache_write != null &&
                              last_run!.tok_cache_write > 0
                                ? `${fmtTok(last_run!.tok_cache_write)}↑`
                                : '0↑'}{' '}
                              {last_run!.tok_cache_read != null &&
                              last_run!.tok_cache_read > 0
                                ? `${fmtTok(last_run!.tok_cache_read)}↓`
                                : '0↓'}
                              {' cached'}
                            </span>
                          ) : null}
                          {(() => {
                            const pct = getCacheHitPct(last_run);
                            if (pct === null) return null;
                            const path = getRunPath(last_run);
                            // The badge uses the accent colour ONLY when
                            // our cache_control markers are actually driving
                            // the cache. On CLI runs the stats still come
                            // from the underlying API call, but the board
                            // contributed nothing — render muted so the
                            // user doesn't read it as "my optimization is
                            // working".
                            const cls = path.cacheControlActive
                              ? 'ml-1.5 inline-flex items-center gap-1 px-1.5 py-0 rounded bg-primary/15 text-primary font-medium tabular-nums'
                              : 'ml-1.5 inline-flex items-center gap-1 px-1.5 py-0 rounded border border-border text-muted-foreground tabular-nums';
                            const title = path.cacheControlActive
                              ? `${pct}% of cacheable input was served from the Anthropic cache this run (board-driven)`
                              : `${pct}% cache hit on a ${path.label} run — these stats come from the underlying API call, not from the board's cache_control markers`;
                            return (
                              <span className={cls} title={title}>
                                <span
                                  className={
                                    path.cacheControlActive
                                      ? 'inline-block size-1.5 rounded-full bg-primary'
                                      : 'inline-block size-1.5 rounded-full bg-muted-foreground/50'
                                  }
                                />
                                {pct}% cache
                                <span className="font-normal">
                                  {path.label}
                                </span>
                              </span>
                            );
                          })()}
                          {last_run!.tok_context_last != null && (
                            <span className="text-muted-foreground">
                              {' '}
                              |{' '}
                              {fmtCtx(
                                last_run!.tok_context_last,
                                last_run!.model,
                              )}
                            </span>
                          )}
                        </>
                      ) : (
                        <>~{fmtTok(last_run!.tok_total!)} tokens</>
                      )}
                      {last_run!.tool_usage_count != null && (
                        <span className={COST_TEXT_CLASS}>
                          {' '}
                          · {last_run!.tool_usage_count} calls
                        </span>
                      )}
                      {totalCostUsd != null && (
                        <span className="text-muted-foreground">
                          {' '}
                          · ${totalCostUsd.toFixed(4)} total
                        </span>
                      )}
                    </span>
                  ) : messages.length > 0 ? (
                    <span title="Estimated total tokens across all messages">
                      ~{total_tokens.toLocaleString()} tokens
                    </span>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        </DialogHeader>

        {/* Tab bar */}
        <div
          role="tablist"
          aria-label="Task sections"
          onKeyDown={handleTabListKeyDown}
          className="order-1 flex items-center gap-0.5 sm:gap-1 overflow-x-auto scrollbar-none touch-pan-x border-b border-border px-2 sm:px-4 bg-muted/30 shrink-0 [&>button]:shrink-0 [&>button]:whitespace-nowrap"
        >
          <button
            role="tab"
            data-ui="task-detail-tab"
            data-tab="details"
            id="task-detail-tab-details"
            tabIndex={activeTab === 'details' ? 0 : -1}
            aria-selected={activeTab === 'details'}
            aria-controls={
              activeTab === 'details' ? 'task-detail-panel-details' : undefined
            }
            onClick={() => selectTab('details')}
            className={taskTabClass(activeTab === 'details')}
          >
            Details
          </button>
          {!isForkedParent && (
            <>
              <button
                role="tab"
                data-ui="task-detail-tab"
                data-tab="chat"
                id="task-detail-tab-chat"
                tabIndex={activeTab === 'chat' ? 0 : -1}
                aria-selected={activeTab === 'chat'}
                aria-controls={
                  activeTab === 'chat' ? 'task-detail-panel-chat' : undefined
                }
                onClick={() => selectTab('chat')}
                className={taskTabClass(activeTab === 'chat')}
              >
                Chat
              </button>
              <button
                role="tab"
                data-ui="task-detail-tab"
                data-tab="history"
                id="task-detail-tab-history"
                tabIndex={activeTab === 'history' ? 0 : -1}
                aria-selected={activeTab === 'history'}
                aria-controls={
                  activeTab === 'history'
                    ? 'task-detail-panel-history'
                    : undefined
                }
                onClick={() => selectTab('history')}
                className={taskTabClass(activeTab === 'history')}
              >
                <span className="sm:hidden">History</span>
                <span className="max-sm:hidden">Run History</span>
                {runCount > 0 && (
                  <span className="ml-1 font-normal">({runCount})</span>
                )}
              </button>
              {showChanges && (
                <button
                  role="tab"
                  data-ui="task-detail-tab"
                  data-tab="changes"
                  id="task-detail-tab-changes"
                  tabIndex={activeTab === 'changes' ? 0 : -1}
                  aria-selected={activeTab === 'changes'}
                  aria-controls={
                    activeTab === 'changes'
                      ? 'task-detail-panel-changes'
                      : undefined
                  }
                  onClick={() => selectTab('changes')}
                  className={taskTabClass(activeTab === 'changes')}
                >
                  Changes
                </button>
              )}
              <button
                role="tab"
                data-ui="task-detail-tab"
                data-tab="recordings"
                id="task-detail-tab-recordings"
                tabIndex={activeTab === 'recordings' ? 0 : -1}
                aria-selected={activeTab === 'recordings'}
                aria-controls={
                  activeTab === 'recordings'
                    ? 'task-detail-panel-recordings'
                    : undefined
                }
                onClick={() => selectTab('recordings')}
                className={taskTabClass(activeTab === 'recordings')}
              >
                Recordings
                {recordings.length > 0 && (
                  <span className="ml-1 font-normal">
                    ({recordings.length})
                  </span>
                )}
              </button>
            </>
          )}
        </div>

        {/* Remount the viewport per tab so browser scroll state and Chat's
            smart-scroll listener cannot leak into another tab. The positions
            above restore each tab to its own previous offset. */}
        {previousChat && (
          <PreviousTranscriptLayer
            previous={previousChat}
            dataUi="task-chat-previous-transcript"
          />
        )}
        <div
          key={activeTab}
          ref={setTabContentNode}
          data-ui="task-tab-content"
          id={`task-detail-panel-${activeTab}`}
          data-task-tab={activeTab}
          data-transcript-revealed={
            activeTab === 'chat' ? String(!chatGated) : undefined
          }
          aria-busy={chatGated || undefined}
          role={activeTab === 'details' ? undefined : 'tabpanel'}
          aria-labelledby={
            activeTab === 'details' ? undefined : `task-detail-tab-${activeTab}`
          }
          className={`${activeTab === 'details' ? 'hidden' : 'order-3 flex-1 min-h-0'} overflow-y-auto overscroll-contain px-4 py-3${chatGated ? ' opacity-0' : ''}`}
          onScroll={handleTabContentScroll}
        >
          {activeTab === 'chat' ? (
            <div ref={chatContentRef} inert={chatGated} className="space-y-3">
              {/* Older messages loader — shown at the top of the list */}
              {isFetchingOlderMessages && (
                <div className="flex justify-center py-2">
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                </div>
              )}
              {!isFetchingOlderMessages && hasOlderMessages && (
                <div className="flex justify-center py-1">
                  <button
                    type="button"
                    onClick={() => {
                      if (chatRef.current)
                        prevScrollHeightRef.current =
                          chatRef.current.scrollHeight;
                      fetchOlderMessages();
                    }}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Scroll up to load older messages
                  </button>
                </div>
              )}

              {/* Message history */}
              {renderedMessages}

              {/* Live streaming bubble */}
              {task_id && hasCurrentStreaming && (
                <TaskStreamingBubble
                  key={`${task_id}:${currentTaskStreamRunId || 'unowned'}`}
                  taskId={task_id}
                  projectId={project_id}
                  messages={messages}
                  isRunning={isRunning}
                  onSendMessage={handleQuestionAnswer}
                  onOpenArtifact={openArtifact}
                />
              )}

              {/* Worktree creation before the agent launches */}
              {isPreparing && !hasCurrentStreaming && (
                <div
                  data-ui="task-preparing-worktree"
                  className="flex items-center gap-2 text-xs text-muted-foreground"
                >
                  <Loader2 className="size-3 animate-spin" />
                  Preparing worktree… The agent starts once it is ready.
                </div>
              )}

              {/* Waiting in queue indicator */}
              {isQueued && !isPreparing && !hasCurrentStreaming && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  Waiting in queue…
                </div>
              )}

              {/* Running indicator when no streaming output yet */}
              {isRunning && !hasCurrentStreaming && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  Agent is running…
                  {elapsed > 0 && (
                    <span className="tabular-nums">
                      ({formatDuration(elapsed)})
                    </span>
                  )}
                </div>
              )}

              {/* Error banner — shown when the last run failed. Retry is
                  intentionally omitted for kanban tasks; use the edit/re-run
                  controls instead. */}
              {hasError && (
                <div className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2">
                  <div className="flex items-start gap-2">
                    <RotateCcw className="size-3.5 mt-0.5 shrink-0 text-destructive" />
                    <p className="text-xs text-destructive break-words flex-1">
                      {task?.error}
                    </p>
                  </div>
                </div>
              )}

              {/* Allows a history jump to align at the top margin even when
                  the selected final run is shorter than the chat viewport. */}
              <div ref={runJumpSpacerRef} aria-hidden="true" />

              {messages.length === 0 && messagesLoading && (
                <p
                  role="status"
                  data-ui="task-chat-loading"
                  className="py-8 text-center text-sm text-muted-foreground"
                >
                  Loading messages…
                </p>
              )}

              {/* Empty state: nothing has run yet and nothing is on its way. */}
              {messages.length === 0 &&
                !messagesLoading &&
                !isRunning &&
                !isQueued &&
                !isPreparing &&
                !hasError && (
                  <p
                    data-ui="task-chat-empty"
                    className="py-8 text-center text-sm text-muted-foreground"
                  >
                    No messages yet. Write a prompt below to queue this task.
                  </p>
                )}
            </div>
          ) : activeTab === 'history' ? (
            <div className="space-y-4 py-2 animate-in fade-in slide-in-from-top-1 duration-200">
              {runHistoryLoadFailed ? (
                <div
                  data-ui="run-history-error"
                  role="alert"
                  className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-4 text-center"
                >
                  <p className="text-sm font-medium">
                    Could not load run history
                  </p>
                  <p className="text-xs text-destructive break-words">
                    {runHistoryError instanceof Error
                      ? runHistoryError.message
                      : 'Unknown error'}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-ui="run-history-retry"
                    disabled={isRunHistoryFetching}
                    onClick={() => void refetchRunHistory()}
                  >
                    Retry
                  </Button>
                </div>
              ) : runHistoryLoading ? (
                <p
                  data-ui="run-history-loading"
                  className="text-sm text-muted-foreground text-center py-8"
                >
                  Loading run history…
                </p>
              ) : (
                <>
                  <TaskStageDurationSummary
                    durations={stageDurations}
                    stages={stages}
                  />
                  <div className="space-y-3" data-ui="persistent-stage-notes">
                    <div className="flex items-center justify-between gap-2 px-1">
                      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                        Persistent Stage Notes
                      </h3>
                      {noteableStages.length > 0 && !isAddingPersistentNote && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          data-ui="persistent-stage-note-add"
                          onClick={() => setIsAddingPersistentNote(true)}
                        >
                          Add note
                        </Button>
                      )}
                    </div>
                    {isAddingPersistentNote && (
                      <PersistentStageNoteAdder
                        key={task_id}
                        projectId={project_id}
                        taskId={task_id!}
                        stages={noteableStages}
                        onSaved={() => setIsAddingPersistentNote(false)}
                      />
                    )}
                    {persistentComments.length === 0 &&
                      !isAddingPersistentNote && (
                        <p
                          className="text-sm text-muted-foreground rounded-lg border border-dashed px-3 py-4 text-center"
                          data-ui="persistent-stage-notes-empty"
                        >
                          No persistent stage notes yet.
                        </p>
                      )}
                    {persistentComments.length > 0 && (
                      <div className="divide-y divide-border border rounded-lg overflow-hidden bg-muted/20">
                        {persistentComments.map((comment) => (
                          <PersistentStageNote
                            key={`${task_id}:${comment.stage_id}`}
                            projectId={project_id}
                            taskId={task_id!}
                            stageId={comment.stage_id}
                            stageTitle={
                              findStage(stages, comment.stage_id)?.title ??
                              comment.stage_id
                            }
                            content={comment.content}
                            updatedAt={comment.updated_at}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                  {runLogs.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">
                      No execution logs for this task yet.
                    </p>
                  ) : (
                    <div className="space-y-3">
                      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-1">
                        Past Executions
                      </h3>
                      <div className="divide-y divide-border border rounded-lg overflow-hidden bg-muted/20">
                        {runLogs.map((run) => (
                          <TaskRunHistoryEntryFrame
                            key={run.id}
                            run={run}
                            onJump={handleJumpToRun}
                          >
                            <RunHistoryEntryHeader
                              run={{
                                id: run.id,
                                status: runHistoryStatus(run),
                                runAt: run.run_at,
                                durationMs: run.duration_ms,
                                model: run.model,
                                modelName: run.model_name,
                                tokenTotal: run.tok_total,
                                costUsd: run.cost_usd ?? null,
                                result: run.output,
                                error: run.error,
                              }}
                              showId={false}
                              lead={
                                <Badge
                                  variant="outline"
                                  className="h-5 shrink-0 px-1.5 text-[11px]"
                                  title={
                                    run.stage
                                      ? `Stage ID: ${run.stage}`
                                      : 'Stage was not recorded for this run'
                                  }
                                >
                                  {run.stage
                                    ? (findStage(stages, run.stage)?.title ??
                                      run.stage)
                                    : 'Unknown'}
                                </Badge>
                              }
                              detail={
                                run.agent_name || run.model ? (
                                  <span
                                    className="min-w-0 break-words text-xs text-muted-foreground"
                                    title={[run.agent_name, run.model]
                                      .filter(Boolean)
                                      .join(' · ')}
                                  >
                                    {[
                                      run.agent_name,
                                      run.model ? shortModel(run.model) : null,
                                    ]
                                      .filter(Boolean)
                                      .join(' · ')}
                                  </span>
                                ) : null
                              }
                              trailing={
                                <TaskRunReviewScore score={run.reviewScore} />
                              }
                            />
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                              {(run.tok_output != null ||
                                run.tok_total != null ||
                                run.tool_usage_count != null) && (
                                <div className="flex items-center gap-2 tabular-nums">
                                  {run.tok_output != null ? (
                                    <>
                                      <span
                                        title={[
                                          `output: ${run.tok_output.toLocaleString()}`,
                                          run.tok_input != null
                                            ? `input: ${run.tok_input.toLocaleString()}`
                                            : null,
                                          run.tok_cache_write != null &&
                                          run.tok_cache_write > 0
                                            ? `cache write: ${run.tok_cache_write.toLocaleString()}`
                                            : null,
                                          run.tok_cache_read != null &&
                                          run.tok_cache_read > 0
                                            ? `cache read: ${run.tok_cache_read.toLocaleString()}`
                                            : null,
                                        ]
                                          .filter(Boolean)
                                          .join(' · ')}
                                      >
                                        {fmtTok(run.tok_output)} out
                                      </span>
                                      {(() => {
                                        // Cache hit-rate badge — same logic as
                                        // the dialog summary, kept path-aware so
                                        // CLI runs render muted (their cache
                                        // stats come from the underlying API
                                        // call, not from the board's
                                        // cache_control markers).
                                        const pct = getCacheHitPct(run);
                                        if (pct === null) return null;
                                        const path = getRunPath(run);
                                        const cls = path.cacheControlActive
                                          ? 'inline-flex items-center gap-1 px-1.5 py-0 rounded bg-primary/15 text-primary font-medium'
                                          : 'inline-flex items-center gap-1 px-1.5 py-0 rounded border border-border text-muted-foreground';
                                        const title = path.cacheControlActive
                                          ? `${pct}% cache hit (board-driven — Anthropic cache_control active)`
                                          : `${pct}% cache hit on a ${path.label} run — stats come from the underlying API call, not from the board's cache_control markers`;
                                        return (
                                          <span className={cls} title={title}>
                                            <span
                                              className={
                                                path.cacheControlActive
                                                  ? 'inline-block size-1.5 rounded-full bg-primary'
                                                  : 'inline-block size-1.5 rounded-full bg-muted-foreground/50'
                                              }
                                            />
                                            {pct}% cache
                                          </span>
                                        );
                                      })()}
                                      {run.tok_context_last != null && (
                                        <span
                                          title={`Context window snapshot: ${run.tok_context_last.toLocaleString()} tokens`}
                                        >
                                          {fmtCtx(
                                            run.tok_context_last,
                                            run.model,
                                          )}
                                        </span>
                                      )}
                                    </>
                                  ) : run.tok_total != null ? (
                                    <span title="Older estimate — breakdown unavailable">
                                      ~{run.tok_total.toLocaleString()} tokens
                                    </span>
                                  ) : null}
                                  {run.tool_usage_count != null && (
                                    <span title="Tool calls made">
                                      {run.tool_usage_count} calls
                                    </span>
                                  )}
                                </div>
                              )}
                              <span
                                data-ui="task-run-trigger"
                                data-run-id={run.id}
                                data-user-id={run.trigger?.user?.id ?? ''}
                                data-trigger-source={
                                  run.trigger?.source ?? 'system'
                                }
                                title={`Triggered by: ${
                                  run.trigger?.user?.username ?? 'Automation'
                                }`}
                              >
                                Triggered by{' '}
                                {run.trigger?.user?.username ?? 'Automation'}
                              </span>
                              <span
                                className="max-w-[240px] truncate font-mono text-[11px]"
                                title={`Run id: ${run.id}`}
                              >
                                {run.id}
                              </span>
                              {run.session_id && (
                                <span
                                  className="max-w-[240px] truncate font-mono text-[11px]"
                                  title={`Session: ${run.session_id}`}
                                >
                                  {run.session_id}
                                </span>
                              )}
                            </div>
                            {run.error && (
                              <div className="line-clamp-2 text-xs text-red-600 dark:text-red-400">
                                {run.error}
                              </div>
                            )}
                            {run.output && (
                              <div className="mt-1 line-clamp-3 overflow-hidden rounded bg-muted/50 p-1.5 font-mono text-xs text-foreground/80">
                                {run.output.slice(0, 300)}
                                {run.output.length > 300 ? '...' : ''}
                              </div>
                            )}
                          </TaskRunHistoryEntryFrame>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          ) : activeTab === 'changes' ? (
            <TaskChangesPanel
              taskId={task_id!}
              projectId={project_id}
              checkoutMode={project?.settings?.taskCheckoutMode}
              diff={taskDiff}
              isLoading={taskDiffLoading}
              isError={taskDiffError}
              onRetry={() => void refetchTaskDiff()}
            />
          ) : activeTab === 'recordings' ? (
            <div
              data-ui="task-recordings-tab"
              data-task-id={task_id}
              className="space-y-4 animate-in fade-in slide-in-from-top-1 duration-200"
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">Recordings</h3>
                  <p className="text-xs text-muted-foreground">
                    Browser recordings captured while this task was running.
                  </p>
                </div>
                {recordings.length > 1 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-xs text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                    disabled={deleteRecordingsMutation.isPending}
                    onClick={() => setRecordingDeleteTarget('all')}
                  >
                    <Trash2 className="size-3.5 mr-1.5" />
                    Delete all
                  </Button>
                )}
              </div>

              {recordings.length === 0 && recordingsLoading ? (
                <p
                  role="status"
                  data-ui="task-recordings-loading"
                  className="py-8 text-center text-sm text-muted-foreground"
                >
                  Loading recordings…
                </p>
              ) : recordings.length === 0 && recordingsError ? (
                <div
                  role="alert"
                  data-ui="task-recordings-error"
                  className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-4 text-center"
                >
                  <p className="text-sm font-medium">
                    Could not load recordings
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void refetchRecordings()}
                  >
                    Retry
                  </Button>
                </div>
              ) : recordings.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No recordings for this task yet.
                </p>
              ) : (
                <TaskRecordingsList
                  recordings={recordings}
                  selectedFilename={selectedRecordingFilename}
                  onSelect={(filename) =>
                    setSelectedRecording(
                      filename && task_id
                        ? { taskId: task_id, filename }
                        : null,
                    )
                  }
                  onDelete={setRecordingDeleteTarget}
                  deleteDisabled={deleteRecordingsMutation.isPending}
                />
              )}
            </div>
          ) : null}
        </div>

        {/* Footer */}
        {activeTab === 'chat' && (
          <div className="order-4 shrink-0 border-t border-border px-4 py-3 space-y-2">
            {forkedMessage && (
              <div className="@container">
                <div data-ui="task-composer" className={composerCardClassName}>
                  <div className="space-y-2 px-3 pt-3 pb-1.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-xs font-medium text-primary">
                        <GitFork className="size-3" />
                        Forking conversation from here:
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => setForkFromMessageId(null)}
                      >
                        <X className="size-3" />
                      </Button>
                    </div>
                    <p className="text-[11px] text-muted-foreground line-clamp-2 italic border-l-2 border-primary/20 pl-2">
                      "{forkedMessage.content.substring(0, 200)}"
                    </p>
                  </div>
                  <Textarea
                    value={forkPrompt}
                    onChange={(e) => setForkPrompt(e.target.value)}
                    placeholder="What should the fork do differently?"
                    rows={2}
                    className={cn(composerTextareaClassName, 'resize-none')}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleFork();
                      }
                    }}
                  />
                  <div className={cn(composerFooterClassName, 'justify-end')}>
                    <Button
                      size="icon"
                      aria-label="Fork"
                      onClick={handleFork}
                      disabled={!forkPrompt.trim() || forkMutation.isPending}
                      className={cn(
                        composerSendButtonClassName,
                        'bg-primary text-primary-foreground hover:bg-primary/90 shadow-primary/20 max-sm:size-11',
                      )}
                    >
                      {forkMutation.isPending ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <GitFork className="size-4" />
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            )}
            {!forkedMessage && isRunning && task_id && (
              <TaskBackgroundTasks projectId={project_id} taskId={task_id} />
            )}
            {!forkedMessage && (
              <>
                <div className="flex flex-wrap items-center gap-1.5 empty:hidden">
                  <AttachmentChips
                    attachments={pendingAttachments}
                    onRemove={removeAttachment}
                  />
                </div>
                <div className="@container">
                  <div
                    data-ui="task-composer"
                    className={composerCardClassName}
                  >
                    <Textarea
                      ref={setChatInput}
                      onPaste={handleAttachmentPaste}
                      placeholder={
                        messages.length > 0
                          ? 'Follow-up message…'
                          : 'Describe the task… (paste screenshots with Ctrl+V)'
                      }
                      rows={3}
                      className={cn(composerTextareaClassName, 'resize-none')}
                      onInput={() => {
                        useStore
                          .getState()
                          .saveDraftByKey(
                            draftKeyRef.current,
                            chatInputRef.current?.value ?? '',
                          );
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          const draft = readDraft();
                          if (
                            messages.length === 0 &&
                            !isRunning &&
                            !isQueued
                          ) {
                            void handleQueue(draft);
                          } else {
                            void handleSend(draft);
                          }
                        }
                      }}
                    />
                    <div className={composerFooterClassName}>
                      <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-1.5">
                        <input
                          ref={fileInputRef}
                          type="file"
                          multiple
                          className="hidden"
                          data-ui="task-detail-file-input"
                          onChange={(e) => {
                            const input = e.currentTarget;
                            if (input.files && input.files.length > 0) {
                              addFiles(Array.from(input.files));
                            }
                            // Reset so picking the same file again fires another change.
                            input.value = '';
                          }}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className={composerFooterIconButtonClassName}
                          aria-label="Attach files"
                          data-ui="task-detail-attach-button"
                          onClick={() => fileInputRef.current?.click()}
                        >
                          <Paperclip />
                        </Button>
                        {executeStages.length > 1 &&
                          (messages.length > 0 || isRunning || isQueued
                            ? task && stage?.type !== 'active'
                            : true) && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  aria-label="Execute in stage"
                                  className={cn(
                                    composerPillClassName,
                                    'shrink-0',
                                  )}
                                >
                                  <span className="truncate">
                                    {
                                      executeStages.find(
                                        (s) => s.id === displayedQueueStageId,
                                      )?.title
                                    }
                                  </span>
                                  <ChevronDown className="size-2.5 shrink-0 opacity-50" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="start" side="top">
                                {executeStages.map((s) => (
                                  <DropdownMenuItem
                                    key={s.id}
                                    onSelect={() =>
                                      setSelectedQueueStageId(s.id)
                                    }
                                  >
                                    <Check
                                      className={cn(
                                        'size-3.5 shrink-0',
                                        s.id === displayedQueueStageId
                                          ? 'opacity-100'
                                          : 'opacity-0',
                                      )}
                                    />
                                    {s.title}
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                      </div>
                      <div className="flex flex-wrap items-center justify-end gap-x-1.5 gap-y-1">
                        <p className={composerHintClassName}>
                          {messages.length === 0 && !isRunning && !isQueued ? (
                            <>
                              Queue →{' '}
                              {executeStages.find(
                                (s) => s.id === validQueueStageId,
                              )?.title ??
                                activeStage?.title ??
                                activeStageTitle}
                              . Backlog → {initialStage?.title || 'backlog'}
                              .{' '}
                            </>
                          ) : (
                            'Send adds a message. '
                          )}
                          ↵ to act · ⇧↵ for newline
                        </p>
                        {messages.length === 0 && !isRunning && !isQueued ? (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              className="max-sm:h-11"
                              onClick={() => {
                                void handleBacklog(readDraft());
                              }}
                              disabled={queueBusy}
                            >
                              Backlog
                            </Button>
                            <Button
                              size="sm"
                              className="max-sm:h-11"
                              onClick={() => {
                                void handleQueue(readDraft());
                              }}
                              disabled={queueBusy}
                            >
                              {queueBusy ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                <Send className="size-3.5" />
                              )}
                              Queue
                            </Button>
                          </>
                        ) : (
                          <>
                            {task && stage?.type !== 'active' && (
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="xs"
                                    className={composerPillClassName}
                                    disabled={executeMutation.isPending}
                                  >
                                    {executeMutation.isPending ? (
                                      <Loader2 className="size-3 animate-spin" />
                                    ) : (
                                      <RotateCcw className="size-3" />
                                    )}
                                    Re-run
                                    <ChevronDown className="size-2.5 shrink-0 opacity-50" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem
                                    onClick={() => {
                                      void handleRerun();
                                    }}
                                  >
                                    <RotateCcw className="size-3.5 mr-2" />
                                    <div className="flex flex-col">
                                      <span>Continue</span>
                                      <span className="text-[10px] text-muted-foreground">
                                        Keep chat history, append new run
                                      </span>
                                    </div>
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    data-ui="continue-task-fresh-session"
                                    onClick={() => {
                                      void handleRerun({ freshSession: true });
                                    }}
                                  >
                                    <RefreshCw className="size-3.5 mr-2" />
                                    <div className="flex flex-col">
                                      <span>Continue in fresh session</span>
                                      <span className="text-[10px] text-muted-foreground">
                                        Keep worktree, resend full task context
                                      </span>
                                    </div>
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    onClick={() => {
                                      void handleRerun({ reset: true });
                                    }}
                                  >
                                    <Trash2 className="size-3.5 mr-2 text-destructive" />
                                    <div className="flex flex-col">
                                      <span>Start over</span>
                                      <span className="text-[10px] text-muted-foreground">
                                        Clear history, reset worktree and queue
                                      </span>
                                    </div>
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            )}
                            {(isRunning || isQueued) && (
                              <Button
                                size="icon"
                                variant="outline"
                                aria-label="Stop"
                                onClick={() =>
                                  task_id && stopMutation.mutate(task_id)
                                }
                                disabled={stopMutation.isPending}
                                className={cn(
                                  composerStopButtonClassName,
                                  'max-sm:size-11',
                                )}
                              >
                                {stopMutation.isPending ? (
                                  <Loader2 className="size-4 animate-spin" />
                                ) : (
                                  <Square className="size-4" />
                                )}
                              </Button>
                            )}
                            <Button
                              size="icon"
                              aria-label="Send"
                              onClick={() => {
                                const draft = readDraft();
                                void handleSend(draft);
                              }}
                              disabled={sendMessageMutation.isPending}
                              className={cn(
                                composerSendButtonClassName,
                                'max-sm:size-11',
                              )}
                            >
                              {sendMessageMutation.isPending ? (
                                <Loader2 className="size-4 animate-spin" />
                              ) : (
                                <Send className="size-4" />
                              )}
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </DialogContent>
      <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Move task to another project</DialogTitle>
          </DialogHeader>
          <DialogDescription className="text-xs">
            Only tasks in a backlog/queue stage can be moved. The task's chat
            history will start empty here — the original transcript remains in
            the source project's storage. Dependencies that don't exist in the
            target will be dropped.
          </DialogDescription>
          <ProjectPicker
            projects={projects ?? []}
            value=""
            onValueChange={handleMoveToProject}
            allowedProjectIds={moveDestinationIds}
            excludedProjectIds={new Set([project_id])}
            disabled={moveMutation.isPending}
            data-ui="move-project-picker"
            aria-label="Move task to project"
            contentClassName="max-h-72"
          />
        </DialogContent>
      </Dialog>
      <Dialog
        open={recordingDeleteTarget !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen && !deleteRecordingsMutation.isPending) {
            setRecordingDeleteTarget(null);
          }
        }}
      >
        <DialogContent
          data-ui="task-recording-delete-dialog"
          className="sm:max-w-md"
          showCloseButton={!deleteRecordingsMutation.isPending}
        >
          <DialogHeader>
            <DialogTitle>
              {recordingDeleteTarget === 'all'
                ? 'Delete all recordings?'
                : 'Delete recording?'}
            </DialogTitle>
            <DialogDescription>
              {recordingDeleteTarget === 'all'
                ? `This will permanently delete all ${recordings.length} recordings for this task.`
                : `This will permanently delete ${recordingDeleteTarget ?? 'this recording'}.`}{' '}
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRecordingDeleteTarget(null)}
              disabled={deleteRecordingsMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteRecordingsMutation.isPending}
              onClick={() => {
                if (!recordingDeleteTarget || !task_id) return;
                deleteRecordingsMutation.mutate({
                  taskId: task_id,
                  filename:
                    recordingDeleteTarget === 'all'
                      ? undefined
                      : recordingDeleteTarget,
                });
              }}
            >
              {deleteRecordingsMutation.isPending && (
                <Loader2 className="size-4 animate-spin" />
              )}
              {recordingDeleteTarget === 'all'
                ? 'Delete all recordings'
                : 'Delete recording'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
