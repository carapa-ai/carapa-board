import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function QueryErrorState({
  title,
  error,
  onRetry,
  isRetrying = false,
  compact = false,
  children,
}: {
  title: string;
  error: unknown;
  /** Omit when retrying cannot help (e.g. the resource does not exist). */
  onRetry?: () => void;
  isRetrying?: boolean;
  /** Small variant for narrow surfaces such as the sidebar. */
  compact?: boolean;
  children?: ReactNode;
}) {
  const message = error instanceof Error ? error.message : 'Unknown error';
  return (
    <div
      data-ui="query-error-state"
      data-compact={compact ? 'true' : undefined}
      role={compact ? 'alert' : undefined}
      className={cn(
        'flex-1 flex items-center justify-center text-muted-foreground',
        compact ? 'p-3' : 'p-6',
      )}
    >
      <div className={cn('text-center', compact ? 'space-y-2' : 'space-y-3')}>
        {compact ? (
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        ) : (
          <h2 className="text-xl font-semibold">{title}</h2>
        )}
        <p className={cn('text-destructive', compact ? 'text-xs' : 'text-sm')}>
          {message}
        </p>
        {onRetry && (
          <Button
            variant="outline"
            size={compact ? 'xs' : 'sm'}
            className={compact ? 'max-md:h-11' : undefined}
            onClick={onRetry}
            disabled={isRetrying}
          >
            {isRetrying && <Loader2 className="animate-spin" aria-hidden />}
            Retry
          </Button>
        )}
        {children}
      </div>
    </div>
  );
}
