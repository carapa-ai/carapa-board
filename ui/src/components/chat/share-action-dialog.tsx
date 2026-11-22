import { useState, useMemo } from 'react';
import { useStore } from '@/store';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  MessageSquare,
  Plus,
  FolderTree,
  ChevronRight,
  Folder,
  Layers,
} from 'lucide-react';
import { useProjects } from '@/hooks/use-projects';
import { projectTreeOptions } from '@/components/layout/project-picker';
import { useNavigate } from '@tanstack/react-router';
import { cn } from '@/lib/utils';

export function mergeSharedIntoDraft(
  existing: string | undefined,
  shared: string,
): string {
  return existing?.trim()
    ? `${existing.replace(/\s+$/, '')}\n\n${shared}`
    : shared;
}

export function ShareActionDialog() {
  const navigate = useNavigate();
  const { data: projects = [] } = useProjects();

  const sharedContent = useStore((s) => s.sharedContent);
  const setSharedContent = useStore((s) => s.setSharedContent);
  const lastProjectId = useStore((s) => s.lastProjectId);
  const activeConvByProject = useStore((s) => s.activeConvByProject);
  const saveDraftByKey = useStore((s) => s.saveDraftByKey);
  const setActiveConvForProject = useStore((s) => s.setActiveConvForProject);

  const [step, setStep] = useState<'options' | 'select-project'>('options');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const projectOptions = useMemo(
    () => projectTreeOptions(projects),
    [projects],
  );

  const lastProject = useMemo(
    () => projects.find((p) => p.id === lastProjectId),
    [projects, lastProjectId],
  );

  const handleClose = () => {
    setSharedContent(null);
    setStep('options');
    setSelectedProjectId(null);
  };

  const executeShare = (project_id: string, convId: string | null) => {
    if (!sharedContent) return;

    const content = sharedContent.title
      ? `${sharedContent.title}\n\n${sharedContent.text || ''}`.trim()
      : sharedContent.text || '';

    // Set active conversation
    setActiveConvForProject(project_id, convId);
    // A new conversation must latch composing mode, as the New button does,
    // or ChatPage snaps back to a live run's stream.
    if (convId === null) {
      useStore
        .getState()
        .setComposingNewConversationForProject(project_id, true);
    }

    // Save draft, keeping any unsent text already typed there
    const draftKey = `${project_id}:${convId || '__new__'}`;
    saveDraftByKey(
      draftKey,
      mergeSharedIntoDraft(useStore.getState().draftByKey[draftKey], content),
    );

    // Navigate
    navigate({
      to: '/chat/$projectId',
      params: { projectId: project_id },
    });

    handleClose();
  };

  if (!sharedContent) return null;

  return (
    <Dialog
      open={!!sharedContent}
      onOpenChange={(open) => !open && handleClose()}
    >
      <DialogContent className="sm:max-w-[400px] min-w-0 grid-cols-[minmax(0,1fr)] p-0 overflow-hidden gap-0">
        <DialogHeader className="p-6 pb-2">
          <DialogTitle>Share to Carapa</DialogTitle>
          <DialogDescription className="line-clamp-2 mt-2 text-xs bg-muted/30 p-2 rounded border italic">
            "{sharedContent.title || sharedContent.text}"
          </DialogDescription>
        </DialogHeader>

        <div className="p-6 pt-2 space-y-3 min-w-0 max-w-full">
          {step === 'options' ? (
            <>
              {lastProject && (
                <>
                  <Button
                    variant="outline"
                    className="w-full justify-start h-auto py-3 px-4 gap-3 text-left"
                    onClick={() =>
                      executeShare(
                        lastProject.id,
                        activeConvByProject[lastProject.id] || null,
                      )
                    }
                  >
                    <div className="bg-primary/10 p-2 rounded-full text-primary">
                      <MessageSquare className="size-4" />
                    </div>
                    <div className="flex flex-col min-w-0">
                      <span className="font-medium text-sm">
                        Continue last conversation
                      </span>
                      <span className="text-[10px] text-muted-foreground truncate">
                        In {lastProject.name}
                      </span>
                    </div>
                  </Button>

                  <Button
                    variant="outline"
                    className="w-full justify-start h-auto py-3 px-4 gap-3 text-left"
                    onClick={() => executeShare(lastProject.id, null)}
                  >
                    <div className="bg-primary/10 p-2 rounded-full text-primary">
                      <Plus className="size-4" />
                    </div>
                    <div className="flex flex-col min-w-0">
                      <span className="font-medium text-sm">
                        New conversation
                      </span>
                      <span className="text-[10px] text-muted-foreground truncate">
                        In {lastProject.name}
                      </span>
                    </div>
                  </Button>
                </>
              )}

              <Button
                variant="outline"
                className="w-full justify-start h-auto py-3 px-4 gap-3 text-left"
                onClick={() => setStep('select-project')}
              >
                <div className="bg-muted p-2 rounded-full text-muted-foreground">
                  <FolderTree className="size-4" />
                </div>
                <div className="flex flex-col min-w-0">
                  <span className="font-medium text-sm">
                    Select another project
                  </span>
                  <span className="text-[10px] text-muted-foreground truncate">
                    Browse all projects
                  </span>
                </div>
              </Button>
            </>
          ) : (
            <div className="space-y-4 min-w-0">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Select Project
                </h4>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-[10px]"
                  onClick={() => setStep('options')}
                >
                  Back
                </Button>
              </div>
              <div className="h-[250px] w-full min-w-0 overflow-y-auto overflow-x-hidden pr-4 -mr-4">
                <div className="space-y-1 w-full min-w-0 overflow-x-hidden">
                  {projectOptions.map((project) => {
                    const Icon = project.settings?.isParent ? Layers : Folder;
                    return (
                      <Button
                        key={project.id}
                        type="button"
                        variant="ghost"
                        data-ui="share-project-option"
                        data-project-id={project.id}
                        aria-level={project.depth + 1}
                        className="w-full max-w-full min-w-0 justify-between h-10 px-3 text-left font-normal overflow-hidden"
                        style={{
                          paddingLeft: `${0.75 + project.depth * 1.125}rem`,
                        }}
                        onClick={() => executeShare(project.id, null)}
                      >
                        <span className="flex min-w-0 flex-1 items-center gap-2">
                          <Icon
                            className={cn(
                              'size-3.5 shrink-0',
                              project.settings?.isParent
                                ? 'text-violet-600 dark:text-violet-400'
                                : 'text-muted-foreground',
                            )}
                          />
                          <span className="min-w-0 truncate text-sm">
                            {project.name}
                          </span>
                        </span>
                        <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                      </Button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="p-4 bg-muted/20 border-t">
          <Button variant="ghost" size="sm" onClick={handleClose}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
