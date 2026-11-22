import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  isDeletableQueuedPrompt,
  isMutableQueuedPrompt,
} from '@/lib/queued-prompt-lifecycle';
import type { QueuedPrompt } from '@/store';

export function QueuedPromptList({
  prompts,
  isAgentRunning,
  canSteer,
  onSteer,
  onEdit,
  onDelete,
  hiddenPromptIds,
}: {
  prompts: QueuedPrompt[];
  isAgentRunning: boolean;
  canSteer: boolean;
  onSteer: (prompt: QueuedPrompt, index: number) => void;
  onEdit: (prompt: QueuedPrompt, index: number) => void;
  onDelete: (prompt: QueuedPrompt, index: number) => void;
  hiddenPromptIds?: ReadonlySet<string>;
}) {
  const visiblePrompts = prompts.filter(
    (prompt) => !prompt.id || !hiddenPromptIds?.has(prompt.id),
  );
  if (visiblePrompts.length === 0) return null;
  return (
    <div data-ui="chat-steering-queue" className="space-y-1.5 px-2">
      <div className="text-xs text-muted-foreground">
        {visiblePrompts.length} queued prompt
        {visiblePrompts.length === 1 ? '' : 's'} will be sent next.
      </div>
      <div className="max-h-40 space-y-1.5 overflow-y-auto">
        {visiblePrompts.map((prompt) => {
          const index = prompts.indexOf(prompt);
          const actionable =
            !prompt.awaitingAcknowledgement && !prompt.consumedByServer;
          const actionsAvailable = actionable && isMutableQueuedPrompt(prompt);
          const deleteAvailable = actionable && isDeletableQueuedPrompt(prompt);
          return (
            <div
              key={prompt.id ?? `${prompt.content}-${index}`}
              data-ui="chat-steering-queued-prompt"
              data-queued-prompt-id={prompt.id}
              data-queue-index={index}
              className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-2.5 py-2"
            >
              <p className="min-w-0 flex-1 truncate text-xs text-foreground">
                {prompt.bubbleContent ||
                  `${prompt.attachments?.length ?? 0} attachment(s)`}
              </p>
              {(isAgentRunning || prompt.serverOwned) && actionsAvailable && (
                <Button
                  size="sm"
                  variant="ghost"
                  // Translucent blue hover fill reads on both themes; only the text tone is theme-swapped.
                  className="h-7 shrink-0 px-2 text-xs text-blue-700 hover:bg-blue-500/10 dark:text-blue-300"
                  onClick={() => onSteer(prompt, index)}
                  disabled={!canSteer}
                  title="Use this queued prompt to steer the running turn"
                >
                  Send now
                </Button>
              )}
              {actionsAvailable && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 shrink-0 px-2 text-xs"
                  onClick={() => onEdit(prompt, index)}
                  title="Edit this queued prompt"
                >
                  Edit
                </Button>
              )}
              {deleteAvailable && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => onDelete(prompt, index)}
                  title="Delete queued prompt"
                  aria-label="Delete queued prompt"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
