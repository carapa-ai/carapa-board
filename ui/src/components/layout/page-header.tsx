import { createContext, ReactNode, useContext } from 'react';
import { Menu, PanelLeftOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { useStore } from '@/store';
import { cn } from '@/lib/utils';
import { HeaderUtilities } from '@/components/layout/header-utilities';

interface PageHeaderProps {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  className?: string;
  actionsClassName?: string;
}

// Pages rendered inside an overlay drop the global chrome (connection and
// notification cluster, menu and sidebar triggers) and the page title, because
// the overlay's own dialog title and close control already provide them.
export const PageHeaderEmbeddedContext = createContext(false);

export function PageHeader({
  icon,
  title,
  subtitle,
  children,
  className,
  actionsClassName,
}: PageHeaderProps) {
  const embedded = useContext(PageHeaderEmbeddedContext);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const desktopSidebarCollapsed = useStore((s) => s.desktopSidebarCollapsed);
  const setDesktopSidebarCollapsed = useStore(
    (s) => s.setDesktopSidebarCollapsed,
  );

  // An embedded header with no subtitle or actions would only be an empty bar.
  if (embedded && !subtitle && !children) return null;

  return (
    <header
      className={cn(
        'px-4 sm:px-6 py-4 border-b border-border bg-background/80 backdrop-blur-md sticky top-0 z-10 flex flex-col sm:flex-row sm:items-center justify-between gap-4',
        className,
      )}
    >
      <div className="flex items-center gap-3 min-w-0">
        {!embedded && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="md:hidden shrink-0"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
            data-ui="open-menu-trigger"
            aria-expanded={sidebarOpen}
            aria-controls="global-sidebar"
          >
            <Menu className="size-5" />
          </Button>
        )}
        {!embedded && desktopSidebarCollapsed && (
          <Tooltip content="Show project sidebar" side="bottom">
            <Button
              variant="ghost"
              size="icon-xs"
              className="hidden md:inline-flex shrink-0"
              aria-label="Show project sidebar"
              aria-expanded={false}
              aria-controls="global-sidebar"
              data-ui="global-sidebar-expand"
              onClick={() => setDesktopSidebarCollapsed(false)}
            >
              <PanelLeftOpen className="size-4" />
            </Button>
          </Tooltip>
        )}
        {!embedded && icon}
        <div className="flex flex-col min-w-0">
          {!embedded && (
            <div className="flex items-center gap-1.5 text-base sm:text-lg font-medium flex-wrap">
              {title}
            </div>
          )}
          {subtitle && (
            <p className="text-xs text-muted-foreground truncate max-w-[280px] xs:max-w-[360px] sm:max-w-none">
              {subtitle}
            </p>
          )}
        </div>
      </div>

      <div className="flex w-full shrink-0 items-center justify-end gap-2 sm:w-auto">
        {children && (
          <div
            className={cn(
              'flex min-w-0 flex-1 items-center gap-2 sm:flex-initial',
              actionsClassName,
            )}
          >
            {children}
          </div>
        )}
        {!embedded && <HeaderUtilities />}
      </div>
    </header>
  );
}
