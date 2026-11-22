import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { useStore } from '@/store';
import {
  useAvailableGroups,
  useLinkProjectToWhatsApp,
  useUnlinkWhatsAppGroup,
} from '@/hooks/use-projects';
import type { AvailableGroup } from '@/types';
import { Loader2 } from 'lucide-react';
import { confirmAction } from '@/components/confirm-dialog';

export function LinkProjectToWhatsAppDialog() {
  const open = useStore((s) => s.linkProjectToWhatsAppDialogOpen);
  const setOpen = useStore((s) => s.setLinkProjectToWhatsAppDialogOpen);
  const project_id = useStore((s) => s.linkProjectToWhatsAppProjectId);
  const setProjectId = useStore((s) => s.setLinkProjectToWhatsAppProjectId);

  const groupsQuery = useAvailableGroups();

  // Only WhatsApp groups — self-chat linking handled automatically via QR
  const isLoading = groupsQuery.isLoading;
  const isError = groupsQuery.isError;
  const items = groupsQuery.data;

  const linkMutation = useLinkProjectToWhatsApp();
  const unlinkMutation = useUnlinkWhatsAppGroup();

  const defaultTrigger = '@Capa';

  const [selected, setSelected] = useState<AvailableGroup | null>(null);
  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState('');

  const isPending = linkMutation.isPending || unlinkMutation.isPending;

  // A controlled Dialog does not fire onOpenChange when `open` changes via
  // props, so reset the form whenever it closes, whatever closed it.
  useEffect(() => {
    if (open) return;
    setSelected(null);
    setName('');
    setTrigger('');
  }, [open]);

  const handleOpenChange = (v: boolean) => {
    setOpen(v);
    if (!v) setProjectId(null);
  };

  const handleSelect = (group: AvailableGroup) => {
    if (group.isRegistered) return;
    setSelected(group);
    setName(group.name ?? '');
  };

  const handleLink = async () => {
    if (!selected || !project_id || !name.trim() || isPending) return;

    try {
      await linkMutation.mutateAsync({
        project_id,
        whatsappJid: selected.jid,
        name: name.trim(),
        trigger: trigger.trim() || defaultTrigger,
      });
    } catch {
      return; // the mutation's onError already showed the toast
    }

    handleOpenChange(false);
  };

  const handleUnlink = async (e: React.MouseEvent, jid: string) => {
    e.stopPropagation();
    if (isPending) return;
    const confirmed = await confirmAction(
      'The project will stop receiving messages from this group.',
      {
        title: 'Disconnect this group?',
        confirmLabel: 'Disconnect',
        destructive: true,
      },
    );
    if (confirmed) {
      try {
        await unlinkMutation.mutateAsync(jid);
      } catch {
        // the mutation's onError already showed the toast
      }
    }
  };

  const title = 'Link to WhatsApp';
  const description = 'Select a WhatsApp group to link to this project.';
  const emptyMessage =
    'No WhatsApp groups found. Make sure the bot has joined a group.';

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <ScrollArea className="h-48 rounded-md border border-border">
            {isLoading && (
              <p className="p-3 text-sm text-muted-foreground">Loading…</p>
            )}
            {!isLoading && isError && (
              <p className="p-3 text-sm text-destructive">
                WhatsApp service unavailable. Check that the messaging service
                is running.
              </p>
            )}
            {!isLoading && !isError && (!items || items.length === 0) && (
              <p className="p-3 text-sm text-muted-foreground">
                {emptyMessage}
              </p>
            )}
            {items?.map((group) => (
              <div
                key={group.jid}
                onClick={() => handleSelect(group)}
                className={cn(
                  'flex items-center justify-between w-full px-3 py-2 text-sm transition-colors cursor-pointer',
                  group.isRegistered
                    ? 'opacity-75 bg-accent/20 cursor-default'
                    : selected?.jid === group.jid
                      ? 'bg-accent text-accent-foreground'
                      : 'hover:bg-accent/50',
                )}
              >
                <div className="flex flex-col overflow-hidden">
                  <span className="font-medium truncate">
                    {group.name || '(Unknown)'}
                  </span>
                  <span className="text-xs text-muted-foreground font-mono truncate">
                    {group.jid.split('@')[0]}
                  </span>
                </div>

                {group.isRegistered ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 ml-2 shrink-0"
                    onClick={(e) => handleUnlink(e, group.jid)}
                    disabled={unlinkMutation.isPending}
                  >
                    {unlinkMutation.isPending ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      'Disconnect'
                    )}
                  </Button>
                ) : (
                  selected?.jid === group.jid && (
                    <span className="ml-2 text-xs font-medium text-primary">
                      Selected
                    </span>
                  )
                )}
              </div>
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
                  onKeyDown={(e) => e.key === 'Enter' && handleLink()}
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
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleLink}
            disabled={!selected || !project_id || !name.trim() || isPending}
          >
            Link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
