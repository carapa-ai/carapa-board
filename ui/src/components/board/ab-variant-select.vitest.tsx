import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AbVariantSelect } from './ab-variant-select';

afterEach(() => cleanup());

function renderSelect(
  props: Partial<React.ComponentProps<typeof AbVariantSelect>> = {},
) {
  const onChange = vi.fn();
  const view = render(
    <AbVariantSelect
      suffixes={['b', 'c']}
      selected={[]}
      onChange={onChange}
      stageType="queue"
      checkoutMode="worktree"
      hasTaskRuntime={false}
      {...props}
    />,
  );
  return { onChange, ...view };
}

const root = () => document.querySelector('[data-ui="ab-variant-select"]');
const option = (variant: string) =>
  document.querySelector<HTMLElement>(
    `[data-ui="ab-variant-option"][data-variant="${variant}"] button`,
  )!;
const ui = (name: string) =>
  document.querySelector<HTMLElement>(`[data-ui="${name}"]`);

describe('AbVariantSelect', () => {
  it('offers A plus every configured suffix and reports the selection', () => {
    const { onChange } = renderSelect({ selected: ['a'] });
    expect(
      Array.from(
        document.querySelectorAll('[data-ui="ab-variant-option"]'),
      ).map((el) => el.textContent),
    ).toEqual(['A', 'B', 'C']);
    fireEvent.click(option('b'));
    expect(onChange).toHaveBeenCalledWith(['a', 'b']);
    fireEvent.click(option('a'));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('is shown only in a queue stage before the fork, and when alternatives exist', () => {
    renderSelect({ stageType: 'active' });
    expect(root()).toBeNull();
    cleanup();
    renderSelect({ forked: true });
    expect(root()).toBeNull();
    cleanup();
    renderSelect({ suffixes: [] });
    expect(root()).toBeNull();
    cleanup();
    renderSelect();
    expect(root()).not.toBeNull();
  });

  it('keeps a single choice with the reason outside worktree checkout mode', () => {
    const { onChange } = renderSelect({
      checkoutMode: 'shared',
      selected: ['b'],
    });
    expect(ui('ab-variant-select-reason')?.textContent).toContain('worktree');
    for (const variant of ['a', 'b', 'c']) {
      expect(option(variant).hasAttribute('disabled')).toBe(false);
    }
    fireEvent.click(option('c'));
    expect(onChange).toHaveBeenLastCalledWith(['c']);
    fireEvent.click(option('b'));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('describes a single non-A variant and warns about a task-level runtime', () => {
    renderSelect({ selected: ['a'], hasTaskRuntime: true });
    expect(ui('ab-variant-runtime-warning')).toBeNull();
    expect(ui('ab-variant-select-hint')).toBeNull();
    cleanup();
    renderSelect({ selected: ['b'], hasTaskRuntime: true });
    expect(ui('ab-variant-select-hint')?.textContent).toContain('variant B');
    expect(ui('ab-variant-runtime-warning')?.textContent).toContain(
      'overrides stage alternatives',
    );
    cleanup();
    renderSelect({ selected: ['a', 'b'], hasTaskRuntime: true });
    expect(ui('ab-variant-select-hint')).toBeNull();
    expect(ui('ab-variant-runtime-warning')).not.toBeNull();
  });
});
