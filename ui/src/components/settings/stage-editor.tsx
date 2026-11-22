import { useCallback, useEffect, useRef, useState } from 'react';
import { Select, SelectItem } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  ArrowUp,
  ArrowDown,
  ChevronDown,
  ChevronRight,
  Trash2,
  Plus,
  RotateCcw,
} from 'lucide-react';
import type { StageDefinition, StageType } from '@/types';
import type { StageMigration, StageOccupancy } from '@/types';
import {
  DEFAULT_STAGES,
  isStageAlternativeId,
  STAGE_ID_PATTERN,
} from '@/lib/stages';
import type { RuntimeCatalog } from '@/lib/api';
import { StageRuntimeLabel } from './stage-runtime-label';
import { RuntimePicker } from '@/components/chat/runtime-picker';
import { StageAlternatives } from '@/components/settings/stage-alternatives';
import { alternativeBaseId, canHaveStageAlternatives } from '@/lib/ab';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface AvailableAiUser {
  id: string;
  name: string;
}

interface StageEditorProps {
  stages: StageDefinition[];
  onChange: (stages: StageDefinition[]) => void;
  runtimeCatalog?: RuntimeCatalog;
  availableAiUsers?: AvailableAiUser[];
  occupancy?: StageOccupancy[];
  stageMigrations?: StageMigration[];
  onStageMigrationsChange?: (migrations: StageMigration[]) => void;
  occupancyStatus?: 'loading' | 'error' | 'ready';
  onRetryOccupancy?: () => void;
  openRemovalStageId?: string;
  openRemovalPipeline?: StageDefinition[];
  onRemovalStageConsumed?: () => void;
  onRemovalApplied?: () => void;
  onRemovalCancelled?: () => void;
  resetStages?: StageDefinition[];
  resetLabel?: string;
  /** True while any alternative suffix draft is invalid and cannot be saved. */
  onSuffixInvalidChange?: (invalid: boolean) => void;
}

const STAGE_TYPES: { value: StageType; label: string; description: string }[] =
  [
    { value: 'queue', label: 'Queue', description: 'Manual / waiting' },
    { value: 'active', label: 'Active', description: 'Triggers execution' },
    {
      value: 'testing',
      label: 'Testing',
      description: 'Read-only validation with programmatic transitions',
    },
    {
      value: 'review',
      label: 'Review',
      description:
        'QA review — runs agent, tracks quality score and rejections',
    },
    { value: 'done', label: 'Done', description: 'Terminal' },
  ];

