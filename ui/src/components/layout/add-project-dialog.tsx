import { useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useStore } from '@/store';
import { useCreateProject } from '@/hooks/use-projects';
import { useNavigate } from '@tanstack/react-router';

export function AddProjectDialog() {
  const open = useStore((s) => s.addProjectDialogOpen);
  const setOpen = useStore((s) => s.setAddProjectDialogOpen);
  const createMutation = useCreateProject();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  // Synchronous guard: `isPending` only updates after React re-renders, so a
  // fast second Enter would otherwise send a duplicate request.
  const submittingRef = useRef(false);

  const reset = () => {
    setName('');
    setFolder('');
  };

  const handleCreate = async () => {
    if (!name.trim() || submittingRef.current) return;
    submittingRef.current = true;
    try {
      const project = await createMutation.mutateAsync({
        name: name.trim(),
        folder: folder.trim() || undefined,
      });
      reset();
      setOpen(false);
      if (project?.id) {
        navigate({ to: '/chat/$projectId', params: { projectId: project.id } });
      }
    } catch {
      // The mutation hook reports the failure; keep the dialog open to retry.
    } finally {
      submittingRef.current = false;
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Project</DialogTitle>
          <DialogDescription>
            Create a new project to track tasks.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="proj-name">
              Name
            </label>
            <Input
              id="proj-name"
              placeholder="My Project"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="proj-folder">
              Folder slug (optional)
            </label>
            <Input
              id="proj-folder"
              placeholder="auto-derived from name"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!name.trim() || createMutation.isPending}
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
