import type { ComponentProps, ElementType } from 'react';
import { cn } from '@/lib/utils';

/**
 * A row of one field and the buttons beside it (search + Search, select +
 * Refresh, input + Add). The row owns the height: its direct fields (`Input`,
 * `SearchInput`, `Select`, `FieldTrigger`) and `Button`s are all the compact
 * field height (`h-8`, a compact field with a `sm` button) or the default one
 * (`h-9`, a default field with a default button), so a button can never end
 * up shorter or taller than the field it sits next to. Use it instead of a
 * bare `flex` wrapper; pass only layout classes.
 */
// Literal class strings (not built up) so Tailwind sees them.
const COMPACT =
  '[&>[data-slot=button]]:h-8 [&>[data-slot=input]]:h-8 [&>[data-slot=select-trigger]]:h-8 [&>[data-slot=field-trigger]]:h-8 [&>[data-slot=search-input]>[data-slot=input]]:h-8';
const DEFAULT =
  '[&>[data-slot=button]]:h-9 [&>[data-slot=input]]:h-9 [&>[data-slot=select-trigger]]:h-9 [&>[data-slot=field-trigger]]:h-9 [&>[data-slot=search-input]>[data-slot=input]]:h-9';

// Touch layouts (`max-md`) enlarge fields and buttons to 44px together.
const TOUCH =
  'max-md:[&>[data-slot=button]]:h-11 max-md:[&>[data-slot=input]]:h-11 max-md:[&>[data-slot=select-trigger]]:h-11 max-md:[&>[data-slot=field-trigger]]:h-11 max-md:[&>[data-slot=search-input]>[data-slot=input]]:h-11';

export function FieldRow({
  compact = false,
  touch = false,
  as: Component = 'div',
  className,
  ...props
}: Omit<ComponentProps<'div'>, 'ref'> &
  Pick<ComponentProps<'form'>, 'onSubmit'> & {
    /** Compact fields (`h-8`) with `sm` buttons; default fields (`h-9`) otherwise. */
    compact?: boolean;
    /** Below the `md` breakpoint fields and buttons are 44px (touch targets). */
    touch?: boolean;
    as?: ElementType;
  }) {
  return (
    <Component
      data-slot="field-row"
      className={cn(
        'flex min-w-0 items-center gap-1.5',
        compact ? COMPACT : DEFAULT,
        touch && TOUCH,
        className,
      )}
      {...props}
    />
  );
}
