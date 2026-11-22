import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeHub } from './knowledge-hub';

const { useKnowledgeBases, refetch } = vi.hoisted(() => ({
  useKnowledgeBases: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock('@/hooks/use-knowledge', () => {
  const mutation = () => ({ mutateAsync: vi.fn(), isPending: false });
  return {
    useKnowledgeBases,
    useKnowledgeVectorStatus: () => ({
      data: undefined,
      isLoading: false,
      error: null,
    }),
    useCreateKnowledgeBase: mutation,
    useUpdateKnowledgeBase: mutation,
    useDeleteKnowledgeBase: mutation,
    useIndexKnowledgeBase: mutation,
    useShareKnowledgeBase: mutation,
    useUnshareKnowledgeBase: mutation,
    useKnowledgeShares: () => ({ data: [] }),
    useKnowledgeFiles: () => ({ data: [] }),
  };
});
vi.mock('@/hooks/use-projects', () => ({ useProjects: () => ({ data: [] }) }));
vi.mock('@/hooks/use-media-query', () => ({ useMediaQuery: () => false }));
vi.mock('./knowledge-documents', () => ({ KnowledgeDocuments: () => null }));
vi.mock('@/components/share-dialog', () => ({ ShareDialog: () => null }));
vi.mock('@/components/layout/page-header', () => ({
  PageHeader: () => null,
}));

function query(overrides: Record<string, unknown>) {
  useKnowledgeBases.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    refetch,
    ...overrides,
  });
}

afterEach(() => {
  cleanup();
  useKnowledgeBases.mockReset();
  refetch.mockReset();
});

describe('KnowledgeHub collection list', () => {
  it('shows an error with Retry when loading fails and retries via refetch', () => {
    query({ isError: true });
    const { rerender } = render(<KnowledgeHub />);
    expect(screen.getByText('Could not load Knowledge Bases')).toBeTruthy();
    expect(screen.queryByText('No Knowledge Bases yet')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);

    query({
      data: [
        {
          id: 'kb-12345678',
          name: 'Docs',
          description: null,
          created_at: '2026-01-01T00:00:00Z',
          last_indexed_at: null,
        },
      ],
    });
    rerender(<KnowledgeHub />);
    expect(screen.queryByText('Could not load Knowledge Bases')).toBeNull();
    expect(screen.getByText('Docs')).toBeTruthy();
  });

  it('shows the empty state when the load succeeds with no knowledge bases', () => {
    query({ data: [] });
    render(<KnowledgeHub />);
    expect(screen.getByText('No Knowledge Bases yet')).toBeTruthy();
    expect(screen.queryByText('Could not load Knowledge Bases')).toBeNull();
  });
});
