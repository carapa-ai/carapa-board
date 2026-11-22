import { Select, SelectItem } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { confirmAction } from '@/components/confirm-dialog';
import { TabsContent } from '@/components/ui/tabs';
import { Plus, X } from 'lucide-react';
import { StageEditor } from '@/components/settings/stage-editor';
import { StageRuntimeLabel } from '@/components/settings/stage-runtime-label';
import { getEffectiveProjectStages, isStageAlternativeId } from '@/lib/stages';
import type { fetchProjectAvailableAiUsers, RuntimeCatalog } from '@/lib/api';
import type {
  Project,
  StageDefinition,
  StageMigration,
  StageOccupancy,
} from '@/types';
import { useState, type Dispatch, type SetStateAction } from 'react';
import { SettingsSection, TAB_CONTENT_CLASS, type FormProps } from './shared';

interface BoardTabProps extends FormProps {
  project: Project | undefined;
  /** Stages are only configurable while kanban mode is enabled. */
  kanbanEnabled: boolean;
  parentId: string | null;
  draftInheritsStages: boolean;
  draftParentChanged: boolean;
  draftParentStages: StageDefinition[];
  draftEffectiveStages: StageDefinition[];
  savedEffectiveStages: StageDefinition[];
  stageOccupancy: StageOccupancy[] | undefined;
  stageOccupancyPending: boolean;
  stageOccupancyError: boolean;
  refetchStageOccupancy: () => Promise<unknown>;
  openRemovalStageId: string | undefined;
  setOpenRemovalStageId: (stageId: string | undefined) => void;
  conflictProspectiveStages: StageDefinition[] | null;
  setConflictProspectiveStages: (stages: StageDefinition[] | null) => void;
  conflictDraftInherited: boolean;
  setConflictDraftInherited: (inherited: boolean) => void;
  stageMigrations: StageMigration[];
  setStageMigrations: Dispatch<SetStateAction<StageMigration[]>>;
  runtimeCatalog: RuntimeCatalog | undefined;
  availableAiUsers: Awaited<ReturnType<typeof fetchProjectAvailableAiUsers>>;
  onStageSuffixInvalidChange: (invalid: boolean) => void;
  /** Saves the removal of this project's own stage list; rejects when refused. */
  onInheritFromParent: () => Promise<void>;
}

