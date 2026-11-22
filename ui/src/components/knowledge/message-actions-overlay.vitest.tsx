import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { copyToClipboard } from '@/lib/utils';
import { MessageActionsOverlay } from './message-actions-overlay';

const saveMessageToKnowledge = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({ saveMessageToKnowledge }));
vi.mock('@/hooks/use-knowledge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-knowledge')>()),
  useSharedKnowledgeBases: () => ({
    data: [{ id: 'kb-1', name: 'Notes', description: 'Shared' }],
    isLoading: false,
  }),
}));
vi.mock('@/lib/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/utils')>()),
  copyToClipboard: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(cleanup);

function renderOverlay(onClose = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MessageActionsOverlay
        id="m1"
        content="hello"
        project_id="p1"
        onClose={onClose}
        anchorY={0}
        hasFork={false}
      />
    </QueryClientProvider>,
  );
  return onClose;
}

describe('MessageActionsOverlay', () => {
  it('is a named modal dialog that closes on Escape and via the labelled close button', () => {
    const onClose = renderOverlay();
    const dialog = screen.getByRole('dialog', { name: 'Message Actions' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('toasts an error and stays open when copying fails', async () => {
    vi.mocked(copyToClipboard).mockResolvedValue(false);
    const onClose = renderOverlay();
    fireEvent.click(screen.getByRole('button', { name: /Copy Text/ }));
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not copy to clipboard'),
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('saves to a knowledge base once while the save is pending', async () => {
    let finish!: (value: { success: boolean; path: string }) => void;
    saveMessageToKnowledge.mockReturnValue(
      new Promise((resolve) => (finish = resolve)),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MessageActionsOverlay
          id="m1"
          content="hello"
          project_id="p1"
          onClose={vi.fn()}
          anchorY={0}
          hasFork={false}
        />
      </QueryClientProvider>,
    );
    const row = screen.getByText('Notes').closest('button')!;
    fireEvent.click(row);
    await vi.waitFor(() => expect(row.disabled).toBe(true));
    fireEvent.click(row);
    expect(saveMessageToKnowledge).toHaveBeenCalledTimes(1);
    finish({ success: true, path: 'a.md' });
  });
});
