import { useState, useEffect, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useStore } from '@/store';
import { useUpdateCronjob, useCronjobs } from '@/hooks/use-cronjobs';
import { validateCron } from '@/lib/utils';
import { toast } from 'sonner';
import { RuntimePicker } from '@/components/chat/runtime-picker';
import { RuntimeStageScope } from '@/components/board/runtime-stage-scope';
import { RuntimeCatalogLoadState } from '@/components/chat/runtime-catalog-load-state';
import { fetchRuntimeCatalog } from '@/lib/api';
import type { RuntimeSelection } from '@/types';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';

interface EditCronjobDialogProps {
  project_id: string;
}

export function EditCronjobDialog({ project_id }: EditCronjobDialogProps) {
  const editCronjobId = useStore((s) => s.editCronjobId);
  const setEditCronjobId = useStore((s) => s.setEditCronjobId);
  const updateMutation = useUpdateCronjob(project_id);
  const { data: cronjobs } = useCronjobs(project_id);

  const saving = updateMutation.isPending;
  const cronjob = cronjobs?.find((c) => c.id === editCronjobId);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [cron_expression, setCronExpression] = useState('');
  const [runtimeSelection, setRuntimeSelection] =
    useState<RuntimeSelection | null>(null);
  const [runtimeSelectionStage, setRuntimeSelectionStage] = useState<
    string | null
  >(null);
  const [queue_mode, setQueueMode] = useState<'always' | 'if_empty'>('always');
  const [cronError, setCronError] = useState('');
  const {
    data: runtimeCatalog,
    isError: runtimeCatalogError,
    isFetching: runtimeCatalogFetching,
    refetch: refetchRuntimeCatalog,
  } = useQuery({
    queryKey: queryKeys.runtimeCatalog,
    queryFn: fetchRuntimeCatalog,
    staleTime: Infinity,
    enabled: !!editCronjobId,
  });

  // Sync the form once per opened cronjob; list refetches replace `cronjob`
  // with a new object and must not overwrite what the user is editing.
  const syncedIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!editCronjobId) {
      syncedIdRef.current = null;
      return;
    }
    if (cronjob && cronjob.id !== syncedIdRef.current) {
      syncedIdRef.current = cronjob.id;
      setTitle(cronjob.title);
      setDescription(cronjob.description || '');
      setCronExpression(cronjob.cron_expression || '');
      setRuntimeSelection(cronjob.runtimeSelection ?? null);
      setRuntimeSelectionStage(cronjob.runtimeSelectionStage ?? null);
      setQueueMode((cronjob.queue_mode || 'always') as 'always' | 'if_empty');
      setCronError('');
    }
  }, [cronjob, editCronjobId]);

  // The save closure is stale once it resolves; track the currently open id.
  const editCronjobIdRef = useRef(editCronjobId);
  editCronjobIdRef.current = editCronjobId;

  const handleSave = async () => {
    if (!editCronjobId || !title.trim() || !cron_expression.trim()) return;
    const savingId = editCronjobId;
    // Only a changed stage is sent, so saving other fields of a row whose
    // stage was later removed is not rejected.
    const effectiveStage = runtimeSelection ? runtimeSelectionStage : null;
    const stageChanged =
      effectiveStage !== (cronjob?.runtimeSelectionStage ?? null);
    try {
      await updateMutation.mutateAsync({
        cronjob_id: savingId,
        data: {
          title: title.trim(),
          description: description.trim(),
          cron_expression: cron_expression.trim(),
          queue_mode: queue_mode,
          model: null,
          agent_name: null,
          runtimeSelection,
          ...(stageChanged && { runtimeSelectionStage: effectiveStage }),
        },
      });
    } catch {
      // useUpdateCronjob already reports the error; keep the dialog open.
      return;
    }
    toast.success('Cronjob updated');
    if (editCronjobIdRef.current === savingId) setEditCronjobId(null);
  };

  return (
    <Dialog
      open={!!editCronjobId}
      onOpenChange={(open) => !open && !saving && setEditCronjobId(null)}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Cronjob</DialogTitle>
          <DialogDescription>
            Modify the recurring job settings.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="edit-cron-title">
              Title
            </label>
            <Input
              id="edit-cron-title"
              placeholder="Cronjob title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={saving}
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="edit-cron-desc">
              Description
            </label>
            <Textarea
              id="edit-cron-desc"
              placeholder="Describe what the agent should do each run..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              disabled={saving}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="edit-cron-expr">
              Cron Expression
            </label>
            <Input
              id="edit-cron-expr"
              placeholder="e.g. 0 9 * * *  (daily at 9am)"
              value={cron_expression}
              onChange={(e) => {
                setCronExpression(e.target.value);
                setCronError(
                  e.target.value.trim()
                    ? validateCron(e.target.value) || ''
                    : '',
                );
              }}
              disabled={saving}
              aria-invalid={cronError ? true : undefined}
              className="font-mono"
            />
            {cronError && (
              <p className="text-xs text-red-600 dark:text-red-500">
                {cronError}
              </p>
            )}
          </div>

          {/* RuntimePicker has no disabled prop; a disabled fieldset disables its native selects. */}
          <fieldset
            className="min-w-0 space-y-2"
            data-ui="cronjob-runtime-picker"
            disabled={saving}
          >
            <RuntimeCatalogLoadState
              catalog={runtimeCatalog}
              isError={runtimeCatalogError}
              isFetching={runtimeCatalogFetching}
              onRetry={() => void refetchRuntimeCatalog()}
              dataUi="cronjob-runtime-catalog"
              errorHint={
                runtimeSelection
                  ? 'The current runtime override is kept and will be saved unchanged, but it can’t be shown until runtimes load.'
                  : undefined
              }
            />
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
              dataUi="cronjob-runtime-stage-edit"
              disabled={saving}
            />
          </fieldset>

          <div className="space-y-2">
            <label className="text-sm font-medium">Queue Mode</label>
            <div className="flex gap-2">
              <Button
                type="button"
                variant={queue_mode === 'always' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setQueueMode('always')}
                disabled={saving}
              >
                Always
              </Button>
              <Button
                type="button"
                variant={queue_mode === 'if_empty' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setQueueMode('if_empty')}
                disabled={saving}
              >
                If queue empty
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {queue_mode === 'always'
                ? 'Queue a new task on every scheduled trigger.'
                : 'Only queue if no tasks are pending in queue columns.'}
            </p>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => setEditCronjobId(null)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={
              !title.trim() || !cron_expression.trim() || !!cronError || saving
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
