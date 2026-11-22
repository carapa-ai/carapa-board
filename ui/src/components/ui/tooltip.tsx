import * as React from 'react';
import { Slot, Tooltip as TooltipPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

// The first hover waits so passing the pointer over a list stays quiet. Within
// SKIP_DELAY_MS of one tooltip closing, the next trigger opens at once.
const OPEN_DELAY_MS = 500;
const SKIP_DELAY_MS = 300;
// Below this width the sidebar is a full-width drawer with no room beside it.
const NARROW_VIEWPORT_PX = 768;

const ProviderPresentContext = React.createContext(false);

/** One per app: shares the open/skip delay state between all tooltips. */
function TooltipProvider({
  delayDuration = OPEN_DELAY_MS,
  skipDelayDuration = SKIP_DELAY_MS,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <ProviderPresentContext.Provider value>
      <TooltipPrimitive.Provider
        delayDuration={delayDuration}
        skipDelayDuration={skipDelayDuration}
        {...props}
      />
    </ProviderPresentContext.Provider>
  );
}

/** True when the element's text is cut off (single-line ellipsis or line clamp). */
function isTextClipped(element: HTMLElement | null | undefined): boolean {
  if (!element) return false;
  return (
    element.scrollWidth > element.clientWidth ||
    element.scrollHeight > element.clientHeight
  );
}

/** Keyboard focus shows the tooltip; focus restored after a mouse click does not. */
function isFocusVisible(element: HTMLElement): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

type TooltipContentValue = React.ReactNode | (() => React.ReactNode);

type TooltipProps = Omit<
  React.ComponentProps<typeof TooltipPrimitive.Trigger>,
  'asChild' | 'content'
> & {
  /**
   * Tooltip body. A function is evaluated each time the pointer or focus
   * arrives; return a falsy value to keep the tooltip closed.
   */
  content: TooltipContentValue;
  /** Show the tooltip only while this element's text is clipped. */
  whenClipped?: React.RefObject<HTMLElement | null>;
  side?: 'top' | 'right' | 'bottom' | 'left';
  /**
   * True (default) when the text repeats the trigger's accessible name or its
   * visible text, so it is kept out of `aria-describedby` to avoid announcing
   * it twice. Pass false when the tooltip adds information (exact time, hint).
   */
  redundant?: boolean;
  children: React.ReactElement<{
    disabled?: boolean;
    'aria-describedby'?: string;
  }>;
};

const TRIGGER_ATTRIBUTE = 'data-tooltip-trigger';

/** True when the event came from a tooltip trigger nested inside this one. */
function fromNestedTrigger(event: React.SyntheticEvent<HTMLElement>): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const innermost = target.closest(`[${TRIGGER_ATTRIBUTE}]`);
  return innermost !== null && innermost !== event.currentTarget;
}

// Radix's own event: every open tooltip closes itself, through its normal
// close path, when a tooltip opens. Dispatched to close the open one.
const RADIX_TOOLTIP_OPEN_EVENT = 'tooltip.open';

/**
 * Hover and keyboard-focus tooltip. It never carries essential information:
 * the trigger needs its own accessible name (`aria-label` or visible text).
 * Radix opens it on hover and keyboard focus only, never for touch, and
 * Escape closes it while the pointer may rest on the tooltip itself.
 *
 * Radix owns the open state. A tooltip that has nothing to show is refused
 * before Radix sees the pointer or focus event: letting Radix start an open
 * that is then dropped would leave the app-wide "skip the delay" flag stuck.
 */
