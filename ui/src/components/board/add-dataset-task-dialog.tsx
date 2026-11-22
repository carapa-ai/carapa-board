import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
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
import { useCreateDatasetTask } from '@/hooks/use-dataset-tasks';
import { RuntimePicker } from '@/components/chat/runtime-picker';
import { RuntimeStageScope } from '@/components/board/runtime-stage-scope';
import { RuntimeCatalogLoadState } from '@/components/chat/runtime-catalog-load-state';
import { fetchRuntimeCatalog } from '@/lib/api';
import { datasetColumns, findInvalidCell } from '@/lib/dataset-rows';
import { parseCsv } from '@/lib/parse-csv';
import type { RuntimeSelection } from '@/types';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';

interface AddDatasetTaskDialogProps {
  project_id: string;
}

export function AddDatasetTaskDialog({
  project_id,
}: AddDatasetTaskDialogProps) {
  const open = useStore((s) => s.addDatasetTaskDialogOpen);
  const setOpen = useStore((s) => s.setAddDatasetTaskDialogOpen);
  const createMutation = useCreateDatasetTask(project_id);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [datasetText, setDatasetText] = useState('');
  const [runtimeSelection, setRuntimeSelection] =
    useState<RuntimeSelection | null>(null);
  const [runtimeSelectionStage, setRuntimeSelectionStage] = useState<
    string | null
  >(null);
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
    enabled: open,
  });

  // Parse result is derived from the current text so no stale error remains.
  const { parsedDataset, parseError } = useMemo(() => {
    const fail = (error: string) => ({
      parsedDataset: null,
      parseError: error,
    });
    if (!datasetText.trim()) return fail('');
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

  const partialPlaceholders = placeholdersInDescription.filter((p) =>
    partialColumns.includes(p),
  );

  // Runtime selections are scoped to a project's stages: drop them on close
  // and on a project switch. The title/prompt draft is kept.
  const clearProjectScopedSelections = useCallback(() => {
    setRuntimeSelection(null);
    setRuntimeSelectionStage(null);
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
    setDatasetText('');
    clearProjectScopedSelections();
    setUploadError('');
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError('');

    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      if (file.name.endsWith('.csv')) {
        const parsed = parseCsv(text);
        if ('error' in parsed) {
          setUploadError(
            parsed.missingData
              ? 'CSV must have a header row and at least one data row'
              : parsed.error,
          );
          return;
        }
        updateDatasetText(JSON.stringify(parsed.rows, null, 2));
      } else {
        updateDatasetText(text);
      }
    };
    reader.readAsText(file);
    // Reset the input so the same file can be re-selected
    e.target.value = '';
  };

  const handleCreate = async () => {
    if (!title.trim() || !parsedDataset) return;
    try {
      await createMutation.mutateAsync({
        title: title.trim(),
        description: description.trim() || undefined,
        dataset: parsedDataset,
        runtimeSelection,
        runtimeSelectionStage: runtimeSelection ? runtimeSelectionStage : null,
      });
    } catch {
      // useCreateDatasetTask already reports the error; keep the draft open.
      return;
    }
    reset();
    setOpen(false);
  };

  // Closing mid-create would let the later success reset a reopened draft.
  const handleOpenChange = (next: boolean) => {
    if (!next && createMutation.isPending) return;
    setOpen(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[min(56rem,calc(100%-2rem))] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Dataset Task</DialogTitle>
          <DialogDescription>
            Run the same task for each row in a dataset. Use {'{{column}}'}{' '}
            placeholders in the description.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="dt-title">
              Title
            </label>
            <Input
              id="dt-title"
              placeholder="Task title (supports {{placeholders}})"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="dt-desc">
              Description / Prompt
            </label>
            <Textarea
              id="dt-desc"
              placeholder={
                'Describe the task... use {{column_name}} for placeholders\ne.g. "Research {{company}} in {{city}}"'
              }
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
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
            {partialPlaceholders.length > 0 && (
              <div className="space-y-0.5 text-xs text-orange-700 dark:text-orange-600">
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
              <label className="text-sm font-medium" htmlFor="dt-dataset">
                Dataset (JSON array)
              </label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs gap-1.5"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="size-3" />
                Upload .json / .csv
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,.csv"
                className="hidden"
                onChange={handleFileUpload}
              />
            </div>
            <Textarea
              id="dt-dataset"
              placeholder={
                '[\n  {"name": "Alice", "city": "Berlin"},\n  {"name": "Bob", "city": "Munich"}\n]'
              }
              value={datasetText}
              onChange={(e) => updateDatasetText(e.target.value)}
              rows={6}
              aria-invalid={datasetError ? true : undefined}
              className="font-mono"
            />
            {datasetError && (
              <p className="text-xs text-red-600 dark:text-red-500">
                {datasetError}
              </p>
            )}
            {parsedDataset && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>{parsedDataset.length} rows</span>
                {detectedColumns.length > 0 && (
                  <>
                    <span>&middot;</span>
                    <span>Columns: {detectedColumns.join(', ')}</span>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="space-y-2" data-ui="dataset-runtime-picker">
            <RuntimeCatalogLoadState
              catalog={runtimeCatalog}
              isError={runtimeCatalogError}
              isFetching={runtimeCatalogFetching}
              onRetry={() => void refetchRuntimeCatalog()}
              dataUi="dataset-runtime-catalog"
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
              dataUi="dataset-runtime-stage"
            />
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
              !parsedDataset ||
              !!datasetError ||
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
