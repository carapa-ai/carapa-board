import { useCallback, useState, memo } from 'react';
import {
  Loader2,
  MessageCircle,
  RotateCcw,
  Send,
  Sparkles,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  draftTaskDescription,
  type TaskDescriptionDraftHistoryEntry,
} from '@/lib/api';
import { MarkdownContent } from '@/components/markdown-content-lazy';

/** Render states of the panel, exposed via `data-state` for DevTools. */
export type TaskAiDescriptionPanelState =
  | 'idle'
  | 'loading'
  | 'preview'
  | 'error';

export interface TaskAiDescriptionPanelProps {
  projectId: string;
  taskId: string;
  /** Current (possibly unsaved) description, shown as comparison context. */
  currentDescription: string;
  /** True while a run is active; the backend then rejects description updates. */
  isRunning: boolean;
  /** True while the dialog's shared task update mutation is saving another change. */
  isUpdatePending: boolean;
  /**
   * Persist the draft through the dialog's existing update mutation.
   * Resolves only once the PATCH has succeeded; on rejection the panel
   * keeps the preview open so the user can retry.
   */
  onApply: (draft: string) => Promise<void>;
  /** Close the panel without saving. */
  onClose: () => void;
  /** Start the dialog's "chat about this task" flow. */
  onOpenInChat: () => void;
}

const IDLE_PLACEHOLDER = 'e.g. add acceptance criteria, tighten the scope';
const REFINE_PLACEHOLDER = 'Refine the draft, e.g. make it shorter';

/**
 * Slim inline panel that drafts a rewritten task description through the
 * one-shot `POST /description/draft` endpoint. State (turn history,
 * instruction text, current state) is local to the panel and is not
 * persisted across dialog close.
 */
