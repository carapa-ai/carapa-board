import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeDocuments } from './knowledge-documents';

const { mutateAsync, toastError, toastSuccess } = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: toastError, success: toastSuccess },
}));
vi.mock('@/hooks/use-knowledge', () => ({
  useKnowledgeFiles: () => ({ data: [], isLoading: false }),
  useUploadKnowledgeFile: () => ({ mutateAsync, isPending: false }),
  useDeleteKnowledgeFile: () => ({ mutateAsync: vi.fn() }),
  useKnowledgeTags: () => ({ data: [], isError: false }),
  useKnowledgeSearch: () => ({ data: undefined }),
}));
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  getNativeBinaryDataUrl: vi.fn(),
  knowledgeThumbnailUrl: vi.fn(),
}));
vi.mock('./knowledge-items', () => ({
  KnowledgeItemGrid: () => null,
  KnowledgeItemCard: () => null,
}));
vi.mock('./document-tags', () => ({
  KnowledgeDocumentTagEditor: () => null,
  KnowledgeTagFilter: () => null,
}));
vi.mock('./knowledge-document-reader', () => ({ default: () => null }));
vi.mock('@/components/confirm-dialog', () => ({ confirmAction: vi.fn() }));

const SIZE_ERROR = 'Document exceeds the 5 MB limit';

const makeFile = (name: string) =>
  new File(['x'], name, { type: 'text/plain' });

function rejectNames(...names: string[]) {
  mutateAsync.mockImplementation(async ({ name }: { name: string }) => {
    if (names.includes(name)) throw new Error(SIZE_ERROR);
    return { success: true, path: name };
  });
}

function errorToastText() {
  expect(toastError).toHaveBeenCalledTimes(1);
  const [title, options] = toastError.mock.calls[0] as [
    string,
    { description?: string } | undefined,
  ];
  return `${title}\n${options?.description ?? ''}`;
}

async function uploadViaInput(files: File[]) {
  const { container } = render(<KnowledgeDocuments kbId="kb-1" />);
  const input = container.querySelector('input[type="file"]')!;
  fireEvent.change(input, { target: { files } });
  await waitFor(() => expect(toastError).toHaveBeenCalled());
}

afterEach(() => {
  cleanup();
  mutateAsync.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
});

describe('KnowledgeDocuments upload failures', () => {
  it('names the failed file and the server reason, not the successful one', async () => {
    rejectNames('big.pdf');
    await uploadViaInput([makeFile('ok.md'), makeFile('big.pdf')]);

    const text = errorToastText();
    expect(text).toContain('big.pdf');
    expect(text).toContain(SIZE_ERROR);
    expect(text).not.toContain('ok.md');
    expect(toastSuccess).toHaveBeenCalledWith('Successfully uploaded 1 file');
  });

  it('lists at most three failures and summarizes the rest', async () => {
    const names = ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf', 'e.pdf'];
    rejectNames(...names);
    await uploadViaInput(names.map(makeFile));

    const text = errorToastText();
    expect(text).toContain('Failed to upload 5 files');
    for (const name of names.slice(0, 3)) {
      expect(text).toContain(`${name}: ${SIZE_ERROR}`);
    }
    expect(text).not.toContain('d.pdf');
    expect(text).toContain('and 2 more');
  });

  it('reports the same name and reason for drag-and-drop uploads', async () => {
    rejectNames('big.pdf');
    const entry = (name: string) => ({
      isFile: true,
      isDirectory: false,
      name,
      file: (resolve: (file: File) => void) => resolve(makeFile(name)),
    });
    const { container } = render(<KnowledgeDocuments kbId="kb-1" />);
    const dropZone = container.querySelector('.border-dashed')!;
    fireEvent.drop(dropZone, {
      dataTransfer: {
        items: [entry('ok.md'), entry('big.pdf')].map((e) => ({
          webkitGetAsEntry: () => e,
        })),
      },
    });
    await waitFor(() => expect(toastError).toHaveBeenCalled());

    const text = errorToastText();
    expect(text).toContain('big.pdf');
    expect(text).toContain(SIZE_ERROR);
    expect(text).not.toContain('ok.md');
    expect(text).not.toContain('Check console for details');
  });
});
