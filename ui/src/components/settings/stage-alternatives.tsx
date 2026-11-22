import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { Select, SelectItem } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { RuntimePicker } from '@/components/chat/runtime-picker';
import type { RuntimeCatalog } from '@/lib/api';
import { StageRuntimeLabel } from './stage-runtime-label';
import {
  alternativeSuffix,
  nextFreeSuffix,
  stageAlternatives,
  validateAlternativeSuffix,
  variantLabel,
} from '@/lib/ab';
import type { StageDefinition } from '@/types';

interface StageAlternativesProps {
  /** The base stage the alternatives belong to. */
  base: StageDefinition;
  /** The complete stage list, alternatives included. */
  stages: StageDefinition[];
  onChange: (stages: StageDefinition[]) => void;
  runtimeCatalog?: RuntimeCatalog;
  availableAiUsers?: { id: string; name: string }[];
  /** Reports whether any suffix draft is invalid (unsaved-able) for this base. */
  onInvalidChange?: (baseId: string, invalid: boolean) => void;
}

/** Whole seconds of a millisecond stage setting, as input text. */
function secondsText(ms: number | undefined): string {
  return ms == null ? '' : String(ms / 1000);
}

/** Milliseconds for an input in seconds; empty or invalid input clears it. */
function secondsToMs(text: string, allowZero: boolean): number | undefined {
  const seconds = Number(text);
  if (text.trim() === '' || !Number.isFinite(seconds)) return undefined;
  if (seconds < 0 || (!allowZero && seconds === 0)) return undefined;
  return Math.round(seconds * 1000);
}

/**
 * Indented alternative sub-rows under an executable base stage. An alternative
 * (`coding.b`) overrides only run configuration; type, title, color and order
 * always come from the base stage.
 */
