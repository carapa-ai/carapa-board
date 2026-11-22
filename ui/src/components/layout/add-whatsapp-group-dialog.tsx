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
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { useStore } from '@/store';
import {
  useAvailableGroups,
  useRegisterWhatsAppGroup,
} from '@/hooks/use-whatsapp';
import { useNavigate } from '@tanstack/react-router';
import type { AvailableGroup } from '@/types';
import { useAppConfig } from '@/hooks/use-app-config';

export function AddWhatsAppGroupDialog() {
  const open = useStore((s) => s.addWhatsAppGroupDialogOpen);
  const setOpen = useStore((s) => s.setAddWhatsAppGroupDialogOpen);
  const { data: groups, isLoading, isError } = useAvailableGroups();
  const registerMutation = useRegisterWhatsAppGroup();
  const navigate = useNavigate();

  const { data: config } = useAppConfig();
  const defaultTrigger = `@${config?.assistantName ?? 'Capa'}`;

  const [selected, setSelected] = useState<AvailableGroup | null>(null);
  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState('');

  const submittingRef = useRef(false);

  const reset = () => {
    setSelected(null);
    setName('');
    setTrigger('');
  };

  const handleSelect = (group: AvailableGroup) => {
    if (group.isRegistered) return;
    setSelected(group);
    setName(group.name ?? '');
  };

  const close = (v: boolean) => {
    setOpen(v);
    if (!v) reset();
  };

  const handleConnect = async () => {
    if (!selected || !name.trim() || submittingRef.current) return;
    submittingRef.current = true;
    try {
      const result = await registerMutation.mutateAsync({
        jid: selected.jid,
        name: name.trim(),
        trigger: trigger.trim() || defaultTrigger,
      });
      close(false);
      navigate({
        to: '/chat/$projectId',
        params: { projectId: result.folder },
      });
    } catch {
      // useRegisterWhatsAppGroup's onError already shows the failure toast.
    } finally {
      submittingRef.current = false;
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Connect WhatsApp Group</DialogTitle>
          <DialogDescription>
            Select a WhatsApp group to link as a project.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <ScrollArea className="h-48 rounded-md border border-border">
            {isLoading && (
              <p className="p-3 text-sm text-muted-foreground">
                Loading groups…
              </p>
            )}
            {!isLoading && isError && (
              <p className="p-3 text-sm text-destructive">
                WhatsApp service unavailable. Check that the messaging service
                is running.
              </p>
            )}
            {!isLoading && !isError && (!groups || groups.length === 0) && (
              <p className="p-3 text-sm text-muted-foreground">
                No WhatsApp groups found. Make sure the bot has joined a group.
              </p>
            )}
            {groups?.map((group) => (
              <button
                key={group.jid}
                disabled={group.isRegistered}
                onClick={() => handleSelect(group)}
                className={cn(
                  'w-full text-left px-3 py-2 text-sm transition-colors',
                  group.isRegistered
                    ? 'text-muted-foreground cursor-not-allowed opacity-50'
                    : selected?.jid === group.jid
                      ? 'bg-accent text-accent-foreground'
                      : 'hover:bg-accent/50',
                )}
              >
                <span className="font-medium">{group.name ?? group.jid}</span>
                {group.isRegistered && (
                  <span className="ml-2 text-xs">(already connected)</span>
                )}
              </button>
            ))}
          </ScrollArea>

          {selected && (
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="wa-name">
                  Project name
                </label>
                <Input
                  id="wa-name"
                  placeholder="My Group"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
                  autoFocus
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="wa-trigger">
                  Trigger word
                </label>
                <Input
                  id="wa-trigger"
                  placeholder={defaultTrigger}
                  value={trigger}
                  onChange={(e) => setTrigger(e.target.value)}
                />
              </div>
            </>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleConnect}
            disabled={!selected || !name.trim() || registerMutation.isPending}
          >
            Connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
