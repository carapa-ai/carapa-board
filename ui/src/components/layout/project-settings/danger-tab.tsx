import { Button } from '@/components/ui/button';
import { TabsContent } from '@/components/ui/tabs';
import { Trash2 } from 'lucide-react';
import type { useDeleteProject } from '@/hooks/use-projects';
import { TAB_CONTENT_CLASS } from './shared';

interface DangerTabProps {
  projectName: string;
  confirmDelete: boolean;
  setConfirmDelete: (confirm: boolean) => void;
  deleteMutation: ReturnType<typeof useDeleteProject>;
  handleDelete: () => void;
  canDelete: boolean;
}

export function DangerTab({
  projectName,
  confirmDelete,
  setConfirmDelete,
  deleteMutation,
  handleDelete,
  canDelete,
}: DangerTabProps) {
  return (
    <TabsContent
      value="danger"
      data-ui="project-settings-tab-danger"
      className={TAB_CONTENT_CLASS}
    >
      <div className="border border-destructive/30 rounded-lg p-4">
        <h3 className="text-sm font-semibold text-destructive mb-1">
          Danger Zone
        </h3>
        {!confirmDelete ? (
          <div className="flex items-center justify-between gap-4">
            <p className="text-xs text-muted-foreground">
              Permanently delete this project and all its tasks, chat history,
              and settings. This action cannot be undone.
              {!canDelete && (
                <span
                  data-ui="project-delete-restricted"
                  className="mt-1 block"
                >
                  Only the project owner or an admin can delete this project.
                </span>
              )}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="border-destructive/50 text-destructive hover:bg-destructive hover:text-destructive-foreground flex-shrink-0"
              disabled={!canDelete}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="size-3.5 mr-1.5" />
              Delete Project
            </Button>
          </div>
        ) : (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 space-y-3">
            <p className="text-sm text-destructive font-medium">
              Are you sure?
            </p>
            <p className="text-xs text-muted-foreground">
              This will permanently delete <strong>{projectName}</strong> and
              all its data.
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmDelete(false)}
                disabled={deleteMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDelete}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending
                  ? 'Deleting...'
                  : 'Yes, delete project'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </TabsContent>
  );
}
