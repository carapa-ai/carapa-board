import { Checkbox } from '@/components/ui/checkbox';
import { stageVariantPayload, variantLabel } from '@/lib/ab';
import type { ProjectSettings, StageType } from '@/types';

interface AbVariantSelectProps {
  /** Alternative suffixes configured in the project (`['b', 'c']`). */
  suffixes: string[];
  /** Selected variants, lowercase; `a` is the base stages. */
  selected: string[];
  onChange: (selected: string[]) => void;
  /** Stage type the task is in. Variants are only editable in a queue stage. */
  stageType: StageType | undefined;
  /** True once the experiment has forked into child cards. */
  forked?: boolean;
  checkoutMode: ProjectSettings['taskCheckoutMode'];
  /** A task-level runtime overrides stage alternatives. */
  hasTaskRuntime: boolean;
}

/** "Run variants": choose which stage alternatives a task runs side by side. */
export function AbVariantSelect({
  suffixes,
  selected,
  onChange,
  stageType,
  forked = false,
  checkoutMode,
  hasTaskRuntime,
}: AbVariantSelectProps) {
  if (suffixes.length === 0 || stageType !== 'queue' || forked) return null;

  const worktreeMode = checkoutMode === 'worktree';
  const options = ['a', ...suffixes];
  // A single variant works in any checkout mode; only experiments (two or
  // more) need worktrees, so outside worktree mode a tick replaces the choice.
  const toggle = (variant: string, checked: boolean) => {
    if (!worktreeMode) return onChange(checked ? [variant] : []);
    onChange(
      checked
        ? [...new Set([...selected, variant])]
        : selected.filter((item) => item !== variant),
    );
  };
  const singleVariant = stageVariantPayload(selected);
  const runsVariant = singleVariant !== null || selected.length >= 2;

  return (
    <div
      data-ui="ab-variant-select"
      className="space-y-1.5 rounded-md border border-border bg-muted/20 p-2"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-xs font-medium">Run variants</span>
        {options.map((variant) => (
          <label
            key={variant}
            data-ui="ab-variant-option"
            data-variant={variant}
            className="flex items-center gap-1.5 text-xs"
          >
            <Checkbox
              checked={selected.includes(variant)}
              onCheckedChange={(checked) => toggle(variant, checked === true)}
              aria-label={`Run variant ${variantLabel(variant)}`}
            />
            {variantLabel(variant)}
          </label>
        ))}
      </div>
      {!worktreeMode && (
        <p
          data-ui="ab-variant-select-reason"
          className="text-[11px] text-muted-foreground"
        >
          A/B experiments (two or more variants) need the project&apos;s task
          checkout mode set to worktree, so each variant gets its own branch.
          Without it you can run the card on one variant.
        </p>
      )}
      {singleVariant && (
        <p
          data-ui="ab-variant-select-hint"
          className="text-[11px] text-muted-foreground"
        >
          This card runs on variant {variantLabel(singleVariant)}&apos;s stage
          alternatives.
          {worktreeMode && ' Tick another variant to start an A/B experiment.'}
        </p>
      )}
      {runsVariant && hasTaskRuntime && (
        <p
          data-ui="ab-variant-runtime-warning"
          className="text-[11px] text-amber-700 dark:text-amber-500"
        >
          A task-level runtime overrides stage alternatives. Clear it so the
          selected variants run on their own stage runtime.
        </p>
      )}
    </div>
  );
}