export const TaskAiDescriptionPanel = memo(function TaskAiDescriptionPanel({
  projectId,
  taskId,
  currentDescription,
  isRunning,
  isUpdatePending,
  onApply,
  onClose,
  onOpenInChat,
}: TaskAiDescriptionPanelProps) {
  const [state, setState] = useState<TaskAiDescriptionPanelState>('idle');
  // Completed turns (instruction + returned draft), oldest first. The last
  // entry is always the newest draft; earlier entries are sent as `history`.
  const [turns, setTurns] = useState<TaskDescriptionDraftHistoryEntry[]>([]);
  const [instruction, setInstruction] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const currentDraft = turns.length > 0 ? turns[turns.length - 1].draft : null;
  const canSend =
    instruction.trim().length > 0 && state !== 'loading' && !isApplying;
  const applyDisabled = isRunning || isUpdatePending || isApplying;

  const handleSend = useCallback(async () => {
    const text = instruction.trim();
    if (!text || state === 'loading' || isApplying) return;
    setState('loading');
    setErrorMessage(null);
    try {
      const { draft } = await draftTaskDescription(
        projectId,
        taskId,
        text,
        turns.length > 0 ? turns : undefined,
      );
      setTurns((prev) => [...prev, { instruction: text, draft }]);
      setInstruction('');
      setApplyError(null);
      setState('preview');
    } catch (error) {
      // Keep `instruction` as-is so the user's text survives the failure.
      setErrorMessage(
        error instanceof Error ? error.message : 'Could not generate a draft',
      );
      setState('error');
    }
  }, [instruction, state, projectId, taskId, turns, isApplying]);

  const handleApply = useCallback(async () => {
    if (applyDisabled || !currentDraft) return;
    setIsApplying(true);
    setApplyError(null);
    try {
      // Await persistence so the panel only closes on success; a failed
      // PATCH (e.g. a running-task 409 race) keeps the preview with a
      // retry affordance instead of losing the generated draft.
      await onApply(currentDraft);
      onClose();
    } catch (error) {
      setApplyError(
        error instanceof Error ? error.message : 'Could not save the draft',
      );
    } finally {
      setIsApplying(false);
    }
  }, [applyDisabled, currentDraft, onApply, onClose]);

  const placeholder =
    state === 'preview' ? REFINE_PLACEHOLDER : IDLE_PLACEHOLDER;

  return (
    <section
      data-ui="task-ai-description"
      data-task-id={taskId}
      data-state={state}
      className="space-y-2 rounded-lg border border-dashed border-border bg-muted/10 p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          <Sparkles className="mr-1 inline size-3" />
          AI edit description
        </h3>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={onOpenInChat}
            title="Open a new chat with this task as context"
          >
            <MessageCircle className="size-3 mr-1" />
            Open in chat
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="size-7 text-muted-foreground hover:text-foreground"
            onClick={onClose}
            disabled={isApplying}
            title={isApplying ? 'Saving the draft' : 'Discard and close'}
            aria-label="Close AI edit panel"
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      {state === 'loading' && (
        <div
          data-ui="task-ai-description-loading"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <Loader2 className="size-4 animate-spin" />
          Generating draft…
        </div>
      )}

      {state === 'error' && (
        <div
          data-ui="task-ai-description-error"
          className="flex items-start justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
        >
          <span data-ui="task-ai-description-error-message">
            {errorMessage ?? 'Could not generate a draft'}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-2 text-xs text-destructive hover:text-destructive"
            onClick={() => void handleSend()}
            title="Retry with the same instruction"
          >
            <RotateCcw className="size-3 mr-1" />
            Retry
          </Button>
        </div>
      )}

      {state === 'preview' && currentDraft && (
        <div className="space-y-2">
          <div data-ui="task-ai-description-draft" className="space-y-1">
            <div className="text-[11px] font-medium text-primary">
              Proposed description (not saved yet)
            </div>
            <div className="text-sm markdown-output">
              <MarkdownContent>{currentDraft}</MarkdownContent>
            </div>
          </div>
          <div data-ui="task-ai-description-current" className="space-y-1">
            <div className="text-[11px] font-medium text-muted-foreground">
              Current description
            </div>
            {currentDescription.trim() ? (
              <div className="text-sm markdown-output">
                <MarkdownContent>{currentDescription}</MarkdownContent>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground italic">
                No description yet.
              </p>
            )}
          </div>
          {applyError && (
            <div
              data-ui="task-ai-description-apply-error"
              className="flex items-start justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
            >
              <span data-ui="task-ai-description-apply-error-message">
                {applyError}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 shrink-0 px-2 text-xs text-destructive hover:text-destructive"
                onClick={() => void handleApply()}
                title="Retry saving this draft"
              >
                <RotateCcw className="size-3 mr-1" />
                Retry
              </Button>
            </div>
          )}
          <div className="flex gap-2 justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={onClose}
              disabled={isApplying}
            >
              Discard
            </Button>
            {/* The hint lives on an enabled, focusable wrapper: the
                disabled button has pointer-events-none and would swallow
                hover/focus, hiding the explanation. */}
            <span
              data-ui="task-ai-description-apply-hint"
              className="inline-flex"
              title={
                isRunning
                  ? 'Description updates are locked while a run is active'
                  : isUpdatePending
                    ? 'Wait for the other task update to finish'
                    : 'Save this draft as the task description'
              }
              tabIndex={0}
            >
              <Button
                type="button"
                size="sm"
                data-ui="task-ai-description-apply"
                className="h-7 text-xs"
                onClick={() => void handleApply()}
                disabled={applyDisabled}
              >
                {isApplying ? 'Saving…' : 'Apply'}
              </Button>
            </span>
          </div>
        </div>
      )}

      {state !== 'loading' && (
        <div className="flex gap-2">
          <Input
            data-ui="task-ai-description-input"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder={placeholder}
            compact
            className="flex-1"
            aria-label={
              state === 'preview' ? 'Refine instruction' : 'Instruction'
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleSend();
              }
            }}
          />
          <Button
            type="button"
            size="sm"
            className="h-8 shrink-0"
            onClick={() => void handleSend()}
            disabled={!canSend}
            title={
              isApplying
                ? 'Saving the current draft'
                : state === 'preview'
                  ? 'Refine the draft'
                  : 'Generate draft'
            }
          >
            <Send className="size-3.5" />
            {state === 'preview' ? 'Refine' : 'Send'}
          </Button>
        </div>
      )}
    </section>
  );
});
