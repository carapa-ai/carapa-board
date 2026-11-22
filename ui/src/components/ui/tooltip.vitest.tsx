import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Tooltip, TooltipProvider } from './tooltip';
import { useRef } from 'react';

function Item({ label, clipped }: { label: string; clipped: boolean }) {
  const textRef = useRef<HTMLSpanElement>(null);
  return (
    <Tooltip content={`full ${label}`} whenClipped={textRef} side="right">
      <button type="button" data-testid={label}>
        <span
          ref={(el) => {
            textRef.current = el;
            if (!el) return;
            Object.defineProperty(el, 'clientWidth', {
              configurable: true,
              value: 100,
            });
            Object.defineProperty(el, 'scrollWidth', {
              configurable: true,
              value: clipped ? 200 : 100,
            });
          }}
        >
          {label}
        </span>
      </button>
    </Tooltip>
  );
}

const shown = () => document.querySelector('[data-slot="tooltip-content"]');
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe('Tooltip open delay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  function setup() {
    const view = render(
      <TooltipProvider>
        <Item label="visible" clipped={false} />
        <Item label="cut" clipped />
        <Item label="cut2" clipped />
      </TooltipProvider>,
    );
    return {
      visible: view.getByTestId('visible'),
      cut: view.getByTestId('cut'),
      cut2: view.getByTestId('cut2'),
    };
  }

  it('shows nothing for text that is not clipped and keeps the delay for the next trigger', () => {
    const { visible, cut } = setup();
    fireEvent.pointerMove(visible);
    advance(1000);
    expect(shown()).toBeNull();
    fireEvent.pointerLeave(visible);
    advance(1000);

    fireEvent.pointerMove(cut);
    advance(100);
    expect(shown()).toBeNull();
    advance(450);
    expect(shown()?.textContent).toContain('full cut');
  });

  it('re-arms the skip delay when a press on the trigger closes an open tooltip', () => {
    const registered: string[] = [];
    const addListener = document.addEventListener.bind(document);
    vi.spyOn(document, 'addEventListener').mockImplementation(
      (type: string, ...rest: [any, any?]) => {
        registered.push(type);
        return addListener(type, ...rest);
      },
    );
    const dispatched: string[] = [];
    const dispatch = document.dispatchEvent.bind(document);
    vi.spyOn(document, 'dispatchEvent').mockImplementation((event: Event) => {
      dispatched.push(event.type);
      return dispatch(event);
    });

    const { cut, cut2 } = setup();
    fireEvent.pointerMove(cut);
    advance(600);
    expect(shown()).not.toBeNull();
    // An open tooltip listens for Radix's close event; if Radix renames it,
    // the press-close below would silently stop working.
    expect(registered).toContain('tooltip.open');

    dispatched.length = 0;
    fireEvent.pointerDown(cut);
    advance(1000);
    expect(shown()).toBeNull();
    // Whatever event the press dispatches must be one Radix is listening for.
    expect(dispatched.length).toBeGreaterThan(0);
    for (const type of dispatched) expect(registered).toContain(type);
    fireEvent.pointerLeave(cut);

    fireEvent.pointerMove(cut2);
    advance(100);
    expect(shown()).toBeNull();
    advance(450);
    expect(shown()?.textContent).toContain('full cut2');
  });
});
