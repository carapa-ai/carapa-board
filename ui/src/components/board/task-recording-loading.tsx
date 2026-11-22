import { Loader2 } from 'lucide-react';

export function TaskRecordingLoading({ filename }: { filename: string }) {
  return (
    <div
      data-ui="task-recording-loading"
      data-recording-filename={filename}
      className="flex items-center gap-2 text-xs text-muted-foreground"
    >
      <Loader2 className="size-3.5 animate-spin" /> Loading recording…
    </div>
  );
}
