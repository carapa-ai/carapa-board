import { createContext, useContext, type ReactNode } from 'react';

/**
 * Actions contributed by the editable-file wrapper (the Edit button). They are
 * rendered inside the header of whichever view is active, so they sit in the
 * header flow instead of overlaying the file content or its view controls.
 */
export const FilePreviewActionsContext = createContext<ReactNode>(null);

/** Shared header bar for text-family file previews. */
export function FilePreviewHeader({
  label,
  mimetype,
  meta,
  controls,
}: {
  label: string;
  mimetype?: string;
  meta?: ReactNode;
  /** View controls (e.g. Tree/Raw toggle), placed before the edit action. */
  controls?: ReactNode;
}) {
  const actions = useContext(FilePreviewActionsContext);
  return (
    <div
      data-ui="file-preview-header"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/50 bg-muted/20 px-3 py-1 text-[11px] text-muted-foreground"
    >
      <span
        className="min-w-[8rem] flex-1 truncate font-medium text-foreground"
        title={label}
      >
        {label}
      </span>
      {mimetype && <span className="font-mono">{mimetype}</span>}
      {meta}
      {controls}
      {actions}
    </div>
  );
}
