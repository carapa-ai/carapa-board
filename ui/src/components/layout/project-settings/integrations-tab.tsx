import { useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { TabsContent } from '@/components/ui/tabs';
import { Loader2, Link as LinkIcon, Smartphone } from 'lucide-react';
import { useStore } from '@/store';
import { formatRelativeTime } from '@/lib/utils';
import { testBrainConnection, type BrainConnectionTestResult } from '@/lib/api';
import type { useUnlinkWhatsAppGroup } from '@/hooks/use-projects';
import type { Project } from '@/types';
import {
  SettingsSection,
  TAB_CONTENT_CLASS,
  type AppConfig,
  type FormProps,
} from './shared';
import { confirmAction } from '@/components/confirm-dialog';
import { ProjectIntegrationsSection } from './project-integrations-section';

type BrainTestState = BrainConnectionTestResult | { result: 'request-failed' };

function brainTestMessage(test: BrainTestState, container?: string): string {
  switch (test.result) {
    case 'accepted':
      return 'The brain accepted this token. Save to keep it.';
    case 'rejected':
      return `The brain rejected this token (HTTP ${test.status}).`;
    case 'error':
      return `The brain answered with HTTP ${test.status}.`;
    case 'no-container':
      return 'Enter a brain container name to test the token.';
    case 'no-token':
      return 'Enter a brain token to test the connection.';
    case 'not-found':
      return `No running container ${container?.trim() ? `named "${container.trim()}"` : 'with the configured name'} was found in CarapaBox. Check the name, or start the brain's stack.`;
    case 'no-endpoint':
      return 'The container is running but has no reachable brain endpoint: its stack publishes no port and has no HTTP ingress for it. Publish the brain port (for example 3100) or add an ingress.';
    case 'discovery-failed':
      return 'Could not list running containers from CarapaBox. Check that CarapaBox is reachable.';
    case 'unreachable':
      return `The brain container was found, but the connection failed${test.code ? ` (${test.code})` : ''}. Check that the brain listens on its published port or ingress address.`;
    case 'request-failed':
      return 'The connection test request to the board failed.';
    default: {
      const unhandled: never = test;
      return unhandled;
    }
  }
}

interface IntegrationsTabProps extends FormProps {
  project: Project | undefined;
  project_id: string | null;
  config: AppConfig | undefined;
  unlinkMutation: ReturnType<typeof useUnlinkWhatsAppGroup>;
}

export function IntegrationsTab({
  form,
  setForm,
  project,
  project_id,
  config,
  unlinkMutation,
}: IntegrationsTabProps) {
  const [brainTest, setBrainTest] = useState<BrainTestState | 'testing' | null>(
    null,
  );
  const brainTestSeq = useRef(0);

  // Reset when the container or token is edited so a stale result never sticks.
  const clearBrainTest = () => {
    brainTestSeq.current++;
    setBrainTest(null);
  };

  const runBrainTest = async () => {
    const brainAuthToken = form.brainAuthToken?.trim();
    if (!project_id || !brainAuthToken) return;
    const seq = ++brainTestSeq.current;
    setBrainTest('testing');
    let result: BrainTestState;
    try {
      result = await testBrainConnection(project_id, {
        brainContainer: form.brainContainer,
        brainAuthToken,
      });
    } catch {
      result = { result: 'request-failed' };
    }
    if (seq === brainTestSeq.current) setBrainTest(result);
  };

  return (
    <TabsContent
      value="integrations"
      data-ui="project-settings-tab-integrations"
      className={TAB_CONTENT_CLASS}
    >
      <div className="space-y-4">
        {config?.enableWhatsApp && (
          <SettingsSection
            name="whatsapp"
            title="WhatsApp"
            description="Link this project to a WhatsApp group to receive and respond to messages."
          >
            {project?.jid ? (
              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Smartphone className="size-4 text-blue-600 dark:text-blue-400 shrink-0" />
                  <span className="text-sm font-mono truncate text-muted-foreground">
                    {project.jid.split('@')[0]}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0 ml-2"
                  onClick={async () => {
                    const confirmed = await confirmAction(
                      'The project will stop receiving messages from this group.',
                      {
                        title: 'Disconnect this WhatsApp group?',
                        confirmLabel: 'Disconnect',
                        destructive: true,
                      },
                    );
                    if (confirmed) {
                      await unlinkMutation.mutateAsync(project.jid!);
                    }
                  }}
                  disabled={unlinkMutation.isPending}
                >
                  {unlinkMutation.isPending ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    'Disconnect'
                  )}
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (!project_id) return;
                  useStore
                    .getState()
                    .setLinkProjectToWhatsAppProjectId(project_id);
                  useStore.getState().setLinkProjectToWhatsAppDialogOpen(true);
                }}
              >
                <LinkIcon className="size-3.5 mr-1.5" />
                Link to WhatsApp Group
              </Button>
            )}
          </SettingsSection>
        )}

        <SettingsSection name="brain" title="Brain">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label
                className="text-sm font-medium"
                htmlFor="settings-brain-container"
              >
                Brain Container
              </label>
              <Input
                id="settings-brain-container"
                placeholder="carapa-brain-main-agent-1"
                value={form.brainContainer ?? ''}
                onChange={(e) => {
                  clearBrainTest();
                  setForm({
                    ...form,
                    brainContainer: e.target.value,
                  });
                }}
              />
              <p className="text-xs text-muted-foreground">
                CarapaBrain container name for the objectives API
              </p>
            </div>
            {form.brainContainer && (
              <div className="space-y-2">
                <label
                  className="text-sm font-medium"
                  htmlFor="settings-brain-auth-token"
                >
                  Brain Auth Token
                </label>
                <Input
                  id="settings-brain-auth-token"
                  type="password"
                  placeholder={
                    form.brainAuthTokenSet
                      ? '••••••••  (configured — enter to replace)'
                      : 'Bearer token for CarapaBrain API'
                  }
                  value={form.brainAuthToken ?? ''}
                  onChange={(e) => {
                    clearBrainTest();
                    setForm({
                      ...form,
                      brainAuthToken: e.target.value,
                    });
                  }}
                  onBlur={() => void runBrainTest()}
                />
                <p className="text-xs text-muted-foreground">
                  CarapaBrain API token (encrypted at rest)
                </p>
                {brainTest && (
                  <p
                    className={`text-xs ${
                      brainTest === 'testing'
                        ? 'text-muted-foreground'
                        : brainTest.result === 'accepted'
                          ? 'text-green-700 dark:text-green-400'
                          : 'text-destructive'
                    }`}
                    data-ui="brain-connection-test-result"
                  >
                    {brainTest === 'testing'
                      ? 'Testing connection…'
                      : brainTestMessage(brainTest, form.brainContainer)}
                  </p>
                )}
                {form.brainAuthRejected && !brainTest && (
                  <p
                    className="text-xs text-destructive"
                    data-ui="brain-auth-rejected-warning"
                  >
                    The brain rejected this token (HTTP{' '}
                    {form.brainAuthRejected.status},{' '}
                    {formatRelativeTime(form.brainAuthRejected.at)}). Its
                    CARAPA_BRAIN_AUTH_TOKEN does not match: enter the brain's
                    token here, or update the brain container's env.
                  </p>
                )}
              </div>
            )}
          </div>
        </SettingsSection>

        <SettingsSection name="carapa-mail" title="Carapa-Mail">
          <div className="flex items-start space-x-2 pt-1">
            <Checkbox
              id="settings-carapamail-enabled"
              checked={form.carapaMailEnabled ?? false}
              onCheckedChange={(checked) =>
                setForm({ ...form, carapaMailEnabled: !!checked })
              }
            />
            <div>
              <label
                htmlFor="settings-carapamail-enabled"
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                Carapa-Mail
              </label>
              <p className="text-xs text-muted-foreground mt-1">
                Give this project's agents the carapa-mail MCP tools (injected
                via api-relay).
              </p>
            </div>
          </div>
          {form.carapaMailEnabled && (
            <div className="space-y-2">
              <label
                className="text-sm font-medium"
                htmlFor="settings-carapamail-token"
              >
                Carapa-Mail Token
              </label>
              <Input
                id="settings-carapamail-token"
                type="password"
                placeholder={
                  form.carapaMailTokenSet
                    ? '••••••••  (configured — enter to replace)'
                    : 'Per-account MCP token from the carapa-mail setup UI'
                }
                value={form.carapaMailToken ?? ''}
                onChange={(e) =>
                  setForm({
                    ...form,
                    carapaMailToken: e.target.value,
                  })
                }
              />
              <p className="text-xs text-muted-foreground">
                Per-account carapa-mail MCP token (encrypted at rest)
              </p>
            </div>
          )}
        </SettingsSection>

        {project_id && <ProjectIntegrationsSection projectId={project_id} />}
      </div>
    </TabsContent>
  );
}
