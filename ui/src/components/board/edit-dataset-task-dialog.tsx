import { useState, useEffect, useMemo, useRef } from 'react';
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
import { Badge } from '@/components/ui/badge';
import { Upload } from 'lucide-react';
import { useStore } from '@/store';
import {
  useDatasetTasks,
  useUpdateDatasetTask,
} from '@/hooks/use-dataset-tasks';
import { RuntimePicker } from '@/components/chat/runtime-picker';
import { RuntimeStageScope } from '@/components/board/runtime-stage-scope';
import { RuntimeCatalogLoadState } from '@/components/chat/runtime-catalog-load-state';
import { fetchRuntimeCatalog } from '@/lib/api';
import { datasetColumns, findInvalidCell } from '@/lib/dataset-rows';
import { parseCsv } from '@/lib/parse-csv';
import type { RuntimeSelection } from '@/types';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';

interface EditDatasetTaskDialogProps {
  project_id: string;
}

export function EditDatasetTaskDialog({
  project_id,
}: EditDatasetTaskDialogProps) {
  const editDatasetTaskId = useStore((s) => s.editDatasetTaskId);
  const setEditDatasetTaskId = useStore((s) => s.setEditDatasetTaskId);
  const { data: datasetTasks } = useDatasetTasks(project_id);
  const updateMutation = useUpdateDatasetTask(project_id);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const saving = updateMutation.isPending;
  // File reads finish asynchronously; ignore one that lands after Save was clicked.
  const savingRef = useRef(saving);
  savingRef.current = saving;

  const dt = datasetTasks?.find((d) => d.id === editDatasetTaskId);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [datasetText, setDatasetText] = useState('');
  const [runtimeSelection, setRuntimeSelection] =
    useState<RuntimeSelection | null>(null);
  const [runtimeSelectionStage, setRuntimeSelectionStage] = useState<
    string | null
  >(null);
  const [loadedDatasetText, setLoadedDatasetText] = useState('');
  const [uploadError, setUploadError] = useState('');
  const {
    data: runtimeCatalog,
    isError: runtimeCatalogError,
    isFetching: runtimeCatalogFetching,
    refetch: refetchRuntimeCatalog,
  } = useQuery({
    queryKey: queryKeys.runtimeCatalog,
    queryFn: fetchRuntimeCatalog,
    staleTime: Infinity,
    enabled: !!editDatasetTaskId,
  });

  // Sync the form once per opened dataset task; list refetches replace `dt`
  // with a new object and must not overwrite what the user is editing.
  const syncedIdRef = useRef<string | null>(null);
  // Bumped on every close so a save that started in an earlier open session
  // cannot close a later session, even one for the same dataset task.
  const closeCountRef = useRef(0);
  useEffect(() => {
    if (!editDatasetTaskId) {
      syncedIdRef.current = null;
      closeCountRef.current += 1;
      return;
    }
    if (dt && dt.id !== syncedIdRef.current) {
      syncedIdRef.current = dt.id;
      setTitle(dt.title);
      setDescription(dt.description);
      const text = JSON.stringify(dt.dataset, null, 2);
      setDatasetText(text);
      setLoadedDatasetText(text);
      setRuntimeSelection(dt.runtimeSelection ?? null);
      setRuntimeSelectionStage(dt.runtimeSelectionStage ?? null);
      setUploadError('');
    }
  }, [dt, editDatasetTaskId]);

  // Parse result is derived from the current text so no stale error remains.
  const { parsedDataset, parseError } = useMemo(() => {
    const fail = (error: string) => ({
      parsedDataset: null,
      parseError: error,
    });
    if (!datasetText.trim()) {
      return fail('Dataset must be a non-empty JSON array');
    }
    try {
      const parsed = JSON.parse(datasetText);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        return fail('Dataset must be a non-empty JSON array');
      }
      if (
        parsed.some(
          (row: unknown) =>
            typeof row !== 'object' || row === null || Array.isArray(row),
        )
      ) {
        return fail('Each row must be a JSON object');
      }
      const cellError = findInvalidCell(parsed);
      if (cellError) return fail(cellError);
      return {
        parsedDataset: parsed as Record<string, string | number>[],
        parseError: '',
      };
    } catch {
      return fail('Invalid JSON');
    }
  }, [datasetText]);
  const datasetError = parseError || uploadError;

  const updateDatasetText = (text: string) => {
    setUploadError('');
    setDatasetText(text);
  };

  const { columns: detectedColumns, partial: partialColumns } = useMemo(
    () => datasetColumns(parsedDataset),
    [parsedDataset],
  );

  const placeholdersInDescription = useMemo(() => {
    const matches = description.match(/\{\{(\w+)\}\}/g);
    if (!matches) return [];
    return [...new Set(matches.map((m) => m.slice(2, -2)))];
  }, [description]);

  // Only meaningful once the dataset parses; otherwise every name would be flagged.
  const unmatchedPlaceholders = parsedDataset
    ? placeholdersInDescription.filter((p) => !detectedColumns.includes(p))
    : [];
  const partialPlaceholders = placeholdersInDescription.filter((p) =>
    partialColumns.includes(p),
  );

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError('');
    const reader = new FileReader();
    reader.onload = () => {
      if (savingRef.current) return;
      const text = reader.result as string;
      if (file.name.endsWith('.csv')) {
        const parsed = parseCsv(text);
        if ('error' in parsed) {
          setUploadError(
            parsed.missingData ? 'CSV needs header + data' : parsed.error,
          );
          return;
        }
        updateDatasetText(JSON.stringify(parsed.rows, null, 2));
      } else {
        updateDatasetText(text);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const datasetInvalid = !parsedDataset;

  // The save closure is stale once it resolves; track the currently open id.
  const editDatasetTaskIdRef = useRef(editDatasetTaskId);
  editDatasetTaskIdRef.current = editDatasetTaskId;

  const handleSave = async () => {
    if (!editDatasetTaskId || !title.trim() || datasetInvalid) return;
    const savingId = editDatasetTaskId;
    const savingCloseCount = closeCountRef.current;
    // Only a changed stage is sent, so saving other fields of a row whose
    // stage was later removed is not rejected.
    const effectiveStage = runtimeSelection ? runtimeSelectionStage : null;
    const stageChanged = effectiveStage !== (dt?.runtimeSelectionStage ?? null);
    try {
      await updateMutation.mutateAsync({
        dataset_task_id: savingId,
        data: {
          title: title.trim(),
          description: description.trim(),
          ...(datasetText !== loadedDatasetText
            ? { dataset: parsedDataset }
            : {}),
          model: null,
          agent_name: null,
          runtimeSelection,
          ...(stageChanged && { runtimeSelectionStage: effectiveStage }),
        },
      });
    } catch {
      // useUpdateDatasetTask already reports the error; keep the dialog open.
      return;
    }
    if (
      editDatasetTaskIdRef.current === savingId &&
      closeCountRef.current === savingCloseCount
    ) {
      setEditDatasetTaskId(null);
    }
  };

  return (
    <Dialog
      open={!!editDatasetTaskId}
      onOpenChange={(open) => !open && !saving && setEditDatasetTaskId(null)}
    >
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Dataset Task</DialogTitle>
          <DialogDescription>
            Modify the dataset task configuration.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <label className="text-sm font-medium">Title</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={saving}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Description / Prompt</label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              disabled={saving}
              aria-describedby={
                unmatchedPlaceholders.length + partialPlaceholders.length > 0
                  ? 'dataset-unmatched-placeholders'
                  : undefined
              }
            />
            {placeholdersInDescription.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-xs text-muted-foreground">
                  Placeholders:
                </span>
                {placeholdersInDescription.map((p) => (
                  <Badge
                    key={p}
                    variant="outline"
                    className={`text-[10px] h-4 px-1 ${
                      detectedColumns.includes(p)
                        ? 'border-green-600 text-green-700 dark:border-green-500/50 dark:text-green-600'
                        : 'border-orange-600 text-orange-700 dark:border-orange-500/50 dark:text-orange-600'
                    }`}
                  >
                    {`{{${p}}}`}
                  </Badge>
                ))}
              </div>
            )}
            {unmatchedPlaceholders.length + partialPlaceholders.length > 0 && (
              <div
                id="dataset-unmatched-placeholders"
                className="space-y-0.5 text-xs text-orange-700 dark:text-orange-600"
              >
                {unmatchedPlaceholders.map((p) => (
                  <p key={p}>No dataset column named {p}</p>
                ))}
                {partialPlaceholders.map((p) => (
                  <p key={p}>
                    Column {p} is missing in some rows; those rows keep a
                    literal {`{{${p}}}`}
                  </p>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Dataset</label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs gap-1.5"
                onClick={() => fileInputRef.current?.click()}
                disabled={saving}
              >
                <Upload className="size-3" /> Upload
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,.csv"
                className="hidden"
                onChange={handleFileUpload}
                disabled={saving}
              />
            </div>
            <Textarea
              value={datasetText}
              onChange={(e) => updateDatasetText(e.target.value)}
              rows={6}
              disabled={saving}
              className="font-mono"
              aria-invalid={!!datasetError}
            />
            {datasetError && (
              <p className="text-xs text-red-600 dark:text-red-500">
                {datasetError}
              </p>
            )}
            {parsedDataset && (
              <p className="text-xs text-muted-foreground">
                {parsedDataset.length} rows &middot; Columns:{' '}
                {detectedColumns.join(', ')}
              </p>
            )}
          </div>

          {/* RuntimePicker has no disabled prop; a disabled fieldset disables its native selects. */}
          <fieldset
            className="min-w-0 space-y-2"
            data-ui="dataset-runtime-picker"
            disabled={saving}
          >
            <RuntimeCatalogLoadState
              catalog={runtimeCatalog}
              isError={runtimeCatalogError}
              isFetching={runtimeCatalogFetching}
              onRetry={() => void refetchRuntimeCatalog()}
              dataUi="dataset-runtime-catalog"
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
              dataUi="dataset-runtime-stage-edit"
              disabled={saving}
            />
          </fieldset>
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => setEditDatasetTaskId(null)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={!title.trim() || datasetInvalid || saving}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
