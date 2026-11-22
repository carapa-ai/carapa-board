import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { DeleteConversationDialog } from './delete-conversation-dialog';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

function setup(onConfirm: () => Promise<unknown>) {
  const onOpenChange = vi.fn();
  render(
    <DeleteConversationDialog
      open
      onOpenChange={onOpenChange}
      title="Plan the launch"
      onConfirm={onConfirm}
    />,
  );
  return onOpenChange;
}

describe('DeleteConversationDialog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('names the conversation and sends nothing on Cancel', () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = setup(onConfirm);
    expect(screen.getByText(/Plan the launch/)).toBeTruthy();
    expect(screen.getByText(/cannot be undone/)).toBeTruthy();
    fireEvent.click(screen.getByText('Cancel'));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('deletes once on confirm', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = setup(onConfirm);
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('shows an error toast when the delete rejects', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('403 Forbidden'));
    const onOpenChange = setup(onConfirm);
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining('403 Forbidden'),
    );
  });
});
