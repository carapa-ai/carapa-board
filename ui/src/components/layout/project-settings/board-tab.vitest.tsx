import { useState } from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Tabs } from '@/components/ui/tabs';
import type { Project, ProjectSettings, StageDefinition } from '@/types';
import { BoardTab } from './board-tab';

const confirmAction = vi.hoisted(() => vi.fn());
vi.mock('@/components/confirm-dialog', () => ({ confirmAction }));

afterEach(() => {
  cleanup();
  confirmAction.mockReset();
});

function Harness({ initial }: { initial: ProjectSettings }) {
  const [form, setForm] = useState<ProjectSettings>(initial);
  return (
    <Tabs defaultValue="board">
      <BoardTab
        {...({
          form,
          setForm,
          project: undefined,
          kanbanEnabled: false,
        } as unknown as React.ComponentProps<typeof BoardTab>)}
      />
      <output data-testid="form">{JSON.stringify(form)}</output>
    </Tabs>
  );
}

describe('BoardTab custom values', () => {
  it('serializes an empty custom_values array after removing the last value', () => {
    render(<Harness initial={{ custom_values: [{ key: 'score' }] }} />);
    const remove = Array.from(document.querySelectorAll('button')).find((b) =>
      b.querySelector('svg.lucide-x'),
    );
    fireEvent.click(remove!);
    expect(screen.getByTestId('form').textContent).toContain(
      '"custom_values":[]',
    );
  });

  it('names the type select and the icon-only remove button', () => {
    render(<Harness initial={{ custom_values: [{ key: 'score' }] }} />);
    expect(
      screen.getByRole('combobox', { name: 'Custom value type' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Remove custom value score' }),
    ).toBeTruthy();
  });
});

describe('BoardTab inherit from parent', () => {
  const stage = (
    id: string,
    type: StageDefinition['type'],
  ): StageDefinition => ({
    id,
    title: id,
    type,
    color: '#888888',
  });
  const parentStages = [stage('queue', 'queue'), stage('done', 'done')];
  const ownStages = [stage('queue', 'queue'), stage('coding', 'active')];

  function renderTab(
    project: Partial<Project>,
    onInheritFromParent = vi.fn().mockResolvedValue(undefined),
  ) {
    render(
      <Tabs defaultValue="board">
        <BoardTab
          {...({
            form: { stages: project.settings?.stages ?? [] },
            setForm: () => {},
            project,
            kanbanEnabled: true,
            parentId: project.parentId ?? null,
            draftInheritsStages: false,
            draftParentChanged: false,
            draftParentStages: parentStages,
            draftEffectiveStages: ownStages,
            savedEffectiveStages: ownStages,
            stageOccupancy: [],
            stageOccupancyPending: false,
            stageOccupancyError: false,
            refetchStageOccupancy: async () => {},
            setOpenRemovalStageId: () => {},
            setConflictProspectiveStages: () => {},
            setConflictDraftInherited: () => {},
            stageMigrations: [],
            setStageMigrations: () => {},
            availableAiUsers: [],
            onStageSuffixInvalidChange: () => {},
            onInheritFromParent,
          } as unknown as React.ComponentProps<typeof BoardTab>)}
        />
      </Tabs>,
    );
    return onInheritFromParent;
  }

  it('is offered only to a child project with its own stages', () => {
    renderTab({ id: 'root', settings: { stages: ownStages } });
    expect(screen.queryByText('Inherit from parent')).toBeNull();
    cleanup();
    renderTab({ id: 'child', parentId: 'root', settings: {} });
    expect(screen.queryByText('Inherit from parent')).toBeNull();
    cleanup();
    renderTab({
      id: 'child',
      parentId: 'root',
      settings: { stages: ownStages },
    });
    expect(screen.getByText('Inherit from parent')).toBeTruthy();
  });

  it('confirms, naming the stages that disappear, then calls the handler', async () => {
    confirmAction.mockResolvedValue(true);
    const onInherit = renderTab({
      id: 'child',
      parentId: 'root',
      settings: { stages: ownStages },
    });
    fireEvent.click(screen.getByText('Inherit from parent'));
    await waitFor(() => expect(onInherit).toHaveBeenCalledTimes(1));
    const message = confirmAction.mock.calls[0][0] as string;
    expect(message).toContain('apply to this project automatically');
    expect(message).toContain('coding (coding)');
    expect(message).not.toContain('queue (queue)');
  });

  it('does nothing when the confirmation is declined', async () => {
    confirmAction.mockResolvedValue(false);
    const onInherit = renderTab({
      id: 'child',
      parentId: 'root',
      settings: { stages: ownStages },
    });
    fireEvent.click(screen.getByText('Inherit from parent'));
    await waitFor(() => expect(confirmAction).toHaveBeenCalled());
    expect(onInherit).not.toHaveBeenCalled();
  });

  it("shows the server's refusal inline", async () => {
    confirmAction.mockResolvedValue(true);
    renderTab(
      { id: 'child', parentId: 'root', settings: { stages: ownStages } },
      vi
        .fn()
        .mockRejectedValue(
          new Error('Cannot remove occupied stages: "coding" (1 card).'),
        ),
    );
    fireEvent.click(screen.getByText('Inherit from parent'));
    expect((await screen.findByRole('alert')).textContent).toContain(
      '"coding" (1 card)',
    );
  });
});
