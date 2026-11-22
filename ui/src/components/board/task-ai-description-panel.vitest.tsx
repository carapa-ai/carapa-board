import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskAiDescriptionPanel } from './task-ai-description-panel';

const draft = vi.hoisted(() => vi.fn());

// The panel is the only importer of `@/lib/api` in this file's module graph,
// so a synchronous minimal mock is safe here and avoids the async
// `importOriginal` factory racing with the test file's own imports.
vi.mock('@/lib/api', () => ({
  draftTaskDescription: draft,
}));

const IDLE_PLACEHOLDER = 'e.g. add acceptance criteria, tighten the scope';
const REFINE_PLACEHOLDER = 'Refine the draft, e.g. make it shorter';

interface PanelOverrides {
  projectId?: string;
  taskId?: string;
  currentDescription?: string;
  isRunning?: boolean;
  isUpdatePending?: boolean;
  onApply?: (draft: string) => Promise<void>;
  onClose?: () => void;
  onOpenInChat?: () => void;
}

/**
 * Harness mirroring the dialog: the panel unmounts when onClose fires, which
 * is how the dialog mounts it (`{isAiEditOpen && <Panel ... />}`).
 */
function renderPanel(overrides: PanelOverrides = {}) {
  function Harness() {
    const [open, setOpen] = useState(true);
    if (!open) return null;
    return (
      <TaskAiDescriptionPanel
        projectId={overrides.projectId ?? 'proj-1'}
        taskId={overrides.taskId ?? 'task-1'}
        currentDescription={overrides.currentDescription ?? 'Current text'}
        isRunning={overrides.isRunning ?? false}
        isUpdatePending={overrides.isUpdatePending ?? false}
        onApply={overrides.onApply ?? (async () => {})}
        onClose={() => {
          overrides.onClose?.();
          setOpen(false);
        }}
        onOpenInChat={overrides.onOpenInChat ?? (() => {})}
      />
    );
  }
  return render(<Harness />);
}

function panelRoot(): HTMLElement {
  const root = document.querySelector<HTMLElement>(
    '[data-ui="task-ai-description"]',
  );
  if (!root) throw new Error('panel root missing');
  return root;
}

function panelState(): string | null {
  return panelRoot().getAttribute('data-state');
}

