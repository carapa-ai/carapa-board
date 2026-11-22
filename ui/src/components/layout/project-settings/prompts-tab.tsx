import { useRef } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { TabsContent } from '@/components/ui/tabs';
import {
  Plus,
  X,
  Loader2,
  RefreshCw,
  ChevronUp,
  ChevronDown,
} from 'lucide-react';
import { toast } from 'sonner';
import { regenerateProjectPrompt } from '@/lib/api';
import type { ChatModeDefinition } from '@/types';
import { SettingsSection, TAB_CONTENT_CLASS, type FormProps } from './shared';
import {
  chatModeIdError,
  isValidChatModeId,
  isValidChatModeLabel,
  serializeChatModePrompts,
} from './chat-mode-validation';

const DEFAULT_CHAT_MODE_OPTIONS: ChatModeDefinition[] = [
  { id: 'ask', label: 'Ask' },
  { id: 'plan', label: 'Plan' },
  { id: 'code', label: 'Code' },
  { id: 'debug', label: 'Debug' },
];

interface PromptsTabProps extends FormProps {
  project_id: string | null;
  savedProjectIsParent: boolean;
  savedProjectUsesRepositoryPrompt: boolean;
  regenerating: boolean;
  setRegenerating: (regenerating: boolean) => void;
}

