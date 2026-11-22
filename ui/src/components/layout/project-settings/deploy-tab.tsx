import { Select, SelectItem } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { TabsContent } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import type { Project } from '@/types';
import { isStageAlternativeId } from '@/lib/stages';
import { AppPublishingSettings } from '../app-publishing-settings';
import { SettingsSection, TAB_CONTENT_CLASS, type FormProps } from './shared';

interface DeployTabProps extends FormProps {
  project: Project | undefined;
  sandboxDraftChanged: boolean;
  canEditDeployService: boolean;
}

export function DeployTab({
  form,
  setForm,
  project,
  sandboxDraftChanged,
  canEditDeployService,
}: DeployTabProps) {
  return (
    <TabsContent
      value="deploy"
      data-ui="project-settings-tab-deploy"
      className={TAB_CONTENT_CLASS}
    >
      <div className="space-y-4">
        <SettingsSection name="deploy" title="Deploy">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label
                className="text-sm font-medium"
                htmlFor="settings-deploy-service"
              >
                Deploy Service
              </label>
              <Input
                id="settings-deploy-service"
                placeholder="carapa-board"
                disabled={!canEditDeployService}
                value={form.deployService ?? ''}
                onChange={(e) =>
                  setForm({
                    ...form,
                    deployService: e.target.value,
                  })
                }
              />
              <p className="text-xs text-muted-foreground">
                Managed service name from managed-services.json
              </p>
              {!canEditDeployService && (
                <p className="text-xs text-muted-foreground">
                  Only a board admin can change this
                </p>
              )}
            </div>
            <div className="space-y-2">
              <label
                className="text-sm font-medium"
                htmlFor="settings-deploy-stage"
              >
                Deploy Stage
              </label>
              <Select
                id="settings-deploy-stage"
                className="w-full"
                value={form.deployStage ?? ''}
                onValueChange={(nextValue) =>
                  setForm({
                    ...form,
                    deployStage: nextValue,
                  })
                }
              >
                <SelectItem value="">First done stage (default)</SelectItem>
                {(form.stages ?? [])
                  .filter((s) => !s.inactive && !isStageAlternativeId(s.id))
                  .map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.title}
                    </SelectItem>
                  ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                Stage that triggers auto-deploy when a task is moved to it
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="settings-graceful-deploy"
              checked={form.gracefulDeploy ?? false}
              onCheckedChange={(checked) =>
                setForm({
                  ...form,
                  gracefulDeploy: checked === true,
                })
              }
            />
            <label
              className="text-sm font-medium"
              htmlFor="settings-graceful-deploy"
            >
              Graceful deploy
            </label>
            <p className="text-xs text-muted-foreground">
              Build image only, then let the service restart itself (requires
              Brain Container)
            </p>
          </div>
        </SettingsSection>

        <AppPublishingSettings
          project={project}
          disabled={sandboxDraftChanged}
        />
      </div>
    </TabsContent>
  );
}