function Tooltip({
  content,
  whenClipped,
  side = 'top',
  redundant = true,
  children,
  ...triggerProps
}: TooltipProps) {
  const providerPresent = React.useContext(ProviderPresentContext);
  // Mirrors Radix's state only to know when to watch for outside presses.
  const [open, setOpen] = React.useState(false);
  const [body, setBody] = React.useState<React.ReactNode>(null);
  const [placement, setPlacement] = React.useState(side);
  const contentRef = React.useRef<HTMLDivElement>(null);
  // The verdict for the current hover or focus, so moving within the trigger
  // does not re-measure or re-render.
  const verdictRef = React.useRef<'admit' | 'refuse' | null>(null);

  // A button that can be disabled always sits in a wrapper: a disabled button
  // swallows pointer events, and a wrapper that appeared only while disabled
  // would re-create the button and drop its focus.
  const wrapped = 'disabled' in children.props;
  // Radix puts aria-describedby on the wrapper; a tooltip that adds
  // information must describe the control inside it instead.
  const describeInnerControl = wrapped && !redundant;
  const wrapperRef = React.useRef<HTMLSpanElement>(null);
  const [innerDescribedBy, setInnerDescribedBy] = React.useState<string>();
  React.useEffect(() => {
    setInnerDescribedBy(
      open && describeInnerControl
        ? (wrapperRef.current?.getAttribute('aria-describedby') ?? undefined)
        : undefined,
    );
  }, [open, describeInnerControl]);

  // A modal menu opened by this very press mounts before Radix sees the
  // pointer-down and then makes the tooltip ignore it, so close it first.
  React.useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        contentRef.current?.contains(event.target)
      ) {
        return;
      }
      document.dispatchEvent(new CustomEvent(RADIX_TOOLTIP_OPEN_EVENT));
    };
    document.addEventListener('pointerdown', closeOnPointerDown, true);
    return () =>
      document.removeEventListener('pointerdown', closeOnPointerDown, true);
  }, [open]);

  const {
    onPointerMove,
    onPointerEnter,
    onPointerLeave,
    onFocus,
    onBlur,
    ...forwarded
  } = triggerProps;

  if (!content) {
    // Nothing to show (e.g. no project selected): still pass on whatever a
    // parent trigger (menu, dialog) injected.
    const inner = <Slot.Root {...triggerProps}>{children}</Slot.Root>;
    return wrapped ? <span className="inline-flex">{inner}</span> : inner;
  }

  const admit = (): boolean => {
    if (verdictRef.current) return verdictRef.current === 'admit';
    const resolved =
      whenClipped && !isTextClipped(whenClipped.current)
        ? null
        : typeof content === 'function'
          ? content()
          : content;
    if (!resolved) {
      verdictRef.current = 'refuse';
      return false;
    }
    setBody(resolved);
    // A tooltip beside a full-width drawer row would leave the viewport.
    const beside = side === 'left' || side === 'right';
    setPlacement(
      beside && window.innerWidth < NARROW_VIEWPORT_PX ? 'bottom' : side,
    );
    verdictRef.current = 'admit';
    return true;
  };

  const gate = {
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
      onPointerMove?.(event as React.PointerEvent<HTMLButtonElement>);
      if (event.defaultPrevented || event.pointerType === 'touch') return;
      // A nested trigger (e.g. the time inside a row) shows its own tooltip.
      if (fromNestedTrigger(event) || !admit()) event.preventDefault();
    },
    onPointerEnter: (event: React.PointerEvent<HTMLElement>) => {
      onPointerEnter?.(event as React.PointerEvent<HTMLButtonElement>);
      // A verdict cached on keyboard focus must not decide a later hover.
      verdictRef.current = null;
    },
    onPointerLeave: (event: React.PointerEvent<HTMLElement>) => {
      onPointerLeave?.(event as React.PointerEvent<HTMLButtonElement>);
      verdictRef.current = null;
    },
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      onFocus?.(event as React.FocusEvent<HTMLButtonElement>);
      if (event.defaultPrevented) return;
      // `target`: the focused control, which may sit inside the trigger.
      if (
        !isFocusVisible(event.target) ||
        fromNestedTrigger(event) ||
        !admit()
      ) {
        event.preventDefault();
      }
    },
    onBlur: (event: React.FocusEvent<HTMLElement>) => {
      onBlur?.(event as React.FocusEvent<HTMLButtonElement>);
      verdictRef.current = null;
    },
  };

  const tooltip = (
    <TooltipPrimitive.Root
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) verdictRef.current = null;
      }}
    >
      {wrapped ? (
        <TooltipPrimitive.Trigger asChild {...gate}>
          <span
            ref={wrapperRef}
            className="inline-flex"
            {...{ [TRIGGER_ATTRIBUTE]: '' }}
          >
            <Slot.Root
              {...forwarded}
              {...(innerDescribedBy && {
                'aria-describedby': innerDescribedBy,
              })}
            >
              {children}
            </Slot.Root>
          </span>
        </TooltipPrimitive.Trigger>
      ) : (
        <TooltipPrimitive.Trigger
          asChild
          {...forwarded}
          {...gate}
          {...{ [TRIGGER_ATTRIBUTE]: '' }}
        >
          {redundant
            ? React.cloneElement(children, {
                'aria-describedby': children.props['aria-describedby'],
              })
            : children}
        </TooltipPrimitive.Trigger>
      )}
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          ref={contentRef}
          data-slot="tooltip-content"
          side={placement}
          sideOffset={8}
          collisionPadding={8}
          // The text is also exposed through aria-describedby when it adds
          // information; hiding the copy here avoids a second reading of it.
          aria-hidden="true"
          className={cn(
            // Lifted off the surface: tooltips often sit over cards that share the
            // popover colour, so the fill is lighter than the popover token, the
            // border is brighter than the default and the shadow is deep.
            'bg-[color-mix(in_oklab,var(--popover),var(--popover-foreground)_14%)] text-popover-foreground z-[60] w-fit max-w-[min(20rem,calc(100vw-1rem))] origin-(--radix-tooltip-content-transform-origin) rounded-md border border-foreground/30 px-2.5 py-1.5 text-xs leading-snug break-words shadow-[0_12px_32px_-6px_rgb(0_0_0/0.75),0_3px_8px_rgb(0_0_0/0.5)]',
            'data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 motion-reduce:animate-none',
          )}
        >
          {body}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );

  // Components rendered outside the app shell (tests, isolated previews) have
  // no provider; give them a private one rather than crashing.
  return providerPresent ? (
    tooltip
  ) : (
    <TooltipProvider>{tooltip}</TooltipProvider>
  );
}

export { Tooltip, TooltipProvider, isTextClipped };
