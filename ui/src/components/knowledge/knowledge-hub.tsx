import { useId, useState } from 'react';
import {
  useKnowledgeBases,
  useKnowledgeVectorStatus,
  useCreateKnowledgeBase,
  useUpdateKnowledgeBase,
  useDeleteKnowledgeBase,
  useIndexKnowledgeBase,
  useShareKnowledgeBase,
  useUnshareKnowledgeBase,
  useKnowledgeShares,
  useKnowledgeFiles,
} from '@/hooks/use-knowledge';
import { useProjects } from '@/hooks/use-projects';
import { Button } from '@/components/ui/button';
import { CardTitle, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { SearchInput } from '@/components/ui/search-input';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import {
  Book,
  Plus,
  Trash2,
  RefreshCw,
  Share2,
  Check,
  X,
  Clock,
  Folder,
  Database,
  HardDrive,
  AlertCircle,
  CheckCircle2,
  Edit2,
  ChevronRight,
  ChevronDown,
  Layers,
  Smartphone,
  Settings2,
  WifiOff,
} from 'lucide-react';
import { ShareDialog } from '@/components/share-dialog';
import { cn } from '@/lib/utils';
import { shortEntityId } from '@/lib/short-id';
import { toast } from 'sonner';
import { Project, KnowledgeBase } from '@/types';
import { KnowledgeItemGrid, KnowledgeItemCard } from './knowledge-items';
import { KnowledgeDocuments } from './knowledge-documents';
import { useMediaQuery } from '@/hooks/use-media-query';
import { PageHeader } from '@/components/layout/page-header';
import { confirmAction } from '@/components/confirm-dialog';

export function KnowledgeHub() {
  const { data: kbs, isLoading, isError, refetch } = useKnowledgeBases();
  const vectorStatus = useKnowledgeVectorStatus();
  const [selectedKbId, setSelectedKbId] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [search, setSearch] = useState('');
  const compact = useMediaQuery('(max-width: 1023px)');
  const [desktopPropertiesOpen, setDesktopPropertiesOpen] = useState(true);
  const [mobilePropertiesOpen, setMobilePropertiesOpen] = useState(false);

  const selectedKb = kbs?.find((k) => k.id === selectedKbId);

  return (
    <div className="flex-1 h-full flex flex-col min-h-0 bg-background/50">
      <PageHeader
        className="sm:flex-col sm:items-stretch xl:flex-row xl:items-center sm:[&>div:last-child]:w-full xl:[&>div:last-child]:w-auto"
        actionsClassName="sm:flex-1 xl:flex-initial"
        icon={
          <div className="p-2 bg-primary/10 rounded-lg shrink-0">
            <Database className="size-5 text-primary" />
          </div>
        }
        title={
          <span className="flex min-w-0 max-w-full items-center gap-1.5 text-muted-foreground flex-wrap">
            <button
              onClick={() => setSelectedKbId(null)}
              className={cn(
                'hover:text-foreground transition-colors font-bold whitespace-nowrap',
                selectedKb &&
                  'text-muted-foreground/70 hover:text-foreground font-medium',
              )}
            >
              Knowledge Hub
            </button>
            {selectedKb && (
              <>
                <ChevronRight className="size-3.5 shrink-0 opacity-60" />
                <span className="min-w-0 max-w-full font-semibold text-foreground truncate">
                  {selectedKb.name}
                </span>
              </>
            )}
          </span>
        }
        subtitle={
          selectedKb
            ? selectedKb.description || 'Manage source files and settings'
            : 'Manage your shared knowledge and RAG sources.'
        }
      >
        {selectedKb ? (
          <Button
            variant="outline"
            className="gap-2 h-9"
            aria-expanded={
              compact ? mobilePropertiesOpen : desktopPropertiesOpen
            }
            onClick={() =>
              compact
                ? setMobilePropertiesOpen(true)
                : setDesktopPropertiesOpen(!desktopPropertiesOpen)
            }
          >
            <Settings2 className="size-4" /> Properties
          </Button>
        ) : (
          <>
            <SearchInput
              aria-label="Search knowledge bases"
              placeholder="Search Knowledge Bases..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              wrapperClassName="flex-1 xl:flex-initial xl:w-64"
            />
            <KnowledgeVectorStatusBadge
              status={vectorStatus.data}
              isLoading={vectorStatus.isLoading}
              hasError={!!vectorStatus.error}
            />
            <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
              <DialogTrigger asChild>
                <Button className="gap-2 shadow-lg shadow-primary/10 transition-all hover:scale-[1.02] active:scale-[0.98] h-9 shrink-0">
                  <Plus className="size-4" />
                  <span className="hidden sm:inline">New KB</span>
                  <span className="inline sm:hidden">New</span>
                </Button>
              </DialogTrigger>
              <CreateKbDialog onSuccess={() => setIsCreateOpen(false)} />
            </Dialog>
          </>
        )}
      </PageHeader>

      <div className="flex-1 flex overflow-hidden relative">
        {selectedKb ? (
          <KnowledgeDocuments key={selectedKb.id} kbId={selectedKb.id} />
        ) : (
          <ScrollArea
            data-ui="knowledge-collections"
            className="flex-1 min-w-0 [&_[data-slot=scroll-area-viewport]>div]:!block [&_[data-slot=scroll-area-viewport]>div]:!w-full"
          >
            <div className="p-4 sm:p-6">
              {isLoading ? (
                <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
                  <RefreshCw className="size-8 animate-spin mb-4 opacity-50" />
                  <p>Loading Knowledge Hub...</p>
                </div>
              ) : isError && !kbs ? (
                <div
                  data-ui="knowledge-collections-error"
                  role="alert"
                  className="flex flex-col items-center justify-center h-64 border-2 border-dashed border-border rounded-xl bg-accent/20"
                >
                  <AlertCircle className="size-12 text-muted-foreground mb-4 opacity-30" />
                  <h3 className="text-lg font-medium">
                    Could not load Knowledge Bases
                  </h3>
                  <p className="text-sm text-muted-foreground mb-6">
                    Something went wrong while loading your library.
                  </p>
                  <Button variant="outline" onClick={() => refetch()}>
                    Retry
                  </Button>
                </div>
              ) : kbs?.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-64 border-2 border-dashed border-border rounded-xl bg-accent/20">
                  <Book className="size-12 text-muted-foreground mb-4 opacity-30" />
                  <h3 className="text-lg font-medium">
                    No Knowledge Bases yet
                  </h3>
                  <p className="text-sm text-muted-foreground mb-6">
                    Create one to start building your AI library.
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => setIsCreateOpen(true)}
                  >
                    Create your first KB
                  </Button>
                </div>
              ) : (
                <KnowledgeItemGrid>
                  {kbs
                    ?.filter((kb) =>
                      kb.name.toLowerCase().includes(search.toLowerCase()),
                    )
                    .map((kb) => (
                      <KnowledgeItemCard
                        key={kb.id}
                        data-ui="knowledge-collection"
                        data-kb-id={kb.id}
                        role="button"
                        tabIndex={0}
                        aria-label={`Open ${kb.name}`}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            setSelectedKbId(kb.id);
                            setDesktopPropertiesOpen(true);
                          }
                        }}
                        className="group cursor-pointer select-none outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => {
                          setSelectedKbId(kb.id);
                          setDesktopPropertiesOpen(true);
                        }}
                      >
                        <CardContent className="p-3 sm:p-4 flex flex-col justify-between h-full">
                          <div className="flex items-start justify-between gap-3 min-w-0">
                            <div className="flex items-center gap-2.5 min-w-0">
                              <div className="p-1.5 bg-primary/10 rounded group-hover:bg-primary/20 transition-colors shrink-0">
                                <Book className="size-4 text-primary" />
                              </div>
                              <div className="min-w-0">
                                <CardTitle className="text-sm font-semibold line-clamp-2 break-words [overflow-wrap:anywhere] group-hover:text-primary transition-colors leading-snug">
                                  {kb.name}
                                </CardTitle>
                                <Badge
                                  variant="outline"
                                  className="text-[9px] px-1 py-0 h-4 uppercase font-semibold border-muted-foreground/30 text-muted-foreground mt-0.5 select-none"
                                >
                                  {kb.last_indexed_at ? 'Indexed' : 'Draft'}
                                </Badge>
                              </div>
                            </div>
                          </div>

                          <p className="text-xs text-muted-foreground line-clamp-1 mt-2 mb-2">
                            {kb.description || 'No description provided.'}
                          </p>

                          <div className="flex flex-wrap gap-2 items-center justify-between border-t border-border/40 pt-2 mt-auto">
                            <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                              <div className="flex items-center gap-1">
                                <Clock className="size-3 shrink-0" />
                                {new Date(kb.created_at).toLocaleDateString()}
                              </div>
                              {kb.last_indexed_at && (
                                <div className="flex items-center gap-1">
                                  <RefreshCw className="size-3 shrink-0" />
                                  {new Date(
                                    kb.last_indexed_at,
                                  ).toLocaleTimeString([], {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  })}
                                </div>
                              )}
                            </div>
                            <Badge
                              variant="secondary"
                              title={kb.id}
                              className="px-1 py-0 h-4 text-[9px] font-mono tracking-wider bg-secondary/50"
                            >
                              ID: {shortEntityId(kb.id)}
                            </Badge>
                          </div>
                        </CardContent>
                      </KnowledgeItemCard>
                    ))}
                </KnowledgeItemGrid>
              )}
            </div>
          </ScrollArea>
        )}
        {selectedKb && !compact && desktopPropertiesOpen && (
          <aside
            data-ui="knowledge-properties"
            data-kb-id={selectedKb.id}
            className="w-[340px] xl:w-[380px] border-l border-border bg-background flex flex-col shrink-0 overflow-hidden min-h-0"
          >
            <KbDetails
              key={selectedKb.id}
              kb={selectedKb}
              onClose={() => setDesktopPropertiesOpen(false)}
              onDeleted={() => setSelectedKbId(null)}
            />
          </aside>
        )}
        {selectedKb && compact && (
          <Dialog
            open={mobilePropertiesOpen}
            onOpenChange={setMobilePropertiesOpen}
          >
            <DialogContent
              data-ui="knowledge-properties-mobile"
              data-kb-id={selectedKb.id}
              showCloseButton={false}
              aria-describedby={undefined}
              className="p-0 gap-0 h-[85dvh] flex flex-col overflow-hidden"
            >
              <DialogTitle className="sr-only">
                Knowledge base properties
              </DialogTitle>
              <KbDetails
                key={selectedKb.id}
                kb={selectedKb}
                onClose={() => setMobilePropertiesOpen(false)}
                onDeleted={() => {
                  setMobilePropertiesOpen(false);
                  setSelectedKbId(null);
                }}
              />
            </DialogContent>
          </Dialog>
        )}
      </div>
    </div>
  );
}

