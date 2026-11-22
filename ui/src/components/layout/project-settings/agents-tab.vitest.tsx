import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Tabs } from '@/components/ui/tabs';
import type { RuntimeCatalog } from '@/lib/api';
import type { ProjectSettings } from '@/types';
import { AgentsTab } from './agents-tab';
import { pruneUnavailablePersonas } from './available-personas';
import { parseTaskCostLimit } from './task-cost-limit';

type AgentsTabProps = React.ComponentProps<typeof AgentsTab>;

afterEach(cleanup);

// Mirrors the dialog: Save is disabled while the typed text is invalid and
// otherwise sends the form's kanbanTaskCostLimitUsd.
function Harness({
  initial,
  onSave,
}: {
  initial: string;
  onSave: (limit: number | null | undefined) => void;
}) {
  const [form, setForm] = useState<ProjectSettings>({});
  const [text, setText] = useState(initial);
  return (
    <Tabs defaultValue="agents">
      <AgentsTab
        form={form}
        setForm={setForm}
        project_id="p"
        config={undefined}
        runtimeCatalog={undefined}
        availableAiUsers={[] as unknown as AgentsTabProps['availableAiUsers']}
        availableAiUserTeams={
          [] as unknown as AgentsTabProps['availableAiUserTeams']
        }
        taskCostLimitText={text}
        setTaskCostLimitText={setText}
      />
      <button
        disabled={!parseTaskCostLimit(text).ok}
        onClick={() => onSave(form.kanbanTaskCostLimitUsd)}
      >
        save
      </button>
    </Tabs>
  );
}

describe('AgentsTab per-task cost limit', () => {
  it('sends a valid amount, null when cleared, and blocks invalid text', () => {
    const saved: (number | null | undefined)[] = [];
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Harness initial="" onSave={(v) => saved.push(v)} />
      </QueryClientProvider>,
    );
    const input = screen.getByLabelText(
      'Per-task cost limit (USD)',
    ) as HTMLInputElement;
    const save = screen.getByText('save') as HTMLButtonElement;
    const type = (value: string) =>
      fireEvent.change(input, { target: { value } });

    type('2');
    fireEvent.click(save);
    expect(saved).toEqual([2]);

    for (const bad of ['-5', '0', 'abc', '-', ' ']) {
      type(bad);
      expect(save.disabled).toBe(true);
      expect(
        screen.getByText(/Enter an amount above 0, or clear the field/),
      ).toBeTruthy();
    }
    // Invalid text never replaced the last valid value.
    expect(saved).toEqual([2]);

    type('1.5');
    expect(save.disabled).toBe(false);
    expect(screen.queryByText(/Enter an amount above 0/)).toBeNull();

    type('');
    fireEvent.click(save);
    expect(saved).toEqual([2, null]);
  });
});

const catalog: RuntimeCatalog = {
  version: 2,
  harnesses: [
    { id: 'claude', label: 'Claude', kind: 'cli', sessionFamily: 'claude' },
  ],
  models: [
    {
      id: 'sonnet',
      label: 'Sonnet',
      capabilities: [],
      bindings: [
        {
          harnessId: 'claude',
          runtimeId: 'claude:sonnet',
          reasoning: { options: [] },
        },
      ],
    },
  ],
  presets: [],
  defaults: {
    chat: { harnessId: 'claude', modelId: 'sonnet' },
    kanban: {
      fallback: { harnessId: 'claude', modelId: 'sonnet' },
      stages: {},
    },
  },
};

describe('AgentsTab runtime catalog load state', () => {
  const renderTab = (props: Partial<AgentsTabProps>) => {
    const element = (extra: Partial<AgentsTabProps>) => (
      <QueryClientProvider client={new QueryClient()}>
        <Tabs defaultValue="agents">
          <AgentsTab
            form={{}}
            setForm={() => {}}
            project_id="p"
            config={undefined}
            runtimeCatalog={undefined}
            availableAiUsers={
              [] as unknown as AgentsTabProps['availableAiUsers']
            }
            availableAiUserTeams={
              [] as unknown as AgentsTabProps['availableAiUserTeams']
            }
            taskCostLimitText=""
            setTaskCostLimitText={() => {}}
            {...extra}
          />
        </Tabs>
      </QueryClientProvider>
    );
    const view = render(element(props));
    return {
      rerenderWith: (extra: Partial<AgentsTabProps>) =>
        view.rerender(element(extra)),
    };
  };
  const errorMarker = '[data-ui="project-settings-runtime-catalog-error"]';

  it('shows an error with Retry in place of the pickers, then the pickers after a successful retry', () => {
    const onRetry = vi.fn();
    const { rerenderWith } = renderTab({
      runtimeCatalogError: true,
      onRetryRuntimeCatalog: onRetry,
    });
    expect(document.querySelectorAll(errorMarker)).toHaveLength(2);
    expect(screen.getAllByText("Couldn't load runtimes.")).toHaveLength(2);
    expect(screen.queryByLabelText('Runtime')).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]);
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerenderWith({ runtimeCatalog: catalog, onRetryRuntimeCatalog: onRetry });
    expect(document.querySelector(errorMarker)).toBeNull();
    expect(screen.getAllByLabelText('Runtime')).toHaveLength(2);
  });

  it('shows loading feedback, not the error or blank, while a retry is pending', () => {
    const { rerenderWith } = renderTab({});
    expect(document.querySelector(errorMarker)).toBeNull();
    expect(screen.queryByText("Couldn't load runtimes.")).toBeNull();

    // Retry after a failure resets the query to pending: error false, fetching.
    rerenderWith({ runtimeCatalogError: false, runtimeCatalogRetrying: true });
    expect(screen.getAllByText('Loading runtimes…')).toHaveLength(2);
    expect(screen.queryByText("Couldn't load runtimes.")).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

describe('AgentsTab stale persona defaults', () => {
  const available = [
    { id: 'mara', name: 'Mara', identity: 'mara@x' },
  ] as unknown as AgentsTabProps['availableAiUsers'];

  it('shows None / no invited personas for ids that are no longer available, and prunes them on save', () => {
    const form: ProjectSettings = {
      defaultMainAiUserId: 'disabled',
      defaultInvitedAiUserIds: ['disabled'],
      defaultInvitedAiUserTeamIds: ['deleted-team'],
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Tabs defaultValue="agents">
          <AgentsTab
            form={form}
            setForm={() => {}}
            project_id="p"
            config={undefined}
            runtimeCatalog={undefined}
            availableAiUsers={available}
            availableAiUserTeams={
              [] as unknown as AgentsTabProps['availableAiUserTeams']
            }
            taskCostLimitText=""
            setTaskCostLimitText={() => {}}
          />
        </Tabs>
      </QueryClientProvider>,
    );
    const select = document.querySelector(
      '#settings-default-persona',
    ) as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(screen.getByText('No invited personas')).toBeTruthy();
    expect(screen.getByText('No invited teams')).toBeTruthy();

    expect(
      pruneUnavailablePersonas(
        { ...form, defaultInvitedAiUserIds: ['disabled', 'mara'] },
        { availableAiUsers: available, availableAiUserTeams: [] },
      ),
    ).toEqual({
      defaultMainAiUserId: null,
      defaultInvitedAiUserIds: ['mara'],
      defaultInvitedAiUserTeamIds: [],
    });
  });
});
