import { useCallback, useEffect, useRef, useState } from 'react';
import { TabsList } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

/**
 * The tab strip of a workspace pane (chat workspace, objective explorer). In a
 * narrow pane the tabs scroll sideways with a fade at the clipped edge instead
 * of cutting a label mid-word, and the active tab is kept in view. Triggers
 * are `shrink-0` with tighter padding so more of them fit.
 */
export function WorkspaceTabsList({
  className,
  children,
  ...props
}: React.ComponentProps<typeof TabsList>) {
  const scroller = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ start: false, end: false });
  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setFade((prev) =>
      prev.start === start && prev.end === end ? prev : { start, end },
    );
  }, []);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(el);
    if (el.firstElementChild) resize.observe(el.firstElementChild);
    // Radix flips `data-state` on the triggers: bring the new active tab into view.
    const mutation = new MutationObserver(() => {
      el.querySelector('[data-state=active]')?.scrollIntoView?.({
        block: 'nearest',
        inline: 'nearest',
      });
    });
    mutation.observe(el, {
      attributes: true,
      attributeFilter: ['data-state'],
      subtree: true,
    });
    return () => {
      resize.disconnect();
      mutation.disconnect();
    };
  }, [measure]);
  const edge = 24;
  const mask = `linear-gradient(to right, ${
    fade.start ? `transparent 0, black ${edge}px` : 'black 0'
  }, ${fade.end ? `black calc(100% - ${edge}px), transparent 100%` : 'black 100%'})`;
  return (
    <div
      ref={scroller}
      data-slot="workspace-tabs-scroller"
      onScroll={measure}
      className="min-w-0 flex-1 overflow-x-auto scrollbar-none touch-pan-x"
      style={fade.start || fade.end ? { maskImage: mask } : undefined}
    >
      <TabsList
        className={cn(
          'mx-2 my-2 w-max justify-start [&>[data-slot=tabs-trigger]]:shrink-0 [&>[data-slot=tabs-trigger]]:px-2',
          className,
        )}
        {...props}
      >
        {children}
      </TabsList>
    </div>
  );
}
