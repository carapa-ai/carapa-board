import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Tabs } from '@/components/ui/tabs';
import { DangerTab } from './danger-tab';

afterEach(cleanup);

function renderTab(canDelete: boolean) {
  render(
    <Tabs defaultValue="danger">
      <DangerTab
        projectName="Demo"
        confirmDelete={false}
        setConfirmDelete={() => {}}
        deleteMutation={{ isPending: false } as never}
        handleDelete={() => {}}
        canDelete={canDelete}
      />
    </Tabs>,
  );
  return screen.getByRole('button', { name: /delete project/i });
}

describe('DangerTab', () => {
  it('enables deletion for an owner or admin', () => {
    expect((renderTab(true) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/only the project owner/i)).toBeNull();
  });

  it('disables deletion with an explanation for an editor', () => {
    expect((renderTab(false) as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText(
        'Only the project owner or an admin can delete this project.',
      ),
    ).toBeTruthy();
  });
});
