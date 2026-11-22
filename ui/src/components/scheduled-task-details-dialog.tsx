import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CronExpressionParser } from 'cron-parser';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectItem } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RuntimePicker } from '@/components/chat/runtime-picker';
import { ChatMessageBubble } from '@/components/chat/chat-message-bubble';
import { RunHistoryEntryPresentation } from '@/components/board/task-run-history-entry';
import { fetchRuntimeCatalog } from '@/lib/api';
import {
  useDeleteScheduledTask,
  useScheduledTaskDetail,
  useScheduledTaskRuns,
  useScheduledTaskTranscript,
  useUpdateScheduledTask,
} from '@/hooks/use-scheduled-tasks';
import { useProject } from '@/hooks/use-projects';
import { transcriptToBubbleItems } from '@/lib/chat-transcript-render-items';
import { formatRelativeTime } from '@/lib/utils';
import { resolveToolCallDisplay, type ScheduledTask } from '@/types';
import { queryKeys } from '@/lib/query-keys';

export function ScheduledTaskDetailsDialog({
  project_id,
  task,
  open,
  onOpenChange,
}: {
  project_id: string;
  task: ScheduledTask | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: project } = useProject(project_id);
  const toolCallDisplay = resolveToolCallDisplay(
    project?.settings?.toolCallDisplay,
  );
  const update = useUpdateScheduledTask(project_id);
  const remove = useDeleteScheduledTask(project_id);
  const [prompt, setPrompt] = useState('');
  const [scheduleType, setScheduleType] =
    useState<ScheduledTask['scheduleType']>('cron');
  const [scheduleValue, setScheduleValue] = useState('');
  const [contextMode, setContextMode] =
    useState<ScheduledTask['contextMode']>('isolated');
  const [runtimeSelection, setRuntimeSelection] =
    useState<ScheduledTask['runtimeSelection']>(null);
  const [status, setStatus] = useState<ScheduledTask['status']>('active');
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [draftTaskId, setDraftTaskId] = useState<string | null>(null);
  const draftSourceRef = useRef<ScheduledTask | null>(null);
  // A save/delete closure is stale once it resolves; track which task the
  // dialog shows now and how often it has been closed since the request began.
  const currentTaskIdRef = useRef(task?.id ?? null);
  currentTaskIdRef.current = task?.id ?? null;
  const closeCountRef = useRef(0);
  const detail = useScheduledTaskDetail(
    project_id,
    task?.id ?? '',
    open && !!task,
  );
  const source = detail.data ?? task;
  useEffect(() => {
    if (!open) {
      closeCountRef.current += 1;
      setDraftTaskId(null);
      draftSourceRef.current = null;
      return;
    }
    if (!source) return;
    const previousSource = draftSourceRef.current;
    const changedTask = draftTaskId !== source.id;
    const pristine =
      previousSource?.id === source.id &&
      prompt === previousSource.prompt &&
      scheduleType === previousSource.scheduleType &&
      scheduleValue === previousSource.scheduleValue &&
      contextMode === previousSource.contextMode &&
      status === previousSource.status &&
      JSON.stringify(runtimeSelection ?? null) ===
        JSON.stringify(previousSource.runtimeSelection ?? null);
    if (changedTask || pristine) {
      setPrompt(source.prompt);
      setScheduleType(source.scheduleType);
      setScheduleValue(source.scheduleValue);
      setContextMode(source.contextMode);
      setRuntimeSelection(source.runtimeSelection ?? null);
      setStatus(source.status);
      setDeleteConfirm(false);
      setSelectedRun(null);
      setDraftTaskId(source.id);
    }
    draftSourceRef.current = source;
  }, [
    open,
    source,
    draftTaskId,
    prompt,
    scheduleType,
    scheduleValue,
    contextMode,
    runtimeSelection,
    status,
  ]);
  const { data: catalog } = useQuery({
    queryKey: queryKeys.runtimeCatalog,
    queryFn: fetchRuntimeCatalog,
    enabled: open,
  });
  const runs = useScheduledTaskRuns(project_id, task?.id ?? '', open && !!task);
  const transcript = useScheduledTaskTranscript(
    project_id,
    task?.id ?? '',
    selectedRun,
  );
  const runRows = runs.data;
  const transcriptData = transcript.data;
  const running =
    runRows?.some((run) => ['running', 'finalizing'].includes(run.status)) ??
    false;
  if (!task || !source) return null;
  let cronValid = true;
  if (scheduleType === 'cron') {
    try {
      // parse('') yields '* * * * *', so reject blank input explicitly.
      if (!scheduleValue.trim()) throw new Error('empty cron expression');
      CronExpressionParser.parse(scheduleValue);
    } catch {
      cronValid = false;
    }
  }
  const cadenceChanged =
    scheduleType !== source.scheduleType ||
    scheduleValue !== source.scheduleValue;
  const error = !prompt.trim()
    ? 'Prompt is required.'
    : scheduleType === 'cron' && !cronValid
      ? 'Use a valid cron expression.'
      : scheduleType === 'interval' &&
          (!/^[1-9]\d*$/.test(scheduleValue) ||
            !Number.isSafeInteger(Number(scheduleValue)))
        ? 'Use a positive safe integer in milliseconds.'
        : scheduleType === 'once' &&
            cadenceChanged &&
            (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
              scheduleValue,
            ) ||
              !Number.isFinite(Date.parse(scheduleValue)) ||
              Date.parse(scheduleValue) <= Date.now())
          ? 'Use a future ISO timestamp.'
          : '';
  const dirty =
    prompt !== source.prompt ||
    scheduleType !== source.scheduleType ||
    scheduleValue !== source.scheduleValue ||
    contextMode !== source.contextMode ||
    status !== source.status ||
    JSON.stringify(runtimeSelection ?? null) !==
      JSON.stringify(source.runtimeSelection ?? null);
  const applyDraft = (updated: ScheduledTask) => {
    setPrompt(updated.prompt);
    setScheduleType(updated.scheduleType);
    setScheduleValue(updated.scheduleValue);
    setContextMode(updated.contextMode);
    setRuntimeSelection(updated.runtimeSelection ?? null);
    setStatus(updated.status);
  };
  const stillShowing = (taskId: string, closeCount: number) =>
    currentTaskIdRef.current === taskId && closeCountRef.current === closeCount;
  const save = () => {
    const savingId = task.id;
    const savingCloseCount = closeCountRef.current;
    update.mutate(
      {
        scheduled_task_id: savingId,
        data: {
          prompt,
          scheduleType,
          scheduleValue,
          contextMode,
          runtimeSelection,
          ...(status === 'completed' ? {} : { status }),
        },
      },
      {
        onSuccess: (updated) => {
          // The query cache is already updated by the hook; only touch the
          // form while it still shows the task that was saved.
          if (stillShowing(savingId, savingCloseCount)) applyDraft(updated);
        },
      },
    );
  };
  const handleOpenChange = (next: boolean) => {
    if (!next && update.isPending) return;
    onOpenChange(next);
  };
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        data-ui="scheduled-task-details-dialog"
        className="sm:max-w-3xl"
      >
        <DialogHeader>
          <DialogTitle>Scheduled task details</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="details">
          <TabsList>
            <TabsTrigger data-ui="scheduled-task-details-tab" value="details">
              Details
            </TabsTrigger>
            <TabsTrigger data-ui="scheduled-task-runs-tab" value="runs">
              Runs
            </TabsTrigger>
          </TabsList>
          <TabsContent
            value="details"
            className="space-y-3"
            data-ui="scheduled-task-details"
          >
            {running && (
              <p
                data-ui="scheduled-task-running-lock"
                className="text-sm text-muted-foreground"
              >
                This task is currently running. Editing and deletion unlock
                after it finishes.
              </p>
            )}
            <fieldset
              disabled={running}
              className="space-y-3 disabled:opacity-60"
            >
              <div className="space-y-1.5">
                <label
                  htmlFor={`scheduled-task-prompt-${task.id}`}
                  className="text-sm font-medium"
                >
                  Prompt
                </label>
                <Textarea
                  id={`scheduled-task-prompt-${task.id}`}
                  data-ui="scheduled-task-prompt"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label
                    htmlFor={`scheduled-task-schedule-type-${task.id}`}
                    className="text-sm font-medium"
                  >
                    Schedule type
                  </label>
                  <Select
                    id={`scheduled-task-schedule-type-${task.id}`}
                    data-ui="scheduled-task-schedule-type"
                    value={scheduleType}
                    onValueChange={(nextValue) =>
                      setScheduleType(
                        nextValue as ScheduledTask['scheduleType'],
                      )
                    }
                    className="w-full"
                  >
                    <SelectItem value="cron">Cron</SelectItem>
                    <SelectItem value="interval">Interval</SelectItem>
                    <SelectItem value="once">One time</SelectItem>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <label
                    htmlFor={`scheduled-task-schedule-value-${task.id}`}
                    className="text-sm font-medium"
                  >
                    Schedule value
                  </label>
                  <Input
                    id={`scheduled-task-schedule-value-${task.id}`}
                    data-ui="scheduled-task-schedule-value"
                    value={scheduleValue}
                    onChange={(e) => setScheduleValue(e.target.value)}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Cron: 0 9 * * 1 · Interval: milliseconds · One time: future ISO
                timestamp
              </p>
              <div className="space-y-1.5">
                <label
                  htmlFor={`scheduled-task-context-mode-${task.id}`}
                  className="text-sm font-medium"
                >
                  Context mode
                </label>
                <Select
                  id={`scheduled-task-context-mode-${task.id}`}
                  data-ui="scheduled-task-context-mode"
                  value={contextMode}
                  onValueChange={(nextValue) =>
                    setContextMode(nextValue as ScheduledTask['contextMode'])
                  }
                  className="w-full"
                >
                  <SelectItem value="isolated">Fresh context</SelectItem>
                  <SelectItem value="group">Group context</SelectItem>
                </Select>
              </div>
              <RuntimePicker
                projectId={project_id}
                catalog={catalog}
                value={runtimeSelection}
                onChange={setRuntimeSelection}
              />
              <p className="text-xs text-muted-foreground">
                Created {formatRelativeTime(source.createdAt)}
                {source.lastRun
                  ? ` · Last run ${formatRelativeTime(source.lastRun)}`
                  : ''}
                {source.nextRun &&
                status === 'active' &&
                new Date(source.nextRun).getTime() > Date.now()
                  ? ` · Next run ${formatRelativeTime(source.nextRun)}`
                  : ''}
              </p>
              {error && (
                <p
                  data-ui="scheduled-task-validation"
                  className="text-sm text-destructive"
                >
                  {error}
                </p>
              )}
              <Button
                data-ui="scheduled-task-status"
                variant="outline"
                disabled={status === 'completed' || running}
                onClick={() =>
                  setStatus(status === 'paused' ? 'active' : 'paused')
                }
              >
                {status === 'paused' ? 'Resume' : 'Pause'}
              </Button>
            </fieldset>
          </TabsContent>
          <TabsContent
            value="runs"
            data-ui="scheduled-task-runs"
            className="space-y-2"
          >
            {runs.isLoading && <p>Loading runs…</p>}
            {runs.isError && <p>Unable to load runs.</p>}
            {!runs.isLoading && !runs.isError && !runRows?.length && (
              <p>No runs yet.</p>
            )}
            {runRows?.length ? (
              <div className="divide-y divide-border border rounded-lg overflow-hidden bg-muted/20">
                {runRows.map((run) => {
                  const expanded = Boolean(
                    run.runId && selectedRun === run.runId,
                  );
                  const expandable = Boolean(
                    run.runId &&
                    !['running', 'finalizing'].includes(run.status),
                  );
                  return (
                    <div
                      key={run.id}
                      data-ui="scheduled-task-run-history-entry"
                      data-run-id={run.runId ?? run.id}
                    >
                      <button
                        aria-controls={
                          run.runId
                            ? `scheduled-task-transcript-${run.id}`
                            : undefined
                        }
                        aria-expanded={expandable ? expanded : undefined}
                        disabled={!expandable}
                        className="w-full text-left p-3 hover:bg-muted/40 disabled:cursor-default disabled:opacity-100 transition-colors"
                        onClick={() =>
                          setSelectedRun(
                            selectedRun === run.runId ? null : run.runId,
                          )
                        }
                      >
                        <RunHistoryEntryPresentation
                          run={{
                            id: run.runId ?? run.id,
                            status: run.status,
                            runAt: run.runAt,
                            durationMs: run.durationMs,
                            model: run.model,
                            modelName: run.modelName,
                            tokenTotal: run.tokTotal,
                            costUsd: run.costUsd,
                            result: run.result,
                            error: run.error,
                          }}
                          details={
                            run.status === 'running' ? (
                              <div>Running…</div>
                            ) : run.status === 'finalizing' ? (
                              <div>Finalizing…</div>
                            ) : !run.runId ? (
                              <div data-ui="scheduled-task-transcript-unavailable">
                                Transcript unavailable
                              </div>
                            ) : null
                          }
                        />
                      </button>
                      {expanded &&
                        (run.transcriptAvailable ? (
                          <div
                            id={`scheduled-task-transcript-${run.id}`}
                            data-ui="scheduled-task-expanded-transcript"
                            data-run-id={run.runId ?? undefined}
                            className="border-t bg-background p-3 space-y-3"
                          >
                            {transcript.isLoading ? (
                              <p data-ui="scheduled-task-transcript-loading">
                                Loading transcript…
                              </p>
                            ) : transcript.isError ? (
                              <p data-ui="scheduled-task-transcript-error">
                                Transcript unavailable
                              </p>
                            ) : (
                              <>
                                {transcriptData?.prompt &&
                                  !transcriptData.entries?.some(
                                    (entry) => entry.role === 'user',
                                  ) && (
                                    <div
                                      data-ui="scheduled-task-transcript-message"
                                      data-role="user"
                                    >
                                      <ChatMessageBubble
                                        id={`${run.runId}-prompt`}
                                        role="user"
                                        content={transcriptData.prompt}
                                        project_id={project_id}
                                      />
                                    </div>
                                  )}
                                {transcriptToBubbleItems(
                                  transcriptData?.entries,
                                ).map((item) => (
                                  <div
                                    key={item.id}
                                    data-ui="scheduled-task-transcript-message"
                                    data-role={item.role}
                                  >
                                    <ChatMessageBubble
                                      id={item.id}
                                      role={item.role}
                                      content={item.content}
                                      created_at={item.created_at}
                                      agent_name={item.agent_name}
                                      thinking={item.thinking}
                                      attachments={item.attachments}
                                      telemetry={item.telemetry}
                                      isError={item.isError}
                                      toolCallDisplay={toolCallDisplay}
                                      project_id={project_id}
                                    />
                                  </div>
                                ))}
                              </>
                            )}
                          </div>
                        ) : (
                          <p
                            id={`scheduled-task-transcript-${run.id}`}
                            data-ui="scheduled-task-transcript-unavailable"
                            className="border-t p-3 text-sm text-muted-foreground"
                          >
                            Transcript unavailable
                          </p>
                        ))}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </TabsContent>
        </Tabs>
        <DialogFooter>
          <Button
            data-ui="scheduled-task-delete"
            variant="destructive"
            disabled={running || remove.isPending}
            onClick={() => {
              if (!deleteConfirm) return setDeleteConfirm(true);
              const deletingId = task.id;
              const deletingCloseCount = closeCountRef.current;
              remove.mutate(deletingId, {
                onSuccess: () => {
                  if (stillShowing(deletingId, deletingCloseCount))
                    onOpenChange(false);
                },
              });
            }}
          >
            {deleteConfirm ? 'Confirm delete' : 'Delete'}
          </Button>
          <Button
            data-ui="scheduled-task-save"
            disabled={
              running ||
              !dirty ||
              !!error ||
              update.isPending ||
              detail.isLoading
            }
            onClick={save}
          >
            {update.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
