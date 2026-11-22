import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { initialize, parse, run } = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn(),
  run: vi.fn(),
}));

vi.mock('mermaid', () => ({ default: { initialize, parse, run } }));

import { MarkdownContent } from './markdown-content';

const BAD = 'graph TD; BAD';
const fence = (code: string) => '```mermaid\n' + code + '\n```';

async function settle() {
  await act(async () => {
    await vi.runAllTimersAsync();
  });
}

describe('MarkdownContent mermaid fences', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    initialize.mockReset();
    parse.mockReset();
    run.mockReset();
    parse.mockImplementation(async (text: string) => {
      if (text.includes('BAD')) throw new Error('parse error');
      return { diagramType: 'flowchart' };
    });
    run.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders valid code after an earlier parse failure', async () => {
    const { rerender } = render(
      <MarkdownContent>{fence(BAD)}</MarkdownContent>,
    );
    await settle();
    expect(screen.getByText('Mermaid diagram failed to render')).toBeTruthy();

    rerender(<MarkdownContent>{fence('graph TD; B-->C')}</MarkdownContent>);
    await settle();
    expect(screen.queryByText('Mermaid diagram failed to render')).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
    const el = run.mock.calls[0][0].nodes[0] as HTMLElement;
    expect(el.textContent).toContain('B-->C');
  });

  it('re-runs mermaid when a rendered diagram changes', async () => {
    const { rerender } = render(
      <MarkdownContent>{fence('graph TD; A-->B')}</MarkdownContent>,
    );
    await settle();
    expect(run).toHaveBeenCalledTimes(1);

    rerender(<MarkdownContent>{fence('graph TD; B-->C')}</MarkdownContent>);
    await settle();
    expect(run).toHaveBeenCalledTimes(2);
    const el = run.mock.calls[1][0].nodes[0] as HTMLElement;
    expect(el.textContent).toContain('B-->C');
  });

  it('debounces rapid changes to the last code', async () => {
    const { rerender } = render(
      <MarkdownContent>{fence('graph TD; A')}</MarkdownContent>,
    );
    rerender(<MarkdownContent>{fence('graph TD; A-->B')}</MarkdownContent>);
    rerender(<MarkdownContent>{fence('graph TD; A-->B-->C')}</MarkdownContent>);
    await settle();
    expect(parse).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledWith(expect.stringContaining('A-->B-->C'));
    expect(run).toHaveBeenCalledTimes(1);
  });
});
