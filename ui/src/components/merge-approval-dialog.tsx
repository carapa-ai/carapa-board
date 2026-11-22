import { useState } from 'react';
import { toast } from 'sonner';
import { decideProposal } from '@/lib/api';
import { usePromptStore } from '@/lib/merge-approval-prompt';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { MergeFindingsList } from '@/components/proposal-card';

/**
 * Confirmation for a human's own merge action (move to a done stage, "Merge
 * this variant") that the merge risk gate held. Confirming approves the exact
 * commit through the normal proposal decision, then repeats the action; the
 * repeat still passes the gate. Mount once near the app root.
 */
export function MergeApprovalDialogHost() {
  const prompt = usePromptStore((s) => s.prompt);
  const setPrompt = usePromptStore((s) => s.set);
  const [busy, setBusy] = useState(false);

  const approve = async () => {
    if (!prompt || busy) return;
    setBusy(true);
    const approved: string[] = [];
    const problems: string[] = [];
    for (const item of prompt.items) {
      try {
        const proposal = await decideProposal(
          prompt.projectId,
          item.approval.proposalId,
          'approve',
        );
        if (proposal.status === 'applied') approved.push(item.taskId);
        else {
          problems.push(
            `"${item.title}": ${proposal.result ?? `approval ${proposal.status}`}`,
          );
        }
      } catch (err) {
        problems.push(
          `"${item.title}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    setBusy(false);
    setPrompt(null);
    if (problems.length > 0) toast.error(problems.join('\n'));
    if (approved.length > 0) prompt.retry(approved);
  };

  return (
    <Dialog
      open={!!prompt}
      onOpenChange={(open) => {
        if (!open && !busy) setPrompt(null);
      }}
    >
      <DialogContent data-ui="merge-approval-dialog">
        <DialogHeader>
          <DialogTitle>Approve and merge?</DialogTitle>
          <DialogDescription>
            The merge risk rules hold{' '}
            {prompt && prompt.items.length === 1
              ? 'this commit'
              : 'these commits'}
            . Approving covers exactly the commit shown, then the merge is
            repeated.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-80 space-y-3 overflow-y-auto">
          {prompt?.items.map((item) => (
            <section
              key={item.taskId}
              data-ui="merge-approval-dialog-item"
              data-task-id={item.taskId}
            >
              <p className="text-sm font-medium">{item.title}</p>
              <p className="text-xs text-muted-foreground">
                Commit{' '}
                <code data-ui="merge-approval-head">
                  {item.approval.headSha.slice(0, 12)}
                </code>
              </p>
              <MergeFindingsList findings={item.approval.findings} />
            </section>
          ))}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            data-ui="merge-approval-dialog-cancel"
            onClick={() => setPrompt(null)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy}
            data-ui="merge-approval-dialog-approve"
            onClick={() => void approve()}
          >
            Approve and merge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