export function BoardTab({
  form,
  setForm,
  project,
  kanbanEnabled,
  parentId,
  draftInheritsStages,
  draftParentChanged,
  draftParentStages,
  draftEffectiveStages,
  savedEffectiveStages,
  stageOccupancy,
  stageOccupancyPending,
  stageOccupancyError,
  refetchStageOccupancy,
  openRemovalStageId,
  setOpenRemovalStageId,
  conflictProspectiveStages,
  setConflictProspectiveStages,
  conflictDraftInherited,
  setConflictDraftInherited,
  stageMigrations,
  setStageMigrations,
  runtimeCatalog,
  availableAiUsers,
  onStageSuffixInvalidChange,
  onInheritFromParent,
}: BoardTabProps) {
  const [inheriting, setInheriting] = useState(false);
  const [inheritError, setInheritError] = useState<string | null>(null);
  // Offered while the saved project owns a stage list that sits on a parent.
  const canInheritFromParent =
    !!project?.parentId &&
    !!project.settings?.stages?.length &&
    !draftParentChanged;

  const inheritFromParent = async () => {
    const parentStageIds = new Set(draftParentStages.map((stage) => stage.id));
    const disappearing = savedEffectiveStages.filter(
      (stage) =>
        !parentStageIds.has(stage.id) && !isStageAlternativeId(stage.id),
    );
    const confirmed = await confirmAction(
      `Parent stage changes will apply to this project automatically.${
        disappearing.length
          ? ` These stages will disappear: ${disappearing
              .map((stage) => `${stage.title} (${stage.id})`)
              .join(', ')}.`
          : ''
      }`,
      { title: 'Inherit stages from parent?', confirmLabel: 'Inherit' },
    );
    if (!confirmed) return;
    setInheriting(true);
    setInheritError(null);
    try {
      await onInheritFromParent();
    } catch (error) {
      setInheritError(error instanceof Error ? error.message : String(error));
    } finally {
      setInheriting(false);
    }
  };

  return (
    <TabsContent
      value="board"
      data-ui="project-settings-tab-board"
      className={TAB_CONTENT_CLASS}
    >
      <div className="space-y-4">
        {kanbanEnabled && (
          <SettingsSection name="stages" title="Stages">
            {project?.parentId && draftInheritsStages && !draftParentChanged ? (
              <div className="space-y-4">
                <div className="rounded-md border border-border bg-muted/40 p-3">
                  <p className="text-sm font-medium">
                    Inherited from parent project
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Parent stage changes apply automatically until this project
                    creates an override.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() =>
                      setForm({
                        ...form,
                        stages: getEffectiveProjectStages(project).map(
                          (stage) => ({ ...stage }),
                        ),
                      })
                    }
                  >
                    Override stages for this project
                  </Button>
                </div>
                <div className="space-y-2">
                  {draftEffectiveStages.map((stage) => (
                    <div
                      key={stage.id}
                      data-ui="inherited-project-stage"
                      data-stage-id={stage.id}
                      className="flex items-center gap-2 rounded-md border border-border bg-muted/20 p-2 text-sm"
                    >
                      <span
                        className="size-3 shrink-0 rounded-full"
                        style={{ backgroundColor: stage.color }}
                      />
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {stage.title}
                      </span>
                      <StageRuntimeLabel
                        selection={stage.runtimeSelection}
                        catalog={runtimeCatalog}
                      />
                      <span className="shrink-0 text-xs uppercase text-muted-foreground">
                        {stage.type}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {canInheritFromParent && (
                  <div
                    data-ui="inherit-parent-stages"
                    className="rounded-md border border-border bg-muted/40 p-3"
                  >
                    <p className="text-sm font-medium">
                      This project has its own stages
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Remove the override to follow the parent project's stages
                      again. This saves immediately.
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      disabled={inheriting}
                      onClick={() => void inheritFromParent()}
                    >
                      Inherit from parent
                    </Button>
                    {inheritError && (
                      <p
                        role="alert"
                        data-ui="inherit-parent-stages-error"
                        className="mt-2 text-xs text-destructive"
                      >
                        {inheritError}
                      </p>
                    )}
                  </div>
                )}
                <StageEditor
                  stages={
                    draftInheritsStages
                      ? savedEffectiveStages
                      : (form.stages ?? savedEffectiveStages)
                  }
                  occupancy={stageOccupancy ?? []}
                  occupancyStatus={
                    stageOccupancyPending
                      ? 'loading'
                      : stageOccupancyError
                        ? 'error'
                        : 'ready'
                  }
                  onRetryOccupancy={() => {
                    void refetchStageOccupancy();
                  }}
                  openRemovalStageId={openRemovalStageId}
                  openRemovalPipeline={conflictProspectiveStages ?? undefined}
                  onRemovalStageConsumed={() =>
                    setOpenRemovalStageId(undefined)
                  }
                  onRemovalApplied={() => {
                    setConflictProspectiveStages(null);
                    setConflictDraftInherited(false);
                  }}
                  onRemovalCancelled={() => {
                    if (conflictProspectiveStages) {
                      setForm({
                        ...form,
                        stages: conflictDraftInherited
                          ? []
                          : conflictProspectiveStages,
                      });
                      setConflictProspectiveStages(null);
                      setConflictDraftInherited(false);
                    }
                  }}
                  resetStages={parentId ? draftParentStages : undefined}
                  resetLabel={parentId ? 'Reset to parent stages' : 'Reset'}
                  stageMigrations={stageMigrations}
                  onStageMigrationsChange={setStageMigrations}
                  runtimeCatalog={runtimeCatalog}
                  availableAiUsers={availableAiUsers}
                  onSuffixInvalidChange={onStageSuffixInvalidChange}
                  onChange={(stages: StageDefinition[]) => {
                    const inheritedTarget =
                      conflictProspectiveStages ?? draftParentStages;
                    // Compare base stages only: alternatives are run config and
                    // must not turn an unchanged inherited pipeline into a copy.
                    const rowStages = stages.filter(
                      (stage) => !isStageAlternativeId(stage.id),
                    );
                    const shouldKeepInherited =
                      (conflictDraftInherited || draftParentChanged) &&
                      rowStages.length === inheritedTarget.length &&
                      rowStages.every(
                        (stage, index) =>
                          stage.id === inheritedTarget[index]?.id,
                      );
                    setForm({
                      ...form,
                      stages: shouldKeepInherited ? [] : stages,
                    });
                    setStageMigrations((migrations) =>
                      migrations.filter(
                        (migration) =>
                          !stages.some(
                            (stage) => stage.id === migration.sourceStageId,
                          ) &&
                          stages.some(
                            (stage) =>
                              stage.id === migration.destinationStageId,
                          ),
                      ),
                    );
                  }}
                />
              </div>
            )}
          </SettingsSection>
        )}

        <SettingsSection
          name="custom-values"
          title="Custom Values"
          description={
            <>
              Define value fields that agents can set on tasks via{' '}
              <code>update_values</code>
            </>
          }
        >
          <div className="space-y-2">
            {(form.custom_values ?? []).map((cv, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  placeholder="key"
                  className="flex-1"
                  value={cv.key}
                  onChange={(e) => {
                    const updated = [...(form.custom_values ?? [])];
                    updated[i] = { ...updated[i], key: e.target.value };
                    setForm({ ...form, custom_values: updated });
                  }}
                />
                <Input
                  placeholder="label (optional)"
                  className="flex-1"
                  value={cv.label ?? ''}
                  onChange={(e) => {
                    const updated = [...(form.custom_values ?? [])];
                    updated[i] = {
                      ...updated[i],
                      label: e.target.value || undefined,
                    };
                    setForm({ ...form, custom_values: updated });
                  }}
                />
                <Select
                  aria-label="Custom value type"
                  value={cv.type ?? 'text'}
                  onValueChange={(nextValue) => {
                    const updated = [...(form.custom_values ?? [])];
                    updated[i] = {
                      ...updated[i],
                      type: nextValue as 'text' | 'number',
                    };
                    setForm({ ...form, custom_values: updated });
                  }}
                >
                  <SelectItem value="text">text</SelectItem>
                  <SelectItem value="number">number</SelectItem>
                </Select>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={
                    cv.key
                      ? `Remove custom value ${cv.key}`
                      : 'Remove custom value'
                  }
                  className="flex-shrink-0"
                  onClick={() => {
                    const updated = (form.custom_values ?? []).filter(
                      (_, j) => j !== i,
                    );
                    setForm({
                      ...form,
                      custom_values: updated,
                    });
                  }}
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setForm({
                  ...form,
                  custom_values: [
                    ...(form.custom_values ?? []),
                    { key: '', type: 'text' },
                  ],
                })
              }
            >
              <Plus className="size-3.5 mr-1" />
              Add Value
            </Button>
          </div>

          <div className="border-t border-border pt-4 space-y-2">
            <label
              className="text-sm font-medium"
              htmlFor="settings-card-template"
            >
              Card Template
            </label>
            <Textarea
              id="settings-card-template"
              placeholder="<b>{{score}}</b>/10 — {{summary}}"
              value={form.cardTemplate ?? ''}
              onChange={(e) =>
                setForm({ ...form, cardTemplate: e.target.value })
              }
              rows={3}
            />
            <p className="text-xs text-muted-foreground">
              HTML template rendered on task cards. Use <code>{'{{key}}'}</code>{' '}
              placeholders matching your value keys above.
            </p>
          </div>
        </SettingsSection>
      </div>
    </TabsContent>
  );
}
