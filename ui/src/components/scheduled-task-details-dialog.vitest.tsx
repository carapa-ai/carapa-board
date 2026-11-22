import {
  QueryClient,
  QueryClientProvider,
  useMutation,
} from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ScheduledTask,
  ScheduledTaskRun,
  ScheduledTaskTranscript,
} from '@/types';
import { ScheduledTaskDetailsDialog } from './scheduled-task-details-dialog';

const state = vi.hoisted(() => ({
  runs: { data: [] as ScheduledTaskRun[], isLoading: false, isError: false },
  transcript: {
    data: undefined as ScheduledTaskTranscript | undefined,
    isLoading: false,
    isError: false,
  },
  updateScheduledTask: undefined as
    | undefined
    | ((vars: {
        scheduled_task_id: string;
        data: Partial<ScheduledTask>;
      }) => Promise<ScheduledTask>),
}));

vi.mock('@/lib/api', () => ({ fetchRuntimeCatalog: vi.fn(async () => ({})) }));
vi.mock('@/hooks/use-projects', () => ({
  useProject: () => ({ data: undefined }),
}));
vi.mock('@/components/chat/runtime-picker', () => ({
  RuntimePicker: () => null,
}));
vi.mock('@/components/chat/chat-message-bubble', () => ({
  ChatMessageBubble: ({
    role,
    content,
    id,
  }: {
    role: string;
    content: string;
    id: string;
  }) => (
    <article
      data-shared-renderer="chat-message-bubble"
      data-role={role}
      data-message-id={id}
    >
      {content}
    </article>
  ),
}));
vi.mock('@/hooks/use-scheduled-tasks', () => ({
  useScheduledTaskDetail: () => ({ data: undefined, isLoading: false }),
  useScheduledTaskRuns: () => state.runs,
  useScheduledTaskTranscript: () => state.transcript,
  useUpdateScheduledTask: () =>
    useMutation({
      mutationFn: (
        vars: Parameters<NonNullable<typeof state.updateScheduledTask>>[0],
      ) => state.updateScheduledTask!(vars),
    }),
  useDeleteScheduledTask: () => ({ mutate: vi.fn(), isPending: false }),
}));

const task: ScheduledTask = {
  id: 'scheduled-1',
  groupFolder: 'project-1',
  chatJid: 'project-1@web',
  prompt: 'Fallback **prompt**',
  scheduleType: 'interval',
  scheduleValue: '60000',
  contextMode: 'isolated',
  nextRun: null,
  lastRun: null,
  lastResult: null,
  status: 'active',
  running: false,
  createdAt: '2026-08-01T00:00:00.000Z',
};

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function dialog(shown: ScheduledTask, onOpenChange = vi.fn()) {
  return (
    <QueryClientProvider client={queryClient}>
      <ScheduledTaskDetailsDialog
        project_id="project-1"
        task={shown}
        open
        onOpenChange={onOpenChange}
      />
    </QueryClientProvider>
  );
}

function renderDialog() {
  return render(dialog(task));
}

async function openRuns() {
  await userEvent.click(screen.getByRole('tab', { name: 'Runs' }));
}

afterEach(() => {
  cleanup();
  state.runs = { data: [], isLoading: false, isError: false };
  state.transcript = { data: undefined, isLoading: false, isError: false };
  state.updateScheduledTask = undefined;
});

describe('ScheduledTaskDetailsDialog run history', () => {
  it('renders shared run metadata and expands role-aware transcript bubbles', async () => {
    state.runs.data = [
      {
        id: 'log-1',
        runId: 'run-1',
        runAt: new Date().toISOString(),
        durationMs: 1250,
        status: 'success',
        result: 'Run result',
        error: null,
        model: 'model-id',
        modelName: 'Model Name',
        tokTotal: 1234,
        costUsd: 0.0123,
        transcriptAvailable: true,
      },
    ];
    state.transcript.data = {
      prompt: 'Ignored fallback',
      entries: [
        { type: 'message', role: 'user', content: 'User **markdown**' },
        {
          type: 'message',
          role: 'assistant',
          content: 'Assistant `tool-aware` reply',
        },
      ],
    };
    renderDialog();
    await openRuns();

    const row = document.querySelector(
      '[data-ui="scheduled-task-run-history-entry"]',
    );
    expect(row?.getAttribute('data-run-id')).toBe('run-1');
    expect(row?.textContent).toContain('success');
    expect(row?.textContent).toContain('run-1');
    expect(row?.textContent).toContain('Model Name');
    expect(row?.textContent).toContain('Run result');

    fireEvent.click(screen.getByRole('button', { name: /success/i }));
    const transcript = document.querySelector(
      '[data-ui="scheduled-task-expanded-transcript"]',
    );
    expect(transcript?.getAttribute('data-run-id')).toBe('run-1');
    expect(transcript?.querySelector('[data-role="user"]')?.textContent).toBe(
      'User **markdown**',
    );
    expect(
      transcript?.querySelector('[data-role="assistant"]')?.textContent,
    ).toBe('Assistant `tool-aware` reply');
    expect(
      transcript?.querySelectorAll(
        '[data-ui="scheduled-task-transcript-message"]',
      ),
    ).toHaveLength(2);
    expect(
      transcript?.querySelectorAll(
        '[data-shared-renderer="chat-message-bubble"]',
      ),
    ).toHaveLength(2);
  });

  it('renders the prompt fallback through the shared user message path', async () => {
    state.runs.data = [
      {
        id: 'log-2',
        runId: 'run-2',
        runAt: new Date().toISOString(),
        durationMs: null,
        status: 'success',
        result: null,
        error: null,
        model: null,
        modelName: null,
        tokTotal: null,
        costUsd: null,
        transcriptAvailable: true,
      },
    ];
    state.transcript.data = {
      prompt: 'Fallback **prompt**',
      entries: [{ type: 'message', role: 'assistant', content: 'Answer' }],
    };
    renderDialog();
    await openRuns();
    fireEvent.click(screen.getByRole('button', { name: /success/i }));
    const messages = document.querySelectorAll(
      '[data-ui="scheduled-task-transcript-message"]',
    );
    expect(messages).toHaveLength(2);
    expect(messages[0].getAttribute('data-role')).toBe('user');
    expect(messages[0].textContent).toBe('Fallback **prompt**');
  });
});

