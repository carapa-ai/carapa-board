import { useContext, useMemo, type ComponentProps } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Link } from 'lucide-react';
import { fetchSharedKnowledgeBases, fetchKnowledgeFiles } from '@/lib/api';
import { useProject } from '@/hooks/use-projects';
import { knowledgeKeys } from '@/hooks/use-knowledge';
import {
  KnowledgeComposerContext,
  KNOWLEDGE_DRAG_TYPE,
  knowledgeReferenceMarkdown,
  openKnowledgeReference,
  type KnowledgeReference,
} from '@/lib/knowledge-reference';
import type { FileExplorerEntry, KnowledgeBase } from '@/types';
import type { FileFavorites } from './use-file-favorites';
import { FileExplorer, type FileExplorerSource } from './file-explorer';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

export function KnowledgeComposer({
  value,
  ...props
}: ComponentProps<'div'> & {
  value: NonNullable<React.ContextType<typeof KnowledgeComposerContext>>;
}) {
  return (
    <KnowledgeComposerContext.Provider value={value}>
      <div {...props} />
    </KnowledgeComposerContext.Provider>
  );
}

export function KnowledgeInsertButton({
  reference,
  className,
}: {
  reference: KnowledgeReference;
  className?: string;
}) {
  const composer = useContext(KnowledgeComposerContext);
  if (!composer) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={className}
      data-ui="knowledge-insert-link"
      data-kb-id={reference.kbId}
      data-filename={reference.filename}
      title={`Insert link to ${reference.filename}`}
      aria-label={`Insert link to ${reference.filename}`}
      onClick={() => composer.insert(reference)}
    >
      <Link className="size-4" />
      <span className={className ? 'sr-only' : undefined}>Insert link</span>
    </Button>
  );
}

const documentOf = ({ kbId, filename }: KnowledgeReference) => ({
  kbId,
  filename,
});

/**
 * Open, drag and insert-link behavior of one knowledge document, shared by the
 * Knowledge and Favorites sections.
 */
export function knowledgeDocumentRow(
  client: QueryClient,
  projectId: string,
  folder: string | undefined,
  onOpen: (() => void) | undefined,
  /** Whether the row also has the actions menu button, which the insert button must leave room for. */
  hasMenu: boolean,
) {
  const reference = (kbId: string, filename: string): KnowledgeReference => ({
    kbId,
    filename,
    kbName: client
      .getQueryData<KnowledgeBase[]>([...knowledgeKeys.all, 'shared', folder])
      ?.find((kb) => kb.id === kbId)?.name,
  });
  return {
    reference,
    open: (ref: KnowledgeReference) => {
      openKnowledgeReference(projectId, ref);
      onOpen?.();
    },
    dragReference: (ref: KnowledgeReference) => ({
      payloads: {
        [KNOWLEDGE_DRAG_TYPE]: JSON.stringify(ref),
        'text/plain': knowledgeReferenceMarkdown(ref),
      },
    }),
    renderActions: (ref: KnowledgeReference) => (
      <KnowledgeInsertButton
        reference={ref}
        className={`absolute top-1 size-8 p-0 ${hasMenu ? 'right-11' : 'right-1'}`}
      />
    ),
  };
}

/** The knowledge bases shared with the project, from the cache when fresh. */
export const fetchSharedBases = (client: QueryClient, folder: string) =>
  client.fetchQuery({
    queryKey: [...knowledgeKeys.all, 'shared', folder],
    queryFn: () => fetchSharedKnowledgeBases(folder),
  });

export function useKnowledgeSource(
  projectId: string,
  onOpen?: () => void,
  /** Adds Add to / Remove from favorites to the document rows. */
  favorites?: FileFavorites,
): FileExplorerSource {
  const client = useQueryClient();
  const { data: project } = useProject(projectId);
  return useMemo(() => {
    const bases = async () => {
      if (!project) throw new Error('Project is not available');
      return fetchSharedBases(client, project.folder);
    };
    const files = (kbId: string) =>
      client.fetchQuery({
        queryKey: [...knowledgeKeys.all, kbId, 'files'],
        queryFn: () => fetchKnowledgeFiles(kbId),
      });
    const doc = knowledgeDocumentRow(
      client,
      projectId,
      project?.folder,
      onOpen,
      !!favorites,
    );
    const reference = (entry: FileExplorerEntry): KnowledgeReference => {
      const slash = entry.path.indexOf('/');
      return doc.reference(
        entry.path.slice(0, slash),
        entry.path.slice(slash + 1),
      );
    };
    const entries = async (kbId: string) =>
      (await files(kbId)).map((file) => ({
        kind: 'file' as const,
        name: file.name,
        path: `${kbId}/${file.name}`,
      }));
    return {
      id: `${projectId}:knowledge:${project?.folder ?? 'loading'}`,
      label: 'Knowledge',
      refresh: () =>
        client.invalidateQueries({
          queryKey: knowledgeKeys.all,
          refetchType: 'none',
        }),
      list: async (path) => {
        const allowed = await bases();
        if (!path)
          return {
            entries: allowed.map((kb) => ({
              kind: 'directory',
              name: kb.name,
              path: kb.id,
            })),
          };
        if (!allowed.some((kb) => kb.id === path))
          throw new Error('Knowledge base is unavailable');
        return { entries: await entries(path) };
      },
      search: async (query) => {
        const allowed = await bases();
        const found = await Promise.all(
          allowed.map(async (kb) =>
            (await entries(kb.id))
              .filter((entry) =>
                `${kb.name} ${entry.name}`
                  .toLowerCase()
                  .includes(query.toLowerCase()),
              )
              .map((entry) => ({
                ...entry,
                name: `${kb.name} / ${entry.name}`,
              })),
          ),
        );
        return { entries: found.flat() };
      },
      open: (entry) => doc.open(reference(entry)),
      // Knowledge-base folders are not documents, so only files are draggable.
      dragReference: (entry) =>
        entry.kind === 'directory'
          ? undefined
          : doc.dragReference(reference(entry)),
      renderActions: (entry) => doc.renderActions(reference(entry)),
      actions: favorites && {
        favorite: {
          isFavorite: (entry) =>
            favorites.isFavorite({
              kind: 'knowledge',
              ...documentOf(reference(entry)),
            }),
          toggle: (entry) =>
            void favorites.toggle({
              kind: 'knowledge',
              ...documentOf(reference(entry)),
            }),
        },
      },
    };
  }, [client, projectId, project, onOpen, favorites]);
}

export function KnowledgePicker({
  projectId,
  open,
  onOpenChange,
  onPreview,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPreview: () => void;
}) {
  const source = useKnowledgeSource(projectId, onPreview);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-ui="knowledge-document-picker"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Add knowledge document</DialogTitle>
          <DialogDescription>
            Browse documents shared with this project. Open a document to
            preview it, or insert its link.
          </DialogDescription>
        </DialogHeader>
        <FileExplorer
          sources={[source]}
          storageKey="knowledge-picker-mode"
          defaultMode="list"
          searchPlaceholder="Search knowledge documents"
        />
      </DialogContent>
    </Dialog>
  );
}
