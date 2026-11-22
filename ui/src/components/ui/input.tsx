import * as React from 'react';

import { fieldClassName } from '@/components/ui/field';
import { cn } from '@/lib/utils';

function Input({
  className,
  type,
  compact = false,
  ...props
}: React.ComponentProps<'input'> & {
  /** Smaller height and text for dense lists, toolbars and sidebars. */
  compact?: boolean;
}) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        fieldClassName,
        compact ? 'h-8 text-xs md:text-xs' : 'h-9',
        'file:text-foreground w-full min-w-0 px-3 py-1 file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
