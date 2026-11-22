import { useState, useCallback, useEffect, useId, useRef } from 'react';
import {
  createFileRoute,
  Link,
  Navigate,
  useNavigate,
} from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Target,
  Pencil,
  Check,
  BarChart2,
  Trash2,
  DollarSign,
} from 'lucide-react';
import { Select, SelectItem } from '@/components/ui/select';
import { Header } from '@/components/layout/header';
import { QueryErrorState } from '@/components/layout/query-error-state';
import { ProjectDialogs } from '@/components/layout/project-dialogs';
import { ChatPage } from '@/components/chat/chat-page';
import { Button } from '@/components/ui/button';
import { FieldRow } from '@/components/ui/field-row';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { RuntimePicker } from '@/components/chat/runtime-picker';
import { RuntimeCatalogLoadState } from '@/components/chat/runtime-catalog-load-state';
import {
  ApiError,
  fetchObjective,
  updateObjective,
  deleteObjective,
  fetchRuntimeCatalog,
} from '@/lib/api';
import { ObjectiveExplorer } from '@/components/objective-explorer/objective-explorer';
import { PreviewPane } from '@/components/chat/preview-pane';
import { MarkdownAppLinkContext } from '@/components/markdown-content';
import { reportFromAppLink } from '@/lib/app-links';
import { queryKeys } from '@/lib/query-keys';
import { objectiveStatusConfig } from '@/lib/objective-status';
import { cn } from '@/lib/utils';
import { canLeaveActivePreview, useStore } from '@/store';
import type { Objective, ObjectiveStatus } from '@/types';
import { useAppConfig } from '@/hooks/use-app-config';

const statusOptions: ObjectiveStatus[] = [
  'draft',
  'active',
  'paused',
  'achieved',
  'failed',
];

function objectiveToForm(objective: Objective) {
  return {
    title: objective.title,
    description: objective.description,
    status: objective.status,
    progress: objective.progress,
    deadline: objective.deadline ?? '',
    eventRuntimeSelection: objective.eventRuntimeSelection ?? null,
    cost_limit_usd:
      objective.cost_limit_usd == null ? '' : String(objective.cost_limit_usd),
  };
}

