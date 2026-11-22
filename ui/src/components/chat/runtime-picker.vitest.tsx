import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { RuntimeCatalog, RuntimeSelection } from '@/lib/api';
import { RuntimePicker } from './runtime-picker';

const catalog: RuntimeCatalog = {
  version: 2,
  harnesses: [
    { id: 'claude', label: 'Claude', kind: 'cli', sessionFamily: 'claude' },
    { id: 'codex', label: 'Codex', kind: 'cli', sessionFamily: 'codex' },
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
        {
          harnessId: 'codex',
          runtimeId: 'codex:sonnet',
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

const claudeValue: RuntimeSelection = {
  harnessId: 'claude',
  modelId: 'sonnet',
};
const codexValue: RuntimeSelection = { harnessId: 'codex', modelId: 'sonnet' };

function renderPicker(props: Partial<ComponentProps<typeof RuntimePicker>>) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <RuntimePicker
        catalog={catalog}
        value={claudeValue}
        onChange={vi.fn()}
        presentation="panel"
        {...props}
      />
    </QueryClientProvider>,
  );
}

beforeAll(() => {
  // jsdom does not implement scrollIntoView; the model list calls it for the selected model.
  Element.prototype.scrollIntoView = vi.fn();
});

afterAll(() => {
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

afterEach(() => {
  cleanup();
});

describe('RuntimePicker prompt cache toggle', () => {
  it('renders the toggle for a Claude harness when both props are given', () => {
    renderPicker({ promptCache1h: false, onPromptCache1hChange: vi.fn() });

    const toggle = screen.getByRole('button', { name: '5-minute cache' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText('Applies from the next message.')).toBeTruthy();
  });

  it('calls the callback with the inverted value when clicked', () => {
    const onChange = vi.fn();
    renderPicker({ promptCache1h: false, onPromptCache1hChange: onChange });

    fireEvent.click(screen.getByRole('button', { name: '5-minute cache' }));

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('shows the 1-hour state when the stored value is on', () => {
    renderPicker({ promptCache1h: true, onPromptCache1hChange: vi.fn() });

    expect(
      screen
        .getByRole('button', { name: '1-hour cache' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('stays hidden without the callback, without the value, or for a non-Claude harness', () => {
    const { unmount } = renderPicker({ promptCache1h: false });
    expect(screen.queryByRole('button', { name: '5-minute cache' })).toBeNull();
    unmount();

    const { unmount: unmountNoValue } = renderPicker({
      onPromptCache1hChange: vi.fn(),
    });
    expect(screen.queryByRole('button', { name: '5-minute cache' })).toBeNull();
    unmountNoValue();

    renderPicker({
      value: codexValue,
      promptCache1h: false,
      onPromptCache1hChange: vi.fn(),
    });
    expect(screen.queryByRole('button', { name: '5-minute cache' })).toBeNull();
  });
});
