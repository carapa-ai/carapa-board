import { useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export interface ConfirmOptions {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive (delete, revoke, discard). */
  destructive?: boolean;
}

interface PendingConfirm extends ConfirmOptions {
  message: string;
  resolve: (confirmed: boolean) => void;
}

// One dialog at a time; later requests wait their turn.
const queue: PendingConfirm[] = [];
const listeners = new Set<() => void>();
let hostMounts = 0;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  hostMounts += 1;
  return () => {
    listeners.delete(listener);
    hostMounts -= 1;
  };
}

function current(): PendingConfirm | undefined {
  return queue[0];
}

function settle(confirmed: boolean) {
  queue.shift()?.resolve(confirmed);
  emit();
}

/**
 * Ask the user to confirm an action in an in-app dialog. Resolves true only on
 * the confirm button; Cancel, Escape and an outside click resolve false. Falls
 * back to the browser prompt when no `ConfirmDialogHost` is mounted.
 */
export function confirmAction(
  message: string,
  options: ConfirmOptions = {},
): Promise<boolean> {
  if (hostMounts === 0) {
    return Promise.resolve(
      typeof window !== 'undefined' && window.confirm(message),
    );
  }
  return new Promise((resolve) => {
    queue.push({ ...options, message, resolve });
    emit();
  });
}

/** Renders the dialog behind `confirmAction`; mount once near the app root. */
export function ConfirmDialogHost() {
  const pending = useSyncExternalStore(subscribe, current, current);
  return (
    <Dialog
      open={!!pending}
      onOpenChange={(open) => {
        if (!open) settle(false);
      }}
    >
      <DialogContent data-ui="confirm-dialog">
        <DialogHeader>
          <DialogTitle>{pending?.title ?? 'Are you sure?'}</DialogTitle>
          <DialogDescription className="whitespace-pre-line">
            {pending?.message}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            data-ui="confirm-dialog-cancel"
            onClick={() => settle(false)}
          >
            {pending?.cancelLabel ?? 'Cancel'}
          </Button>
          <Button
            type="button"
            variant={pending?.destructive ? 'destructive' : 'default'}
            data-ui="confirm-dialog-confirm"
            onClick={() => settle(true)}
          >
            {pending?.confirmLabel ?? 'Confirm'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
