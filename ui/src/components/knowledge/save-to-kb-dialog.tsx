import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Select, SelectItem } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Loader2, Notebook, Save } from 'lucide-react';
import { fetchSharedKnowledgeBases } from '@/lib/api';
import { useSaveMessageToKnowledge } from '@/hooks/use-knowledge';
import type { KnowledgeBase } from '@/types';
import { toast } from 'sonner';

interface SaveToKBDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  content: string;
  project_id: string;
}

export function SaveToKBDialog({
  open,
  onOpenChange,
  content,
  project_id,
}: SaveToKBDialogProps) {
  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedKbId, setSelectedKbId] = useState<string>('');
  const { mutate: saveMessage, isPending: saving } =
    useSaveMessageToKnowledge();

  useEffect(() => {
    if (open && project_id) {
      setLoading(true);
      fetchSharedKnowledgeBases(project_id)
        .then((data) => {
          setKbs(data);
          if (data.length > 0) {
            setSelectedKbId(data[0].id);
          }
        })
        .catch((err) => {
          console.error('Failed to fetch KBs:', err);
          toast.error('Failed to load knowledge bases');
        })
        .finally(() => setLoading(false));
    }
  }, [open, project_id, content]);

  const handleSave = () => {
    if (!selectedKbId) return;
    // Backend derives a descriptive filename and appends the cached page
    // transcript of any web links opened earlier in the chat.
    saveMessage(
      { id: selectedKbId, content, group_folder: project_id },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Notebook className="size-5 text-blue-700 dark:text-blue-500" />
            Save to Knowledge Base
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <label htmlFor="kb" className="text-sm font-medium">
              Select Knowledge Base
            </label>
            {loading ? (
              <div className="h-10 flex items-center justify-center border rounded-md bg-muted/50">
                <Loader2 className="size-4 animate-spin opacity-50" />
              </div>
            ) : kbs.length === 0 ? (
              <div className="text-sm text-amber-800 dark:text-amber-500 bg-amber-500/10 p-3 rounded-md border border-amber-500/20">
                No knowledge bases shared with this project.
              </div>
            ) : (
              <Select
                id="kb"
                className="w-full"
                value={selectedKbId}
                onValueChange={(nextValue) => setSelectedKbId(nextValue)}
              >
                {kbs.map((kb) => (
                  <SelectItem key={kb.id} value={kb.id}>
                    {kb.name}
                  </SelectItem>
                ))}
              </Select>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            The message is saved with an auto-generated filename, along with the
            full page content of any web links opened earlier in the chat (when
            still cached).
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || kbs.length === 0 || !selectedKbId}
            className="gap-2"
          >
            {saving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            {saving ? 'Saving…' : 'Save Information'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
