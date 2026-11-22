import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Confirmation shown before a conversation is deleted. `onConfirm` performs the
 * delete; a rejection is surfaced as a toast and the dialog closes, leaving the
 * conversation in the list.
 */
export function DeleteConversationDialog({
  open,
  onOpenChange,
  title,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  onConfirm: () => Promise<unknown>;
}) {
  const [pending, setPending] = useState(false);

  const confirm = async () => {
    setPending(true);
    try {
      await onConfirm();
    } catch (err) {
      toast.error(
        `Failed to delete conversation: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      setPending(false);
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      {/* Portal events bubble through the React tree to the row's onClick. */}
      <DialogContent
        data-ui="delete-conversation-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>Delete conversation?</DialogTitle>
          <DialogDescription>
            “{title}” and its messages will be deleted. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            data-ui="delete-conversation-cancel"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            data-ui="delete-conversation-confirm"
            disabled={pending}
            onClick={() => void confirm()}
          >
            {pending && <Loader2 className="size-3.5 animate-spin" />}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
