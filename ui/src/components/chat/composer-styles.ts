import { cn } from '@/lib/utils';

/**
 * Shared shell of the prompt composers: the main chat page's "Unified Input
 * Card" and the task detail dialog's Chat-tab composer. Rule 12's composer
 * exception: the card keeps its own outline with a stronger focus state —
 * `border-black/10` with a `border-black/20` focus in light and
 * `border-white/10` with `border-white/20` in dark — and the controls inside
 * it (borderless textarea, footer pills and icon buttons) keep their own
 * control styles. Both composers import from here so they stay in sync.
 */

/** The rounded input card the composer is built around. */
export const composerCardClassName = cn(
  'relative bg-muted/40 border border-black/10 dark:border-white/10 rounded-2xl transition-all duration-200 shadow-sm',
  'focus-within:bg-muted/60 focus-within:border-black/20 dark:focus-within:border-white/20 focus-within:shadow-md',
);

/** Borderless textarea inside the composer card. */
export const composerTextareaClassName = cn(
  'border-none bg-transparent shadow-none focus-visible:ring-0',
  'placeholder:text-muted-foreground/50',
);

/** Footer row inside the composer card, below the textarea. */
export const composerFooterClassName =
  'flex flex-wrap justify-between items-center gap-x-3 gap-y-1 px-3 py-1.5 border-t border-black/5 dark:border-white/5';

/** Pill-shaped picker trigger in the composer footer (e.g. the runtime selector). */
export const composerPillClassName =
  // Light fill kept at /5 (hover /10) so the +N badge's text-blue-800 on bg-primary/20 stays >= 4.5:1 even on hover.
  'h-7 min-h-7 min-w-0 gap-1 rounded-lg border border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/10 px-2 text-[11px] font-medium text-muted-foreground hover:bg-black/10 dark:hover:bg-white/15 hover:text-foreground has-[>svg]:px-2';

/** Ghost icon button on the left of the composer footer (the chat "+" button). */
export const composerFooterIconButtonClassName =
  'size-8 shrink-0 rounded-lg text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5 hover:text-foreground sm:size-7';

/** Blue send icon button on the right of the composer footer. */
export const composerSendButtonClassName =
  // text-white on the filled bg-blue-600 keeps >= 4.5:1 in both themes.
  'size-9 rounded-xl shadow-lg shadow-blue-500/10 @md:size-8 bg-blue-600 text-white hover:bg-blue-700 dark:hover:bg-blue-500';

/** Red-outline stop icon button in the composer footer. */
export const composerStopButtonClassName =
  // Translucent red hover fill reads on both themes; border/text tones are theme-swapped.
  'size-9 rounded-xl border-red-600/30 dark:border-red-500/30 text-red-600 dark:text-red-400 hover:bg-red-500/10 @md:size-8';

/** Muted keyboard hint in the composer footer, shown from the @2xl container width. */
export const composerHintClassName =
  'hidden shrink-0 whitespace-nowrap text-[10px] font-medium text-muted-foreground/50 @2xl:block';