export function StageAlternatives({
  base,
  stages,
  onChange,
  runtimeCatalog,
  availableAiUsers,
  onInvalidChange,
}: StageAlternativesProps) {
  const alternatives = stageAlternatives(stages, base.id);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Suffix text being typed. It only becomes the alternative's id once valid.
  const [suffixDrafts, setSuffixDrafts] = useState<Record<string, string>>({});

  // A draft that differs from the committed suffix is unconfirmed: Save stays
  // blocked until it is committed (valid) or reverted on blur.
  const hasUnconfirmedSuffix = alternatives.some(
    (alternative) =>
      suffixDrafts[alternative.id] !== undefined &&
      suffixDrafts[alternative.id] !== alternativeSuffix(alternative.id),
  );
  useEffect(() => {
    onInvalidChange?.(base.id, hasUnconfirmedSuffix);
    return () => onInvalidChange?.(base.id, false);
  }, [onInvalidChange, base.id, hasUnconfirmedSuffix]);

  const updateAlternative = (id: string, updates: Partial<StageDefinition>) =>
    onChange(
      stages.map((stage) =>
        stage.id === id ? { ...stage, ...updates } : stage,
      ),
    );

  const addAlternative = () => {
    const suffix = nextFreeSuffix(stages, base.id);
    const alternative: StageDefinition = {
      id: `${base.id}.${suffix}`,
      title: `${base.title} ${variantLabel(suffix)}`,
      type: base.type,
      color: base.color,
    };
    onChange([...stages, alternative]);
    setExpandedId(alternative.id);
  };

  const removeAlternative = (id: string) => {
    onChange(stages.filter((stage) => stage.id !== id));
    discardDraft(id);
    if (expandedId === id) setExpandedId(null);
  };

  const discardDraft = (id: string) =>
    setSuffixDrafts((drafts) => {
      const { [id]: _discarded, ...rest } = drafts;
      return rest;
    });

  // Typing only updates the raw draft. The stage id changes when the field is
  // committed, so an unconfirmed intermediate suffix is never saved.
  const editSuffix = (alternative: StageDefinition, text: string) =>
    setSuffixDrafts((drafts) => ({ ...drafts, [alternative.id]: text }));

  // Commit a valid draft as the alternative's id; revert an invalid one.
  const commitSuffix = (alternative: StageDefinition) => {
    const draft = suffixDrafts[alternative.id];
    if (draft === undefined) return;
    discardDraft(alternative.id);
    const nextId = `${base.id}.${draft}`;
    if (
      nextId === alternative.id ||
      validateAlternativeSuffix(draft, base.id, stages, alternative.id)
    ) {
      return;
    }
    onChange(
      stages.map((stage) =>
        stage.id === alternative.id
          ? {
              ...stage,
              id: nextId,
              title: `${base.title} ${variantLabel(draft)}`,
            }
          : stage,
      ),
    );
    setExpandedId(nextId);
  };

  return (
    <div
      data-ui="stage-editor-alternatives"
      data-stage-id={base.id}
      className="ml-5 space-y-2 border-l border-border pl-3"
    >
      {alternatives.map((alternative, index) => {
        const suffix = alternativeSuffix(alternative.id);
        const draft = suffixDrafts[alternative.id] ?? suffix;
        const suffixError = validateAlternativeSuffix(
          draft,
          base.id,
          stages,
          alternative.id,
        );
        const expanded = expandedId === alternative.id;
        const fieldId = `stage-alternative-${index}-${base.id}`;
        return (
          <div
            // Position, not id, keeps the suffix input mounted while renaming.
            key={index}
            data-ui="stage-editor-alternative"
            data-stage-id={alternative.id}
            data-base-stage-id={base.id}
            className="rounded-md border border-border bg-muted/10"
          >
            <div className="flex items-center gap-2 px-2 py-1.5">
              <button
                type="button"
                data-ui="stage-alternative-header"
                data-stage-id={alternative.id}
                aria-expanded={expanded}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setExpandedId(expanded ? null : alternative.id)}
              >
                {expanded ? (
                  <ChevronDown className="size-3 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-3 text-muted-foreground" />
                )}
                <span
                  data-ui="stage-alternative-variant"
                  className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary"
                >
                  {variantLabel(suffix)}
                </span>
                <span className="min-w-[4.5rem] flex-1 truncate font-mono text-xs text-muted-foreground">
                  {alternative.id}
                </span>
                <StageRuntimeLabel
                  selection={alternative.runtimeSelection}
                  catalog={runtimeCatalog}
                />
                {suffixError && !expanded && (
                  <span
                    data-ui="stage-alternative-header-invalid"
                    className="shrink-0 text-[11px] text-destructive"
                  >
                    Invalid suffix
                  </span>
                )}
              </button>
              <Button
                data-ui="stage-alternative-remove"
                data-stage-id={alternative.id}
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                title="Remove alternative"
                aria-label={`Remove alternative ${alternative.id}`}
                onClick={() => removeAlternative(alternative.id)}
              >
                <Trash2 className="size-3" />
              </Button>
            </div>

            {expanded && (
              <div className="space-y-3 border-t border-border px-3 py-3">
                <p className="text-[11px] text-muted-foreground">
                  Overrides run settings only; anything left empty inherits from{' '}
                  {base.title || base.id}.
                </p>
                <div className="space-y-1">
                  <label
                    className="text-xs text-muted-foreground"
                    htmlFor={`${fieldId}-suffix`}
                  >
                    Variant suffix
                  </label>
                  <Input
                    id={`${fieldId}-suffix`}
                    data-ui="stage-alternative-suffix"
                    data-stage-id={alternative.id}
                    value={draft}
                    maxLength={8}
                    aria-invalid={suffixError ? true : undefined}
                    onChange={(event) =>
                      editSuffix(alternative, event.target.value)
                    }
                    onBlur={() => commitSuffix(alternative)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return;
                      // Commit instead of letting the dialog save mid-edit.
                      event.preventDefault();
                      commitSuffix(alternative);
                    }}
                    className="font-mono"
                  />
                  {suffixError && (
                    <p
                      data-ui="stage-alternative-suffix-error"
                      className="text-[11px] text-destructive"
                    >
                      {suffixError} Fix it, or leave the field to revert.
                    </p>
                  )}
                </div>
                <div
                  data-ui="stage-alternative-runtime-picker"
                  data-stage-id={alternative.id}
                >
                  <RuntimePicker
                    catalog={runtimeCatalog}
                    value={alternative.runtimeSelection}
                    onChange={(value) =>
                      updateAlternative(alternative.id, {
                        runtimeSelection: value ?? undefined,
                      })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <label
                    className="text-xs text-muted-foreground"
                    htmlFor={`${fieldId}-persona`}
                  >
                    Main persona
                  </label>
                  <Select
                    compact
                    id={`${fieldId}-persona`}
                    data-ui="stage-alternative-persona"
                    data-stage-id={alternative.id}
                    value={alternative.mainAiUserId ?? ''}
                    onValueChange={(nextValue) =>
                      updateAlternative(alternative.id, {
                        mainAiUserId: nextValue || undefined,
                      })
                    }
                    className="w-full"
                  >
                    <SelectItem value="">Inherit from base stage</SelectItem>
                    {availableAiUsers?.map((aiUser) => (
                      <SelectItem key={aiUser.id} value={aiUser.id}>
                        {aiUser.name}
                      </SelectItem>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1">
                  <label
                    className="text-xs text-muted-foreground"
                    htmlFor={`${fieldId}-sandbox`}
                  >
                    Sandbox
                  </label>
                  <Input
                    id={`${fieldId}-sandbox`}
                    data-ui="stage-alternative-sandbox"
                    data-stage-id={alternative.id}
                    value={alternative.workerSandbox ?? ''}
                    onChange={(event) =>
                      updateAlternative(alternative.id, {
                        workerSandbox: event.target.value || undefined,
                      })
                    }
                    placeholder="Inherit from base stage"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label
                      className="text-xs text-muted-foreground"
                      htmlFor={`${fieldId}-stall-timeout`}
                    >
                      Stall timeout (seconds)
                    </label>
                    <Input
                      id={`${fieldId}-stall-timeout`}
                      data-ui="stage-alternative-stall-timeout"
                      data-stage-id={alternative.id}
                      type="number"
                      min={1}
                      value={secondsText(alternative.stallTimeoutMs)}
                      onChange={(event) =>
                        updateAlternative(alternative.id, {
                          stallTimeoutMs: secondsToMs(
                            event.target.value,
                            false,
                          ),
                        })
                      }
                      placeholder="Inherit"
                    />
                  </div>
                  <div className="space-y-1">
                    <label
                      className="text-xs text-muted-foreground"
                      htmlFor={`${fieldId}-stall-grace`}
                    >
                      Stall grace (seconds)
                    </label>
                    <Input
                      id={`${fieldId}-stall-grace`}
                      data-ui="stage-alternative-stall-grace"
                      data-stage-id={alternative.id}
                      type="number"
                      min={0}
                      value={secondsText(alternative.stallGraceMs)}
                      onChange={(event) =>
                        updateAlternative(alternative.id, {
                          stallGraceMs: secondsToMs(event.target.value, true),
                        })
                      }
                      placeholder="Inherit"
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <label
                    className="text-xs text-muted-foreground"
                    htmlFor={`${fieldId}-record`}
                  >
                    Record session
                  </label>
                  <Select
                    compact
                    id={`${fieldId}-record`}
                    data-ui="stage-alternative-record-toggle"
                    data-stage-id={alternative.id}
                    value={
                      alternative.record === undefined
                        ? 'inherit'
                        : alternative.record
                          ? 'on'
                          : 'off'
                    }
                    onValueChange={(nextValue) =>
                      updateAlternative(alternative.id, {
                        record:
                          nextValue === 'inherit'
                            ? undefined
                            : nextValue === 'on',
                      })
                    }
                    className="w-full"
                  >
                    <SelectItem value="inherit">
                      Inherit from base stage
                    </SelectItem>
                    <SelectItem value="on">Record</SelectItem>
                    <SelectItem value="off">Do not record</SelectItem>
                  </Select>
                </div>
                <div className="space-y-1">
                  <label
                    className="text-xs text-muted-foreground"
                    htmlFor={`${fieldId}-prompt`}
                  >
                    Stage prompt
                  </label>
                  <Textarea
                    id={`${fieldId}-prompt`}
                    data-ui="stage-alternative-prompt"
                    data-stage-id={alternative.id}
                    value={alternative.workerPrompt ?? ''}
                    onChange={(event) =>
                      updateAlternative(alternative.id, {
                        workerPrompt: event.target.value || undefined,
                      })
                    }
                    placeholder={`Saved as stage-${alternative.id}.md; empty uses the ${base.title || base.id} prompt`}
                    rows={base.type === 'review' ? 5 : 3}
                  />
                </div>
              </div>
            )}
          </div>
        );
      })}
      <Button
        type="button"
        data-ui="stage-alternative-add"
        data-stage-id={base.id}
        variant="ghost"
        size="sm"
        className="h-7 text-xs"
        onClick={addAlternative}
      >
        <Plus className="size-3" />
        Add alternative
      </Button>
    </div>
  );
}
