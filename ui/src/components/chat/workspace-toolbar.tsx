import type { ComponentProps, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * The toolbar at the top of a workspace tab (Files, Changes, Browser, Events,
 * Mail...). The tab body has an 8px left margin (`ml-2`, the tab strip's
 * inset) and each scrolling tab pads its right side (`pr-2`) so scrollbars sit
 * at the pane edge, so the toolbar adds no horizontal padding unless it sits
 * in a tab that runs to the edge (Browser, Mail: `pr-2`): 8px above
 * (below the strip), 8px below, one quiet separator, rows 32px tall with a
 * 6px gap. A scrolling tab without a toolbar (Runs) starts its content at the
 * same 8px (`workspaceContentClassName`); the Dashboard iframe has no padding
 * and fills the body.
 */
export function WorkspaceToolbar({
  className,
  ...props
}: ComponentProps<'div'>) {
  return (
    <div
      data-slot="workspace-toolbar"
      className={cn(
        'flex min-w-0 shrink-0 flex-col gap-1.5 border-b border-border pt-2 pb-2',
        className,
      )}
      {...props}
    />
  );
}

/** One toolbar row: controls and a quiet text line share the 32px height. */
export function WorkspaceToolbarRow({
  className,
  ...props
}: ComponentProps<'div'>) {
  return (
    <div
      data-slot="workspace-toolbar-row"
      className={cn(
        'flex min-h-8 min-w-0 flex-wrap items-center gap-1.5',
        className,
      )}
      {...props}
    />
  );
}

/** Top inset of a workspace tab body that has no toolbar. */
export const workspaceContentClassName = 'pt-2';

/**
 * The one icon-only action of a workspace toolbar: a ghost shared `Button`
 * (32px, the compact field height) with its accessible name in `label` and a
 * hover tooltip.
 */
export function ToolbarIconButton({
  label,
  tooltip,
  size = 'icon-sm',
  disabled,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, 'aria-label' | 'title' | 'variant'> & {
  label: string;
  /** Longer hint that adds to the label (consequences, shortcuts). */
  tooltip?: ReactNode;
}) {
  return (
    <Tooltip content={tooltip ?? label} side="bottom" redundant={!tooltip}>
      <Button
        type="button"
        variant="ghost"
        size={size}
        aria-label={label}
        disabled={disabled}
        {...props}
      >
        {children}
      </Button>
    </Tooltip>
  );
}

/**
 * A toolbar row of text actions (Commit, Merge, ...) with the row's icon
 * actions (`trailing`, e.g. Refresh) pinned to its right end.
 */
export function ToolbarActionsRow({
  actions,
  trailing,
}: {
  actions?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <WorkspaceToolbarRow
      data-ui="changes-actions"
      className="flex-nowrap justify-between"
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {actions}
      </div>
      {trailing}
    </WorkspaceToolbarRow>
  );
}