function KnowledgeVectorStatusBadge({
  status,
  isLoading,
  hasError,
}: {
  status: { enabled: boolean; available: boolean; status: string } | undefined;
  isLoading: boolean;
  hasError: boolean;
}) {
  const unavailable = hasError || status?.status === 'unavailable';
  const disabled = status?.status === 'disabled';
  const label = isLoading
    ? 'Checking semantic index'
    : hasError
      ? 'Semantic index status unavailable'
      : disabled
        ? 'Keyword fallback · vector search disabled'
        : unavailable
          ? 'Keyword fallback · semantic index unavailable'
          : 'Semantic search connected';
  const Icon = isLoading
    ? RefreshCw
    : unavailable || disabled
      ? WifiOff
      : CheckCircle2;

  return (
    <div
      data-ui="knowledge-vector-status"
      data-status={
        isLoading ? 'loading' : hasError ? 'unknown' : status?.status
      }
      role="status"
      title={label}
      className={cn(
        'inline-flex min-h-9 items-center gap-1.5 rounded-md border px-2.5 text-xs whitespace-nowrap',
        isLoading && 'border-border text-muted-foreground',
        !isLoading &&
          !unavailable &&
          !disabled &&
          'border-green-500/20 bg-green-500/5 text-green-700 dark:text-green-400',
        !isLoading &&
          (unavailable || disabled) &&
          'border-amber-500/20 bg-amber-500/5 text-amber-800 dark:text-amber-400',
      )}
    >
      <Icon className={cn('size-3.5 shrink-0', isLoading && 'animate-spin')} />
      <span className="hidden sm:inline">{label}</span>
      <span className="sm:hidden">
        {isLoading
          ? 'Checking'
          : unavailable || disabled
            ? 'Fallback'
            : 'Connected'}
      </span>
    </div>
  );
}

