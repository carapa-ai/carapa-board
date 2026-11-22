import { useState } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from './dialog';

afterEach(cleanup);

function StateDialog({
  onCloseAutoFocus,
  removeOpenerOnClose = false,
}: {
  onCloseAutoFocus?: (event: Event) => void;
  removeOpenerOnClose?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [openerRemoved, setOpenerRemoved] = useState(false);
  return (
    <>
      {!openerRemoved && <button onClick={() => setOpen(true)}>open</button>}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next && removeOpenerOnClose) setOpenerRemoved(true);
        }}
      >
        <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
          <DialogTitle>Title</DialogTitle>
          <DialogDescription>Body</DialogDescription>
        </DialogContent>
      </Dialog>
    </>
  );
}

async function openAndClose() {
  const opener = screen.getByText('open');
  opener.focus();
  fireEvent.click(opener);
  await screen.findByRole('dialog');
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  return opener;
}

describe('DialogContent close focus', () => {
  it('restores focus to the opener of a state-opened dialog', async () => {
    render(<StateDialog />);
    const opener = await openAndClose();
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('does not force focus when the opener was removed', async () => {
    render(<StateDialog removeOpenerOnClose />);
    const opener = screen.getByText('open');
    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole('dialog');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await act(async () => {});
    expect(document.activeElement).toBe(document.body);
  });

  it('respects a caller handler that prevents default', async () => {
    const handler = vi.fn((event: Event) => event.preventDefault());
    render(<StateDialog onCloseAutoFocus={handler} />);
    const opener = await openAndClose();
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(document.activeElement).not.toBe(opener);
  });

  it('still calls a non-preventing caller handler and restores focus', async () => {
    const handler = vi.fn();
    render(<StateDialog onCloseAutoFocus={handler} />);
    const opener = await openAndClose();
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(document.activeElement).toBe(opener);
  });

  it('still returns focus to a DialogTrigger', async () => {
    render(
      <Dialog>
        <DialogTrigger>trigger</DialogTrigger>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
          <DialogDescription>Body</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    const trigger = screen.getByText('trigger');
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole('dialog');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
