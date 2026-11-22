import { useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Hourglass } from 'lucide-react';
import { Slider } from 'radix-ui';
import {
  fetchProjectHarnesses,
  type RuntimeCatalog,
  type RuntimeSelection,
} from '@/lib/api';
import { FieldTrigger, Select, SelectItem } from '@/components/ui/select';
import { queryKeys } from '@/lib/query-keys';
import { RuntimeHarnessIcon } from '@/components/chat/runtime-harness-icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

interface RuntimePickerProps {
  catalog?: RuntimeCatalog;
  value?: RuntimeSelection | null;
  onChange: (value: RuntimeSelection | null) => void;
  allowClear?: boolean;
  presets?: RuntimeCatalog['presets'];
  presentation?: 'form' | 'panel';
  reasoningEmptyLabel?: string;
  /** Hide harnesses the project's sandbox host has not installed. */
  projectId?: string;
  /** Claude prompt-cache lifetime; the toggle shows in the panel only for Claude harnesses. */
  promptCache1h?: boolean;
  onPromptCache1hChange?: (value: boolean) => void;
}

/** Restrict a catalog to the given harnesses; `keep` stays listed so a stored selection remains visible. */
function restrictCatalogHarnesses(
  catalog: RuntimeCatalog | undefined,
  harnessIds: string[] | null | undefined,
  keep?: string,
): RuntimeCatalog | undefined {
  if (!catalog || !harnessIds) return catalog;
  const allowed = new Set(harnessIds);
  if (keep) allowed.add(keep);
  return {
    ...catalog,
    harnesses: catalog.harnesses.filter((item) => allowed.has(item.id)),
    models: catalog.models
      .map((item) => ({
        ...item,
        bindings: item.bindings.filter((binding) =>
          allowed.has(binding.harnessId),
        ),
      }))
      .filter((item) => item.bindings.length > 0),
    presets: catalog.presets.filter((item) =>
      allowed.has(item.selection.harnessId),
    ),
  };
}

export function normalizeRuntimePickerSelection(
  catalog: RuntimeCatalog,
  next: RuntimeSelection,
): RuntimeSelection | null {
  const nextBinding = catalog.models
    .find((item) => item.id === next.modelId)
    ?.bindings.find((item) => item.harnessId === next.harnessId);
  if (!nextBinding) return null;

  // Omitted reasoning is meaningful for layered Kanban overrides: it inherits
  // from the next lower layer. Only replace an explicit value when changing
  // bindings makes that value invalid.
  const explicitReasoning =
    typeof next.reasoning === 'string' && next.reasoning.trim().length > 0
      ? next.reasoning
      : undefined;
  const reasoning = !explicitReasoning
    ? undefined
    : nextBinding.reasoning.options.includes(explicitReasoning)
      ? explicitReasoning
      : nextBinding.reasoning.default;
  return {
    harnessId: next.harnessId,
    modelId: next.modelId,
    ...(reasoning ? { reasoning } : {}),
    ...(next.temperature !== undefined
      ? { temperature: next.temperature }
      : {}),
  };
}

