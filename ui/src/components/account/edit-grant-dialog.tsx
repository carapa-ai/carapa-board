import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Select, SelectItem } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { OAuthTargetsField } from '@/components/oauth/oauth-targets-field';
import {
  fetchOAuthGrantChoices,
  updateOAuthGrant,
  type OAuthGrant,
  type OAuthGrantChoices,
  type OAuthGrantEntry,
} from '@/lib/api';
import { describeOAuthDays } from '@/lib/oauth-display';

const KEEP_EXPIRY = 'keep';

const SELECT_CLASS = 'w-full';

function EditGrantForm({
  grant,
  choices,
  onClose,
  onSaved,
}: {
  grant: OAuthGrant;
  choices: OAuthGrantChoices;
  onClose: () => void;
  onSaved: () => void;
}) {
  const grantable = new Map(choices.targets.map((t) => [t.folder, t]));
  // Projects the owner can no longer grant are dropped from the editable list
  // and write narrows to read where the owner is now a viewer; the server
  // refuses both and token use already ignores them.
  const [selection, setSelection] = useState<OAuthGrantEntry[]>(() =>
    grant.targets.flatMap(({ kind, folder, access }) => {
      const option = grantable.get(folder);
      if (!option) return [];
      return [
        { kind, folder, access: option.canWrite ? access : ('read' as const) },
      ];
    }),
  );
  const unavailable = grant.targets.length - selection.length;
  const [expiry, setExpiry] = useState(KEEP_EXPIRY);

  const save = useMutation({
    mutationFn: () =>
      updateOAuthGrant(grant.id, {
        targets: selection,
        ...(expiry !== KEEP_EXPIRY && { days: Number(expiry) }),
      }),
    onSuccess: () => {
      toast.success('Access updated');
      onSaved();
    },
  });

  return (
    <>
      <div className="min-w-0 space-y-4">
        <div className="space-y-1 text-sm">
          <span className="text-xs text-muted-foreground">Projects</span>
          <OAuthTargetsField
            options={choices.targets}
            value={selection}
            onChange={setSelection}
            disabled={save.isPending}
          />
          {unavailable > 0 && (
            <p
              data-ui="edit-grant-unavailable"
              className="text-xs text-muted-foreground"
            >
              {unavailable === 1
                ? '1 project is no longer available to you and was removed from this list.'
                : `${unavailable} projects are no longer available to you and were removed from this list.`}
            </p>
          )}
        </div>

        <label className="block space-y-1 text-sm">
          <span className="text-xs text-muted-foreground">Expires</span>
          <Select
            className={SELECT_CLASS}
            value={expiry}
            disabled={save.isPending}
            onValueChange={(nextValue) => setExpiry(nextValue)}
          >
            <SelectItem value={KEEP_EXPIRY}>
              Keep current ({new Date(grant.expiresAt).toLocaleString()})
            </SelectItem>
            {choices.days.map((d) => (
              <SelectItem key={d} value={String(d)}>
                {describeOAuthDays(d)} from now
              </SelectItem>
            ))}
          </Select>
        </label>

        {save.error && (
          <p role="alert" className="text-sm text-destructive">
            {save.error.message}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Saving asks this device to confirm with a fresh signature. Narrowing
          access or shortening the expiry applies to the client's next request.
        </p>
      </div>
      <DialogFooter>
        <Button variant="outline" disabled={save.isPending} onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={save.isPending || selection.length === 0}
          onClick={() => save.mutate()}
        >
          {save.isPending && <Loader2 className="size-4 animate-spin" />}
          Save changes
        </Button>
      </DialogFooter>
    </>
  );
}

export function EditGrantDialog({
  grant,
  onClose,
  onSaved,
}: {
  grant: OAuthGrant | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { data, error, isLoading } = useQuery({
    queryKey: ['oauth', 'grant-choices'],
    queryFn: fetchOAuthGrantChoices,
    enabled: !!grant,
    staleTime: 0,
  });

  return (
    <Dialog open={!!grant} onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-ui="edit-grant-dialog">
        <DialogHeader>
          <DialogTitle>Edit access for {grant?.clientName}</DialogTitle>
          <DialogDescription>
            Choose the projects this client can reach, the access for each, and
            when the grant expires.
          </DialogDescription>
        </DialogHeader>
        {grant &&
          (isLoading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading projects…
            </p>
          ) : error || !data ? (
            <p role="alert" className="text-sm text-destructive">
              Failed to load projects: {error?.message ?? 'Unknown error'}
            </p>
          ) : (
            <EditGrantForm
              key={grant.id}
              grant={grant}
              choices={data}
              onClose={onClose}
              onSaved={onSaved}
            />
          ))}
      </DialogContent>
    </Dialog>
  );
}