export function EditObjectiveDialog({
  objective,
  project_id,
  open,
  onOpenChange,
  onSaved,
}: {
  objective: Objective;
  project_id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const fieldId = useId();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [runtimeTouched, setRuntimeTouched] = useState(false);
  const {
    data: runtimeCatalog,
    isError: runtimeCatalogError,
    isFetching: runtimeCatalogFetching,
    refetch: refetchRuntimeCatalog,
  } = useQuery({
    queryKey: queryKeys.runtimeCatalog,
    queryFn: fetchRuntimeCatalog,
    staleTime: Infinity,
    enabled: open,
  });
  const [form, setForm] = useState(() => objectiveToForm(objective));
  // Form values taken when the dialog last reset; Save sends only fields that
  // differ from it, so a stale untouched field never overwrites newer server
  // state (e.g. progress/status changed by the brain while the dialog is open).
  const snapshotRef = useRef(form);
  const prevRef = useRef({ open: false, id: objective.id });

  // Reset the form only when the dialog opens or the edited objective changes;
  // a refetch that merely replaces the `objective` object must not clobber edits.
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = { open, id: objective.id };
    // Every close path (Esc, Cancel, successful Save, parent) disarms delete.
    if (!open) setConfirmingDelete(false);
    if (!open || (prev.open && prev.id === objective.id)) return;
    const next = objectiveToForm(objective);
    snapshotRef.current = next;
    setForm(next);
    setRuntimeTouched(false);
  }, [open, objective]);

  const mutation = useMutation({
    mutationFn: (data: Parameters<typeof updateObjective>[2]) =>
      updateObjective(project_id, objective.id, data),
    onSuccess: (updated) => {
      queryClient.setQueryData<Objective>(
        queryKeys.objectives.detail(project_id, objective.id),
        (current) => (current ? { ...current, ...updated } : updated),
      );
      queryClient.setQueryData<Objective[]>(
        queryKeys.objectives.all(project_id),
        (current) =>
          current?.map((item) =>
            item.id === updated.id ? { ...item, ...updated } : item,
          ),
      );
      queryClient.invalidateQueries({
        queryKey: queryKeys.objectives.detail(project_id, objective.id),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.objectives.all(project_id),
      });
      onSaved?.();
      deleteMutation.reset();
      onOpenChange(false);
    },
    onError: (error) => {
      if (!(error instanceof ApiError) || error.status !== 409) return;
      queryClient.invalidateQueries({
        queryKey: queryKeys.objectives.detail(project_id, objective.id),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.objectives.all(project_id),
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteObjective(project_id, objective.id),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.objectives.all(project_id),
      });
      const store = useStore.getState();
      if (store.activeObjectiveByProject[project_id] === objective.id) {
        store.setActiveObjectiveForProject(project_id, null);
      }
      onOpenChange(false);
      navigate({
        to: '/objectives/$projectId',
        params: { projectId: project_id },
      });
    },
  });

  function handleSave() {
    const base = snapshotRef.current;
    const changes: Parameters<typeof updateObjective>[2] = {
      ...(form.title !== base.title ? { title: form.title } : {}),
      ...(form.description !== base.description
        ? { description: form.description }
        : {}),
      ...(form.status !== base.status ? { status: form.status } : {}),
      ...(form.progress !== base.progress ? { progress: form.progress } : {}),
      ...(form.deadline !== base.deadline
        ? { deadline: form.deadline || null }
        : {}),
      ...(runtimeTouched
        ? { eventRuntimeSelection: form.eventRuntimeSelection }
        : {}),
      ...(form.cost_limit_usd !== base.cost_limit_usd
        ? {
            cost_limit_usd:
              form.cost_limit_usd === '' ? null : Number(form.cost_limit_usd),
          }
        : {}),
    };
    // Nothing edited: there is nothing to write, so just close.
    if (Object.keys(changes).length === 0) {
      handleDialogOpenChange(false);
      return;
    }
    mutation.mutate(changes);
  }

  function handleDialogOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      mutation.reset();
      deleteMutation.reset();
    }
    onOpenChange(nextOpen);
  }

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent
        className="max-w-lg max-h-[85vh] overflow-y-auto"
        data-ui="edit-objective-dialog"
      >
        <DialogHeader>
          <DialogTitle>Edit Objective</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <label
              htmlFor={`${fieldId}-title`}
              className="text-xs font-medium text-muted-foreground"
            >
              Title
            </label>
            <Input
              id={`${fieldId}-title`}
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </div>
          <div>
            <label
              htmlFor={`${fieldId}-description`}
              className="text-xs font-medium text-muted-foreground"
            >
              Description
            </label>
            <Textarea
              id={`${fieldId}-description`}
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
              rows={3}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label
                htmlFor={`${fieldId}-status`}
                className="text-xs font-medium text-muted-foreground"
              >
                Status
              </label>
              <Select
                id={`${fieldId}-status`}
                value={form.status}
                onValueChange={(nextValue) =>
                  setForm({
                    ...form,
                    status: nextValue as ObjectiveStatus,
                  })
                }
                className="flex w-full"
              >
                {statusOptions.map((s) => (
                  <SelectItem key={s} value={s}>
                    {objectiveStatusConfig[s].label}
                  </SelectItem>
                ))}
              </Select>
            </div>
            <div>
              <label
                htmlFor={`${fieldId}-progress`}
                className="text-xs font-medium text-muted-foreground"
              >
                Progress (%)
              </label>
              <Input
                id={`${fieldId}-progress`}
                type="number"
                min={0}
                max={100}
                value={form.progress}
                onChange={(e) =>
                  setForm({ ...form, progress: Number(e.target.value) })
                }
              />
            </div>
          </div>
          <div>
            <label
              htmlFor={`${fieldId}-deadline`}
              className="text-xs font-medium text-muted-foreground"
            >
              Deadline
            </label>
            <Input
              id={`${fieldId}-deadline`}
              type="date"
              value={form.deadline ? form.deadline.slice(0, 10) : ''}
              onChange={(e) => setForm({ ...form, deadline: e.target.value })}
            />
          </div>
          <div>
            <label
              htmlFor={`${fieldId}-cost-limit`}
              className="text-xs font-medium text-muted-foreground"
            >
              Cost limit (USD)
            </label>
            <Input
              id={`${fieldId}-cost-limit`}
              type="number"
              min={0}
              step="0.01"
              value={form.cost_limit_usd}
              onChange={(e) =>
                setForm({ ...form, cost_limit_usd: e.target.value })
              }
              placeholder="No limit"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Leave empty for no limit. Only users can change this value.
            </p>
          </div>
          <div className="space-y-2" data-ui="objective-event-runtime-override">
            <label className="text-xs font-medium text-muted-foreground">
              Objective event handling runtime override
            </label>
            <RuntimeCatalogLoadState
              catalog={runtimeCatalog}
              isError={runtimeCatalogError}
              isFetching={runtimeCatalogFetching}
              onRetry={() => void refetchRuntimeCatalog()}
              dataUi="objective-event-runtime-catalog"
              errorHint={
                form.eventRuntimeSelection
                  ? 'The current runtime override is kept and will be saved unchanged, but it can’t be shown until runtimes load.'
                  : undefined
              }
            />
            <RuntimePicker
              projectId={project_id}
              catalog={runtimeCatalog}
              value={form.eventRuntimeSelection}
              allowClear
              reasoningEmptyLabel="Inherit project reasoning"
              onChange={(value) => {
                setRuntimeTouched(true);
                setForm({ ...form, eventRuntimeSelection: value });
              }}
            />
            <p className="text-xs text-muted-foreground">
              Applies only to autonomous objective events. Default inherits the
              project Kanban harness, model, and reasoning; objective chats use
              the normal chat runtime.
            </p>
          </div>
        </div>
        {mutation.isError && (
          <p
            role="alert"
            data-ui="objective-edit-error"
            className="text-sm text-destructive"
          >
            {mutation.error instanceof Error
              ? mutation.error.message
              : 'Failed to update objective'}
          </p>
        )}
        {deleteMutation.isError && (
          <p
            role="alert"
            data-ui="objective-delete-error"
            className="text-sm text-destructive"
          >
            {deleteMutation.error instanceof Error
              ? deleteMutation.error.message
              : 'Failed to delete objective'}
          </p>
        )}
        <DialogFooter className="flex-row justify-between sm:justify-between">
          {confirmingDelete ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-destructive">
                Delete this objective?
              </span>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => deleteMutation.mutate()}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? 'Deleting...' : 'Confirm'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setConfirmingDelete(false);
                  deleteMutation.reset();
                }}
              >
                No
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmingDelete(true)}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 className="size-4 mr-1" /> Delete
            </Button>
          )}
          <div className="flex gap-2">
            <Button
              variant="ghost"
              onClick={() => handleDialogOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={mutation.isPending || !form.title.trim()}
            >
              {mutation.isPending ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ObjectiveDetail({
  project_id,
  objective_id,
  report,
  conversationId,
}: {
  project_id: string;
  objective_id: string;
  report?: string;
  conversationId?: string;
}) {
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  // The report the workspace has to open and the token that identifies this
  // request. A request starts when a deep link carries a report, when the
  // deep-linked report changes, and when the report's chat link is activated
  // again. The token keeps those requests apart even when the URL does not
  // change, so the same report can be opened again.
  const [reportRequest, setReportRequest] = useState<{
    report: string | undefined;
    token: number;
  }>(() => ({ report, token: 0 }));
  // The token of the request whose report the workspace already opened. The
  // explorer unmounts when the user switches tabs, so the marker lives in
  // this component (which survives) and a report is opened once per request.
  const [openedRequestToken, setOpenedRequestToken] = useState<number>();
  const [editingProgress, setEditingProgress] = useState(false);
  const [progressInput, setProgressInput] = useState('');
  const [progressInvalid, setProgressInvalid] = useState(false);

  const {
    data: objective,
    isLoading,
    error,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: queryKeys.objectives.detail(project_id, objective_id),
    queryFn: () => fetchObjective(project_id, objective_id),
  });

  const updateMutation = useMutation({
    mutationFn: (data: Parameters<typeof updateObjective>[2]) =>
      updateObjective(project_id, objective_id, data),
    onSuccess: (updated) => {
      queryClient.setQueryData<Objective>(
        queryKeys.objectives.detail(project_id, objective_id),
        (current) => (current ? { ...current, ...updated } : updated),
      );
      queryClient.setQueryData<Objective[]>(
        queryKeys.objectives.all(project_id),
        (current) =>
          current?.map((item) =>
            item.id === updated.id ? { ...item, ...updated } : item,
          ),
      );
      queryClient.invalidateQueries({
        queryKey: queryKeys.objectives.detail(project_id, objective_id),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.objectives.all(project_id),
      });
    },
    onError: (error) => {
      if (!(error instanceof ApiError) || error.status !== 409) return;
      queryClient.invalidateQueries({
        queryKey: queryKeys.objectives.detail(project_id, objective_id),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.objectives.all(project_id),
      });
    },
  });

  const handleStatusChange = useCallback(
    (status: ObjectiveStatus) => {
      updateMutation.mutate({ status });
    },
    [updateMutation],
  );

  const commitProgress = useCallback(() => {
    const val = parseInt(progressInput, 10);
    if (isNaN(val) || val < 0 || val > 100) {
      setProgressInvalid(true);
      return;
    }
    updateMutation.mutate({ progress: val });
    setProgressInvalid(false);
    setEditingProgress(false);
  }, [progressInput, updateMutation]);

  // A deep link that points at another report starts a new request: the
  // report of the previous request must not suppress it.
  useEffect(() => {
    setReportRequest((prev) =>
      prev.report === report ? prev : { report, token: prev.token + 1 },
    );
  }, [report]);

  // A chat link to this objective's report is a no-op in the router once the
  // route is open: the URL does not change, so the workspace would keep the
  // report it already opened. Start a new request instead, so the report is
  // opened again.
  const objectivePath = `/objective/${project_id}/${objective_id}`;
  const handleAppLink = useCallback(
    async (path: string): Promise<boolean | void> => {
      const target = reportFromAppLink(path, objectivePath);
      // Links to another objective, or to this objective without a report,
      // are served by the route change itself.
      if (!target || !bareReportFilename(target)) return;
      // The request rebuilds the workspace pane, so the file editor in it is
      // unmounted and its draft would be lost. Ask the active preview
      // whether it may be left before that happens: an unsaved draft must
      // never be discarded behind the user's back. When the user cancels,
      // the request stays untouched and the activation is vetoed.
      const allowed = await canLeaveActivePreview(project_id);
      if (!allowed) return false;
      setReportRequest((prev) => ({
        report: target,
        token: prev.token + 1,
      }));
      // The leave guard was consulted here, so the router's blocker must
      // not ask again.
      return true;
    },
    [objectivePath, project_id],
  );

  // The explorer reports that it opened the report of the current request.
  const reportRequestRef = useRef(reportRequest);
  reportRequestRef.current = reportRequest;
  const handleReportOpened = useCallback((opened: string) => {
    const request = reportRequestRef.current;
    // A report that belongs to a superseded request must not mark the
    // current request as opened; that request opens its own report.
    if (request.report !== opened) return;
    setOpenedRequestToken(request.token);
  }, []);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <Target className="size-5 animate-pulse mr-2" /> Loading objective...
      </div>
    );
  }

  // A failed background refetch keeps the loaded objective in `data`; only a
  // missing objective blanks the page.
  if (!objective) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <QueryErrorState
        title={notFound ? 'Objective not found' : 'Failed to load objective'}
        error={error ?? new Error('Objective unavailable')}
        onRetry={notFound ? undefined : () => void refetch()}
        isRetrying={isFetching}
      >
        <div>
          <Link
            to="/objectives/$projectId"
            params={{ projectId: project_id }}
            className="text-sm text-muted-foreground underline hover:text-foreground transition-colors"
          >
            Back to objectives
          </Link>
        </div>
      </QueryErrorState>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Status + progress bar */}
      <div className="border-b border-border px-4 md:px-5 py-2 flex items-center gap-2 md:gap-3 flex-shrink-0 flex-wrap">
        <Link
          to="/objectives/$projectId"
          params={{ projectId: project_id }}
          aria-label="Back to objectives"
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <h2 className="text-base font-semibold flex-1 truncate">
          {objective.title}
        </h2>
        {objective.cost_limit_usd != null && (
          <span
            className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400"
            title="Objective cost / user-set limit"
          >
            <DollarSign className="size-3.5" />
            {(objective.runStats?.totalCostUsd ?? 0).toFixed(2)}
            {' / '}
            {objective.cost_limit_usd.toFixed(2)}
          </span>
        )}

        {/* Inline progress */}
        <div className="flex items-center gap-2">
          <BarChart2 className="size-4 text-muted-foreground" />
          {editingProgress ? (
            <FieldRow compact className="gap-1">
              <Input
                compact
                type="number"
                min={0}
                max={100}
                defaultValue={objective.progress}
                aria-label="Progress (%)"
                aria-invalid={progressInvalid || undefined}
                aria-describedby={
                  progressInvalid ? 'objective-progress-error' : undefined
                }
                className="w-16"
                onChange={(e) => {
                  setProgressInput(e.target.value);
                  setProgressInvalid(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitProgress();
                  if (e.key === 'Escape') {
                    setProgressInvalid(false);
                    setEditingProgress(false);
                  }
                }}
                autoFocus
              />
              <span className="text-xs text-muted-foreground">%</span>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={commitProgress}
                aria-label="Save progress"
              >
                <Check className="size-3.5" />
              </Button>
              {progressInvalid && (
                <span
                  id="objective-progress-error"
                  role="alert"
                  data-ui="objective-progress-error"
                  className="text-xs text-destructive"
                >
                  Enter a number from 0 to 100
                </span>
              )}
            </FieldRow>
          ) : (
            <button
              className="flex items-center gap-1 text-sm hover:text-foreground text-muted-foreground group"
              onClick={() => {
                setProgressInput(String(objective.progress));
                setEditingProgress(true);
              }}
              title="Click to update progress"
            >
              <div className="w-20 h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className={cn(
                    'h-full rounded-full transition-all',
                    objective.progress >= 100
                      ? 'bg-green-700 dark:bg-green-500'
                      : 'bg-cyan-600 dark:bg-cyan-500',
                  )}
                  style={{ width: `${Math.min(100, objective.progress)}%` }}
                />
              </div>
              <span className="font-medium text-foreground text-xs">
                {objective.progress}%
              </span>
              <Pencil className="size-3 opacity-0 group-hover:opacity-100 transition-opacity" />
            </button>
          )}
        </div>

        {/* Status pills */}
        <div className="flex items-center gap-1">
          {statusOptions.map((s) => (
            <button
              key={s}
              onClick={() => handleStatusChange(s)}
              disabled={updateMutation.isPending}
              data-ui="objective-status-action"
              data-objective-status={s}
              aria-pressed={objective.status === s}
              className={cn(
                'text-xs px-2 py-0.5 rounded-full transition-colors',
                objective.status === s
                  ? (objectiveStatusConfig[s]?.bg ?? '') +
                      ' ' +
                      (objectiveStatusConfig[s]?.color ?? '')
                  : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {objectiveStatusConfig[s]?.label ?? s}
            </button>
          ))}
        </div>

        {updateMutation.isError && (
          <p
            role="alert"
            data-ui="objective-status-error"
            className="basis-full text-sm text-destructive"
          >
            {updateMutation.error instanceof Error
              ? updateMutation.error.message
              : 'Failed to update objective status'}
          </p>
        )}

        <Button
          variant="ghost"
          size="sm"
          aria-label="Edit objective"
          onClick={() => setEditOpen(true)}
        >
          <Pencil className="size-4" />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <MarkdownAppLinkContext.Provider value={handleAppLink}>
          <ChatPage
            project_id={project_id}
            objective_id={objective_id}
            route_conversation_id={conversationId}
            workspacePane={{
              defaultOpen: true,
              // Each request changes the token, which forces the pane open
              // again.
              openRequest:
                reportRequest.report !== undefined
                  ? `${reportRequest.report}#${reportRequest.token}`
                  : undefined,
              marker: 'objective-workspace-pane',
              // Stable per objective: switching the key when the project
              // Browser tab is selected re-read another stored open state
              // and closed the pane on opening or leaving Browser.
              openStateKey: `objective:${objective_id}`,
              render: ({ conversationId, onClose, onFileOpen }) => (
                <PreviewPane
                  key={`${objective_id}:${reportRequest.report ?? ''}:${reportRequest.token}`}
                  project_id={project_id}
                  conversation_id={conversationId}
                  workspaceViewScope="local"
                  localDefaultView="files"
                  onClose={onClose}
                  onFileOpen={onFileOpen}
                  renderWorkspaceExplorer={(explorerProps) => (
                    <ObjectiveExplorer
                      project_id={project_id}
                      objective_id={objective_id}
                      objective_title={objective.title}
                      initial_report={
                        openedRequestToken === reportRequest.token
                          ? undefined
                          : reportRequest.report
                      }
                      onInitialReportOpened={handleReportOpened}
                      conversation_id={conversationId}
                      {...explorerProps}
                    />
                  )}
                />
              ),
            }}
          />
        </MarkdownAppLinkContext.Provider>
      </div>

      <EditObjectiveDialog
        objective={objective}
        project_id={project_id}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={() => updateMutation.reset()}
      />
    </div>
  );
}

