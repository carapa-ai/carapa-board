import {
  type ComponentPropsWithoutRef,
  type ReactNode,
  useEffect,
  useRef,
} from 'react';
import { useViewportHeight } from '@/hooks/use-keyboard-height';
import { isOldAndroid } from '@/lib/platform';
import { cn } from '@/lib/utils';

/**
 * Full-screen page (login, lock, connection screens) whose content stays
 * reachable with the on-screen keyboard open: it scrolls once the content is
 * taller than the space left. Props style the content column, which fills
 * at least the screen so it can still centre its children.
 */
export function KeyboardSafeScreen({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<'div'>) {
  const content = (
    <div {...props} className={cn('min-h-full', className)}>
      {children}
    </div>
  );
  return isOldAndroid ? (
    <OldAndroidScreen>{content}</OldAndroidScreen>
  ) : (
    <div className="h-screen overflow-y-auto bg-background">{content}</div>
  );
}

// Android ≤10 does not resize the WebView for the keyboard (see
// useViewportHeight): follow the keyboard estimate, then bring the focused
// field back into view.
function OldAndroidScreen({ children }: { children: ReactNode }) {
  const height = useViewportHeight();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && ref.current?.contains(active)) {
      active.scrollIntoView({ block: 'center' });
    }
  }, [height]);
  return (
    <div
      ref={ref}
      className="overflow-y-auto bg-background"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: height ? `${height}px` : '100vh',
      }}
    >
      {children}
    </div>
  );
}
