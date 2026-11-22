import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KanbanCard } from './kanban-card';
import { useStore } from '@/store';

const testState = {
  projectStatus: 'running',
  executePending: false,
  stopPending: false,
  tasks: [] as Array<Record<string, unknown>>,
  executeTask: vi.fn(),
  dragKeyDown: vi.fn(),
};

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: () => ({
    attributes: {},
    listeners: { onKeyDown: (e: unknown) => testState.dragKeyDown(e) },
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

vi.mock('@/hooks/use-projects', () => ({
  useProjects: () => ({
    data: [
      {
        id: 'marker-project',
        name: 'Marker project',
        settings: {
          status: testState.projectStatus,
          kanbanRuntimeSelection: {
            harnessId: 'project-harness',
            modelId: 'project-model',
          },
        },
        effectiveStages: [
          {
            id: 'backlog',
            title: 'Backlog',
            type: 'queue',
            color: '#888',
            runOnEntry: true,
          },
          {
            id: 'implementation',
            title: 'Implementation',
            type: 'active',
            color: '#38f',
          },
          {
            id: 'testing',
            title: 'Testing',
            type: 'testing',
            color: '#f80',
            runtimeSelection: {
              harnessId: 'codex',
              modelId: 'gpt-5.6-sol',
            },
          },
          { id: 'review', title: 'Review', type: 'review', color: '#a0f' },
          {
            id: 'inactive-review',
            title: 'Inactive review',
            type: 'review',
            color: '#aaa',
            inactive: true,
          },
          { id: 'done', title: 'Done', type: 'done', color: '#2c5' },
        ],
      },
    ],
  }),
}));

vi.mock('@/hooks/use-tasks', () => ({
  useTasks: () => ({ data: testState.tasks }),
}));
vi.mock('@/hooks/use-elapsed-time', () => ({
  useElapsedTime: () => 0,
}));
vi.mock('@/lib/agents', () => ({
  useResolveModelLabel: () => (value: string | null | undefined) =>
    value ?? null,
  useResolveAgentLabel: () => (value: string | null | undefined) =>
    value ?? 'agent',
  useResolveRuntimeSelectionLabel:
    () =>
    (value: { harnessId: string; modelId: string } | null | undefined) => {
      if (!value) return '';
      const labels: Record<string, string> = {
        codex: 'Codex',
        'gpt-5.6-sol': 'GPT-5.6 Sol',
        'claude-code': 'Claude Code',
        'claude-opus-4-1': 'Claude Opus 4.1',
        'project-harness': 'Project Harness',
        'project-model': 'Project Model',
      };
      return `${labels[value.harnessId] ?? value.harnessId} · ${labels[value.modelId] ?? value.modelId}`;
    },
}));
vi.mock('@/hooks/use-task-mutations', () => ({
  useExecuteTask: () => ({
    mutate: testState.executeTask,
    isPending: testState.executePending,
  }),
  useStopTask: () => ({ mutate: vi.fn(), isPending: testState.stopPending }),
  useUpdateTask: () => ({ mutate: vi.fn(), isPending: false }),
}));

afterEach(() => {
  cleanup();
  useStore.getState().setDetailTaskId(null);
  testState.projectStatus = 'running';
  testState.executePending = false;
  testState.stopPending = false;
  testState.tasks = [];
  testState.executeTask.mockReset();
  testState.dragKeyDown.mockReset();
  vi.restoreAllMocks();
});

const baseTask = {
  id: 'marker-task',
  project_id: 'marker-project',
  title: 'Marker task',
  description: '',
  status: 'testing',
  priority: 0,
  created_at: '2026-08-10T00:00:00.000Z',
  archived: false,
  depends_on_ids: [],
};

describe('KanbanCard manual task trigger', () => {
  it('shows the existing trigger for a non-running task on a running board', () => {
    const { container } = render(
      <KanbanCard task={baseTask} project_id="marker-project" />,
    );

    const trigger = container.querySelector(
      '[data-ui="manual-task-trigger"][data-task-id="marker-task"]',
    );
    expect(trigger).toBeTruthy();
    expect(trigger?.getAttribute('title')).toBe('Run task manually');
    expect(trigger?.getAttribute('aria-label')).toBe('Run task manually');
  });

  it('keeps the trigger available while the board is paused', () => {
    testState.projectStatus = 'paused';
    const { container } = render(
      <KanbanCard task={baseTask} project_id="marker-project" />,
    );

    expect(
      container.querySelector('[data-ui="manual-task-trigger"]'),
    ).toBeTruthy();
  });

  it('shows no run button of any kind for a forked A/B experiment parent', () => {
    const { container } = render(
      <KanbanCard
        task={{ ...baseTask, ab_fork_commit: 'abc123' }}
        project_id="marker-project"
      />,
    );

    expect(
      container.querySelector('[data-ui="manual-task-trigger"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-ui="manual-task-trigger-disabled"]'),
    ).toBeNull();
  });

  it.each([
    ['running', { running: true, phase: 'running' as const }],
    ['claimed', { queued: true, phase: 'queued' as const }],
    ['inactive', { status: 'inactive-review' }],
  ])('hides the trigger for a %s task', (_label, taskOverrides) => {
    const { container } = render(
      <KanbanCard
        task={{ ...baseTask, ...taskOverrides }}
        project_id="marker-project"
      />,
    );

    expect(
      container.querySelector('[data-ui="manual-task-trigger"]'),
    ).toBeNull();
  });

  it('moves a passive-stage task into the first active stage when run', () => {
    const { container } = render(
      <KanbanCard
        task={{ ...baseTask, status: 'backlog' }}
        project_id="marker-project"
      />,
    );

    fireEvent.click(
      container.querySelector('[data-ui="manual-task-trigger"]') as Element,
    );
    expect(testState.executeTask).toHaveBeenCalledWith({
      task_id: 'marker-task',
      stage: 'implementation',
    });
  });

  it('shows the trigger for a waiting task but hides it during stop mutation', () => {
    const waitingTask = {
      ...baseTask,
      waiting: true,
      phase: 'waiting' as const,
    };
    const first = render(
      <KanbanCard task={waitingTask} project_id="marker-project" />,
    );
    expect(
      first.container.querySelector('[data-ui="manual-task-trigger"]'),
    ).toBeTruthy();
    first.unmount();

    testState.stopPending = true;
    const stopping = render(
      <KanbanCard task={waitingTask} project_id="marker-project" />,
    );
    expect(
      stopping.container.querySelector('[data-ui="manual-task-trigger"]'),
    ).toBeNull();
  });

  it('keeps a blocked trigger visible and explains the dependency on activation', () => {
    testState.tasks = [
      { ...baseTask, id: 'dependency', title: 'Dependency', status: 'testing' },
    ];
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const { container } = render(
      <KanbanCard
        task={{ ...baseTask, depends_on_ids: ['dependency'] }}
        project_id="marker-project"
      />,
    );

    const trigger = container.querySelector(
      '[data-ui="manual-task-trigger"]',
    ) as HTMLButtonElement;
    expect(trigger.title).toBe('Blocked by unmet dependencies');
    fireEvent.click(trigger);
    expect(alert).toHaveBeenCalledWith(
      'Cannot execute. Blocked by: Dependency',
    );
    expect(testState.executeTask).not.toHaveBeenCalled();
  });

  it('preserves the pending disabled state on the existing trigger', () => {
    testState.executePending = true;
    const { container } = render(
      <KanbanCard task={baseTask} project_id="marker-project" />,
    );
    const trigger = container.querySelector(
      '[data-ui="manual-task-trigger"]',
    ) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
  });
});

describe('KanbanCard execution markers', () => {
  it('renders only the pulse for an active automatic entry run even if stale non-running state is present', () => {
    const { container } = render(
      <KanbanCard
        task={{
          ...baseTask,
          status: 'backlog',
          error: 'Previous run failed',
          waiting: true,
          running: true,
          phase: 'running',
        }}
        project_id="marker-project"
      />,
    );

    expect(
      container.querySelector('[data-ui="task-running-marker"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('[data-ui="task-waiting-marker"]'),
    ).toBeNull();
  });
});

describe('KanbanCard icon-only action names', () => {
  it('names the stop button of a running task', () => {
    render(
      <KanbanCard
        task={{ ...baseTask, running: true, phase: 'running' }}
        project_id="marker-project"
      />,
    );
    expect(screen.getByRole('button', { name: /stop/i })).toBeTruthy();
  });

  it('names the retry button of an idle failed task', () => {
    testState.projectStatus = 'starting';
    render(
      <KanbanCard
        task={{ ...baseTask, phase: 'idle', error: 'boom' }}
        project_id="marker-project"
      />,
    );
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('hides retry while a failed task is queued', () => {
    testState.projectStatus = 'starting';
    render(
      <KanbanCard
        task={{ ...baseTask, queued: true, phase: 'queued', error: 'boom' }}
        project_id="marker-project"
      />,
    );
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });
});

describe('KanbanCard runtime badge', () => {
  it('keeps task runtime and recorded run identity above the stage runtime', () => {
    const { getByText, rerender } = render(
      <KanbanCard
        task={{
          ...baseTask,
          runtimeSelection: {
            harnessId: 'claude-code',
            modelId: 'claude-opus-4-1',
          },
        }}
        project_id="marker-project"
      />,
    );
    expect(getByText('Claude Code · Claude Opus 4.1')).toBeTruthy();

    rerender(
      <KanbanCard
        task={{ ...baseTask, last_agent_name: 'Last Run Agent' }}
        project_id="marker-project"
      />,
    );
    expect(getByText('Last Run Agent')).toBeTruthy();

    rerender(
      <KanbanCard
        task={{
          ...baseTask,
          runtimeSelection: {
            harnessId: 'claude-code',
            modelId: 'claude-opus-4-1',
          },
        }}
        project_id="marker-project"
        readOnly
        replayRun={{
          id: 'recorded-run',
          task_id: baseTask.id,
          started_at: '2026-08-10T01:00:00.000Z',
          completed_at: '2026-08-10T01:01:00.000Z',
          status: 'completed',
          stage: 'testing',
          agent_name: 'Recorded Agent',
          model: 'configured-model',
          model_name: 'Recorded Model',
        }}
      />,
    );
    expect(getByText('Recorded Agent')).toBeTruthy();
    expect(getByText('Recorded Model')).toBeTruthy();
  });
});

describe('KanbanCard touch affordances', () => {
  it('action row and select checkbox carry pointer-coarse:opacity-100', () => {
    const { container, getByLabelText } = render(
      <KanbanCard
        task={baseTask}
        project_id="marker-project"
        onToggleSelect={vi.fn()}
      />,
    );

    const checkbox = getByLabelText('Select Marker task');
    expect(checkbox.parentElement?.className).toContain(
      'pointer-coarse:opacity-100',
    );
    const actionRow = container.querySelector(
      '[data-ui="manual-task-trigger"]',
    )?.parentElement;
    expect(actionRow?.className).toContain('pointer-coarse:opacity-100');
  });
});

describe('KanbanCard keyboard open', () => {
  it('opens the detail dialog on Enter at the card root only', () => {
    const { container, getByLabelText } = render(
      <KanbanCard
        task={baseTask}
        project_id="marker-project"
        onToggleSelect={vi.fn()}
      />,
    );
    const card = container.querySelector('[data-ui="kanban-card"]')!;

    fireEvent.keyDown(getByLabelText('Select Marker task'), { key: 'Enter' });
    fireEvent.keyDown(
      container.querySelector('[data-ui="manual-task-trigger"]')!,
      { key: 'Enter' },
    );
    expect(useStore.getState().detailTaskId).toBeNull();

    fireEvent.keyDown(card, { key: 'Enter' });
    expect(useStore.getState().detailTaskId).toBe('marker-task');
  });

  it('starts a keyboard drag only from the card root, not inner controls', () => {
    const { container, getByLabelText } = render(
      <KanbanCard
        task={baseTask}
        project_id="marker-project"
        onToggleSelect={vi.fn()}
      />,
    );

    fireEvent.keyDown(getByLabelText('Select Marker task'), { key: ' ' });
    expect(testState.dragKeyDown).not.toHaveBeenCalled();

    fireEvent.keyDown(container.querySelector('[data-ui="kanban-card"]')!, {
      key: ' ',
    });
    expect(testState.dragKeyDown).toHaveBeenCalledTimes(1);
  });

  it('does not open a read-only card on Enter', () => {
    const { container } = render(
      <KanbanCard task={baseTask} project_id="marker-project" readOnly />,
    );
    fireEvent.keyDown(container.querySelector('[data-ui="kanban-card"]')!, {
      key: 'Enter',
    });
    expect(useStore.getState().detailTaskId).toBeNull();
  });
});
