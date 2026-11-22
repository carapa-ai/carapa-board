import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { CreateKbDialog, EditKbDialog } from './knowledge-hub';

const mutateAsync = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/use-knowledge', () => {
  const mutation = () => ({ mutateAsync, isPending: false });
  return {
    useKnowledgeBases: vi.fn(),
    useKnowledgeVectorStatus: vi.fn(),
    useCreateKnowledgeBase: mutation,
    useUpdateKnowledgeBase: mutation,
    useDeleteKnowledgeBase: mutation,
    useIndexKnowledgeBase: mutation,
    useShareKnowledgeBase: mutation,
    useUnshareKnowledgeBase: mutation,
    useKnowledgeShares: vi.fn(),
    useKnowledgeFiles: vi.fn(),
  };
});
vi.mock('@/hooks/use-projects', () => ({ useProjects: vi.fn() }));
vi.mock('@/hooks/use-media-query', () => ({ useMediaQuery: () => true }));
vi.mock('./knowledge-documents', () => ({ KnowledgeDocuments: () => null }));
vi.mock('./knowledge-items', () => ({
  KnowledgeItemGrid: () => null,
  KnowledgeItemCard: () => null,
}));
vi.mock('@/components/share-dialog', () => ({ ShareDialog: () => null }));
vi.mock('@/components/layout/page-header', () => ({
  PageHeader: () => null,
}));

const kb = { id: 'kb-1', name: 'Original', description: 'Desc' };

function Harness({ edit }: { edit: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button onClick={() => setOpen(true)}>reopen</button>
      <button onClick={() => setOpen(false)}>close</button>
      <Dialog open={open} onOpenChange={setOpen}>
        {edit ? (
          <EditKbDialog kb={kb} onSuccess={() => setOpen(false)} />
        ) : (
          <CreateKbDialog onSuccess={() => setOpen(false)} />
        )}
      </Dialog>
    </>
  );
}

afterEach(() => {
  cleanup();
  mutateAsync.mockReset();
});

describe('Knowledge base dialogs', () => {
  it('Edit dialog discards an abandoned edit on reopen', () => {
    render(<Harness edit />);
    fireEvent.change(screen.getByDisplayValue('Original'), {
      target: { value: 'Abandoned' },
    });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByText('reopen'));
    expect(screen.getByDisplayValue('Original')).toBeTruthy();
    expect(screen.queryByDisplayValue('Abandoned')).toBeNull();
  });

  it('Create dialog is empty again after reopen', () => {
    render(<Harness edit={false} />);
    const input = screen.getByPlaceholderText('e.g. Project Documentation');
    fireEvent.change(input, { target: { value: 'Abandoned' } });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByText('reopen'));
    expect(
      (
        screen.getByPlaceholderText(
          'e.g. Project Documentation',
        ) as HTMLInputElement
      ).value,
    ).toBe('');
  });

  it.each([
    ['Create', false, 'Create KB'],
    ['Edit', true, 'Save Changes'],
  ])(
    '%s dialog blocks blank names, trims the saved name and labels fields',
    async (_label, edit, action) => {
      render(<Harness edit={edit} />);
      const name = screen.getByLabelText('Name') as HTMLInputElement;
      const button = screen.getByRole('button', {
        name: action,
      }) as HTMLButtonElement;

      fireEvent.change(name, { target: { value: '   ' } });
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
      expect(mutateAsync).not.toHaveBeenCalled();

      fireEvent.change(name, { target: { value: '  Docs  ' } });
      expect(button.disabled).toBe(false);
      fireEvent.click(button);
      expect(mutateAsync).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(mutateAsync.mock.calls[0][0])).toContain(
        '"name":"Docs"',
      );
      expect(screen.getByLabelText('Description')).toBeTruthy();
    },
  );
});
