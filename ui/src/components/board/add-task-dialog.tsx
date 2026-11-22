import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FieldTrigger, Select, SelectItem } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SearchInput } from '@/components/ui/search-input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Link as LinkIcon,
  X,
  Filter,
  Target,
  Paperclip,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { useStore } from '@/store';
import { useCreateTask, useUpdateTask } from '@/hooks/use-task-mutations';
import { useTasks } from '@/hooks/use-tasks';
import { useProjects } from '@/hooks/use-projects';
import {
  getActiveProjectStages,
  getActiveExecutionStages,
  getInitialStage,
  findStage,
} from '@/lib/stages';
import { usePasteAttachments } from '@/hooks/use-paste-attachments';
import { AttachmentChips } from '@/components/attachment-chips';
import {
  uploadAttachment,
  fetchObjectives,
  fetchRuntimeCatalog,
} from '@/lib/api';
import { appendUploadedAttachments } from '@/lib/attachment-description';
import { RuntimePicker } from '@/components/chat/runtime-picker';
import { RuntimeStageScope } from '@/components/board/runtime-stage-scope';
import { AbVariantSelect } from '@/components/board/ab-variant-select';
import {
  abVariantsPayload,
  stageVariantPayload,
  projectVariantSuffixes,
  taskAbParentId,
} from '@/lib/ab';
import type { RuntimeSelection } from '@/lib/api';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import type { Objective } from '@/types';

interface AddTaskDialogProps {
  project_id: string;
}

