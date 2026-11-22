import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  assignProjectToBox,
  createCarapaBox,
  deleteCarapaBox,
  fetchCarapaBoxes,
  revokeCarapaBox,
  rotateCarapaBoxToken,
  type CarapaBoxView,
} from '@/lib/api';
import { Select, SelectItem } from '@/components/ui/select';
import { useAuth } from '@/lib/auth';
import { useProjects } from '@/hooks/use-projects';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/layout/page-header';
import { confirmAction } from '@/components/confirm-dialog';
import { queryKeys } from '@/lib/query-keys';

const selectClass = 'w-full min-w-0';

function IssuedCredential({
  boxId,
  value,
  onDone,
}: {
  boxId: string;
  value: string;
  onDone: () => void;
}) {
  return (
    <Card data-ui="box-credential">
      <CardContent className="space-y-3 p-4">
        <CardTitle className="text-base">
          Connection secret for {boxId}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Shown once. Configure the box with CARAPA_HUB_URL, CARAPA_BOX_ID=
          {boxId} and this value as CARAPA_HUB_BOX_SECRET.
        </p>
        <Input readOnly value={value} onFocus={(e) => e.target.select()} />
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() =>
              navigator.clipboard
                .writeText(value)
                .then(() => toast.success('Copied'))
            }
          >
            Copy
          </Button>
          <Button onClick={onDone}>Done</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function BoxRow({
  box,
  projects,
  onIssued,
  refresh,
}: {
  box: CarapaBoxView;
  projects: string[];
  onIssued: (boxId: string, value: string) => void;
  refresh: () => void;
}) {
  const [project, setProject] = useState('');
  const onError = (error: Error) => toast.error(error.message);
  const rotate = useMutation({
    mutationFn: () => rotateCarapaBoxToken(box.id),
    onSuccess: (result) => {
      onIssued(box.id, result.token);
      refresh();
    },
    onError,
  });
  const revoke = useMutation({
    mutationFn: () => revokeCarapaBox(box.id),
    onSuccess: refresh,
    onError,
  });
  const remove = useMutation({
    mutationFn: () => deleteCarapaBox(box.id),
    onSuccess: refresh,
    onError,
  });
  const assign = useMutation({
    mutationFn: async () => {
      const reduced = box.kind === 'native';
      if (
        reduced &&
        !(await confirmAction(
          `${box.label} runs agents without container isolation.`,
          { title: `Assign ${project} to it?`, confirmLabel: 'Assign' },
        ))
      ) {
        return { ok: false };
      }
      return assignProjectToBox(box.id, project, reduced);
    },
    onSuccess: () => {
      setProject('');
      refresh();
    },
    onError,
  });
  const implicitLocal = box.id === 'local' && !box.createdAt;
  return (
    <div className="space-y-2 border-t pt-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`inline-block size-2 rounded-full ${box.online ? 'bg-emerald-600 dark:bg-emerald-500' : 'bg-muted-foreground'}`}
          aria-label={box.online ? 'online' : 'offline'}
        />
        <span className="font-medium">{box.label}</span>
        <span className="text-xs text-muted-foreground">
          {box.id} · {box.kind} · isolation: {box.isolationLevel}
          {box.version ? ` · v${box.version}` : ''}
          {box.revokedAt ? ' · revoked' : ''}
        </span>
      </div>
      {box.kind === 'native' && (
        <p className="text-xs text-amber-800 dark:text-amber-500">
          Reduced isolation: agents run natively with the harness sandbox only.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {box.online
          ? implicitLocal
            ? 'Reached over CARAPA_BOX_URL'
            : `Connected since ${box.connectedAt ? new Date(box.connectedAt).toLocaleString() : '—'}`
          : `Offline${box.lastSeenAt ? ` · last seen ${new Date(box.lastSeenAt).toLocaleString()}` : ''}`}
      </p>
      <p className="text-xs">
        Projects: {box.projects.length ? box.projects.join(', ') : 'none'}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          compact
          aria-label={`Assign a project to ${box.id}`}
          className="sm:w-56"
          value={project}
          onValueChange={(nextValue) => setProject(nextValue)}
        >
          <SelectItem value="">Move project here…</SelectItem>
          {projects
            .filter((folder) => !box.projects.includes(folder))
            .map((folder) => (
              <SelectItem key={folder} value={folder}>
                {folder}
              </SelectItem>
            ))}
        </Select>
        <Button
          size="sm"
          variant="outline"
          disabled={!project || assign.isPending || !!box.revokedAt}
          onClick={() => assign.mutate()}
        >
          Assign
        </Button>
        {!implicitLocal && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={rotate.isPending}
              onClick={() => rotate.mutate()}
            >
              Rotate secret
            </Button>
            {!box.revokedAt && (
              <Button
                size="sm"
                variant="outline"
                disabled={revoke.isPending}
                onClick={async () => {
                  const confirmed = await confirmAction('It disconnects now.', {
                    title: `Revoke ${box.id}?`,
                    confirmLabel: 'Revoke',
                    destructive: true,
                  });
                  if (confirmed) revoke.mutate();
                }}
              >
                Revoke
              </Button>
            )}
            <Button
              size="sm"
              variant="destructive"
              disabled={remove.isPending || box.projects.length > 0}
              onClick={async () => {
                const confirmed = await confirmAction(
                  'This cannot be undone.',
                  {
                    title: `Delete ${box.id}?`,
                    confirmLabel: 'Delete',
                    destructive: true,
                  },
                );
                if (confirmed) remove.mutate();
              }}
            >
              Delete
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export function BoxesPage() {
  const isAdmin = useAuth((s) => s.user?.role === 'admin');
  const { data: projectList } = useProjects();
  const projectFolders = (projectList ?? []).map((p) => p.id).sort();
  const queryClient = useQueryClient();
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<'docker' | 'native'>('docker');
  const [issued, setIssued] = useState<{ boxId: string; value: string } | null>(
    null,
  );
  const query = useQuery({
    queryKey: queryKeys.admin.boxes,
    queryFn: fetchCarapaBoxes,
    enabled: isAdmin,
    refetchInterval: 5000,
    gcTime: 0,
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.admin.boxes });
  const create = useMutation({
    mutationFn: createCarapaBox,
    onSuccess: (result) => {
      setIssued({ boxId: result.box.id, value: result.token });
      setId('');
      setLabel('');
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  if (!isAdmin) return <div className="p-6">Admin access required.</div>;
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden" id="boxes">
      <PageHeader
        title="CarapaBox hosts"
        subtitle="Machines that run project sandboxes and connect out to this Board."
      />
      <div className="flex-1 overflow-auto p-4 sm:p-6">
        <div className="mx-auto max-w-3xl space-y-4">
          {issued && (
            <IssuedCredential
              boxId={issued.boxId}
              value={issued.value}
              onDone={() => setIssued(null)}
            />
          )}
          <Card data-ui="box-register">
            <CardContent className="space-y-4 p-4">
              <CardTitle className="text-base">Register a box</CardTitle>
              <div className="grid gap-3 sm:grid-cols-3">
                <Input
                  aria-label="Box id"
                  placeholder="id (e.g. lab-pc)"
                  value={id}
                  maxLength={63}
                  onChange={(e) => setId(e.target.value.toLowerCase())}
                />
                <Input
                  aria-label="Label"
                  placeholder="Label"
                  value={label}
                  maxLength={80}
                  onChange={(e) => setLabel(e.target.value)}
                />
                <Select
                  aria-label="Kind"
                  className={selectClass}
                  value={kind}
                  onValueChange={(nextValue) =>
                    setKind(nextValue as 'docker' | 'native')
                  }
                >
                  <SelectItem value="docker">
                    Linux CarapaBox (Docker)
                  </SelectItem>
                  <SelectItem value="native">
                    Native runner (reduced isolation)
                  </SelectItem>
                </Select>
              </div>
              <Button
                disabled={!/^[a-z0-9][a-z0-9-]*$/.test(id) || create.isPending}
                onClick={() => create.mutate({ id, label, kind })}
              >
                {create.isPending ? 'Registering…' : 'Register'}
              </Button>
              <p className="text-xs text-muted-foreground">
                A project&apos;s group directory and IPC tree live on the box
                that runs it. Stop a project&apos;s running work before moving
                it; files are not copied between boxes.
              </p>
            </CardContent>
          </Card>
          {query.isLoading && <p role="status">Loading boxes…</p>}
          {query.error && (
            <p role="alert" className="text-sm text-destructive">
              {query.error.message}
            </p>
          )}
          {query.data && (
            <Card>
              <CardContent className="space-y-3 p-4">
                {query.data.boxes.map((box) => (
                  <BoxRow
                    key={box.id}
                    box={box}
                    projects={projectFolders}
                    onIssued={(boxId, value) => setIssued({ boxId, value })}
                    refresh={refresh}
                  />
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
