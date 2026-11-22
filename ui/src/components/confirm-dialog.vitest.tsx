import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialogHost, confirmAction } from './confirm-dialog';

afterEach(cleanup);

describe('confirmAction', () => {
  it('falls back to the browser prompt without a host', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await expect(confirmAction('Delete it?')).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledWith('Delete it?');
    confirm.mockRestore();
  });

  it('resolves true only on the confirm button', async () => {
    render(<ConfirmDialogHost />);
    let result!: Promise<boolean>;
    act(() => {
      result = confirmAction('Remove the thing?', {
        title: 'Remove?',
        confirmLabel: 'Remove',
        destructive: true,
      });
    });
    expect(screen.getByText('Remove?')).toBeTruthy();
    expect(screen.getByText('Remove the thing?')).toBeTruthy();
    fireEvent.click(screen.getByText('Remove'));
    await expect(result).resolves.toBe(true);
    expect(screen.queryByText('Remove?')).toBeNull();
  });

  it('resolves false on Cancel', async () => {
    render(<ConfirmDialogHost />);
    let result!: Promise<boolean>;
    act(() => {
      result = confirmAction('Go ahead?');
    });
    fireEvent.click(screen.getByText('Cancel'));
    await expect(result).resolves.toBe(false);
  });

  it('shows queued requests one after another', async () => {
    render(<ConfirmDialogHost />);
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = confirmAction('First?');
      second = confirmAction('Second?');
    });
    expect(screen.getByText('First?')).toBeTruthy();
    expect(screen.queryByText('Second?')).toBeNull();
    fireEvent.click(screen.getByText('Cancel'));
    await expect(first).resolves.toBe(false);
    expect(await screen.findByText('Second?')).toBeTruthy();
    fireEvent.click(screen.getByText('Confirm'));
    await expect(second).resolves.toBe(true);
  });
});