function submitInstruction(text: string) {
  const input = screen.getByPlaceholderText(IDLE_PLACEHOLDER);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

function submitRefine(text: string) {
  const input = screen.getByPlaceholderText(REFINE_PLACEHOLDER);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

afterEach(() => {
  cleanup();
  draft.mockReset();
});

describe('TaskAiDescriptionPanel', () => {
  it('shows a loading state while the draft is generated, then renders the proposal preview', async () => {
    let resolveDraft: (value: { draft: string }) => void = () => {};
    draft.mockReturnValueOnce(
      new Promise<{ draft: string }>((resolve) => {
        resolveDraft = resolve;
      }),
    );

    renderPanel({ taskId: 'task-42' });

    const root = panelRoot();
    expect(root.getAttribute('data-task-id')).toBe('task-42');
    expect(root.getAttribute('data-state')).toBe('idle');

    submitInstruction('add acceptance criteria');

    expect(panelState()).toBe('loading');
    expect(
      document.querySelector('[data-ui="task-ai-description-loading"]'),
    ).not.toBeNull();
    // The input is hidden while loading so a second request cannot start.
    expect(screen.queryByPlaceholderText(IDLE_PLACEHOLDER)).toBeNull();
    expect(draft).toHaveBeenCalledTimes(1);
    expect(draft).toHaveBeenCalledWith(
      'proj-1',
      'task-42',
      'add acceptance criteria',
      undefined,
    );

    resolveDraft({ draft: '**Proposed** draft' });

    await waitFor(() => expect(panelState()).toBe('preview'));
    const draftArea = document.querySelector(
      '[data-ui="task-ai-description-draft"]',
    );
    expect(draftArea?.textContent).toContain('Proposed draft');
    const currentArea = document.querySelector(
      '[data-ui="task-ai-description-current"]',
    );
    expect(currentArea?.textContent).toContain('Current text');
  });

  it('disables every discard and close control while applying', async () => {
    let resolveApply: () => void = () => {};
    draft.mockResolvedValueOnce({ draft: 'Draft text' });
    const onApply = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveApply = resolve;
        }),
    );
    const onClose = vi.fn();

    renderPanel({ onApply, onClose });
    submitInstruction('rewrite');
    await waitFor(() => expect(panelState()).toBe('preview'));

    const close = screen.getByRole('button', {
      name: 'Close AI edit panel',
    }) as HTMLButtonElement;
    const discard = screen.getByRole('button', {
      name: 'Discard',
    }) as HTMLButtonElement;
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(close.disabled).toBe(true);
    expect(discard.disabled).toBe(true);
    fireEvent.click(close);
    fireEvent.click(discard);
    expect(onClose).not.toHaveBeenCalled();

    resolveApply();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('keeps the preview and offers a retry when applying fails', async () => {
    draft.mockResolvedValueOnce({ draft: 'Draft text' });
    const onApply = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('Could not update task: task is running'),
      )
      .mockResolvedValueOnce(undefined);
    const onClose = vi.fn();

    renderPanel({ onApply, onClose });
    submitInstruction('rewrite');

    await waitFor(() => expect(panelState()).toBe('preview'));

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-ui="task-ai-description-apply-error-message"]',
        )?.textContent,
      ).toContain('Could not update task: task is running'),
    );
    // The generated draft survives the failed PATCH: the panel and its
    // preview are still mounted with the draft text intact.
    expect(panelState()).toBe('preview');
    expect(
      document.querySelector('[data-ui="task-ai-description-draft"]')
        ?.textContent,
    ).toContain('Draft text');
    expect(onClose).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-ui="task-ai-description"]'),
    ).not.toBeNull();

    const applyError = document.querySelector<HTMLElement>(
      '[data-ui="task-ai-description-apply-error"]',
    )!;
    fireEvent.click(within(applyError).getByRole('button', { name: 'Retry' }));

    expect(onApply).toHaveBeenCalledTimes(2);
    expect(onApply).toHaveBeenLastCalledWith('Draft text');
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        document.querySelector('[data-ui="task-ai-description"]'),
      ).toBeNull(),
    );
  });

  it('sends accumulated instruction/draft pairs as history on each refine turn', async () => {
    draft
      .mockResolvedValueOnce({ draft: 'D0' })
      .mockResolvedValueOnce({ draft: 'D1' })
      .mockResolvedValueOnce({ draft: 'D2' });

    renderPanel();
    submitInstruction('I0');
    await waitFor(() => expect(panelState()).toBe('preview'));

    submitRefine('I1');
    await waitFor(() => expect(draft).toHaveBeenCalledTimes(2));
    expect(draft).toHaveBeenNthCalledWith(
      1,
      'proj-1',
      'task-1',
      'I0',
      undefined,
    );
    expect(draft).toHaveBeenNthCalledWith(2, 'proj-1', 'task-1', 'I1', [
      { instruction: 'I0', draft: 'D0' },
    ]);

    await waitFor(() =>
      expect(
        document.querySelector('[data-ui="task-ai-description-draft"]')
          ?.textContent,
      ).toContain('D1'),
    );

    submitRefine('I2');
    await waitFor(() => expect(draft).toHaveBeenCalledTimes(3));
    expect(draft).toHaveBeenNthCalledWith(3, 'proj-1', 'task-1', 'I2', [
      { instruction: 'I0', draft: 'D0' },
      { instruction: 'I1', draft: 'D1' },
    ]);
  });

  it('keeps the typed instruction and offers a retry on failure', async () => {
    // The api layer surfaces backend 502s as `Error` with the backend message
    // (covered by the api tests); the panel only needs an Error to handle.
    draft
      .mockRejectedValueOnce(
        new Error('Could not generate a description draft: llm down'),
      )
      .mockResolvedValueOnce({ draft: 'Recovered draft' });

    renderPanel();
    submitInstruction('make it shorter');

    await waitFor(() => expect(panelState()).toBe('error'));
    expect(
      document.querySelector('[data-ui="task-ai-description-error-message"]')
        ?.textContent,
    ).toContain('Could not generate a description draft: llm down');
    // The instruction the user typed survives the failure.
    expect(
      (screen.getByPlaceholderText(IDLE_PLACEHOLDER) as HTMLInputElement).value,
    ).toBe('make it shorter');

    draft.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(draft).toHaveBeenCalledTimes(1);
    expect(draft).toHaveBeenCalledWith(
      'proj-1',
      'task-1',
      'make it shorter',
      undefined,
    );

    await waitFor(() => expect(panelState()).toBe('preview'));
    expect(
      document.querySelector('[data-ui="task-ai-description-draft"]')
        ?.textContent,
    ).toContain('Recovered draft');
  });
});
