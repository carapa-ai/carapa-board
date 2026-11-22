import { Checkbox } from '@/components/ui/checkbox';
import { TabsContent } from '@/components/ui/tabs';
import type { Project } from '@/types';
import type { projectTreeOptions } from '@/components/layout/project-picker';
import { ProjectTreeMultiSelect } from '@/components/layout/project-tree-multi-select';
import { TAB_CONTENT_CLASS, type FormProps } from './shared';

interface MemoryTabProps extends FormProps {
  project: Project | undefined;
  memorySourceOptions: ReturnType<typeof projectTreeOptions>;
}

export function MemoryTab({
  form,
  setForm,
  project,
  memorySourceOptions,
}: MemoryTabProps) {
  return (
    <TabsContent
      value="memory"
      data-ui="project-settings-tab-memory"
      className={TAB_CONTENT_CLASS}
    >
      <div className="space-y-4">
        {project?.isMain ? (
          <div
            className="rounded-md border bg-muted/20 p-3"
            data-ui="main-project-memory-sources-info"
          >
            <p className="text-sm font-medium">Shared memories</p>
            <p className="mt-1 text-xs text-muted-foreground">
              In Deep memory mode, this main project automatically searches
              structured memories from all projects you can access.
            </p>
          </div>
        ) : (
          <div className="min-w-0 space-y-2" data-ui="memory-source-projects">
            <label className="text-sm font-medium">Memory Sources</label>
            <ProjectTreeMultiSelect
              options={memorySourceOptions}
              selectedIds={form.memorySourceProjects ?? []}
              emptyLabel="No linked projects"
              onToggle={(candidate, checked) => {
                const current = form.memorySourceProjects ?? [];
                setForm({
                  ...form,
                  memorySourceProjects: checked
                    ? [...current, candidate.id]
                    : current.filter((id) => id !== candidate.id),
                });
              }}
              dataUi={{
                trigger: 'memory-source-projects-trigger',
                content: 'memory-source-project-tree',
                item: 'memory-source-project',
              }}
            />
            <p className="text-xs text-muted-foreground">
              Select the exact projects whose memories this project can recall.
              Child projects are included only when selected separately.
            </p>
          </div>
        )}

        <div className="flex items-start space-x-2 pt-1">
          <Checkbox
            id="settings-disable-observations"
            checked={form.disableObservations ?? false}
            onCheckedChange={(checked) =>
              setForm({ ...form, disableObservations: !!checked })
            }
          />
          <div>
            <label
              htmlFor="settings-disable-observations"
              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              Disable Memory Observations
            </label>
            <p className="text-xs text-muted-foreground mt-1">
              Stop extracting decisions and facts from chats for this project.
            </p>
          </div>
        </div>
      </div>
    </TabsContent>
  );
}
