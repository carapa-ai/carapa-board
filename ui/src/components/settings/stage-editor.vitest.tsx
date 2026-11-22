import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StageEditor } from './stage-editor';
import { chooseOption, selectedLabel } from '@/test-utils/select';
import type { StageDefinition, StageMigration } from '@/types';

const source: StageDefinition = {
  id: 'source',
  title: 'Source',
  type: 'queue',
  color: '#888888',
};
const destination: StageDefinition = {
  id: 'destination',
  title: 'Destination',
  type: 'queue',
  color: '#22aa55',
};

function ui(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `[data-ui="${selector}"]`,
  );
  if (!element) throw new Error(`Missing UI marker: ${selector}`);
  return element;
}

afterEach(() => cleanup());

describe('StageEditor accessibility', () => {
  it('expands a stage via its keyboard-operable toggle and names its controls', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StageEditor stages={[source, destination]} onChange={vi.fn()} />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    const toggle = ui('stage-editor-stage-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // Start at the colour input, which precedes the toggle in tab order.
    screen.getByLabelText('Colour of stage Source').focus();
    await user.tab();
    expect(document.activeElement).toBe(toggle);
    await user.keyboard('{Enter}');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText('Inactive')).toBeTruthy();
    await user.keyboard('{Enter}');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    const row = within(ui('stage-editor-stage'));
    expect(row.getByLabelText('Colour of stage Source')).toBeTruthy();
    expect(row.getByRole('button', { name: /move source down/i })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /move destination up/i }),
    ).toBeTruthy();
    expect(
      row.getByRole('button', { name: /remove stage source/i }),
    ).toBeTruthy();
  });
});

describe('StageEditor id validation', () => {
  it('flags an empty stage id', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StageEditor
          stages={[{ ...source, id: '' }, destination]}
          onChange={vi.fn()}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(ui('stage-editor-stage-toggle'));
    expect(ui('stage-editor-id-invalid-error')).toBeTruthy();
  });
});

