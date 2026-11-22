import type { ComponentProps } from 'react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/** Fit the content area, including when the properties pane is open. */
export function KnowledgeItemGrid({
  className,
  ...props
}: ComponentProps<'div'>) {
  return (
    <div
      {...props}
      className={cn(
        'grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-3 sm:gap-4',
        className,
      )}
    />
  );
}

export function KnowledgeItemCard({
  className,
  ...props
}: ComponentProps<typeof Card>) {
  return (
    <Card
      {...props}
      className={cn(
        'min-w-0 gap-0 py-0 overflow-hidden border-border transition-colors hover:border-primary/40',
        className,
      )}
    />
  );
}
