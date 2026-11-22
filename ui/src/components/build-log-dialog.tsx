import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SHOW_BUILD_LOG_EVENT } from '@/lib/build-log';
import { copyToClipboard } from '@/lib/utils';

function BuildLogDialog({
  output,
  title = 'Build log',
  onOpenChange,
}: {
  output: string | null;
  title?: string;
  onOpenChange: (open: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <Dialog open={output !== null} onOpenChange={onOpenChange}>
      <DialogContent data-ui="build-log-dialog" className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Tail of the failed build output.
          </DialogDescription>
        </DialogHeader>
        <pre
          ref={(el) => {
            // The failure is at the end of the output; open scrolled there.
            if (el) el.scrollTop = el.scrollHeight;
          }}
          data-ui="build-log-output"
          className="max-h-[60vh] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap break-words"
        >
          {output}
        </pre>
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            data-ui="build-log-copy"
            onClick={async () => {
              if (await copyToClipboard(output ?? '')) setCopied(true);
            }}
          >
            {copied ? (
              <Check className="size-3.5 mr-1" />
            ) : (
              <Copy className="size-3.5 mr-1" />
            )}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Listens for showBuildLog() and renders the dialog; mount once at the root. */
export function BuildLogHost() {
  const [log, setLog] = useState<{ output: string; title?: string } | null>(
    null,
  );

  useEffect(() => {
    const onShow = (event: Event) => {
      const detail = (event as CustomEvent<{ output?: string; title?: string }>)
        .detail;
      if (detail?.output)
        setLog({ output: detail.output, title: detail.title });
    };
    window.addEventListener(SHOW_BUILD_LOG_EVENT, onShow);
    return () => window.removeEventListener(SHOW_BUILD_LOG_EVENT, onShow);
  }, []);

  return (
    <BuildLogDialog
      output={log?.output ?? null}
      title={log?.title}
      onOpenChange={(open) => {
        if (!open) setLog(null);
      }}
    />
  );
}
