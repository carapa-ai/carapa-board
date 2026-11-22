import * as React from 'react';
import { Search, X } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

type SearchInputProps = React.ComponentProps<'input'> & {
  /** Size/layout of the wrapper (`flex-1`, `max-w-sm`, margins). */
  wrapperClassName?: string;
  /** Smaller height, text and icon for dense surfaces (sidebars, dropdowns). */
  compact?: boolean;
  /** When set, a clear button shows while the field has a value. */
  onClear?: () => void;
  clearLabel?: string;
};

/**
 * The one search-field look: the shared `Input` (field fill, focus ring) with
 * a leading search icon and an optional clear button. Do not restyle the border,
 * background or focus ring at the call site; pass only size and layout classes.
 */
function SearchInput({
  className,
  wrapperClassName,
  compact = false,
  onClear,
  clearLabel = 'Clear search',
  value,
  ...props
}: SearchInputProps) {
  const hasValue = typeof value === 'string' ? value !== '' : Boolean(value);
  return (
    <div
      data-slot="search-input"
      className={cn('relative min-w-0', wrapperClassName)}
    >
      <Search
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground',
          compact ? 'left-2.5 size-3.5' : 'left-3 size-4',
        )}
      />
      <Input
        value={value}
        compact={compact}
        className={cn(
          '[&::-webkit-search-cancel-button]:hidden',
          compact ? 'pl-8 pr-7' : 'pl-9 pr-8',
          className,
        )}
        {...props}
      />
      {onClear && hasValue && (
        <button
          type="button"
          aria-label={clearLabel}
          onClick={onClear}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className={compact ? 'size-3' : 'size-3.5'} />
        </button>
      )}
    </div>
  );
}

export { SearchInput };
