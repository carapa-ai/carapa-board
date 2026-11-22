import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { RuntimeCatalog } from '@/lib/api';

interface RuntimeCatalogLoadStateProps {
  catalog: RuntimeCatalog | undefined;
  isError: boolean;
  isFetching: boolean;
  onRetry: () => void;
  dataUi: string;
  /** Extra line for forms that hold a stored selection the picker cannot show. */
  errorHint?: string;
}

/**
 * RuntimePicker renders nothing without a catalog, so this shows the load
 * state in its place. A retry after a failure resets the query to pending
 * (error false, fetching true), so loading is keyed on fetching, not on the
 * error.
 */
export function RuntimeCatalogLoadState({
  catalog,
  isError,
  isFetching,
  onRetry,
  dataUi,
  errorHint,
}: RuntimeCatalogLoadStateProps) {
  if (catalog) return null;
  if (isFetching) {
    return (
      <p
        className="flex items-center gap-2 text-sm text-muted-foreground"
        data-ui={`${dataUi}-loading`}
      >
        <Loader2 className="size-4 animate-spin" />
        Loading runtimes…
      </p>
    );
  }
  if (!isError) return null;
  return (
    <div className="space-y-1" data-ui={`${dataUi}-error`}>
      <div className="flex items-center gap-3">
        <p role="alert" className="text-sm text-destructive">
          Couldn't load runtimes.
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
      {errorHint && (
        <p className="text-xs text-muted-foreground">{errorHint}</p>
      )}
    </div>
  );
}
