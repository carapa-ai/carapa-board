import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StageAlternatives } from './stage-alternatives';
import type { StageDefinition } from '@/types';

const coding: StageDefinition = {
  id: 'coding',
  title: 'Coding',
  type: 'active',
  color: '#2266ff',
};
const codingB: StageDefinition = { ...coding, id: 'coding.b' };

function ui(name: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-ui="${name}"]`);
  if (!element) throw new Error(`Missing UI marker: ${name}`);
  return element;
}

function Harness({
  onInvalidChange,
}: {
  onInvalidChange: (baseId: string, invalid: boolean) => void;
}) {
  const [stages, setStages] = useState<StageDefinition[]>([coding, codingB]);
  return (
    <QueryClientProvider client={new QueryClient()}>
      <StageAlternatives
        base={coding}
        stages={stages}
        onChange={setStages}
        onInvalidChange={onInvalidChange}
      />
    </QueryClientProvider>
  );
}

afterEach(() => cleanup());

describe('StageAlternatives', () => {
  it('keeps the raw suffix draft and only renames the stage on commit', () => {
    const onInvalidChange = vi.fn();
    render(<Harness onInvalidChange={onInvalidChange} />);
    fireEvent.click(ui('stage-alternative-header'));
    const suffix = ui('stage-alternative-suffix') as HTMLInputElement;

    // Invalid characters are kept (never stripped) and block Save.
    fireEvent.change(suffix, { target: { value: 'bad/1' } });
    expect(suffix.value).toBe('bad/1');
    expect(ui('stage-alternative-suffix-error')).toBeTruthy();
    expect(onInvalidChange).toHaveBeenLastCalledWith('coding', true);
    expect(ui('stage-alternative-header').textContent).toContain('coding.b');

    // Leaving the field reverts to the committed suffix.
    fireEvent.blur(suffix);
    expect(suffix.value).toBe('b');
    expect(onInvalidChange).toHaveBeenLastCalledWith('coding', false);

    // A valid draft is unconfirmed until committed, then renames the stage.
    fireEvent.change(suffix, { target: { value: 'fast' } });
    expect(onInvalidChange).toHaveBeenLastCalledWith('coding', true);
    expect(ui('stage-alternative-header').textContent).toContain('coding.b');
    fireEvent.keyDown(suffix, { key: 'Enter' });
    expect(onInvalidChange).toHaveBeenLastCalledWith('coding', false);
    expect(ui('stage-alternative-header').textContent).toContain('coding.fast');
  });

  it('opens its overrides from a keyboard-operable header button', () => {
    render(<Harness onInvalidChange={vi.fn()} />);
    const header = ui('stage-alternative-header');
    expect(header.tagName).toBe('BUTTON');
    expect(header.getAttribute('type')).toBe('button');
    expect(header.getAttribute('aria-expanded')).toBe('false');

    // A native button turns Enter and Space into clicks; verify the toggle.
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(ui('stage-alternative-suffix')).toBeTruthy();
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
  });
});