/** A bare report filename, or undefined for anything with a path separator or `..`. */
function bareReportFilename(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && !/[\\/]|\.\./.test(value)
    ? value
    : undefined;
}

function ObjectiveDetailPage() {
  const { projectId, objectiveId } = Route.useParams();
  // The router can keep unvalidated raw search keys on the match, so
  // re-apply the filename check instead of trusting the validated shape.
  const search = Route.useSearch();
  const report = bareReportFilename(search.report);
  const conversationId = search.conversationId;
  const setActiveObjective = useStore((s) => s.setActiveObjectiveForProject);
  const { data: config } = useAppConfig();

  useEffect(() => {
    setActiveObjective(projectId, objectiveId);
  }, [projectId, objectiveId, setActiveObjective]);

  if (config !== undefined && !config.enableObjectives) {
    return <Navigate to="/board/$projectId" params={{ projectId }} />;
  }

  return (
    <>
      <Header project_id={projectId} />
      <ObjectiveDetail
        key={`${projectId}:${objectiveId}`}
        project_id={projectId}
        objective_id={objectiveId}
        report={report}
        conversationId={conversationId}
      />
      <ProjectDialogs project_id={projectId} />
    </>
  );
}

export const Route = createFileRoute('/objective/$projectId/$objectiveId')({
  validateSearch: (
    search: Record<string, unknown>,
  ): { report?: string; conversationId?: string } => {
    const report = bareReportFilename(search.report);
    const conversationId =
      typeof search.conversationId === 'string' && search.conversationId !== ''
        ? search.conversationId
        : undefined;
    return {
      ...(report ? { report } : {}),
      ...(conversationId ? { conversationId } : {}),
    };
  },
  component: ObjectiveDetailPage,
});
