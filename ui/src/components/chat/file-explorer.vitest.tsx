import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chooseOption } from '@/test-utils/select';
import { FileExplorer, type FileExplorerSource } from './file-explorer';

describe('FileExplorer sort control', () => {
  beforeEach(() => localStorage.clear());

  it('passes the chosen sort to sortable sources and persists it', async () => {
    const list = vi.fn().mockResolvedValue({ entries: [] });
    const source: FileExplorerSource = {
      id: 'group',
      label: 'Files',
      sortable: true,
      list,
      open: vi.fn(),
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <FileExplorer sources={[source]} storageKey="files-test" />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    await waitFor(() =>
      expect(list).toHaveBeenCalledWith('', undefined, undefined),
    );

    await chooseOption(screen.getByLabelText('Sort files'), 'Newest first');
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith('', undefined, {
        sort: 'modified',
        order: 'desc',
      }),
    );
    expect(localStorage.getItem('files-test:sort')).toBe('modified-desc');
  });

  it('hides the sort control when no source is sortable', () => {
    const source: FileExplorerSource = {
      id: 'repo',
      label: 'Repo',
      list: vi.fn().mockResolvedValue({ entries: [] }),
      open: vi.fn(),
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <FileExplorer sources={[source]} storageKey="files-test" />
      </QueryClientProvider>,
    );
    expect(screen.queryByLabelText('Sort files')).toBeNull();
  });
});