describe('ScheduledTaskDetailsDialog slow save', () => {
  const taskB: ScheduledTask = {
    ...task,
    id: 'scheduled-2',
    prompt: 'Task B prompt',
    scheduleType: 'cron',
    scheduleValue: '0 8 * * *',
  };

  // The mutation function only runs once react-query has dispatched the
  // mutation, so settle helpers wait for the request to have started.
  function deferSave() {
    let settle!: {
      resolve: (v: ScheduledTask) => void;
      reject: (e: Error) => void;
    };
    const started = new Promise<void>((begin) => {
      state.updateScheduledTask = () =>
        new Promise<ScheduledTask>((resolve, reject) => {
          settle = { resolve, reject };
          begin();
        });
    });
    return {
      resolve: async (v: ScheduledTask) => {
        await started;
        settle.resolve(v);
      },
      reject: async (e: Error) => {
        await started;
        settle.reject(e);
      },
    };
  }

  const promptField = () =>
    screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' });
  const saveButton = () =>
    document.querySelector<HTMLButtonElement>(
      '[data-ui="scheduled-task-save"]',
    )!;

  it('does not write a resolved save into the form once another task is shown', async () => {
    const save = deferSave();
    const { rerender } = renderDialog();
    fireEvent.change(promptField(), { target: { value: 'A edited' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveButton().disabled).toBe(true));

    rerender(dialog(taskB));
    await waitFor(() => expect(promptField().value).toBe('Task B prompt'));
    fireEvent.change(promptField(), { target: { value: 'B typed draft' } });

    await save.resolve({
      ...task,
      prompt: 'A edited',
      scheduleValue: '3600000',
    });
    await waitFor(() => expect(queryClient.isMutating()).toBe(0));

    expect(promptField().value).toBe('B typed draft');
    expect(
      screen.getByDisplayValue<HTMLInputElement>('0 8 * * *'),
    ).toBeTruthy();
  });

  it('applies the server response when the same task is still shown', async () => {
    const save = deferSave();
    renderDialog();
    fireEvent.change(promptField(), { target: { value: 'A edited' } });
    fireEvent.click(saveButton());

    await save.resolve({
      ...task,
      prompt: 'A normalized',
      scheduleValue: '90000',
    });
    await waitFor(() => expect(promptField().value).toBe('A normalized'));
    expect(screen.getByDisplayValue('90000')).toBeTruthy();
  });

  it('disables Save and ignores close requests while the save is pending', async () => {
    const save = deferSave();
    const onOpenChange = vi.fn();
    render(dialog(task, onOpenChange));
    fireEvent.change(promptField(), { target: { value: 'A edited' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveButton().disabled).toBe(true));

    await userEvent.keyboard('{Escape}');
    expect(onOpenChange).not.toHaveBeenCalled();

    await save.resolve({ ...task, prompt: 'A edited' });
    await waitFor(() => expect(queryClient.isMutating()).toBe(0));
    await userEvent.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps the draft and stays editable when the save fails', async () => {
    const save = deferSave();
    renderDialog();
    fireEvent.change(promptField(), { target: { value: 'A edited' } });
    fireEvent.click(saveButton());

    await save.reject(new Error('boom'));
    await waitFor(() => expect(queryClient.isMutating()).toBe(0));
    expect(promptField().value).toBe('A edited');
    expect(saveButton().disabled).toBe(false);
  });
});
