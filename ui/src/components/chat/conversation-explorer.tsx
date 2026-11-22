import { useEffect, useState, type ReactNode } from 'react';
import { Capacitor } from '@capacitor/core';
import { X } from 'lucide-react';
import { useProject } from '@/hooks/use-projects';
import { useAuth } from '@/lib/auth';
import { canUseProjectShell, showsChangesTab } from '@/lib/project-code';
import { canViewProjectMail } from '@/lib/mail-state';
import { MailTab } from './mail-tab';
import { Tabs, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { WorkspaceTabsList } from './workspace-tabs-list';
import { BashTab } from './bash-tab';
import { BrowserTab, type BrowserAnnotationSubmission } from './browser-tab';
import { ChangesTab } from './changes-tab';
import { FilesTab } from './files-tab';
import type { ConversationTabValue } from '@/store';
export type { ConversationTabValue } from '@/store';

/**
 * Possible values for the conversation tablist (Changes/Files)
 * plus a virtual "preview" tab that swaps the body for the active file
 * preview. Only meaningful when at least one preview tab is open — the
 * caller flips `tabValue` between 'preview' and one of the conversation
 * values based on whether the user is currently looking at the file tree
 * (or changes) versus the open file.
 */
/**
 * Right-side explorer for a simple chat conversation: Files + Changes tabs.
 * (Objective chats use ObjectiveExplorer, which folds these in alongside its
 * Runs/Events/Reports/Files tabs.)
 *
 * The conversation tablist is always rendered. When `tabValue === 'preview'`
 * and `previewBody` is provided, the body is the file preview; otherwise
 * the body shows the selected conversation tab (Changes/Files).
 * This lets the user click "Files" while a preview is open to browse the
 * file tree, pick a second file, and have the body swap back to the
 * preview automatically (the caller flips `tabValue` to 'preview' on
 * preview-tab activation).
 */
export function ConversationExplorer({
  project_id,
  conversation_id,
  taskId,
  onClose,
  onFileOpen,
  previewStrip,
  previewBody,
  tabValue,
  onTabValueChange,
  onAnnotationSubmitted,
  onProjectSetup,
}: {
  project_id: string;
  conversation_id: string | null;
  taskId?: string | null;
  onClose?: () => void;
  /** Forwarded to FilesTab as `onOpenPanel`, which asks the parent to
   *  reveal the right pane. The preview tab itself is opened by FilesTab
   *  via the preview-tab store; this callback only nudges the parent to
   *  make sure the pane is visible. */
  onFileOpen?: () => void;
  /** Optional file-preview tab strip rendered below the conversation
   *  tablist. */
  previewStrip?: ReactNode;
  /** Optional file-preview body. When `tabValue === 'preview'`, this body
   *  is shown in place of the conversation tab body. */
  previewBody?: React.ReactNode;
  /** Controlled value for the conversation Tabs root. `'preview'` is a
   *  virtual tab that means "show the file preview body"; the other three
   *  values map to the matching TabsContent. */
  tabValue?: ConversationTabValue;
  onTabValueChange?: (v: ConversationTabValue) => void;
  onAnnotationSubmitted?: (submission: BrowserAnnotationSubmission) => void;
  onProjectSetup?: () => void;
}) {
  // When no preview is open (or no controlled state is provided), default
  // to the conversation tabs' natural behavior so the explorer works as a
  // standalone component. Once a preview is open, the caller passes
  // controlled props to drive the body swap.
  const isControlled = tabValue !== undefined && onTabValueChange !== undefined;
  const [uncontrolledTab, setUncontrolledTab] =
    useState<ConversationTabValue>('files');
  const { data: project } = useProject(project_id);
  const user = useAuth((s) => s.user);
  const showMail = canViewProjectMail(project, user);
  const showChanges = showsChangesTab(project);
  const isAndroid =
    Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  const showBash = !isAndroid && canUseProjectShell(project, user);
  const requestedTab = isControlled ? tabValue : uncontrolledTab;
  const tabHidden =
    (requestedTab === 'mail' && !showMail) ||
    (requestedTab === 'changes' && !showChanges) ||
    (requestedTab === 'bash' && !showBash);
  const activeTab = tabHidden ? 'files' : requestedTab;
  useEffect(() => {
    if (project && tabHidden) {
      if (isControlled) onTabValueChange('files');
      else setUncontrolledTab('files');
    }
  }, [project, tabHidden, isControlled, onTabValueChange]);
  const showPreviewBody =
    isControlled && tabValue === 'preview' && !!previewBody;
  // The open-files tab strip is only relevant when the body is showing
  // file content — browsing the file tree (`files`) or viewing an open
  // file (`preview`, where the strip is the switcher between open files).
  // Hide it on Changes/Bash so it doesn't clutter tabs that have
  // nothing to do with files. This mirrors the shells strip, which lives
  // inside `BashTab` and is therefore only visible when the Bash tab is
  // active.
  const showPreviewStrip =
    !!previewStrip && (tabValue === 'files' || tabValue === 'preview');
  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-background">
      <Tabs
        value={activeTab}
        onValueChange={(v) => {
          if (isControlled) {
            onTabValueChange(v as ConversationTabValue);
          } else {
            setUncontrolledTab(v as ConversationTabValue);
          }
        }}
        className="flex flex-col h-full"
      >
        <div className="flex items-center justify-between border-b border-border pr-1">
          <WorkspaceTabsList>
            <TabsTrigger value="files">Files</TabsTrigger>
            {showChanges && <TabsTrigger value="changes">Changes</TabsTrigger>}
            <TabsTrigger value="browser">Browser</TabsTrigger>
            {showMail && <TabsTrigger value="mail">Mail</TabsTrigger>}
            {showBash && <TabsTrigger value="bash">Bash</TabsTrigger>}
          </WorkspaceTabsList>
          {onClose && (
            <button
              onClick={onClose}
              className="shrink-0 p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
              title="Hide panel"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
        {showPreviewStrip && previewStrip}
        {/* `ml-2` (the tab strip's inset) keeps the panel's content off the
            drag-to-resize handle that sits at `left-0` of the parent `<div>`
            in `chat-page.tsx` (the handle is `w-1 cursor-col-resize z-10`,
            and the bash TabsContent below is also `z-10`, so without this
            margin the bash panel would visually cover the handle and the
            user couldn't grab it). There is no right margin: that 8px inset
            is `pr-2` inside each tab that scrolls itself (Files, Changes), so
            its scrollbar sits at the pane's right edge. Tabs that run to the
            edge (Mail, Browser, Bash) own their scroller or iframe and pad
            only their toolbars. Toolbars (workspace-toolbar.tsx) add no
            horizontal padding of their own. */}
        <div className="flex-1 min-h-0 overflow-hidden relative ml-2">
          {showMail && (
            <TabsContent
              value="mail"
              forceMount
              className="absolute inset-0 overflow-hidden data-[state=inactive]:hidden"
            >
              <MailTab
                key={project_id}
                projectId={project_id}
                active={activeTab === 'mail'}
                configured={!!project?.settings?.carapaMailTokenSet}
              />
            </TabsContent>
          )}
          <TabsContent
            value="browser"
            forceMount
            className="absolute inset-0 overflow-hidden data-[state=inactive]:hidden"
          >
            <BrowserTab
              projectId={project_id}
              conversationId={conversation_id}
              taskId={taskId}
              active={activeTab === 'browser'}
              onAnnotationSubmitted={onAnnotationSubmitted}
            />
          </TabsContent>
          {/* forceMount keeps every TabsContent in the DOM at all times
            so switching to a file preview (and back) doesn't reset the
            Files tree state (expanded folders, scroll position). With
            forceMount the inactive panels get `data-state="inactive"`
            from Radix; `data-[state=inactive]:hidden` collapses them
            out of the layout so the active panel fills the body.
            Project-scoped tabs (group Files and Bash) keep
            working before a first conversation exists. */}
          <TabsContent
            value="changes"
            forceMount
            className="absolute inset-0 overflow-auto pr-2 pb-2 data-[state=inactive]:hidden"
          >
            {showChanges && (
              <ChangesTab
                key={`${project_id}:${conversation_id ?? 'shared'}`}
                project_id={project_id}
                conversation_id={conversation_id}
                active={activeTab === 'changes'}
                onProjectSetup={onProjectSetup}
              />
            )}
          </TabsContent>
          <TabsContent
            value="files"
            forceMount
            className="absolute inset-0 overflow-auto pr-2 pb-2 data-[state=inactive]:hidden"
          >
            <FilesTab
              project_id={project_id}
              conversation_id={conversation_id}
              onOpenPanel={onFileOpen}
            />
          </TabsContent>
          {/* Preview body sits on top of (and in place of) the conversation
            TabsContents when the caller drives `tabValue` to `'preview'`.
            Group files can be previewed before the first conversation exists. */}
          {previewBody && (
            <div
              className={
                showPreviewBody ? 'absolute inset-0 overflow-hidden' : 'hidden'
              }
            >
              {previewBody}
            </div>
          )}
          {/* This is intentionally outside the conversation branch. A switch
            transiently passes through `conversation_id = null`; on supported
            platforms, keeping one project-scoped BashTab mounted preserves
            every terminal/SSE pair. */}
          {showBash && (
            <TabsContent
              value="bash"
              forceMount
              className="absolute inset-0 overflow-hidden p-0 data-[state=inactive]:hidden z-10"
            >
              <BashTab project_id={project_id} conversation_id={null} />
            </TabsContent>
          )}
        </div>
      </Tabs>
    </div>
  );
}