function stageName(stage: StageDefinition): string {
  return stage.title || '(untitled)';
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/** Slug of a title that does not collide with `takenIds`: `testing`, `testing_2`, ... */
function uniqueSlug(title: string, takenIds: Set<string>): string {
  const base = slugify(title);
  if (!base) return '';
  let slug = base;
  for (let n = 2; takenIds.has(slug); n++) slug = `${base}_${n}`;
  return slug;
}

function stageTypeUpdates(type: StageType): Partial<StageDefinition> {
  return { type };
}

/**
 * Alternatives of a row whose id was edited to match another row's id. Two
 * rows cannot both carry `<id>.b` without one overwriting the other, so the
 * edited row's alternatives wait here (by row, not id) until its id is unique.
 */
const parkedAlternatives = new WeakMap<
  StageDefinition,
  { suffix: string; stage: StageDefinition }[]
>();

/** Base stages: the rows shown and the destinations offered for a removal. */
function stageRows(stages: StageDefinition[]): StageDefinition[] {
  return stages.filter((stage) => !isStageAlternativeId(stage.id));
}

/**
 * Full stage list for a change to the rows. Alternatives (`coding.b`) are run
 * config, not rows, so they are carried over from the current list (and any
 * supplied list) and kept while their base stage remains. Removing a base
 * stage, or changing it to a type without alternatives, also drops them, since
 * validation rejects an orphan.
 */
function withStageAlternatives(
  current: StageDefinition[],
  next: StageDefinition[],
): StageDefinition[] {
  const rows = stageRows(next);
  const alternatives = new Map<string, StageDefinition>();
  for (const stage of [...current, ...next]) {
    if (isStageAlternativeId(stage.id)) alternatives.set(stage.id, stage);
  }
  // Alternatives parked while their row shared an id come back under the row's
  // id once it is unique again.
  for (const row of rows) {
    const parked = parkedAlternatives.get(row);
    if (!parked || rows.some((other) => other !== row && other.id === row.id))
      continue;
    parkedAlternatives.delete(row);
    for (const { suffix, stage } of parked) {
      const id = `${row.id}${suffix}`;
      alternatives.set(id, { ...stage, id });
    }
  }
  const kept = [...alternatives.values()].filter((alternative) =>
    rows.some(
      (stage) =>
        stage.id === alternativeBaseId(alternative.id) &&
        canHaveStageAlternatives(stage),
    ),
  );
  return [...rows, ...kept];
}

// Id each row object had when it entered the editor (null for a row added in
// this session). Only that id can hold board cards or own alternatives, so both
// follow the row rather than its draft id, which may equal another stage's id.
// Module-level so it survives the editor unmounting with its settings tab; the
// draft keeps the same row objects.
const rowOrigins = new WeakMap<StageDefinition, string | null>();
function originOf(row: StageDefinition): string | null {
  if (!rowOrigins.has(row)) rowOrigins.set(row, row.id);
  return rowOrigins.get(row) ?? null;
}

export function StageEditor({
  stages,
  onChange,
  runtimeCatalog,
  availableAiUsers,
  occupancy = [],
  stageMigrations = [],
  onStageMigrationsChange,
  occupancyStatus = 'ready',
  onRetryOccupancy,
  openRemovalStageId,
  openRemovalPipeline,
  onRemovalStageConsumed,
  onRemovalApplied,
  onRemovalCancelled,
  resetStages,
  resetLabel = 'Reset',
  onSuffixInvalidChange,
}: StageEditorProps) {
  const invalidSuffixBases = useRef(new Set<string>());
  const reportSuffixInvalid = useCallback(
    (baseId: string, invalid: boolean) => {
      if (invalid) invalidSuffixBases.current.add(baseId);
      else invalidSuffixBases.current.delete(baseId);
      onSuffixInvalidChange?.(invalidSuffixBases.current.size > 0);
    },
    [onSuffixInvalidChange],
  );
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<StageDefinition | null>(
    null,
  );
  const [destinationStageId, setDestinationStageId] = useState('');
  const [removalError, setRemovalError] = useState<string | null>(null);
  const [pendingPipeline, setPendingPipeline] = useState<
    StageDefinition[] | null
  >(null);
  const [remainingRemovals, setRemainingRemovals] = useState<StageDefinition[]>(
    [],
  );
  const [pendingMigrations, setPendingMigrations] = useState<StageMigration[]>(
    [],
  );
  // Ids of stages added in this session whose id still follows their title.
  const autoSlugIds = useRef(new Set<string>());
  const stageDefinitions = useRef(new Map<string, StageDefinition>());
  stages.forEach((stage) => stageDefinitions.current.set(stage.id, stage));
  const rows = stageRows(stages);
  const sharesId = (index: number) =>
    rows.some((other, i) => i !== index && other.id === rows[index].id);
  // A row whose id an earlier row already uses is the duplicate.
  const isDuplicateId = (index: number) =>
    rows.slice(0, index).some((row) => row.id === rows[index].id);

  useEffect(() => {
    if (!openRemovalStageId || occupancyStatus !== 'ready' || pendingRemoval)
      return;
    const rowStages = stageRows(stages);
    const source = rowStages.find((stage) => stage.id === openRemovalStageId);
    if (!source) return;
    const prospectivePipeline =
      openRemovalPipeline ??
      rowStages.filter((stage) => stage.id !== source.id);
    const occupiedRemoved = rowStages.filter(
      (stage) =>
        !prospectivePipeline.some((candidate) => candidate.id === stage.id) &&
        (occupancy.find((item) => item.stageId === stage.id)?.total ?? 0) > 0,
    );
    setPendingPipeline(prospectivePipeline);
    setPendingMigrations(
      stageMigrations.filter((migration) =>
        prospectivePipeline.some(
          (stage) => stage.id === migration.destinationStageId,
        ),
      ),
    );
    setRemainingRemovals(
      occupiedRemoved.filter((stage) => stage.id !== source.id),
    );
    setDestinationStageId('');
    setRemovalError(null);
    setPendingRemoval(source);
    onRemovalStageConsumed?.();
  }, [
    openRemovalStageId,
    occupancyStatus,
    stages,
    pendingRemoval,
    openRemovalPipeline,
    onRemovalStageConsumed,
    occupancy,
    stageMigrations,
  ]);

  const applyPipeline = (
    next: StageDefinition[],
    migrations: StageMigration[],
  ) => {
    onChange(withStageAlternatives(stages, next));
    onStageMigrationsChange?.(
      migrations.filter(
        (migration) =>
          !next.some((stage) => stage.id === migration.sourceStageId) &&
          (pendingPipeline ?? next).some(
            (stage) => stage.id === migration.destinationStageId,
          ),
      ),
    );
    setPendingPipeline(null);
    setRemainingRemovals([]);
    setPendingMigrations([]);
    setExpandedIndex(null);
  };

  const requestPipelineChange = (next: StageDefinition[]) => {
    const removed = rows.filter(
      (stage) => !next.some((candidate) => candidate.id === stage.id),
    );
    if (removed.length === 0) {
      applyPipeline(next, stageMigrations);
      return;
    }
    if (occupancyStatus !== 'ready') return;
    const removedIds = new Set(removed.map((stage) => stage.id));
    const invalidatedSources = stageMigrations
      .filter((migration) => removedIds.has(migration.destinationStageId))
      .map((migration) => migration.sourceStageId);
    const occupied = removed.filter(
      (stage) =>
        (occupancy.find((item) => item.stageId === stage.id)?.total ?? 0) > 0,
    );
    for (const sourceStageId of invalidatedSources) {
      if (!occupied.some((stage) => stage.id === sourceStageId)) {
        const source = stageDefinitions.current.get(sourceStageId);
        if (source) occupied.push(source);
      }
    }
    const existing = stageMigrations.filter((migration) =>
      next.some((stage) => stage.id === migration.destinationStageId),
    );
    if (occupied.length === 0) {
      applyPipeline(next, existing);
      return;
    }
    setPendingPipeline(next);
    setPendingMigrations(existing);
    setRemainingRemovals(occupied.slice(1));
    setDestinationStageId('');
    setRemovalError(null);
    setPendingRemoval(occupied[0]);
  };

  // Cards in a stage or in any of its alternatives; null while occupancy loads.
  const stageCardCount = (stageId: string): number | null => {
    if (occupancyStatus !== 'ready') return null;
    return occupancy
      .filter(
        (item) =>
          item.stageId === stageId ||
          (isStageAlternativeId(item.stageId) &&
            alternativeBaseId(item.stageId) === stageId),
      )
      .reduce((sum, item) => sum + item.total, 0);
  };
  // Explains why a row's id cannot be renamed; null when it can.
  const idLockHint = (index: number): string | null => {
    const origin = originOf(rows[index]);
    if (origin === null) return null;
    const count = stageCardCount(origin);
    if (count === null) return 'Checking cards...';
    if (count === 0) return null;
    return `${count} ${count === 1 ? 'card is' : 'cards are'} in this stage; move them before renaming its id.`;
  };
  const isIdLocked = (index: number) => idLockHint(index) !== null;

  const ownedAlternatives = (baseId: string) =>
    stages.filter(
      (stage) =>
        isStageAlternativeId(stage.id) &&
        alternativeBaseId(stage.id) === baseId,
    );

  const updateStage = (index: number, updates: Partial<StageDefinition>) => {
    const row = rows[index];
    const updated = { ...row, ...updates };
    rowOrigins.set(updated, originOf(row));
    const held = parkedAlternatives.get(row);
    if (held) parkedAlternatives.set(updated, held);
    let next = rows.map((s, i) => (i === index ? updated : s));
    const previousId = row.id;
    // Alternatives (`testing.b`) are keyed by their base id, so rows sharing an
    // id cannot both own them in the flat list. A row in such a group holds its
    // alternatives itself (parkedAlternatives); the flat list has none under a
    // shared id, and each row gets its own back once its id is unique.
    let renamed = stages;
    if (updates.id !== undefined && updates.id !== previousId) {
      const share = (id: string) =>
        rows.filter((other, i) => i !== index && other.id === id);
      const leavingGroup = sharesId(index);
      const joined = share(updates.id);
      const moving = leavingGroup ? [] : ownedAlternatives(previousId);
      const joinedOwn =
        joined.length === 1 ? ownedAlternatives(updates.id) : [];
      const parkAlternatives = (
        target: StageDefinition,
        own: StageDefinition[],
      ) =>
        parkedAlternatives.set(target, [
          ...(parkedAlternatives.get(target) ?? []),
          ...own.map((stage) => ({
            suffix: stage.id.slice(alternativeBaseId(stage.id).length),
            stage,
          })),
        ]);
      if (joined.length > 0) {
        parkAlternatives(updated, moving);
        if (joinedOwn.length > 0) {
          // Hold them on a draft-only copy: the original row may be shared
          // (e.g. cached saved settings) and outlive a cancelled draft.
          const copy = { ...joined[0] };
          rowOrigins.set(copy, originOf(joined[0]));
          parkAlternatives(copy, joinedOwn);
          next = next.map((stage) => (stage === joined[0] ? copy : stage));
        }
        const parkedIds = new Set(
          [...moving, ...joinedOwn].map((stage) => stage.id),
        );
        renamed = stages.filter((stage) => !parkedIds.has(stage.id));
      } else if (moving.length > 0) {
        const movingIds = new Set(moving.map((stage) => stage.id));
        renamed = stages.map((stage) =>
          movingIds.has(stage.id)
            ? {
                ...stage,
                id: `${updates.id}${stage.id.slice(previousId.length)}`,
              }
            : stage,
        );
      }
    }
    onChange(withStageAlternatives(renamed, next));
    onStageMigrationsChange?.(
      stageMigrations.filter(
        (migration) =>
          !next.some((stage) => stage.id === migration.sourceStageId) &&
          next.some((stage) => stage.id === migration.destinationStageId),
      ),
    );
  };

  const moveStage = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    [next[index], next[target]] = [next[target], next[index]];
    requestPipelineChange(next);
    setExpandedIndex(target);
  };

  const removeStage = (index: number) => {
    requestPipelineChange(rows.filter((_, i) => i !== index));
  };

  const confirmRemoval = () => {
    if (!pendingRemoval || !destinationStageId) {
      setRemovalError('Choose a destination stage.');
      return;
    }
    const migrations = [
      ...(pendingPipeline ? pendingMigrations : stageMigrations).filter(
        (migration) => migration.sourceStageId !== pendingRemoval.id,
      ),
      { sourceStageId: pendingRemoval.id, destinationStageId },
    ];
    if (remainingRemovals.length > 0 && pendingPipeline) {
      setPendingMigrations(migrations);
      setRemainingRemovals(remainingRemovals.slice(1));
      setDestinationStageId('');
      setPendingRemoval(remainingRemovals[0]);
      return;
    }
    applyPipeline(
      pendingPipeline ?? rows.filter((stage) => stage.id !== pendingRemoval.id),
      migrations,
    );
    setPendingRemoval(null);
    setExpandedIndex(null);
    onRemovalApplied?.();
  };

  const cancelRemoval = () => {
    setPendingRemoval(null);
    setPendingPipeline(null);
    setRemainingRemovals([]);
    setPendingMigrations([]);
    onRemovalCancelled?.();
  };

  const addStage = () => {
    const newStage: StageDefinition = {
      id: `stage_${Date.now()}`,
      title: '',
      type: 'queue',
      // Persisted stage colour (the color input needs a hex); rendered as
      // graphical dots/bars where #8B8FA3 keeps >= 3:1 on both themes.
      color: '#8B8FA3',
      inactive: false,
    };
    autoSlugIds.current.add(newStage.id);
    rowOrigins.set(newStage, null);
    requestPipelineChange([...rows, newStage]);
    setExpandedIndex(rows.length);
  };

  const resetToDefaults = () => {
    requestPipelineChange(
      (resetStages ?? DEFAULT_STAGES).map((s) => ({ ...s })),
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium">Stages</label>
        <Button
          variant="ghost"
          size="sm"
          onClick={resetToDefaults}
          className="h-7 text-xs"
        >
          <RotateCcw className="size-3" />
          {resetLabel}
        </Button>
      </div>

      <div className="space-y-2">
        {occupancyStatus !== 'ready' && (
          <div
            data-ui="stage-occupancy-status"
            className="rounded-md border border-amber-700 bg-amber-500/10 p-3 text-sm dark:border-amber-500/40"
          >
            {occupancyStatus === 'loading'
              ? 'Checking stage card usage…'
              : 'Could not check stage card usage. Stage removal is disabled until occupancy can be checked.'}
            {occupancyStatus === 'error' && onRetryOccupancy && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="ml-2"
                onClick={onRetryOccupancy}
              >
                Retry
              </Button>
            )}
          </div>
        )}
        {rows.map((stage, index) => (
          <div
            key={index}
            data-ui="stage-editor-stage"
            data-stage-id={stage.id}
            className={`rounded-md border border-border bg-muted/20 ${stage.inactive ? 'opacity-60' : ''}`}
          >
            {/* Stage row */}
            <div className="flex items-center gap-2 px-2 py-1.5">
              <input
                type="color"
                value={stage.color}
                aria-label={`Colour of stage ${stageName(stage)}`}
                onChange={(e) => updateStage(index, { color: e.target.value })}
                className="size-5 shrink-0 rounded border-0 cursor-pointer p-0"
              />
              <button
                type="button"
                data-ui="stage-editor-stage-toggle"
                data-stage-id={stage.id}
                aria-expanded={expandedIndex === index}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() =>
                  setExpandedIndex(expandedIndex === index ? null : index)
                }
              >
                {expandedIndex === index ? (
                  <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                )}
                <span
                  className={`text-sm font-medium min-w-[4.5rem] flex-1 truncate ${stage.inactive ? 'line-through' : ''}`}
                >
                  {stageName(stage)}
                </span>
                <StageRuntimeLabel
                  selection={stage.runtimeSelection}
                  catalog={runtimeCatalog}
                />
                {stage.inactive && (
                  <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded uppercase tracking-wider text-muted-foreground mr-2 shrink-0">
                    Inactive
                  </span>
                )}
                <span className="shrink-0 text-[10px] text-muted-foreground uppercase tracking-wide">
                  {stage.type}
                </span>
              </button>
              <div className="flex gap-0.5">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  aria-label={`Move ${stageName(stage)} up`}
                  onClick={() => moveStage(index, -1)}
                  disabled={index === 0}
                >
                  <ArrowUp className="size-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  aria-label={`Move ${stageName(stage)} down`}
                  onClick={() => moveStage(index, 1)}
                  disabled={index === rows.length - 1}
                >
                  <ArrowDown className="size-3" />
                </Button>
                <Button
                  data-ui="stage-editor-remove"
                  data-source-stage-id={stage.id}
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                  aria-label={`Remove stage ${stageName(stage)}`}
                  onClick={() => removeStage(index)}
                  disabled={rows.length <= 1 || occupancyStatus !== 'ready'}
                >
                  <Trash2 className="size-3" />
                </Button>
              </div>
            </div>

            {/* Expanded details */}
            {expandedIndex === index && (
              <div className="border-t border-border px-3 py-3 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">
                      Title
                    </label>
                    <Input
                      value={stage.title}
                      onChange={(e) => {
                        const title = e.target.value;
                        const updates: Partial<StageDefinition> = { title };
                        // Only a just-added stage derives its id from the title,
                        // until its id is edited explicitly; renaming an
                        // existing id is an action on the ID field, and never
                        // allowed while cards are in it.
                        if (
                          autoSlugIds.current.has(stage.id) &&
                          !isIdLocked(index)
                        ) {
                          updates.id =
                            uniqueSlug(
                              title,
                              new Set(
                                rows
                                  .filter((_, i) => i !== index)
                                  .map((row) => row.id),
                              ),
                            ) || stage.id;
                          autoSlugIds.current.delete(stage.id);
                          autoSlugIds.current.add(updates.id);
                        }
                        updateStage(index, updates);
                      }}
                      placeholder="Stage title"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">
                      ID (slug)
                    </label>
                    <Input
                      value={stage.id}
                      disabled={isIdLocked(index)}
                      onChange={(e) => {
                        autoSlugIds.current.delete(stage.id);
                        updateStage(index, {
                          id: e.target.value
                            .toLowerCase()
                            .replace(/[^a-z0-9_]/g, ''),
                        });
                      }}
                      placeholder="stage_id"
                      className="font-mono"
                    />
                    {isIdLocked(index) && (
                      <p
                        data-ui="stage-editor-id-locked-hint"
                        className="text-[11px] text-muted-foreground"
                      >
                        {idLockHint(index)}
                      </p>
                    )}
                    {!STAGE_ID_PATTERN.test(stage.id) && (
                      <p
                        data-ui="stage-editor-id-invalid-error"
                        role="alert"
                        className="text-[11px] text-destructive"
                      >
                        Stage ID is required: start with a letter, then
                        lowercase letters, digits or underscores
                      </p>
                    )}
                    {isDuplicateId(index) && (
                      <p
                        data-ui="stage-editor-id-duplicate-error"
                        role="alert"
                        className="text-[11px] text-destructive"
                      >
                        Stage ID already used
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-1 flex-1 mr-4">
                    <label className="text-xs text-muted-foreground">
                      Type
                    </label>
                    <div
                      data-ui="stage-type-options"
                      className="grid grid-cols-2 gap-1 sm:flex"
                    >
                      {STAGE_TYPES.map((t) => (
                        <Button
                          key={t.value}
                          data-ui="stage-type-option"
                          data-stage-type={t.value}
                          variant={
                            stage.type === t.value ? 'default' : 'outline'
                          }
                          size="sm"
                          className="h-7 text-xs flex-1"
                          onClick={() =>
                            updateStage(index, stageTypeUpdates(t.value))
                          }
                          title={t.description}
                        >
                          {t.label}
                        </Button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-1 flex flex-col items-end">
                    <label
                      htmlFor={`stage-inactive-${index}-${stage.id}`}
                      className="text-xs text-muted-foreground"
                    >
                      Inactive
                    </label>
                    <Checkbox
                      id={`stage-inactive-${index}-${stage.id}`}
                      checked={!!stage.inactive}
                      onCheckedChange={(checked) =>
                        updateStage(index, { inactive: checked === true })
                      }
                    />
                  </div>
                </div>

                {/* Agent config is available for every stage. Executable stages
                    keep their ordinary run behavior; entry automation is opt-in. */}
                <div
                  data-ui="stage-agent-configuration"
                  data-stage-id={stage.id}
                  className="space-y-3 pt-2 border-t border-border/50"
                >
                  <p className="text-xs text-muted-foreground font-medium">
                    {stage.type === 'review'
                      ? 'Review Configuration'
                      : stage.type === 'testing'
                        ? 'Testing Configuration'
                        : stage.type === 'active'
                          ? 'Worker Configuration'
                          : 'Entry Agent Configuration'}
                  </p>
                  {stage.type === 'review' && (
                    <p className="text-[11px] text-muted-foreground bg-muted/40 rounded px-2 py-1.5">
                      Write your review criteria below. The system automatically
                      appends the required JSON output format and MCP tool
                      instructions.
                    </p>
                  )}
                  {stage.type === 'testing' && (
                    <p className="text-[11px] text-muted-foreground bg-muted/40 rounded px-2 py-1.5">
                      Testing runs are read-only. The system parses
                      pass/fail/blocked verdicts and owns every stage
                      transition.
                    </p>
                  )}
                  <div
                    data-ui="stage-persist-session"
                    data-stage-id={stage.id}
                    className="flex items-start gap-2 rounded-md border border-border bg-muted/20 p-3"
                  >
                    <Checkbox
                      id={`stage-persist-session-${index}`}
                      data-ui="stage-persist-session-toggle"
                      data-stage-id={stage.id}
                      checked={stage.persistSession ?? stage.type === 'active'}
                      onCheckedChange={(checked) =>
                        updateStage(index, { persistSession: checked === true })
                      }
                    />
                    <div>
                      <label
                        htmlFor={`stage-persist-session-${index}`}
                        className="text-xs font-medium leading-none"
                      >
                        Persist agent session
                      </label>
                      <p className="text-[11px] text-muted-foreground mt-1">
                        Resume this stage’s compatible agent session when the
                        task returns here. Disable for fresh-eyes testing or
                        review.
                      </p>
                    </div>
                  </div>
                  <div
                    data-ui="stage-run-on-entry"
                    data-stage-id={stage.id}
                    className="flex items-start gap-2 rounded-md border border-border bg-muted/20 p-3"
                  >
                    <Checkbox
                      id={`stage-run-on-entry-${index}`}
                      data-ui="stage-run-on-entry-toggle"
                      data-stage-id={stage.id}
                      checked={!!stage.runOnEntry}
                      onCheckedChange={(checked) =>
                        updateStage(index, { runOnEntry: checked === true })
                      }
                    />
                    <div>
                      <label
                        htmlFor={`stage-run-on-entry-${index}`}
                        className="text-xs font-medium leading-none"
                      >
                        Run one-shot agent on entry
                      </label>
                      <p className="text-[11px] text-muted-foreground mt-1">
                        {stage.type === 'active' ||
                        stage.type === 'testing' ||
                        stage.type === 'review'
                          ? 'Adds a one-shot entry run without changing this stage’s normal execution. A stage prompt alone does not enable entry automation.'
                          : 'When enabled, entering this stage starts one agent run. A stage prompt alone does not enable entry automation.'}
                      </p>
                      <p className="text-[11px] text-muted-foreground mt-1">
                        The agent should leave a concise resolution or handoff,
                        then move resolved work to an Active, Testing, or Review
                        stage.
                      </p>
                    </div>
                  </div>
                  <div data-ui="stage-runtime-picker" data-stage-id={stage.id}>
                    <RuntimePicker
                      catalog={runtimeCatalog}
                      value={stage.runtimeSelection}
                      onChange={(value) =>
                        updateStage(index, {
                          runtimeSelection: value ?? undefined,
                        })
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <label
                      className="text-xs text-muted-foreground"
                      htmlFor={`stage-main-persona-${index}`}
                    >
                      Main persona
                    </label>
                    <Select
                      compact
                      id={`stage-main-persona-${index}`}
                      data-ui="stage-main-persona"
                      data-stage-id={stage.id}
                      value={stage.mainAiUserId ?? ''}
                      onValueChange={(nextValue) =>
                        updateStage(index, {
                          mainAiUserId: nextValue || undefined,
                        })
                      }
                      className="w-full"
                    >
                      <SelectItem value="">No persona</SelectItem>
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
                      htmlFor={`stage-worker-prompt-${index}`}
                    >
                      {stage.type === 'review'
                        ? 'Review Criteria (Worker Prompt)'
                        : stage.type === 'queue' || stage.type === 'done'
                          ? 'Entry Prompt'
                          : 'Worker Prompt'}
                    </label>
                    <Textarea
                      id={`stage-worker-prompt-${index}`}
                      data-ui="stage-worker-prompt"
                      data-stage-id={stage.id}
                      value={stage.workerPrompt ?? ''}
                      onChange={(e) =>
                        updateStage(index, {
                          workerPrompt: e.target.value || undefined,
                        })
                      }
                      placeholder={
                        stage.type === 'review'
                          ? 'Describe the review criteria (e.g. correctness, scope, style). The output format is appended automatically.'
                          : stage.type === 'queue' || stage.type === 'done'
                            ? 'Instructions for the one-shot entry agent (does not enable automation)'
                            : 'Stage-specific worker prompt (falls back to project default)'
                      }
                      rows={stage.type === 'review' ? 6 : 3}
                    />
                  </div>

                  <div className="flex items-center justify-between gap-3 pt-1">
                    <div className="space-y-0.5">
                      <label
                        htmlFor={`stage-record-session-${index}`}
                        className="text-xs text-muted-foreground"
                      >
                        Record session
                      </label>
                      <p className="text-[11px] text-muted-foreground">
                        Capture a Playwright video of the agent&apos;s browser
                        session for tasks in this stage.
                      </p>
                    </div>
                    <Checkbox
                      id={`stage-record-session-${index}`}
                      data-ui="stage-record-session-toggle"
                      data-stage-id={stage.id}
                      checked={!!stage.record}
                      onCheckedChange={(checked) =>
                        updateStage(index, { record: checked === true })
                      }
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Alternatives: run-config overrides of this stage, e.g. coding.b */}
            {canHaveStageAlternatives(stage) && !sharesId(index) && (
              <div className="border-t border-border px-3 py-3">
                <StageAlternatives
                  base={stage}
                  stages={stages}
                  onChange={onChange}
                  runtimeCatalog={runtimeCatalog}
                  availableAiUsers={availableAiUsers}
                  onInvalidChange={reportSuffixInvalid}
                />
              </div>
            )}
          </div>
        ))}
      </div>

      <Button variant="outline" size="sm" onClick={addStage} className="w-full">
        <Plus className="size-3.5" />
        Add Stage
      </Button>

      <Dialog
        open={!!pendingRemoval}
        onOpenChange={(open) => {
          if (!open) {
            setPendingRemoval(null);
            setPendingPipeline(null);
            setRemainingRemovals([]);
            setPendingMigrations([]);
            setDestinationStageId('');
            onRemovalCancelled?.();
          }
        }}
      >
        <DialogContent data-ui="stage-removal-dialog">
          <DialogHeader>
            <DialogTitle>Move cards before removing stage</DialogTitle>
            <DialogDescription>
              {(() => {
                const usage =
                  pendingRemoval &&
                  occupancy.find((item) => item.stageId === pendingRemoval.id);
                if (!usage) return 'Cards use this stage.';
                return `${usage.total} ${usage.total === 1 ? 'card uses' : 'cards use'} ${pendingRemoval.title || pendingRemoval.id} (${usage.active} active, ${usage.archived} archived). Choose where they should go.`;
              })()}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label
              htmlFor="stage-removal-destination"
              className="text-sm font-medium"
            >
              Destination stage
            </label>
            <Select
              id="stage-removal-destination"
              data-ui="stage-removal-destination"
              data-source-stage-id={pendingRemoval?.id}
              data-destination-stage-id={destinationStageId}
              value={destinationStageId}
              onValueChange={(nextValue) => {
                setDestinationStageId(nextValue);
                setRemovalError(null);
              }}
              aria-invalid={!!removalError}
              aria-describedby={
                removalError ? 'stage-removal-error' : undefined
              }
              className="w-full"
            >
              <SelectItem value="" disabled>
                Choose a destination stage
              </SelectItem>
              {(pendingPipeline ?? rows)
                .filter((stage) => stage.id !== pendingRemoval?.id)
                .map((stage) => (
                  <SelectItem key={stage.id} value={stage.id}>
                    {stage.title || stage.id}
                  </SelectItem>
                ))}
            </Select>
            {removalError && (
              <p
                id="stage-removal-error"
                role="alert"
                data-ui="stage-removal-error"
                className="text-sm text-destructive"
              >
                {removalError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              data-ui="stage-removal-cancel"
              onClick={cancelRemoval}
            >
              Cancel
            </Button>
            <Button data-ui="stage-removal-confirm" onClick={confirmRemoval}>
              Move cards and remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