export function PromptsTab({
  form,
  setForm,
  project_id,
  savedProjectIsParent,
  savedProjectUsesRepositoryPrompt,
  regenerating,
  setRegenerating,
}: PromptsTabProps) {
  const chatModes = form.chatModes?.length
    ? form.chatModes
    : DEFAULT_CHAT_MODE_OPTIONS;
  const modeIdError = chatModeIdError(form.chatModes);
  // Each row owns its prompt by position, independent of its (possibly empty
  // or duplicated) id while being edited. form.chatModePrompts is re-serialized
  // under the final ids on every edit. If the form was replaced from outside
  // (project load/reset, or the empty list falling back to the default modes),
  // the remembered rows no longer match it and are re-derived from
  // form.chatModePrompts.
  const ownedRef = useRef<{
    modes: ChatModeDefinition[];
    prompts: Record<string, string> | undefined;
    rows: (string | undefined)[];
  } | null>(null);
  const owned = ownedRef.current;
  const rowPrompts =
    owned && owned.modes === chatModes && owned.prompts === form.chatModePrompts
      ? owned.rows
      : chatModes.map((m) => form.chatModePrompts?.[m.id]);
  const commit = (
    modes: ChatModeDefinition[],
    rows: (string | undefined)[],
  ) => {
    const prompts = serializeChatModePrompts(modes, rows);
    ownedRef.current = { modes, prompts, rows };
    setForm({ ...form, chatModes: modes, chatModePrompts: prompts });
  };

  return (
    <TabsContent
      value="prompts"
      data-ui="project-settings-tab-prompts"
      className={TAB_CONTENT_CLASS}
    >
      <div className="space-y-4">
        {savedProjectIsParent && project_id && (
          <div
            data-ui="project-prompt-regeneration"
            className="rounded-md border bg-muted/30 p-3"
          >
            <div className="space-y-2">
              <div>
                <h3 className="text-sm font-semibold">Generated Root Prompt</h3>
                <p className="text-xs text-muted-foreground mt-1">
                  Regenerating overwrites the generated root{' '}
                  <code>AGENTS.md</code> from the parent-project template and
                  refreshes the registered child-project list.
                </p>
              </div>
              {savedProjectUsesRepositoryPrompt ? (
                <p className="text-xs text-muted-foreground">
                  Repository-backed projects use a repository-owned prompt and
                  cannot regenerate this generated file.
                </p>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={regenerating}
                  onClick={async () => {
                    setRegenerating(true);
                    try {
                      await regenerateProjectPrompt(project_id);
                      toast.success('Prompt regenerated');
                    } catch (err: any) {
                      toast.error(`Failed: ${err.message}`);
                    } finally {
                      setRegenerating(false);
                    }
                  }}
                >
                  {regenerating ? (
                    <Loader2 className="h-3 w-3 animate-spin mr-1" />
                  ) : (
                    <RefreshCw className="h-3 w-3 mr-1" />
                  )}
                  Regenerate Prompt
                </Button>
              )}
            </div>
          </div>
        )}
        <SettingsSection name="agent-prompts" title="Agent prompts">
          <div className="space-y-2">
            <label
              className="text-sm font-medium"
              htmlFor="settings-worker-prompt"
            >
              Worker Prompt
            </label>
            <Textarea
              id="settings-worker-prompt"
              placeholder="Instructions prepended to each task..."
              value={form.workerPrompt ?? ''}
              onChange={(e) =>
                setForm({ ...form, workerPrompt: e.target.value })
              }
              rows={4}
            />
            <p className="text-xs text-muted-foreground">
              Prepended to the task description when the worker runs
            </p>
          </div>

          <div className="space-y-2">
            <label
              className="text-sm font-medium"
              htmlFor="settings-system-prompt"
            >
              System Prompt
            </label>
            <Textarea
              id="settings-system-prompt"
              placeholder="You are a senior software engineer working on this repository..."
              value={form.systemPrompt ?? ''}
              onChange={(e) =>
                setForm({ ...form, systemPrompt: e.target.value })
              }
              rows={4}
            />
            <p className="text-xs text-muted-foreground">
              Passed as <code>--system-prompt</code> to the agent. Sets the
              agent's role and constraints.
            </p>
          </div>
        </SettingsSection>

        <SettingsSection
          name="chat-modes"
          title="Chat Modes"
          description={
            <>
              Configure chat modes and prompt overrides. Prompts are saved as
              markdown files in <code>.agent/prompts/</code> (e.g.{' '}
              <code>chat-mode-ask.md</code>).
            </>
          }
        >
          {chatModes.map((mode, idx) => (
            <div key={idx} className="rounded-md border p-3 space-y-2">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <Input
                  placeholder="mode id"
                  aria-label={`Mode id for ${mode.label || mode.id}`}
                  aria-invalid={
                    !isValidChatModeId(mode.id) ||
                    chatModes.some((m, i) => i !== idx && m.id === mode.id)
                      ? true
                      : undefined
                  }
                  value={mode.id}
                  onChange={(e) => {
                    const nextId = e.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9_-]/g, '');
                    commit(
                      chatModes.map((m, i) =>
                        i === idx ? { ...m, id: nextId } : { ...m },
                      ),
                      rowPrompts,
                    );
                  }}
                />
                <Input
                  placeholder="Mode label"
                  aria-label={`Mode label for ${mode.label || mode.id}`}
                  aria-invalid={
                    isValidChatModeLabel(mode.label) ? undefined : true
                  }
                  value={mode.label}
                  onChange={(e) => {
                    commit(
                      chatModes.map((m, i) =>
                        i === idx ? { ...m, label: e.target.value } : { ...m },
                      ),
                      rowPrompts,
                    );
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-9"
                  onClick={() => {
                    commit(
                      chatModes
                        .filter((_, i) => i !== idx)
                        .map((m) => ({ ...m })),
                      rowPrompts.filter((_, i) => i !== idx),
                    );
                  }}
                  title="Remove mode"
                  aria-label={`Remove mode ${mode.label || mode.id}`}
                >
                  <X className="size-4" />
                </Button>
              </div>
              <Textarea
                placeholder={`Prompt override for "${mode.id}"`}
                rows={4}
                value={rowPrompts[idx] ?? ''}
                onChange={(e) =>
                  commit(
                    chatModes.map((m) => ({ ...m })),
                    rowPrompts.map((v, i) => (i === idx ? e.target.value : v)),
                  )
                }
              />
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              const baseId = 'mode';
              let n = 1;
              let nextId = `${baseId}-${n}`;
              const used = new Set(chatModes.map((m) => m.id.toLowerCase()));
              while (used.has(nextId)) {
                n += 1;
                nextId = `${baseId}-${n}`;
              }
              commit(
                [
                  ...chatModes.map((m) => ({ ...m })),
                  { id: nextId, label: 'New Mode' },
                ],
                [...rowPrompts, undefined],
              );
            }}
          >
            <Plus className="size-3.5 mr-1" />
            Add Mode
          </Button>
          {modeIdError && (
            <p
              role="alert"
              data-ui="chat-mode-id-error"
              className="text-xs text-destructive"
            >
              {modeIdError}
            </p>
          )}
        </SettingsSection>

        <SettingsSection
          name="starter-prompts"
          title="Starter Prompts"
          description="Clickable buttons shown when a new chat conversation is empty. Clicking populates the input field."
        >
          <div className="space-y-2">
            {(form.starterPrompts ?? []).map((sp, i) => {
              const prompts = form.starterPrompts ?? [];
              const move = (from: number, to: number) => {
                const updated = [...prompts];
                const [item] = updated.splice(from, 1);
                updated.splice(to, 0, item);
                setForm({ ...form, starterPrompts: updated });
              };
              return (
                <div key={i} className="flex items-start gap-2">
                  <div className="flex flex-col gap-0.5 self-center">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6"
                      disabled={i === 0}
                      onClick={() => move(i, i - 1)}
                      title="Move up"
                    >
                      <ChevronUp className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6"
                      disabled={i === prompts.length - 1}
                      onClick={() => move(i, i + 1)}
                      title="Move down"
                    >
                      <ChevronDown className="size-3.5" />
                    </Button>
                  </div>
                  <div className="flex flex-col gap-1 flex-1">
                    <Input
                      placeholder="Button label (e.g. Summarise today)"
                      value={sp.label}
                      onChange={(e) => {
                        const updated = [...prompts];
                        updated[i] = {
                          ...updated[i],
                          label: e.target.value,
                        };
                        setForm({ ...form, starterPrompts: updated });
                      }}
                    />
                    <Textarea
                      placeholder="Full prompt text injected into the chat input…"
                      rows={2}
                      value={sp.prompt}
                      onChange={(e) => {
                        const updated = [...prompts];
                        updated[i] = {
                          ...updated[i],
                          prompt: e.target.value,
                        };
                        setForm({ ...form, starterPrompts: updated });
                      }}
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 flex-shrink-0 mt-1"
                    aria-label={`Remove starter prompt ${i + 1}`}
                    onClick={() => {
                      const updated = prompts.filter((_, j) => j !== i);
                      setForm({
                        ...form,
                        starterPrompts: updated,
                      });
                    }}
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
              );
            })}
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setForm({
                  ...form,
                  starterPrompts: [
                    ...(form.starterPrompts ?? []),
                    { label: '', prompt: '' },
                  ],
                })
              }
            >
              <Plus className="size-3.5 mr-1" />
              Add Prompt
            </Button>
          </div>
        </SettingsSection>
      </div>
    </TabsContent>
  );
}