export function CreateKbDialog({ onSuccess }: { onSuccess: () => void }) {
  // The form lives inside DialogContent, which unmounts while closed, so its
  // state starts empty on every open and abandoned input never reappears.
  return (
    <DialogContent className="sm:max-w-[425px]">
      <CreateKbForm onSuccess={onSuccess} />
    </DialogContent>
  );
}

function CreateKbForm({ onSuccess }: { onSuccess: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const createMutation = useCreateKnowledgeBase();
  const nameId = useId();
  const descriptionId = useId();
  const trimmedName = name.trim();

  const handleCreate = async () => {
    if (!trimmedName) return;
    try {
      await createMutation.mutateAsync({
        name: trimmedName,
        description: description.trim() || null,
      });
      toast.success('Knowledge Base created!');
      onSuccess();
    } catch (e: any) {
      toast.error(
        `Failed to create Knowledge Base: ${e.message || 'Unknown error'}`,
      );
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Create Knowledge Base</DialogTitle>
      </DialogHeader>
      <div className="grid gap-4 py-4">
        <div className="grid gap-2">
          <label htmlFor={nameId} className="text-sm font-medium">
            Name
          </label>
          <Input
            id={nameId}
            placeholder="e.g. Project Documentation"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <label htmlFor={descriptionId} className="text-sm font-medium">
            Description
          </label>
          <Textarea
            id={descriptionId}
            placeholder="What kind of information does this KB contain?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      </div>
      <DialogFooter>
        <Button
          onClick={handleCreate}
          disabled={createMutation.isPending || !trimmedName}
        >
          {createMutation.isPending ? (
            <RefreshCw className="size-4 animate-spin mr-2" />
          ) : (
            <Plus className="size-4 mr-2" />
          )}
          Create KB
        </Button>
      </DialogFooter>
    </>
  );
}

export function EditKbDialog({
  kb,
  onSuccess,
}: {
  kb: any;
  onSuccess: () => void;
}) {
  // The form lives inside DialogContent, which unmounts while closed, so its
  // state is re-initialised from the KB on every open.
  return (
    <DialogContent className="sm:max-w-[425px]">
      <EditKbForm kb={kb} onSuccess={onSuccess} />
    </DialogContent>
  );
}

function EditKbForm({ kb, onSuccess }: { kb: any; onSuccess: () => void }) {
  const [name, setName] = useState(kb.name);
  const [description, setDescription] = useState(kb.description || '');
  const updateMutation = useUpdateKnowledgeBase();
  const nameId = useId();
  const descriptionId = useId();
  const trimmedName = name.trim();

  const handleUpdate = async () => {
    if (!trimmedName) return;
    try {
      await updateMutation.mutateAsync({
        id: kb.id,
        data: { name: trimmedName, description: description.trim() || null },
      });
      toast.success('Knowledge Base updated!');
      onSuccess();
    } catch (e: any) {
      toast.error(
        `Failed to update Knowledge Base: ${e.message || 'Unknown error'}`,
      );
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Edit Knowledge Base</DialogTitle>
      </DialogHeader>
      <div className="grid gap-4 py-4">
        <div className="grid gap-2">
          <label htmlFor={nameId} className="text-sm font-medium">
            Name
          </label>
          <Input
            id={nameId}
            placeholder="e.g. Project Documentation"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <label htmlFor={descriptionId} className="text-sm font-medium">
            Description
          </label>
          <Textarea
            id={descriptionId}
            placeholder="What kind of information does this KB contain?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      </div>
      <DialogFooter>
        <Button
          onClick={handleUpdate}
          disabled={updateMutation.isPending || !trimmedName}
        >
          {updateMutation.isPending ? (
            <RefreshCw className="size-4 animate-spin mr-2" />
          ) : (
            <Check className="size-4 mr-2" />
          )}
          Save Changes
        </Button>
      </DialogFooter>
    </>
  );
}

function KbDetails({
  kb,
  onClose,
  onDeleted,
}: {
  kb: KnowledgeBase;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const deleteMutation = useDeleteKnowledgeBase();
  const indexMutation = useIndexKnowledgeBase();
  const { data: projects } = useProjects();
  const { data: sharedGroups } = useKnowledgeShares(kb.id);
  const shareMutation = useShareKnowledgeBase();
  const unshareMutation = useUnshareKnowledgeBase();
  const {
    data: files,
    isError: filesFailed,
    isPending: filesPending,
  } = useKnowledgeFiles(kb.id);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isShareOpen, setIsShareOpen] = useState(false);
  const [sharingOpen, setSharingOpen] = useState(true);

  const handleIndex = async () => {
    try {
      await indexMutation.mutateAsync(kb.id);
      toast.success('Indexing started in background');
    } catch (e: any) {
      toast.error(`Failed to start indexing: ${e.message}`);
    }
  };

  const handleDelete = async () => {
    const confirmed = await confirmAction(
      'All vectors and metadata will be removed.',
      {
        title: 'Delete this Knowledge Base?',
        confirmLabel: 'Delete',
        destructive: true,
      },
    );
    if (!confirmed) return;
    try {
      await deleteMutation.mutateAsync(kb.id);
      toast.success('Knowledge Base deleted');
      onDeleted();
    } catch (e: any) {
      toast.error(`Failed to delete KB: ${e.message}`);
    }
  };

  const toggleShare = async (group_folder: string, isShared: boolean) => {
    try {
      if (isShared) {
        await unshareMutation.mutateAsync({ id: kb.id, group_folder });
        toast.info('Access removed for project');
      } else {
        await shareMutation.mutateAsync({ id: kb.id, group_folder });
        toast.success('Access granted for project');
      }
    } catch (e: any) {
      toast.error(`Sharing update failed: ${e.message}`);
    }
  };

  // Tree Logic
  const parentIds = new Set(
    projects?.filter((p) => p.settings?.isParent).map((p) => p.id),
  );
  const rootProjects =
    projects?.filter((p) => !p.parentId || !parentIds.has(p.parentId)) || [];
  const childrenByParent = new Map<string, Project[]>();
  projects?.forEach((p) => {
    if (p.parentId && parentIds.has(p.parentId)) {
      const arr = childrenByParent.get(p.parentId) ?? [];
      arr.push(p);
      childrenByParent.set(p.parentId, arr);
    }
  });

  return (
    <div className="h-full flex flex-col overflow-hidden min-h-0 bg-background">
      <div className="px-4 sm:px-6 py-4 border-b border-border flex items-center justify-between bg-accent/10 shrink-0 gap-3">
        <h3 className="font-bold text-base sm:text-lg flex items-center gap-2 min-w-0 flex-1 truncate">
          <Book className="size-4 text-primary shrink-0" />
          <span className="truncate">Properties</span>
        </h3>
        <div className="flex items-center gap-1 shrink-0">
          <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="icon-xs" title="Edit Metadata">
                <Edit2 className="size-3.5" />
              </Button>
            </DialogTrigger>
            <EditKbDialog kb={kb} onSuccess={() => setIsEditOpen(false)} />
          </Dialog>
          <Button
            variant="ghost"
            size="icon-xs"
            title="Share with users"
            onClick={() => setIsShareOpen(true)}
          >
            <Share2 className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Close properties"
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>
      <ShareDialog
        open={isShareOpen}
        onOpenChange={setIsShareOpen}
        target={{ kind: 'kb', kbId: kb.id, label: kb.name }}
      />

      <ScrollArea className="flex-1 min-h-0 min-w-0 [&_[data-slot=scroll-area-viewport]>div]:!block [&_[data-slot=scroll-area-viewport]>div]:!w-full">
        <div className="p-4 sm:p-6 space-y-8 sm:space-y-10">
          {/* Indexing Section */}
          <section>
            <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4 flex items-center gap-2">
              <RefreshCw className="size-3.5 text-primary" />
              Indexing Status
            </h4>
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground leading-relaxed">
                Trigger indexing to process the documents in this knowledge
                base. This will chunk the text, generate embeddings, and update
                the vector store.
              </p>
              <Button
                onClick={handleIndex}
                disabled={indexMutation.isPending || !files?.length}
                variant="secondary"
                className="w-full gap-2 transition-all active:scale-95 shadow-sm"
              >
                {indexMutation.isPending ? (
                  <RefreshCw className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                {kb.last_indexed_at
                  ? 'Re-index Documents'
                  : 'Start Initial Indexing'}
              </Button>
              {kb.last_indexed_at && (
                // Translucent green tint reads on both themes.
                <div className="flex items-center justify-center gap-2 text-[10px] text-muted-foreground bg-green-500/5 py-2 rounded-lg border border-green-500/10">
                  <Badge
                    variant="outline"
                    className="px-1 py-0 h-4 bg-green-500/10 text-green-700 dark:text-green-500 border-green-500/20"
                  >
                    SYNCED
                  </Badge>
                  <span>
                    Last indexed:{' '}
                    {new Date(kb.last_indexed_at).toLocaleString()}
                  </span>
                </div>
              )}
              {!files?.length && !filesPending && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/5 border border-amber-500/10 text-amber-800 dark:text-amber-500 text-[10px]">
                  <AlertCircle className="size-3.5 shrink-0" />
                  <span>
                    {filesFailed && !files
                      ? 'Could not load documents'
                      : 'Upload at least one document before indexing.'}
                  </span>
                </div>
              )}
            </div>
          </section>

          <section>
            <button
              onClick={() => setSharingOpen(!sharingOpen)}
              className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4 flex items-center gap-2 hover:text-foreground transition-colors"
            >
              {sharingOpen ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
              <Share2 className="size-3.5 text-primary" />
              Project Sharing
            </button>
            {sharingOpen && (
              <div className="space-y-4">
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Select projects that can use this Knowledge Base as a RAG
                  source.
                </p>
                <div className="space-y-1">
                  {rootProjects.map((project) => (
                    <div key={project.id} className="space-y-1">
                      <ProjectShareItem
                        project={project}
                        isShared={sharedGroups?.includes(project.folder)}
                        onToggle={toggleShare}
                      />
                      {childrenByParent.get(project.id)?.map((child) => (
                        <ProjectShareItem
                          key={child.id}
                          project={child}
                          isShared={sharedGroups?.includes(child.folder)}
                          onToggle={toggleShare}
                          isChild
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>

          <section className="pt-4 border-t border-border">
            <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4 flex items-center gap-2">
              <Settings2 className="size-3.5 text-primary" />
              Advanced
            </h4>
            <div className="p-3 rounded-lg bg-secondary/30 border border-border/50 group/path mb-6">
              <p className="text-[10px] font-bold text-muted-foreground uppercase mb-1 flex items-center gap-1">
                <HardDrive className="size-3" />
                Host path
              </p>
              <p className="text-[10px] font-mono break-all text-muted-foreground group-hover/path:text-foreground transition-colors">
                {kb.folder_path}
              </p>
            </div>
            <Button
              variant="ghost"
              className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive gap-2 text-xs"
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
            >
              <Trash2 className="size-3.5" />
              Destroy Knowledge Base
            </Button>
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}

function ProjectShareItem({
  project,
  isShared,
  onToggle,
  isChild,
}: {
  project: Project;
  isShared?: boolean;
  onToggle: (folder: string, shared: boolean) => void;
  isChild?: boolean;
}) {
  const Icon = project.settings?.isParent
    ? Layers
    : project.jid
      ? Smartphone
      : Folder;
  const iconColor = project.settings?.isParent
    ? 'text-purple-700 dark:text-purple-400'
    : project.jid
      ? 'text-blue-700 dark:text-blue-400'
      : 'text-yellow-800 dark:text-yellow-400';

  return (
    <div
      className={cn(
        'flex items-center justify-between p-2 rounded-lg border transition-all cursor-pointer group/item',
        isShared
          ? 'bg-primary/5 border-primary/20'
          : 'bg-background border-border hover:bg-accent/50',
        isChild && 'ml-4 scale-[0.98] border-l-2',
      )}
      onClick={() => onToggle(project.folder, !!isShared)}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <div
          className={cn(
            'p-1.5 rounded-md shadow-sm transition-colors',
            isShared ? 'bg-primary/20' : 'bg-secondary',
          )}
        >
          <Icon
            className={cn('size-3.5', isShared ? 'text-primary' : iconColor)}
          />
        </div>
        <span
          className={cn(
            'text-xs font-medium truncate',
            isShared ? 'text-primary' : 'text-foreground',
          )}
        >
          {project.name}
        </span>
      </div>
      <div
        className={cn(
          'size-4 rounded-full border flex items-center justify-center transition-all shrink-0',
          isShared
            ? 'bg-primary border-primary scale-110 shadow-lg shadow-primary/20'
            : 'border-muted-foreground/30',
        )}
      >
        {isShared && <Check className="size-2.5 text-primary-foreground" />}
      </div>
    </div>
  );
}