export function AddTaskDialog({ project_id }: AddTaskDialogProps) {
  const open = useStore((s) => s.addDialogOpen);
  const setOpen = useStore((s) => s.setAddDialogOpen);
  const createMutation = useCreateTask(project_id);
  const updateMutation = useUpdateTask(project_id);
  const { data: tasks = [] } = useTasks(project_id);
  const { data: projects } = useProjects();
  const project = projects?.find((p) => p.id === project_id);
  const stages = useMemo(
    () => getActiveProjectStages(project?.settings),
    [project?.settings],
  );
  const executeStages = useMemo(
    () => getActiveExecutionStages(stages),
    [stages],
  );
  const variantSuffixes = useMemo(
    () => projectVariantSuffixes(project),
    [project],
  );
  const initialStageType = useMemo(
    () => getInitialStage(stages)?.type,
    [stages],
  );

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [runtimeSelection, setRuntimeSelection] =
    useState<RuntimeSelection | null>(null);
  const [runtimeSelectionStage, setRuntimeSelectionStage] = useState<
    string | null
  >(null);
  const [priorityMode, setPriorityMode] = useState('next');
  const [selectedExecuteStageId, setSelectedExecuteStageId] = useState('');
  const [dependsOnIds, setDependsOnIds] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [showOnlyActive, setShowOnlyActive] = useState(true);
  const [objectiveId, setObjectiveId] = useState<string | null>(null);
  const [abVariants, setAbVariants] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const {
    data: objectives = [],
    isError: objectivesError,
    refetch: refetchObjectives,
  } = useQuery<Objective[]>({
    queryKey: queryKeys.objectives.all(project_id),
    queryFn: () => fetchObjectives(project_id),
    staleTime: 30_000,
    enabled: open,
  });
  const {
    data: runtimeCatalog,
    isError: runtimeCatalogError,
    isFetching: runtimeCatalogFetching,
    refetch: refetchRuntimeCatalog,
  } = useQuery({
    queryKey: queryKeys.runtimeCatalog,
    queryFn: fetchRuntimeCatalog,
    staleTime: Infinity,
  });

  const {
    pending,
    addFiles,
    removeAt,
    clear: clearAttachments,
    handlePaste,
  } = usePasteAttachments();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const filteredTasks = useMemo(() => {
    return tasks
      .filter((f) => {
        // An A/B experiment is listed by its parent only (the parent follows
        // the picked winner). Keep a variant listed if it is already selected
        // so it can still be removed.
        if (taskAbParentId(f) !== null && !dependsOnIds.includes(f.id))
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
      .sort((a, b) => b.priority - a.priority); // Newest/highest priority first
  }, [tasks, searchQuery, showOnlyActive, stages, dependsOnIds]);

  // Selections that reference project-owned entities (dependencies, execution
  // stage, objective, A/B variants) never carry over a close (Cancel, Escape,
  // overlay, or store) or a project switch, even while the dialog stays open
  // (e.g. browser Back). Otherwise a hidden stale ID would be submitted.
  const clearProjectScopedSelections = useCallback(() => {
    setDependsOnIds([]);
    setSelectedExecuteStageId('');
    setObjectiveId(null);
    setAbVariants([]);
  }, []);
  useEffect(() => {
    if (!open) clearProjectScopedSelections();
  }, [open, clearProjectScopedSelections]);
  useEffect(() => {
    clearProjectScopedSelections();
  }, [project_id, clearProjectScopedSelections]);

  const reset = () => {
    setTitle('');
    setDescription('');
    setRuntimeSelection(null);
    setRuntimeSelectionStage(null);
    setPriorityMode('next');
    clearProjectScopedSelections();
    setSearchQuery('');
    setShowOnlyActive(true);
    clearAttachments();
  };

  const computeTopPriority = (): number => {
    const minPriority = tasks.reduce((min, f) => Math.min(min, f.priority), 0);
    return minPriority - 1000;
  };

  const addDependency = (id: string) => {
    setDependsOnIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  };

  const removeDependency = (id: string) => {
    setDependsOnIds((prev) => prev.filter((d) => d !== id));
  };

  const dependsOnTasks = useMemo(
    () =>
      dependsOnIds.flatMap((id) => {
        const task = tasks.find((f) => f.id === id);
        return task ? [task] : [];
      }),
    [tasks, dependsOnIds],
  );

  const handleCreate = async (andExecute: boolean) => {
    // The ref blocks re-entry synchronously: attachment uploads run before the
    // mutation starts, so `createMutation.isPending` alone misses that window.
    if (!title.trim() || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await submitTask(andExecute);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const submitTask = async (andExecute: boolean) => {
    // Upload pending attachments and build description with file paths. A
    // failed upload aborts the submit (the helper toasts) so the draft and
    // chips stay for a retry instead of creating a task that lacks the files.
    const finalDescription = await appendUploadedAttachments(
      pending,
      description.trim(),
      (file) => uploadAttachment(project_id, file),
    );
    if (finalDescription === null) return;

    const variantsPayload = abVariantsPayload(abVariants);
    const stageVariant = stageVariantPayload(abVariants);
    let task: Awaited<ReturnType<typeof createMutation.mutateAsync>>;
    try {
      task = await createMutation.mutateAsync({
        title: title.trim(),
        description: finalDescription || undefined,
        runtimeSelection: runtimeSelection ?? undefined,
        runtimeSelectionStage: runtimeSelection
          ? runtimeSelectionStage
          : undefined,
        // The server assigns the append priority. Only Top priority is an
        // intentional client-side override.
        priority: priorityMode === 'top' ? computeTopPriority() : undefined,
        depends_on_ids: dependsOnIds,
        author: 'user',
        objective_id: objectiveId,
        ...(variantsPayload ? { abVariants: variantsPayload } : {}),
        ...(stageVariant ? { stageVariant } : {}),
      });
    } catch {
      // useCreateTask already reports the error; keep the draft open.
      return;
    }
    if (andExecute && task?.id) {
      const stageId = selectedExecuteStageId || executeStages[0]?.id;
      if (stageId) {
        updateMutation.mutate({ task_id: task.id, data: { status: stageId } });
      }
    }
    reset();
    setOpen(false);
  };

  const busy = submitting || createMutation.isPending;

  // Closing mid-create would let the later success reset a reopened draft.
  const handleOpenChange = (next: boolean) => {
    if (!next && busy) return;
    setOpen(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="h-[85dvh] sm:max-w-4xl max-h-[85dvh] flex flex-col gap-0 p-0 overflow-hidden"
      >
        <DialogClose
          className="absolute right-3 top-3 z-20 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none"
          title="Close"
        >
          <X className="size-4" />
          <span className="sr-only">Close</span>
        </DialogClose>

        {/* Header */}
        <DialogHeader className="contents">
          <div
            data-ui="add-task-header"
            className="order-0 shrink-0 space-y-2 border-b border-border px-4 pt-4 pb-3"
          >
            <div className="flex items-center gap-2 pr-8">
              <DialogTitle>Add Task</DialogTitle>
            </div>
            <DialogDescription>
              Create a new task for this project.
            </DialogDescription>
          </div>
        </DialogHeader>

        <div
          data-ui="add-task-form"
          className="order-1 flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-3 space-y-4"
        >
          <div className="space-y-2">
            <RuntimePicker
              projectId={project_id}
              catalog={runtimeCatalog}
              value={runtimeSelection}
              onChange={(next) => {
                setRuntimeSelection(next);
                if (!next) setRuntimeSelectionStage(null);
              }}
            />
            <RuntimeStageScope
              projectId={project_id}
              runtimeSelection={runtimeSelection}
              value={runtimeSelectionStage}
              onChange={setRuntimeSelectionStage}
              dataUi="task-runtime-stage"
            />
            {/* The picker renders nothing without a catalog, so show the load
                state in its place. A retry after a failure resets the query to
                pending (error false, fetching true), so loading is keyed on
                fetching, not on the error. */}
            {!runtimeCatalog && runtimeCatalogFetching ? (
              <p
                className="flex items-center gap-2 text-sm text-muted-foreground"
                data-ui="add-task-runtime-catalog-loading"
              >
                <Loader2 className="size-4 animate-spin" />
                Loading runtimes…
              </p>
            ) : !runtimeCatalog && runtimeCatalogError ? (
              <div
                className="flex items-center gap-3"
                data-ui="add-task-runtime-catalog-error"
              >
                <p role="alert" className="text-sm text-destructive">
                  Couldn't load runtimes.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void refetchRuntimeCatalog()}
                >
                  Retry
                </Button>
              </div>
            ) : null}
          </div>
          <AbVariantSelect
            suffixes={variantSuffixes}
            selected={abVariants}
            onChange={setAbVariants}
            stageType={initialStageType}
            checkoutMode={project?.settings?.taskCheckoutMode}
            hasTaskRuntime={runtimeSelection !== null}
          />
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="task-title">
              Title
            </label>
            <Input
              id="task-title"
              placeholder="Task title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate(false)}
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="task-desc">
              Description
            </label>
            <Textarea
              id="task-desc"
              placeholder="Describe what the agent should do… (paste screenshots with Ctrl+V or use the paperclip)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onPaste={handlePaste}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleCreate(false);
                }
              }}
              rows={8}
              className="min-h-[200px]"
            />
            <div className="flex flex-wrap items-center gap-1.5">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                data-ui="add-task-file-input"
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
                size="icon-sm"
                aria-label="Attach files"
                data-ui="add-task-attach-button"
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip />
              </Button>
              <AttachmentChips attachments={pending} onRemove={removeAt} />
            </div>
          </div>

          {objectivesError && objectives.length === 0 ? (
            <div className="space-y-2" data-ui="add-task-objectives-error">
              <label className="text-sm font-medium">
                Objective (optional)
              </label>
              <div className="flex items-center gap-3">
                <p role="alert" className="text-sm text-destructive">
                  Couldn't load objectives.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void refetchObjectives()}
                >
                  Retry
                </Button>
              </div>
            </div>
          ) : (
            objectives.length > 0 && (
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Objective (optional)
                </label>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Button
                    variant={objectiveId === null ? 'secondary' : 'ghost'}
                    size="sm"
                    className="h-8 text-xs px-2 gap-1.5"
                    onClick={() => setObjectiveId(null)}
                  >
                    <Target className="size-3" />
                    None
                  </Button>
                  {objectives.map((obj) => (
                    <Button
                      key={obj.id}
                      variant={objectiveId === obj.id ? 'secondary' : 'ghost'}
                      size="sm"
                      className="h-8 text-xs px-2 gap-1.5"
                      onClick={() => setObjectiveId(obj.id)}
                      title={`${obj.status} · ${obj.progress}%`}
                    >
                      {obj.title}
                    </Button>
                  ))}
                </div>
              </div>
            )
          )}

          <div className="space-y-2">
            <label className="text-sm font-medium">Depends on (optional)</label>
            <div className="flex flex-col gap-2">
              <DropdownMenu
                onOpenChange={(open) => {
                  if (!open) setSearchQuery('');
                }}
              >
                <DropdownMenuTrigger asChild>
                  <FieldTrigger className="w-full">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <LinkIcon className="size-3.5 shrink-0" />
                      {dependsOnIds.length > 0
                        ? 'Add another dependency…'
                        : 'Select dependency…'}
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
                      searchInputRef.current?.focus();
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
                      ref={searchInputRef}
                      placeholder="Search tasks..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'ArrowDown') {
                          e.preventDefault();
                          e.stopPropagation();
                          (
                            listRef.current?.querySelector<HTMLElement>(
                              '[data-ui="dependency-task-option"]',
                            ) ??
                            listRef.current?.querySelector<HTMLElement>(
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
                  <div ref={listRef} className="overflow-y-auto flex-1">
                    {dependsOnIds.length > 0 && (
                      <DropdownMenuItem
                        onSelect={() => setDependsOnIds([])}
                        className="text-muted-foreground italic"
                      >
                        <X className="size-3 mr-1.5" />
                        Clear all
                      </DropdownMenuItem>
                    )}
                    {filteredTasks.map((f) => (
                      <DropdownMenuItem
                        key={f.id}
                        data-ui="dependency-task-option"
                        onSelect={() => addDependency(f.id)}
                        className={cn(
                          dependsOnIds.includes(f.id) &&
                            'bg-primary/15 text-primary',
                        )}
                      >
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

              {dependsOnTasks.length > 0 && (
                <div
                  data-ui="add-task-dependency-chips"
                  className="flex flex-wrap items-center gap-1.5 p-2 rounded-md border border-border bg-muted/20"
                >
                  {dependsOnTasks.map((dep) => (
                    <Badge
                      key={dep.id}
                      data-ui="add-task-dependency-chip"
                      data-task-id={dep.id}
                      variant="secondary"
                      className="text-[10px] h-6 pl-1.5 pr-0 gap-1 max-w-full"
                    >
                      <span className="truncate">{dep.title}</span>
                      <button
                        type="button"
                        onClick={() => removeDependency(dep.id)}
                        className="shrink-0 inline-flex min-h-6 min-w-6 items-center justify-center"
                        aria-label={`Remove dependency ${dep.title}`}
                      >
                        <X className="size-2.5 hover:text-destructive" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </div>

          {executeStages.length > 1 && (
            <div className="space-y-2">
              <label
                className="text-sm font-medium"
                htmlFor="task-execute-stage"
              >
                Execute in stage
              </label>
              <Select
                id="task-execute-stage"
                value={selectedExecuteStageId || executeStages[0]?.id}
                onValueChange={(nextValue) =>
                  setSelectedExecuteStageId(nextValue)
                }
                className="w-full"
              >
                {executeStages.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.title}
                  </SelectItem>
                ))}
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="task-priority">
              Priority
            </label>
            <Select
              id="task-priority"
              value={priorityMode}
              onValueChange={(nextValue) => setPriorityMode(nextValue)}
              className="w-full"
            >
              <SelectItem value="next">Next in line</SelectItem>
              <SelectItem value="top">Top priority</SelectItem>
            </Select>
          </div>
        </div>

        <DialogFooter
          data-ui="add-task-footer"
          className="order-2 shrink-0 border-t border-border px-4 py-3 gap-2"
        >
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="secondary"
            onClick={() => handleCreate(false)}
            disabled={!title.trim() || busy}
          >
            Create
          </Button>
          <Button
            onClick={() => handleCreate(true)}
            disabled={!title.trim() || busy}
          >
            Create & Execute
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