/** Shared harness/model/reasoning selection behavior for chat menus and Kanban forms. */
export function RuntimePicker({
  catalog: fullCatalog,
  value,
  onChange,
  allowClear = true,
  presets: allPresets = [],
  presentation = 'form',
  reasoningEmptyLabel = 'Inherit reasoning',
  projectId,
  promptCache1h,
  onPromptCache1hChange,
}: RuntimePickerProps) {
  const { data: installed } = useQuery({
    queryKey: queryKeys.projectHarnesses(projectId ?? ''),
    queryFn: () => fetchProjectHarnesses(projectId!),
    enabled: !!projectId,
    staleTime: 30_000,
  });
  const harnessIds = installed?.harnessIds;
  const catalog = useMemo(
    () => restrictCatalogHarnesses(fullCatalog, harnessIds, value?.harnessId),
    [fullCatalog, harnessIds, value?.harnessId],
  );
  const presets = harnessIds
    ? allPresets.filter(
        (item) =>
          item.selection.harnessId === value?.harnessId ||
          harnessIds.includes(item.selection.harnessId),
      )
    : allPresets;
  const model = catalog?.models.find((item) => item.id === value?.modelId);
  const binding = model?.bindings.find(
    (item) => item.harnessId === value?.harnessId,
  );
  // Auto and the harness's own default first, then discovered models, then
  // the rest in catalog order.
  const compatibleModels = useMemo(() => {
    const rank = (item: RuntimeCatalog['models'][number]) => {
      const own = item.bindings.find(
        (candidate) => candidate.harnessId === value?.harnessId,
      );
      if (item.id === 'auto' || !own?.model) return 0;
      return item.discovered ? 1 : 2;
    };
    return (
      catalog?.models
        .filter((item) =>
          item.bindings.some(
            (candidate) => candidate.harnessId === value?.harnessId,
          ),
        )
        .sort((a, b) => rank(a) - rank(b)) ?? []
    );
  }, [catalog, value?.harnessId]);

  if (!catalog) return null;

  const select = (next: RuntimeSelection) => {
    const normalized = normalizeRuntimePickerSelection(catalog, next);
    if (normalized) onChange(normalized);
  };

  const selectHarness = (harnessId: string) => {
    const models = catalog.models.filter((item) =>
      item.bindings.some((candidate) => candidate.harnessId === harnessId),
    );
    const nextModel =
      models.find((item) => item.id === value?.modelId) ??
      models.find((item) => item.id === catalog.defaults.chat.modelId) ??
      models[0];
    if (!nextModel) return;
    select({ harnessId, modelId: nextModel.id, reasoning: value?.reasoning });
  };

  if (presentation === 'panel' && value) {
    const reasoningOptions = binding?.reasoning.options ?? [];
    const isClaudeHarness =
      catalog.harnesses.find((item) => item.id === value.harnessId)
        ?.sessionFamily === 'claude';
    return (
      <RuntimePickerPanel
        harnesses={catalog.harnesses}
        models={compatibleModels}
        reasoningOptions={reasoningOptions}
        value={value}
        reasoningValue={value.reasoning ?? binding?.reasoning.default}
        presets={presets}
        promptCache={
          isClaudeHarness &&
          promptCache1h !== undefined &&
          onPromptCache1hChange
            ? { enabled: promptCache1h, onChange: onPromptCache1hChange }
            : undefined
        }
        onHarness={selectHarness}
        onModel={(modelId) => select({ ...value, modelId })}
        onReasoning={(reasoning) => select({ ...value, reasoning })}
        onPreset={(preset) => select(preset.selection)}
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      <Select
        className="w-full"
        value={value?.harnessId ?? ''}
        aria-label="Runtime"
        onValueChange={(nextValue) => {
          if (!nextValue) return allowClear && onChange(null);
          selectHarness(nextValue);
        }}
      >
        {allowClear && <SelectItem value="">Default runtime</SelectItem>}
        {catalog.harnesses.map((harness) => (
          <SelectItem key={harness.id} value={harness.id}>
            {harness.label}
          </SelectItem>
        ))}
      </Select>
      <Select
        className="w-full"
        value={value?.modelId ?? ''}
        aria-label="Model"
        disabled={!value?.harnessId}
        onValueChange={(nextValue) =>
          select({
            harnessId: value!.harnessId,
            modelId: nextValue,
            reasoning: value?.reasoning,
          })
        }
      >
        {!value?.modelId && <SelectItem value="">Model</SelectItem>}
        {compatibleModels.map((compatibleModel) => (
          <SelectItem key={compatibleModel.id} value={compatibleModel.id}>
            {compatibleModel.label}
            {compatibleModel.unavailable ? ' (unavailable)' : ''}
          </SelectItem>
        ))}
      </Select>
      <Select
        className="w-full"
        value={value?.reasoning ?? ''}
        aria-label="Reasoning"
        disabled={!binding || binding.reasoning.options.length === 0}
        onValueChange={(nextValue) =>
          onChange({ ...value!, reasoning: nextValue || undefined })
        }
      >
        <SelectItem value="">{reasoningEmptyLabel}</SelectItem>
        {binding?.reasoning.options.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
      </Select>
      {presets.length > 0 && (
        <Select
          className="w-full"
          value=""
          aria-label="Preset"
          onValueChange={(nextValue) => {
            const preset = presets.find((item) => item.id === nextValue);
            if (preset) select(preset.selection);
          }}
        >
          <SelectItem value="">Preset</SelectItem>
          {presets.map((preset) => (
            <SelectItem key={preset.id} value={preset.id}>
              {preset.label}
            </SelectItem>
          ))}
        </Select>
      )}
    </div>
  );
}

interface RuntimePickerPanelProps {
  harnesses: RuntimeCatalog['harnesses'];
  models: RuntimeCatalog['models'];
  reasoningOptions: string[];
  value: RuntimeSelection;
  reasoningValue?: string;
  presets: RuntimeCatalog['presets'];
  promptCache?: { enabled: boolean; onChange: (enabled: boolean) => void };
  onHarness: (harnessId: string) => void;
  onModel: (modelId: string) => void;
  onReasoning: (reasoning: string) => void;
  onPreset: (preset: RuntimeCatalog['presets'][number]) => void;
}

const capitalize = (text: string) => text[0].toUpperCase() + text.slice(1);

/** Single-surface picker: harness icons, model list, reasoning slider, presets button. */
function RuntimePickerPanel({
  harnesses,
  models,
  reasoningOptions,
  value,
  reasoningValue,
  presets,
  promptCache,
  onHarness,
  onModel,
  onReasoning,
  onPreset,
}: RuntimePickerPanelProps) {
  const reasoningIndex = reasoningValue
    ? reasoningOptions.indexOf(reasoningValue)
    : -1;
  const lastIndex = reasoningOptions.length - 1;
  const pointPosition = (index: number) => `${(index / lastIndex) * 100}%`;

  // Scroll the selected model into view when the panel opens or the selection
  // changes, not on every re-render (that would fight the user's own scrolling).
  const modelListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    modelListRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [value.modelId]);

  return (
    <div data-ui="runtime-picker-panel" className="flex flex-col gap-2">
      <div
        data-ui="runtime-harness-grid"
        role="radiogroup"
        aria-label="Harness"
        className="flex flex-wrap gap-1"
      >
        {harnesses.map((harness) => {
          const selected = harness.id === value.harnessId;
          return (
            <button
              key={harness.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={harness.label}
              title={harness.label}
              data-ui="runtime-harness-option"
              data-harness-id={harness.id}
              className={cn(
                'flex size-8 items-center justify-center rounded-md border outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                selected
                  ? 'border-primary/60 bg-primary/15'
                  : 'border-transparent hover:bg-accent',
              )}
              onClick={() => onHarness(harness.id)}
            >
              <RuntimeHarnessIcon icon={harness.icon} className="size-6" />
            </button>
          );
        })}
      </div>

      <div
        ref={modelListRef}
        data-ui="runtime-model-list"
        role="listbox"
        aria-label="Model"
        className="h-41 overflow-y-auto rounded-md border border-border/60 p-0.5"
      >
        {models.map((model) => {
          const selected = model.id === value.modelId;
          return (
            <button
              key={model.id}
              type="button"
              role="option"
              aria-selected={selected}
              data-ui="runtime-model-option"
              data-model-id={model.id}
              className={cn(
                'flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-xs outline-hidden hover:bg-accent focus-visible:bg-accent sm:text-sm',
                selected && 'bg-accent',
              )}
              onClick={() => onModel(model.id)}
            >
              <Check
                className={cn(
                  'size-3.5 shrink-0',
                  selected ? 'opacity-100' : 'opacity-0',
                )}
              />
              <span
                data-ui="runtime-model-label"
                data-discovered={model.discovered ? '' : undefined}
                className={cn(
                  'min-w-0 truncate',
                  model.discovered && 'text-primary',
                )}
              >
                {model.label}
              </span>
              {model.unavailable && (
                <span
                  data-ui="runtime-model-unavailable"
                  className="ml-auto shrink-0 text-[10px] text-muted-foreground"
                >
                  unavailable
                </span>
              )}
            </button>
          );
        })}
      </div>

      {reasoningOptions.length <= 1 ? (
        // Placeholder keeps the panel height stable when the model has no
        // reasoning levels, so the popover does not resize on model changes.
        <div data-ui="runtime-reasoning-placeholder" className="h-12" />
      ) : (
        <div data-ui="runtime-reasoning-slider" className="px-5 pb-1 pt-1">
          <Slider.Root
            aria-label="Reasoning"
            min={0}
            max={lastIndex}
            step={1}
            value={[Math.max(reasoningIndex, 0)]}
            onValueChange={([index]) => onReasoning(reasoningOptions[index])}
            className="relative flex h-5 w-full touch-none items-center select-none"
          >
            <Slider.Track className="relative h-1 grow rounded-full bg-muted">
              <Slider.Range
                className={cn(
                  'absolute h-full rounded-full bg-primary/70',
                  reasoningIndex < 0 && 'hidden',
                )}
              />
              {reasoningOptions.map((option, index) => (
                <span
                  key={option}
                  aria-hidden="true"
                  className={cn(
                    'absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full',
                    index <= reasoningIndex ? 'bg-primary' : 'bg-border',
                  )}
                  style={{ left: pointPosition(index) }}
                />
              ))}
            </Slider.Track>
            <Slider.Thumb
              className={cn(
                'block size-4 rounded-full border-2 border-primary bg-background shadow outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
                reasoningIndex < 0 && 'opacity-40',
              )}
            />
          </Slider.Root>
          <div className="relative mt-1 h-4">
            {reasoningOptions.map((option, index) => (
              <button
                key={option}
                type="button"
                tabIndex={-1}
                data-ui="runtime-reasoning-point"
                data-reasoning={option}
                className={cn(
                  'absolute -translate-x-1/2 text-[10px] leading-4 whitespace-nowrap text-muted-foreground',
                  index === reasoningIndex && 'font-medium text-foreground',
                )}
                style={{ left: pointPosition(index) }}
                onClick={() => onReasoning(option)}
              >
                {capitalize(option)}
              </button>
            ))}
          </div>
        </div>
      )}

      {promptCache && (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            data-ui="runtime-prompt-cache-toggle"
            aria-pressed={promptCache.enabled}
            title="Claude only. Keeps the cached conversation for 1 hour instead of 5 minutes, so replies after a longer pause stay fast and cheap. Each cache write costs more (2× instead of 1.25× the input price)."
            className={cn(
              'flex h-8 w-full items-center gap-2 rounded-md border px-2 text-xs outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring sm:text-sm',
              promptCache.enabled
                ? 'border-primary/60 bg-primary/15 text-foreground'
                : 'border-border/60 text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
            onClick={() => promptCache.onChange(!promptCache.enabled)}
          >
            <Hourglass className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">
              {promptCache.enabled ? '1-hour cache' : '5-minute cache'}
            </span>
          </button>
          <p className="px-1 text-[10px] text-muted-foreground">
            Applies from the next message.
          </p>
        </div>
      )}

      {presets.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <FieldTrigger
              compact
              data-ui="runtime-presets-trigger"
              className="w-full text-muted-foreground"
            >
              Presets
            </FieldTrigger>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="start"
            collisionPadding={8}
            className="max-h-60 w-(--radix-dropdown-menu-trigger-width)"
          >
            {presets.map((preset) => (
              <DropdownMenuItem
                key={preset.id}
                className="text-xs sm:text-sm"
                onSelect={() => onPreset(preset)}
              >
                {preset.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
