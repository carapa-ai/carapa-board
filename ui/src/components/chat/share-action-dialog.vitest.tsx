import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useStore } from '@/store';
import { mergeSharedIntoDraft, ShareActionDialog } from './share-action-dialog';

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' },
}));
vi.mock('@/hooks/use-projects', () => ({
  useProjects: () => ({ data: [{ id: 'p1', name: 'Project One' }] }),
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}));

describe('mergeSharedIntoDraft', () => {
  it('uses the shared text when the draft is empty and appends otherwise', () => {
    expect(mergeSharedIntoDraft(undefined, 'shared')).toBe('shared');
    expect(mergeSharedIntoDraft('', 'shared')).toBe('shared');
    expect(mergeSharedIntoDraft('  ', 'shared')).toBe('shared');
    expect(mergeSharedIntoDraft('abc', 'shared')).toBe('abc\n\nshared');
  });
});

describe('ShareActionDialog', () => {
  it('keeps a half-typed draft when sharing into the active conversation', () => {
    useStore.setState({
      sharedContent: { title: 'Title', text: 'body' },
      lastProjectId: 'p1',
      activeConvByProject: { p1: 'c1' },
      draftByKey: { 'p1:c1': 'half typed' },
    });

    render(<ShareActionDialog />);
    fireEvent.click(screen.getByText('Continue last conversation'));

    expect(useStore.getState().draftByKey['p1:c1']).toBe(
      'half typed\n\nTitle\n\nbody',
    );
  });
});
