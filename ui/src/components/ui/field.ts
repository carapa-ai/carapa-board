/**
 * The shared look of every form field: text input, textarea, search input and
 * select trigger. A quiet 1px `border-border` outline (the same as outline
 * buttons) on the `--field` fill, a slightly brighter fill on hover, and on
 * focus `border-ring` plus a 1px full-strength ring (>= 3:1). Size and padding
 * stay with each component; call sites pass only layout classes.
 */
export const fieldClassName =
  'text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground bg-field hover:bg-field-hover border border-border focus-visible:border-ring aria-invalid:border-destructive rounded-md text-base md:text-sm shadow-xs transition-[color,box-shadow,background-color] outline-none focus-visible:ring-1 focus-visible:ring-ring aria-invalid:ring-1 aria-invalid:ring-destructive disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-field';