describe('StageEditor occupied-stage removal', () => {
  it('keeps the id of an occupied stage when it is retitled', () => {
    const onChange = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StageEditor
          stages={[source, destination]}
          occupancy={[{ stageId: 'source', total: 2, active: 1, archived: 1 }]}
          onChange={onChange}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(ui('stage-editor-stage-toggle'));
    const idInput = document.querySelector<HTMLInputElement>(
      'input[placeholder="stage_id"]',
    )!;
    expect(idInput.disabled).toBe(true);
    expect(ui('stage-editor-id-locked-hint').textContent).toContain('2 cards');
    fireEvent.change(
      document.querySelector('input[placeholder="Stage title"]')!,
      {
        target: { value: 'Renamed' },
      },
    );
    expect(onChange.mock.calls[0][0][0]).toMatchObject({
      id: 'source',
      title: 'Renamed',
    });
  });

  it('derives a new stage id from its title; existing ids change only via the id input', () => {
    function Stateful() {
      const [stages, setStages] = useState([source, destination]);
      return (
        <QueryClientProvider client={new QueryClient()}>
          <StageEditor stages={stages} onChange={setStages} />
        </QueryClientProvider>
      );
    }
    render(<Stateful />);
    const title = () =>
      document.querySelector<HTMLInputElement>(
        'input[placeholder="Stage title"]',
      )!;
    const idInput = () =>
      document.querySelector<HTMLInputElement>(
        'input[placeholder="stage_id"]',
      )!;

    // Existing stage: retitling keeps the id, the id input renames it.
    fireEvent.click(ui('stage-editor-stage-toggle'));
    fireEvent.change(title(), { target: { value: 'Renamed' } });
    expect(idInput().value).toBe('source');
    fireEvent.change(idInput(), { target: { value: 'renamed' } });
    expect(idInput().value).toBe('renamed');

    // New stage: the id follows the title keystroke by keystroke.
    fireEvent.click(screen.getByText(/add stage/i));
    for (const typed of ['C', 'Co', 'Cod', 'Codi', 'Codin', 'Coding']) {
      fireEvent.change(title(), { target: { value: typed } });
    }
    expect(idInput().value).toBe('coding');
  });

  it('never locks or collides a newly added stage with an occupied stage id', () => {
    const worker: StageDefinition = { ...source, id: 'worker', type: 'active' };
    const workerB: StageDefinition = { ...worker, id: 'worker.b' };
    let latest: StageDefinition[] = [];
    function Stateful() {
      const [stages, setStages] = useState([worker, workerB, destination]);
      const [shown, setShown] = useState(true);
      latest = stages;
      return (
        <QueryClientProvider client={new QueryClient()}>
          <button onClick={() => setShown(!shown)}>toggle editor</button>
          {shown && (
            <StageEditor
              stages={stages}
              onChange={setStages}
              occupancy={[
                { stageId: 'worker', total: 1, active: 1, archived: 0 },
              ]}
            />
          )}
        </QueryClientProvider>
      );
    }
    render(<Stateful />);
    fireEvent.click(screen.getByRole('button', { name: /add stage/i }));
    const title = () =>
      document.querySelector<HTMLInputElement>(
        'input[placeholder="Stage title"]',
      )!;
    const idInput = () =>
      document.querySelector<HTMLInputElement>(
        'input[placeholder="stage_id"]',
      )!;
    const typeTitle = (value: string) => {
      for (let i = 1; i <= value.length; i++)
        fireEvent.change(title(), { target: { value: value.slice(0, i) } });
    };

    typeTitle('Worker');
    expect(idInput().disabled).toBe(false);
    expect(idInput().value).toBe('worker_2');
    typeTitle('Worker QA');
    expect(idInput().disabled).toBe(false);
    expect(idInput().value).toBe('worker_qa');

    // A typed id that collides is flagged on the later row.
    fireEvent.change(idInput(), { target: { value: 'worker' } });
    expect(ui('stage-editor-id-duplicate-error').textContent).toBe(
      'Stage ID already used',
    );

    // The added row stays editable after the editor remounts (tab switch).
    const toggle = screen.getByRole('button', { name: /toggle editor/i });
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    fireEvent.click(
      document.querySelectorAll('[data-ui="stage-editor-stage-toggle"]')[2],
    );
    expect(idInput().value).toBe('worker');
    expect(idInput().disabled).toBe(false);

    // Correcting it leaves the saved stage's alternative with the saved stage.
    fireEvent.change(idInput(), { target: { value: 'unique' } });
    expect(latest.map((stage) => stage.id)).toEqual([
      'worker',
      'destination',
      'unique',
      'worker.b',
    ]);

    // The saved occupied stage stays locked.
    fireEvent.click(
      document.querySelectorAll('[data-ui="stage-editor-stage-toggle"]')[0],
    );
    expect(idInput().value).toBe('worker');
    expect(idInput().disabled).toBe(true);
  });

  it("keeps each row's alternatives through chained duplicate renames", () => {
    const active = { ...source, type: 'active' } as const;
    const qa: StageDefinition = { ...active, id: 'qa', title: 'QA' };
    const worker: StageDefinition = { ...active, id: 'worker', title: 'W' };
    const alt = (base: StageDefinition): StageDefinition => ({
      ...base,
      id: `${base.id}.b`,
      title: `${base.title} B`,
    });
    let latest: StageDefinition[] = [];
    function Stateful() {
      const [stages, setStages] = useState([qa, alt(qa), worker, alt(worker)]);
      latest = stages;
      return (
        <QueryClientProvider client={new QueryClient()}>
          <StageEditor stages={stages} onChange={setStages} />
        </QueryClientProvider>
      );
    }
    render(<Stateful />);
    const toggles = () =>
      document.querySelectorAll('[data-ui="stage-editor-stage-toggle"]');
    const idInput = () =>
      document.querySelector<HTMLInputElement>(
        'input[placeholder="stage_id"]',
      )!;
    const setId = (row: number, id: string) => {
      const toggle = toggles()[row];
      if (toggle.getAttribute('aria-expanded') === 'false')
        fireEvent.click(toggle);
      fireEvent.change(idInput(), { target: { value: id } });
    };
    const alternatives = () =>
      Object.fromEntries(
        latest
          .filter((stage) => stage.id.endsWith('.b'))
          .map((stage) => [stage.id, stage.title]),
      );

    setId(1, 'build');
    expect(alternatives()).toEqual({ 'qa.b': 'QA B', 'build.b': 'W B' });
    setId(0, 'build');
    expect(alternatives()).toEqual({});
    expect(
      document.querySelector('[data-ui="stage-editor-alternatives"]'),
    ).toBeNull();
    setId(0, 'unique');
    expect(alternatives()).toEqual({ 'unique.b': 'QA B', 'build.b': 'W B' });
  });

  it("does not carry a cancelled draft's parked alternatives into the next draft", () => {
    const active = { ...source, type: 'active' } as const;
    const qa: StageDefinition = { ...active, id: 'qa', title: 'QA' };
    const worker: StageDefinition = { ...active, id: 'worker', title: 'W' };
    const workerB: StageDefinition = { ...worker, id: 'worker.b', title: 'B1' };
    const saved = [qa, worker, workerB];
    let latest: StageDefinition[] = [];
    function Draft({ initial }: { initial: StageDefinition[] }) {
      const [stages, setStages] = useState(initial);
      latest = stages;
      return (
        <QueryClientProvider client={new QueryClient()}>
          <StageEditor stages={stages} onChange={setStages} />
        </QueryClientProvider>
      );
    }
    const first = render(<Draft initial={saved} />);
    fireEvent.click(
      document.querySelectorAll('[data-ui="stage-editor-stage-toggle"]')[0],
    );
    fireEvent.change(document.querySelector('input[placeholder="stage_id"]')!, {
      target: { value: 'worker' },
    });
    first.unmount(); // cancelled: the next draft starts from the saved rows

    // The reopened draft has an edited alternative; retitling must keep it.
    render(<Draft initial={[qa, worker, { ...workerB, title: 'B2' }]} />);
    fireEvent.click(
      document.querySelectorAll('[data-ui="stage-editor-stage-toggle"]')[1],
    );
    fireEvent.change(
      document.querySelector('input[placeholder="Stage title"]')!,
      { target: { value: 'Worker 2' } },
    );
    expect(latest.find((stage) => stage.id === 'worker.b')?.title).toBe('B2');
  });

  it('requires an intentional destination and records the selected migration', async () => {
    const onChange = vi.fn();
    const onMigrationsChange = vi.fn();
    render(
      <StageEditor
        stages={[source, destination]}
        occupancy={[{ stageId: 'source', total: 2, active: 1, archived: 1 }]}
        onChange={onChange}
        onStageMigrationsChange={onMigrationsChange}
      />,
    );

    fireEvent.click(ui('stage-editor-remove'));
    expect(ui('stage-removal-dialog')).toBeTruthy();
    expect(selectedLabel(ui('stage-removal-destination'))).toBe(
      'Choose a destination stage',
    );
    fireEvent.click(ui('stage-removal-confirm'));
    expect(ui('stage-removal-error').textContent).toContain(
      'Choose a destination stage',
    );
    expect(ui('stage-removal-error').getAttribute('role')).toBe('alert');
    expect(ui('stage-removal-destination').getAttribute('aria-invalid')).toBe(
      'true',
    );
    expect(onChange).not.toHaveBeenCalled();

    await chooseOption(ui('stage-removal-destination'), 'Destination');
    expect(
      document.querySelector('[data-ui="stage-removal-error"]'),
    ).toBeNull();
    fireEvent.click(ui('stage-removal-confirm'));
    expect(onChange).toHaveBeenCalledWith([destination]);
    expect(onMigrationsChange).toHaveBeenLastCalledWith([
      { sourceStageId: 'source', destinationStageId: 'destination' },
    ]);
  });

  it('keeps the draft unchanged when the chooser is cancelled', () => {
    const onChange = vi.fn();
    render(
      <StageEditor
        stages={[source, destination]}
        occupancy={[{ stageId: 'source', total: 1, active: 1, archived: 0 }]}
        onChange={onChange}
      />,
    );
    fireEvent.click(ui('stage-editor-remove'));
    fireEvent.click(ui('stage-removal-cancel'));
    expect(onChange).not.toHaveBeenCalled();
    expect(ui('stage-editor-stage').getAttribute('data-stage-id')).toBe(
      'source',
    );
  });

  it('disables removal while occupancy is loading or unavailable', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <StageEditor
        stages={[source, destination]}
        occupancyStatus="loading"
        onChange={onChange}
      />,
    );
    expect((ui('stage-editor-remove') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(ui('stage-occupancy-status').textContent).toContain(
      'Checking stage card usage',
    );

    rerender(
      <StageEditor
        stages={[source, destination]}
        occupancyStatus="error"
        onChange={onChange}
      />,
    );
    expect((ui('stage-editor-remove') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(ui('stage-occupancy-status').textContent).toContain(
      'Could not check stage card usage',
    );
  });

  it('queues every occupied stage in a reset and limits destinations to the target pipeline', async () => {
    const second: StageDefinition = {
      ...source,
      id: 'second',
      title: 'Second',
    };
    const onChange = vi.fn();
    const onMigrationsChange = vi.fn();
    render(
      <StageEditor
        stages={[source, second, destination]}
        resetStages={[destination]}
        occupancy={[
          { stageId: 'source', total: 1, active: 1, archived: 0 },
          { stageId: 'second', total: 1, active: 1, archived: 0 },
        ]}
        onChange={onChange}
        onStageMigrationsChange={onMigrationsChange}
      />,
    );
    fireEvent.click(document.querySelector('button')!);
    fireEvent.keyDown(ui('stage-removal-destination'), { key: 'Enter' });
    const listed = await screen.findAllByRole('option');
    expect(listed).toHaveLength(2);
    expect(listed.map((option) => option.textContent)).toEqual([
      'Choose a destination stage',
      'Destination',
    ]);
    fireEvent.keyDown(listed[0]!, { key: 'Escape' });
    await chooseOption(ui('stage-removal-destination'), 'Destination');
    fireEvent.click(ui('stage-removal-confirm'));
    expect(ui('stage-removal-dialog')).toBeTruthy();
    expect(
      ui('stage-removal-destination').getAttribute('data-source-stage-id'),
    ).toBe('second');
    await chooseOption(ui('stage-removal-destination'), 'Destination');
    fireEvent.click(ui('stage-removal-confirm'));
    expect(onChange).toHaveBeenCalledWith([destination]);
    expect(onMigrationsChange).toHaveBeenLastCalledWith([
      { sourceStageId: 'source', destinationStageId: 'destination' },
      { sourceStageId: 'second', destinationStageId: 'destination' },
    ]);
  });

  it('does not publish a partial migration when a queued removal is cancelled', async () => {
    const second: StageDefinition = { ...source, id: 'second' };
    const onChange = vi.fn();
    const onMigrationsChange = vi.fn();
    render(
      <StageEditor
        stages={[source, second, destination]}
        resetStages={[destination]}
        occupancy={[
          { stageId: 'source', total: 1, active: 1, archived: 0 },
          { stageId: 'second', total: 1, active: 1, archived: 0 },
        ]}
        onChange={onChange}
        onStageMigrationsChange={onMigrationsChange}
      />,
    );
    fireEvent.click(document.querySelector('button')!);
    await chooseOption(ui('stage-removal-destination'), 'Destination');
    fireEvent.click(ui('stage-removal-confirm'));
    fireEvent.click(ui('stage-removal-cancel'));
    expect(onMigrationsChange).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reopens a migration when its destination is removed in a later delete', async () => {
    const other: StageDefinition = {
      ...destination,
      id: 'other',
      title: 'Other',
    };
    function SequentialDeleteHarness() {
      const [stages, setStages] = useState([source, destination, other]);
      const [migrations, setMigrations] = useState<StageMigration[]>([
        { sourceStageId: 'source', destinationStageId: 'destination' },
      ]);
      return (
        <>
          <button
            data-ui="simulate-first-confirm"
            onClick={() => setStages([destination, other])}
          />
          <StageEditor
            stages={stages}
            occupancy={[
              { stageId: 'source', total: 1, active: 1, archived: 0 },
              { stageId: 'destination', total: 0, active: 0, archived: 0 },
            ]}
            stageMigrations={migrations}
            onChange={setStages}
            onStageMigrationsChange={setMigrations}
          />
          <output data-ui="sequential-migrations">
            {JSON.stringify(migrations)}
          </output>
        </>
      );
    }
    render(<SequentialDeleteHarness />);
    fireEvent.click(ui('simulate-first-confirm'));

    fireEvent.click(ui('stage-editor-remove'));
    expect(ui('stage-removal-dialog')).toBeTruthy();
    expect(
      ui('stage-removal-destination').getAttribute('data-source-stage-id'),
    ).toBe('source');
    await chooseOption(ui('stage-removal-destination'), 'Other');
    fireEvent.click(ui('stage-removal-confirm'));

    expect(ui('stage-editor-stage').getAttribute('data-stage-id')).toBe(
      'other',
    );
    expect(ui('sequential-migrations').textContent).toContain(
      '"destinationStageId":"other"',
    );
  });

  it('consumes conflict recovery once so cancelling does not reopen the chooser', () => {
    function RecoveryHarness() {
      const [openId, setOpenId] = useState<string | undefined>('source');
      const [cancelled, setCancelled] = useState(false);
      return (
        <>
          <StageEditor
            stages={[source, destination]}
            occupancy={[
              { stageId: 'source', total: 1, active: 1, archived: 0 },
            ]}
            openRemovalStageId={openId}
            onRemovalStageConsumed={() => setOpenId(undefined)}
            onRemovalCancelled={() => setCancelled(true)}
            onChange={vi.fn()}
          />
          {cancelled && <output data-ui="recovery-cancelled">cancelled</output>}
        </>
      );
    }
    render(<RecoveryHarness />);
    expect(ui('stage-removal-dialog')).toBeTruthy();
    fireEvent.click(ui('stage-removal-cancel'));
    expect(ui('recovery-cancelled').textContent).toBe('cancelled');
    expect(
      document.querySelector('[data-ui="stage-removal-dialog"]'),
    ).toBeNull();
  });

  it('does not restore a pre-conflict pipeline after confirming then cancelling another removal', async () => {
    function RecoveryThenCancelHarness() {
      const other: StageDefinition = {
        ...destination,
        id: 'other',
        title: 'Other',
      };
      const [stages, setStages] = useState([source, destination, other]);
      const [recoveryArmed, setRecoveryArmed] = useState(true);
      return (
        <StageEditor
          stages={stages}
          occupancy={[
            { stageId: 'source', total: 1, active: 1, archived: 0 },
            { stageId: 'destination', total: 1, active: 1, archived: 0 },
            { stageId: 'other', total: 0, active: 0, archived: 0 },
          ]}
          onChange={setStages}
          onRemovalApplied={() => setRecoveryArmed(false)}
          onRemovalCancelled={() => {
            if (recoveryArmed) setStages([source, destination]);
          }}
        />
      );
    }
    render(<RecoveryThenCancelHarness />);
    fireEvent.click(ui('stage-editor-remove'));
    await chooseOption(ui('stage-removal-destination'), 'Destination');
    fireEvent.click(ui('stage-removal-confirm'));
    fireEvent.click(ui('stage-editor-remove'));
    fireEvent.click(ui('stage-removal-cancel'));
    expect(ui('stage-editor-stage').getAttribute('data-stage-id')).toBe(
      'destination',
    );
  });
});

describe('StageEditor stage alternatives', () => {
  const activeDestination: StageDefinition = {
    ...destination,
    type: 'active',
  };
  const alternative: StageDefinition = {
    id: 'destination.b',
    title: 'Destination B',
    type: 'active',
    color: '#123456',
    runtimeSelection: { harnessId: 'codex', modelId: 'b-model' },
  };

  it('hides alternatives from rows and removal destinations, and keeps them on save', async () => {
    const onChange = vi.fn();
    render(
      <StageEditor
        stages={[source, activeDestination, alternative]}
        occupancy={[{ stageId: 'source', total: 1, active: 1, archived: 0 }]}
        onChange={onChange}
      />,
    );
    const rowIds = Array.from(
      document.querySelectorAll('[data-ui="stage-editor-stage"]'),
    ).map((row) => row.getAttribute('data-stage-id'));
    expect(rowIds).toEqual(['source', 'destination']);

    fireEvent.click(
      document.querySelectorAll<HTMLElement>(
        '[data-ui="stage-editor-remove"]',
      )[0],
    );
    fireEvent.keyDown(ui('stage-removal-destination'), { key: 'Enter' });
    const listed = await screen.findAllByRole('option');
    expect(listed.map((option) => option.textContent)).toEqual([
      'Choose a destination stage',
      'Destination',
    ]);
    fireEvent.keyDown(listed[0]!, { key: 'Escape' });

    await chooseOption(ui('stage-removal-destination'), 'Destination');
    fireEvent.click(ui('stage-removal-confirm'));
    expect(onChange).toHaveBeenCalledWith([activeDestination, alternative]);
  });
});

describe('StageEditor alternative rows', () => {
  const coding: StageDefinition = {
    id: 'coding',
    title: 'Coding',
    type: 'active',
    color: '#3b82f6',
  };
  const codingB: StageDefinition = {
    id: 'coding.b',
    title: 'Coding B',
    type: 'active',
    color: '#3b82f6',
  };

  /** Keeps the edited list like the settings dialog does. */
  function Harness({
    initial,
    onChange,
  }: {
    initial: StageDefinition[];
    onChange: (stages: StageDefinition[]) => void;
  }) {
    const [stages, setStages] = useState(initial);
    return (
      <QueryClientProvider client={new QueryClient()}>
        <StageEditor
          stages={stages}
          onChange={(next) => {
            onChange(next);
            setStages(next);
          }}
        />
      </QueryClientProvider>
    );
  }

  const ids = (onChange: ReturnType<typeof vi.fn>) =>
    (onChange.mock.lastCall![0] as StageDefinition[]).map((stage) => stage.id);

  it('adds the next free suffix, only under executable stages', () => {
    const onChange = vi.fn();
    render(<Harness initial={[source, coding, codingB]} onChange={onChange} />);
    expect(
      Array.from(
        document.querySelectorAll('[data-ui="stage-alternative-add"]'),
      ).map((button) => button.getAttribute('data-stage-id')),
    ).toEqual(['coding']);

    fireEvent.click(ui('stage-alternative-add'));
    expect(ids(onChange)).toEqual(['source', 'coding', 'coding.b', 'coding.c']);
    expect(
      document.querySelectorAll('[data-ui="stage-editor-alternative"]'),
    ).toHaveLength(2);
  });

  it('validates an edited suffix like the server and only commits valid ones', () => {
    const onChange = vi.fn();
    render(
      <Harness
        initial={[coding, { ...codingB, id: 'coding.c' }, codingB]}
        onChange={onChange}
      />,
    );
    fireEvent.click(ui('stage-alternative-header'));
    const suffix = ui('stage-alternative-suffix');

    fireEvent.change(suffix, { target: { value: 'a' } });
    expect(ui('stage-alternative-suffix-error').textContent).toContain(
      'reserved',
    );
    fireEvent.change(suffix, { target: { value: 'b' } });
    expect(ui('stage-alternative-suffix-error').textContent).toContain(
      'already exists',
    );
    fireEvent.change(suffix, { target: { value: '9x' } });
    expect(ui('stage-alternative-suffix-error').textContent).toContain(
      'starting with a letter',
    );
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(suffix, { target: { value: 'fast' } });
    fireEvent.blur(suffix);
    expect(ids(onChange)).toEqual(['coding', 'coding.fast', 'coding.b']);
    expect(
      document.querySelector('[data-ui="stage-alternative-suffix-error"]'),
    ).toBeNull();
  });

  it('removes an alternative without touching its base stage', () => {
    const onChange = vi.fn();
    render(<Harness initial={[coding, codingB]} onChange={onChange} />);
    fireEvent.click(ui('stage-alternative-remove'));
    expect(ids(onChange)).toEqual(['coding']);
    expect(
      document.querySelector('[data-ui="stage-editor-alternative"]'),
    ).toBeNull();
  });
});
