import { useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useProject } from '@/hooks/use-projects';
import { useAuth } from '@/lib/auth';
import { canViewProjectMail } from '@/lib/mail-state';
import { canUseProjectShell, showsChangesTab } from '@/lib/project-code';
import { Tabs, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { WorkspaceTabsList } from '@/components/chat/workspace-tabs-list';
import { workspaceContentClassName } from '@/components/chat/workspace-toolbar';
import { RunsTab } from './runs-tab';
import { EventsTab } from './events-tab';
import { ObjectiveDashboard } from './objective-dashboard';
import { BrowserTab } from '@/components/chat/browser-tab';
import { BashTab } from '@/components/chat/bash-tab';
import { MailTab } from '@/components/chat/mail-tab';
import { ChangesTab } from '@/components/chat/changes-tab';
import { FilesTab } from '@/components/chat/files-tab';

interface Props {
  project_id: string;
  objective_id: string;
  objective_title?: string;
  /** Report filename from a deep link; opened from the Files tab's Objective section. */
  initial_report?: string;
  /** Called once the deep-linked report has been opened, so the owner can stop passing it. */
  onInitialReportOpened?: (report: string) => void;
  /** Active objective conversation — required by Changes. */
  conversation_id?: string | null;
  onClose?: () => void;
  onFileOpen?: () => void;
  previewStrip?: ReactNode;
  previewBody?: ReactNode;
  tabValue?: string;
  onTabValueChange?: (value: string) => void;
}

export function ObjectiveExplorer({
  project_id,
  objective_id,
  objective_title = 'Objective',
  initial_report,
  onInitialReportOpened,
  conversation_id,
  onClose,
  onFileOpen,
  previewStrip,
  previewBody,
  tabValue,
  onTabValueChange,
}: Props) {
  const [uncontrolledTab, setUncontrolledTab] = useState('files');
  const { data: project } = useProject(project_id);
  const user = useAuth((s) => s.user);
  const showMail = canViewProjectMail(project, user);
  const showBash = canUseProjectShell(project, user);
  const requestedTab = tabValue ?? uncontrolledTab;
  const showChanges = showsChangesTab(project);
  const selectedTab =
    (requestedTab === 'mail' && !showMail) ||
    (requestedTab === 'bash' && !showBash) ||
    (requestedTab === 'changes' && !showChanges)
      ? 'files'
      : requestedTab;
  const showPreviewStrip =
    !!previewStrip && (selectedTab === 'files' || selectedTab === 'preview');

  return (
    <div
      data-ui="objective-workspace-tabs"
      data-objective-id={objective_id}
      className="flex h-full w-full flex-col overflow-hidden bg-background"
    >
      <Tabs
        value={selectedTab}
        onValueChange={(value) => {
          if (onTabValueChange) onTabValueChange(value);
          else setUncontrolledTab(value);
        }}
        className="flex h-full flex-col"
      >
        <div className="flex min-w-0 items-center border-b border-border pr-1">
          <WorkspaceTabsList>
            <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
            <TabsTrigger value="runs">Runs</TabsTrigger>
            <TabsTrigger value="events">Events</TabsTrigger>
            <TabsTrigger value="files">Files</TabsTrigger>
            <TabsTrigger value="browser">Browser</TabsTrigger>
            {showMail && <TabsTrigger value="mail">Mail</TabsTrigger>}
            {showBash && <TabsTrigger value="bash">Bash</TabsTrigger>}
            {showChanges && <TabsTrigger value="changes">Changes</TabsTrigger>}
          </WorkspaceTabsList>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Hide panel"
              aria-label="Hide objective workspace"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
        {showPreviewStrip && previewStrip}
        <div className="relative ml-2 min-h-0 flex-1 overflow-hidden">
          {/* The dashboard iframe has no padding of its own: it fills the body
              (which keeps its `ml-2`) to the pane's right, top and bottom edges. */}
          <TabsContent
            value="dashboard"
            forceMount
            className="absolute inset-0 overflow-hidden data-[state=inactive]:hidden"
          >
            <ObjectiveDashboard
              project_id={project_id}
              objective_id={objective_id}
              objective_title={objective_title}
            />
          </TabsContent>
          <TabsContent
            value="runs"
            className={`absolute inset-0 overflow-auto pr-2 pb-2 ${workspaceContentClassName}`}
          >
            <RunsTab project_id={project_id} objective_id={objective_id} />
          </TabsContent>
          <TabsContent
            value="events"
            className="absolute inset-0 overflow-auto pr-2 pb-2"
          >
            <EventsTab project_id={project_id} objective_id={objective_id} />
          </TabsContent>
          {/* Files stays mounted so opening a file preview (and closing it
            again) keeps its expanded folders and scroll. */}
          <TabsContent
            value="files"
            forceMount
            className="absolute inset-0 overflow-auto pr-2 pb-2 data-[state=inactive]:hidden"
          >
            <FilesTab
              project_id={project_id}
              conversation_id={conversation_id ?? null}
              objective_id={objective_id}
              initial_report={initial_report}
              onInitialReportOpened={onInitialReportOpened}
              onOpenPanel={onFileOpen}
            />
          </TabsContent>
          <TabsContent
            value="browser"
            className="absolute inset-0 overflow-hidden"
          >
            <BrowserTab
              projectId={project_id}
              conversationId={conversation_id ?? null}
              active={selectedTab === 'browser'}
            />
          </TabsContent>
          {showMail && (
            <TabsContent
              value="mail"
              forceMount
              className="absolute inset-0 overflow-hidden data-[state=inactive]:hidden"
            >
              <MailTab
                key={project_id}
                projectId={project_id}
                active={selectedTab === 'mail'}
                configured={!!project?.settings?.carapaMailTokenSet}
              />
            </TabsContent>
          )}
          {showBash && (
            <TabsContent
              value="bash"
              className="absolute inset-0 z-10 overflow-hidden p-0"
            >
              <BashTab
                project_id={project_id}
                conversation_id={conversation_id ?? null}
              />
            </TabsContent>
          )}
          {showChanges && (
            <TabsContent
              value="changes"
              className="absolute inset-0 overflow-auto pr-2 pb-2"
            >
              {conversation_id ? (
                <ChangesTab
                  key={`${project_id}:${conversation_id}`}
                  project_id={project_id}
                  conversation_id={conversation_id}
                  active={selectedTab === 'changes'}
                />
              ) : (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Select a conversation to see its changes.
                </p>
              )}
            </TabsContent>
          )}
          {previewBody && (
            <div
              className={
                selectedTab === 'preview'
                  ? 'absolute inset-0 overflow-hidden'
                  : 'hidden'
              }
            >
              {previewBody}
            </div>
          )}
        </div>
      </Tabs>
    </div>
  );
}
