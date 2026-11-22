import * as React from 'react';
import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import { Select as SelectPrimitive } from 'radix-ui';

import { fieldClassName } from '@/components/ui/field';
import { menuContentClassName, menuItemClassName } from '@/components/ui/menu';
import { cn } from '@/lib/utils';

/** Trigger look shared by `Select` and every custom picker (dropdown menus, popovers). */
const fieldTriggerClassName = cn(
  fieldClassName,
  'inline-flex w-fit max-w-full items-center justify-between gap-2 px-3 py-1 text-left whitespace-nowrap data-[placeholder]:text-muted-foreground [&>span]:min-w-0 [&>span]:truncate',
);
const triggerSizeClassName = (compact: boolean) =>
  compact ? 'h-8 text-xs md:text-xs' : 'h-9';

/**
 * A button that looks like a form field, with a trailing chevron. Use it as the
 * trigger of any custom picker (`<DropdownMenuTrigger asChild>`), so pickers and
 * `Select` triggers are identical.
 */
function FieldTrigger({
  className,
  children,
  compact = false,
  ...props
}: React.ComponentProps<'button'> & { compact?: boolean }) {
  return (
    <button
      type="button"
      data-slot="field-trigger"
      className={cn(
        fieldTriggerClassName,
        triggerSizeClassName(compact),
        className,
      )}
      {...props}
    >
      {children}
      <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

/** Lets `SelectItem` follow the trigger's size: a compact select lists compact items. */
const SelectSizeContext = React.createContext(false);

// Radix reserves '' for "no value", but forms use '' for "none/default".
const EMPTY_VALUE = '__select_empty__';
const toRadixValue = (value: string) => (value === '' ? EMPTY_VALUE : value);

type SelectProps = Omit<
  React.ComponentProps<typeof SelectPrimitive.Trigger>,
  'value' | 'defaultValue' | 'onChange' | 'dir'
> & {
  /** `''` selects the `SelectItem value=""` option; `undefined`/`null` shows the placeholder. */
  value?: string | null;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  name?: string;
  required?: boolean;
  /** Smaller height and text for dense lists, toolbars and sidebars. */
  compact?: boolean;
  contentClassName?: string;
};

/**
 * The one select. Replaces native `<select>`: the trigger is the shared field
 * look, the list shares the dropdown-menu surface and item hover. Pass
 * `SelectItem` children, and only layout classes (`w-full`, `flex-1`) as
 * `className`; `id`, `aria-label` and `data-*` land on the trigger.
 */
function Select({
  value,
  onValueChange,
  placeholder,
  name,
  required,
  disabled,
  compact = false,
  className,
  contentClassName,
  children,
  ...triggerProps
}: SelectProps) {
  return (
    <SelectPrimitive.Root
      value={value == null ? undefined : toRadixValue(value)}
      onValueChange={(next) =>
        onValueChange?.(next === EMPTY_VALUE ? '' : next)
      }
      name={name}
      required={required}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        data-slot="select-trigger"
        className={cn(
          fieldTriggerClassName,
          triggerSizeClassName(compact),
          className,
        )}
        {...triggerProps}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon asChild>
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          data-slot="select-content"
          position="popper"
          sideOffset={4}
          className={cn(
            menuContentClassName,
            'max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) origin-(--radix-select-content-transform-origin) max-w-[min(32rem,calc(100vw-1rem))]',
            contentClassName,
          )}
        >
          <SelectSizeContext.Provider value={compact}>
            <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
          </SelectSizeContext.Provider>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

function SelectItem({
  value,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof SelectPrimitive.Item>, 'value'> & {
  value: string;
}) {
  const compact = React.useContext(SelectSizeContext);
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      value={toRadixValue(value)}
      className={cn(
        menuItemClassName,
        'pr-8',
        compact && 'py-1 text-xs',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <span className="pointer-events-none absolute right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  );
}

export { FieldTrigger, Select, SelectItem };
