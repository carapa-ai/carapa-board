import { useState } from 'react';
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
import { useCreateCronjob } from '@/hooks/use-cronjobs';
import { validateCron } from '@/lib/utils';
import { RuntimePicker } from '@/components/chat/runtime-picker';
import { RuntimeStageScope } from '@/components/board/runtime-stage-scope';
import { RuntimeCatalogLoadState } from '@/components/chat/runtime-catalog-load-state';
import { fetchRuntimeCatalog } from '@/lib/api';
import type { RuntimeSelection } from '@/types';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';

interface AddCronjobDialogProps {
  project_id: string;
}

export function AddCronjobDialog({ project_id }: AddCronjobDialogProps) {
  const open = useStore((s) => s.addCronjobDialogOpen);
  const setOpen = useStore((s) => s.setAddCronjobDialogOpen);
  const createMutation = useCreateCronjob(project_id);

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
    enabled: open,
  });

  const reset = () => {
    setTitle('');
    setDescription('');
    setCronExpression('');
    setRuntimeSelection(null);
    setRuntimeSelectionStage(null);
    setQueueMode('always');
    setCronError('');
  };

  const handleCreate = async () => {
    if (!title.trim() || !cron_expression.trim()) return;
    try {
      await createMutation.mutateAsync({
        title: title.trim(),
        description: description.trim() || undefined,
        cron_expression: cron_expression.trim(),
        queue_mode: queue_mode,
        runtimeSelection,
        runtimeSelectionStage: runtimeSelection ? runtimeSelectionStage : null,
      });
    } catch {
      // useCreateCronjob already reports the error; keep the draft open.
      return;
    }
    reset();
    setOpen(false);
  };

  // Closing mid-create would let the later success reset a reopened draft.
  const handleOpenChange = (next: boolean) => {
    if (!next && createMutation.isPending) return;
    if (!next) reset();
    setOpen(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[min(56rem,calc(100%-2rem))]">
        <DialogHeader>
          <DialogTitle>Add Cronjob</DialogTitle>
          <DialogDescription>
            Create a recurring job that spawns task cards on a schedule.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="cron-title">
              Title
            </label>
            <Input
              id="cron-title"
              placeholder="Cronjob title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="cron-desc">
              Description
            </label>
            <Textarea
              id="cron-desc"
              placeholder="Describe what the agent should do each run..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="cron-expr">
              Cron Expression
            </label>
            <Input
              id="cron-expr"
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
              aria-invalid={cronError ? true : undefined}
              className="font-mono"
            />
            {cronError && (
              <p className="text-xs text-red-600 dark:text-red-500">
                {cronError}
              </p>
            )}
          </div>

          <div className="space-y-2" data-ui="cronjob-runtime-picker">
            <RuntimeCatalogLoadState
              catalog={runtimeCatalog}
              isError={runtimeCatalogError}
              isFetching={runtimeCatalogFetching}
              onRetry={() => void refetchRuntimeCatalog()}
              dataUi="cronjob-runtime-catalog"
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
              dataUi="cronjob-runtime-stage"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium" id="cron-queue-mode-label">
              Queue Mode
            </label>
            <div
              role="radiogroup"
              aria-labelledby="cron-queue-mode-label"
              className="flex gap-2"
            >
              <Button
                type="button"
                role="radio"
                aria-checked={queue_mode === 'always'}
                variant={queue_mode === 'always' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setQueueMode('always')}
              >
                Always
              </Button>
              <Button
                type="button"
                role="radio"
                aria-checked={queue_mode === 'if_empty'}
                variant={queue_mode === 'if_empty' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setQueueMode('if_empty')}
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
            onClick={() => handleOpenChange(false)}
            disabled={createMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={
              !title.trim() ||
              !cron_expression.trim() ||
              !!cronError ||
              createMutation.isPending
            }
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
