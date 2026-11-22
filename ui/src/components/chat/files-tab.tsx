import {
  fetchSharedBases,
  knowledgeDocumentRow,
  useKnowledgeSource,
} from './knowledge-source';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Capacitor } from '@capacitor/core';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import {
  apiFetch,
  fetchFileFavorites,
  listGroupFiles,
  listMountFiles,
  listRepoFiles,
  listRootFiles,
  mountFileContentUrl,
  rootFileContentUrl,
} from '@/lib/api';
import { useProject, useProjects } from '@/hooks/use-projects';
import { API_BASE_URL, resolveApiUrl } from '@/lib/api-config';
import { availableProjectModes } from '@/lib/modes';
import { favoritesSourceId } from '@/lib/artifact-cache';
import { fileDeepLinkPath } from '@/lib/file-deep-link';
import { queryKeys } from '@/lib/query-keys';
import type {
  Conversation,
  FileExplorerEntry,
  FileFavorite,
  FileFavoriteRef,
  RepoFilesResponse,
} from '@/types';
import { applyIfLeaveAllowed, useStore, type PreviewTab } from '@/store';
import {
  FileExplorer,
  focusAfterChange,
  type ExplorerRowTarget,
  type FileExplorerSource,
} from './file-explorer';
import { MoveFileDialog, type MoveRequest } from './move-file-dialog';
import { useGroupFileOps, type GroupFileOps } from './use-group-file-ops';
import { useFileFavorites, type FileFavorites } from './use-file-favorites';
import { useAppConfig } from '@/hooks/use-app-config';

export async function hydrate(
  projectId: string,
  source: 'group' | 'repo',
  filePath: string,
  conversationId: string | null,
  tabId: string,
  update: ReturnType<typeof useStore.getState>['updatePreviewTab'],
) {
  const endpoint =
    source === 'group'
      ? `/api/projects/${projectId}/files/group/content?path=${encodeURIComponent(filePath)}`
      : conversationId
        ? `/api/projects/${projectId}/conversations/${conversationId}/files/repo/content?path=${encodeURIComponent(filePath)}`
        : `/api/projects/${projectId}/files/repo/content?path=${encodeURIComponent(filePath)}`;
  try {
    const response = await apiFetch(API_BASE_URL + endpoint, {
      method: 'HEAD',
    });
    if (!response.ok) return;
    const contentLength = response.headers.get('Content-Length');
    update(projectId, tabId, {
      mimetype: response.headers.get('Content-Type')?.split(';')[0],
      size: contentLength === null ? undefined : Number(contentLength),
    });
  } catch {
    // Metadata is optional; opening a preview must not surface probe failures.
  }
}

const IMAGE_PATH = /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i;

/** Where a favorited group-folder file lives: its section, plus any folder below the section root. */
function groupOrigin(path: string): string {
  const objective = /^objectives\/([^/]+)\//.exec(path);
  const [label, root] = path.startsWith('artifacts/')
    ? ['Artifacts', 'artifacts']
    : objective
      ? [`Objective ${objective[1]}`, `objectives/${objective[1]}`]
      : ['Group folder', ''];
  const folder = path
    .slice(root ? root.length + 1 : 0)
    .split('/')
    .slice(0, -1)
    .join('/');
  return folder ? `${label} / ${folder}` : label;
}

/** Folders are dragged as `path/` so the agent can tell them from files. */
const dragPath = (path: string, entry: FileExplorerEntry) =>
  entry.kind === 'directory' && !path.endsWith('/') ? `${path}/` : path;

/**
 * What opening, downloading, linking and dragging a group-folder file needs,
 * for entries shown relative to `root` (a group-relative directory, or '' for
 * the whole folder). Shared by the group sections and the Favorites section,
 * so a file behaves the same wherever it is listed.
 */
function createGroupFileAccess({
  project_id,
  root,
  conversation_id,
  openPreviewTab,
  updatePreviewTab,
  onOpenPanel,
  connectionMode,
  deepLinks,
}: {
  project_id: string;
  root: string;
  conversation_id: string | null;
  openPreviewTab: ReturnType<typeof useStore.getState>['openPreviewTab'];
  updatePreviewTab: ReturnType<typeof useStore.getState>['updatePreviewTab'];
  onOpenPanel?: () => void;
  connectionMode: ReturnType<typeof useStore.getState>['connectionMode'];
  /** Whether the project's chat route can open `?file=` links. */
  deepLinks: boolean;
}) {
  const full = (relative: string) =>
    root ? (relative ? `${root}/${relative}` : root) : relative;
  const relative = (apiPath: string) =>
    root && apiPath.startsWith(`${root}/`)
      ? apiPath.slice(root.length + 1)
      : apiPath;
  const contentUrl = (entry: FileExplorerEntry, thumbnail = false) =>
    IMAGE_PATH.test(entry.path)
      ? `${API_BASE_URL}/api/projects/${project_id}/files/group/content?path=${encodeURIComponent(full(entry.path))}${thumbnail ? '&thumbnail=1' : ''}`
      : undefined;
  return {
    full,
    relative,
    thumbnailUrl: (entry: FileExplorerEntry) => contentUrl(entry, true),
    imagePreviewUrl: (entry: FileExplorerEntry) => contentUrl(entry),
    actions: {
      download: (entry: FileExplorerEntry) => {
        const path = full(entry.path);
        return path.startsWith('artifacts/')
          ? {
              direct: true,
              url: resolveApiUrl(
                `/artifacts/${encodeURIComponent(project_id)}/${path
                  .slice('artifacts/'.length)
                  .split('/')
                  .map(encodeURIComponent)
                  .join('/')}`,
                Capacitor.isNativePlatform() ? connectionMode : undefined,
              ),
            }
          : {
              url: `${API_BASE_URL}/api/projects/${project_id}/files/group/content?path=${encodeURIComponent(path)}`,
            };
      },
      link: deepLinks
        ? (entry: FileExplorerEntry) =>
            fileDeepLinkPath(project_id, {
              source: 'group',
              path: full(entry.path),
            })
        : undefined,
      reference: (entry: FileExplorerEntry) =>
        `@${dragPath(full(entry.path), entry)}`,
    },
    dragReference: (entry: FileExplorerEntry) => {
      const path = dragPath(full(entry.path), entry);
      return {
        payloads: {
          'application/x-carapa-file': path,
          'text/plain': `@${path}`,
        },
      };
    },
    open: (entry: FileExplorerEntry) => {
      const filePath = full(entry.path);
      const tabId = `group:${filePath}`;
      // Hydrate and reveal the panel only once the tab exists: a leave prompt
      // for the previously active editor may still be open.
      applyIfLeaveAllowed(
        openPreviewTab(project_id, {
          id: tabId,
          title: entry.name,
          kind: 'file',
          source: 'group',
          path: filePath,
          openFileContextConversationId: conversation_id,
        }),
        () => {
          void hydrate(
            project_id,
            'group',
            filePath,
            null,
            tabId,
            updatePreviewTab,
          );
          onOpenPanel?.();
        },
      );
    },
  };
}

/**
 * Group-folder source rooted at `root` (a group-relative directory, or '' for
 * the whole folder). Entries are shown relative to `root`; API calls and
 * preview tabs use the full group-relative path.
 */
function createGroupSource({
  project_id,
  id,
  label,
  root,
  conversation_id,
  openPreviewTab,
  updatePreviewTab,
  onOpenPanel,
  ops,
  groupRoots,
  onMove,
  connectionMode,
  deepLinks,
  favorites,
}: {
  project_id: string;
  id: string;
  label: string;
  root: string;
  conversation_id: string | null;
  openPreviewTab: ReturnType<typeof useStore.getState>['openPreviewTab'];
  updatePreviewTab: ReturnType<typeof useStore.getState>['updatePreviewTab'];
  onOpenPanel?: () => void;
  ops: GroupFileOps;
  /** Every group-folder section (id and root), to find a moved row in any of them. */
  groupRoots: readonly { id: string; root: string }[];
  /** Opens the Move… picker for a request. */
  onMove: (request: MoveRequest) => void;
  connectionMode: ReturnType<typeof useStore.getState>['connectionMode'];
  /** Whether the project's chat route can open `?file=` links. */
  deepLinks: boolean;
  favorites: FileFavorites;
}): FileExplorerSource {
  const { full, relative, ...access } = createGroupFileAccess({
    project_id,
    root,
    conversation_id,
    openPreviewTab,
    updatePreviewTab,
    onOpenPanel,
    connectionMode,
    deepLinks,
  });
  const favoriteOf = (entry: FileExplorerEntry): FileFavoriteRef => ({
    kind: 'group',
    path: full(entry.path),
  });
  const toRelative = async (
    request: Promise<Awaited<ReturnType<typeof listGroupFiles>>>,
  ) => {
    const page = await request;
    return {
      ...page,
      entries: page.entries.map((entry) => ({
        ...entry,
        path: relative(entry.path),
        canManage: page.canManage,
      })),
    };
  };
  return {
    id,
    label,
    sortable: true,
    list: (path, cursor, sort) =>
      toRelative(
        listGroupFiles(project_id, { path: full(path), cursor, ...sort }),
      ),
    search: (search, cursor) =>
      toRelative(
        listGroupFiles(project_id, {
          search,
          cursor,
          ...(root ? { path: root } : {}),
        }),
      ),
    ...access,
    actions: {
      ...access.actions,
      favorite: {
        isFavorite: (entry) => favorites.isFavorite(favoriteOf(entry)),
        toggle: (entry) => void favorites.toggle(favoriteOf(entry)),
      },
      edit: {
        canManage: (entry) => !!entry.canManage,
        rename: async (entry, newName) => {
          const restoreFocus = focusAfterChange(id, entry.path);
          const renamed = await ops.rename(full(entry.path), newName);
          if (renamed === null) return false;
          restoreFocus(relative(renamed));
          return true;
        },
        move: (entry) =>
          onMove({
            name: entry.name,
            path: full(entry.path),
            move: async (destination) => {
              const restoreFocus = focusAfterChange(id, entry.path);
              const moved = await ops.move(full(entry.path), destination);
              if (moved === null) return false;
              const elsewhere: ExplorerRowTarget[] = [];
              for (const section of groupRoots) {
                if (!section.root)
                  elsewhere.push({ sourceId: section.id, path: moved });
                else if (moved.startsWith(`${section.root}/`))
                  elsewhere.push({
                    sourceId: section.id,
                    path: moved.slice(section.root.length + 1),
                  });
              }
              restoreFocus(undefined, elsewhere);
              return true;
            },
          }),
        remove: async (entry) => {
          const restoreFocus = focusAfterChange(id, entry.path);
          const removed = await ops.remove(
            full(entry.path),
            entry.name,
            entry.kind === 'directory',
          );
          if (removed) restoreFocus();
        },
      },
    },
  };
}

export function FilesTab({
  project_id,
  conversation_id,
  objective_id,
  initial_report,
  onInitialReportOpened,
  onOpenPanel,
}: {
  project_id: string;
  conversation_id: string | null;
  /** On an objective page, adds an "Objective" section rooted at that objective's folder. */
  objective_id?: string;
  /** Bare report filename (deep link) opened from the Objective section's `reports/` folder. */
  initial_report?: string;
  /** Called once the linked report is opened, so the caller can stop re-sending it on remount. */
  onInitialReportOpened?: (report: string) => void;
  onOpenPanel?: () => void;
}) {
  const openPreviewTab = useStore((state) => state.openPreviewTab);
  const updatePreviewTab = useStore((state) => state.updatePreviewTab);
  const queryClient = useQueryClient();
  const connectionMode = useStore((state) => state.connectionMode);
  const ops = useGroupFileOps(project_id);
  const [moveRequest, setMoveRequest] = useState<MoveRequest | null>(null);
  const { data: projects } = useProjects();
  const childFolders = useMemo(
    () =>
      (projects ?? [])
        .filter((child) => child.parentId === project_id)
        .map((child) => child.folder),
    [projects, project_id],
  );
  const conversationCacheVersion = useSyncExternalStore(
    (notify) => queryClient.getQueryCache().subscribe(notify),
    () =>
      ['conversations', 'objectiveConversations']
        .flatMap((queryKey) =>
          queryClient.getQueriesData<InfiniteData<Conversation[]>>({
            queryKey: [queryKey],
          }),
        )
        .map(
          ([key, data]) =>
            `${JSON.stringify(key)}:${data?.pages.length ?? 0}:${
              data?.pages
                .flat()
                .map(
                  (conversation) =>
                    `${conversation.id}:${conversation.use_worktree}`,
                )
                .join(',') ?? ''
            }`,
        )
        .join('|'),
  );
  const { data: project } = useProject(project_id);
  const { data: config } = useAppConfig();
  const deepLinks = availableProjectModes(project, config).includes('chat');
  const extraMounts = project?.effectiveSandbox?.extraMounts;
  // `workspaceRoots[0]` is the primary root; the rest are `extraRoots` in the
  // server's order, which is also the index the root routes expect. A root
  // that is (inside) an extra mount's folder is already shown as that mount.
  const workspaceRoots = project?.effectiveSandbox?.workspaceRoots;
  const extraRoots = useMemo(
    () =>
      workspaceRoots
        ?.slice(1)
        .map((containerPath, index) => ({ containerPath, index }))
        .filter(
          ({ containerPath }) =>
            !extraMounts?.some(
              (mount) =>
                containerPath === mount.containerPath ||
                containerPath.startsWith(`${mount.containerPath}/`),
            ),
        ),
    [workspaceRoots, extraMounts],
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (opened || !rootRef.current) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setOpened(true);
        observer.disconnect();
      }
    });
    observer.observe(rootRef.current);
    return () => observer.disconnect();
  }, [opened]);
  const fileFavorites = useFileFavorites(project_id, opened);
  const knowledgeSource = useKnowledgeSource(
    project_id,
    onOpenPanel,
    fileFavorites,
  );
  const useWorktree = useMemo(() => {
    if (!conversation_id) return false;
    for (const [, data] of [
      ...queryClient.getQueriesData<InfiniteData<Conversation[]>>({
        queryKey: ['conversations'],
      }),
      ...queryClient.getQueriesData<InfiniteData<Conversation[]>>({
        queryKey: ['objectiveConversations'],
      }),
    ])
      if (
        data?.pages
          .flat()
          .some(
            (conversation) =>
              conversation.id === conversation_id && conversation.use_worktree,
          )
      )
        return true;
    return false;
  }, [conversation_id, queryClient, conversationCacheVersion]);
  const repoConversationId =
    conversation_id && useWorktree ? conversation_id : null;
  const sources = useMemo<FileExplorerSource[]>(() => {
    const groupSourceDeps = {
      project_id,
      conversation_id,
      openPreviewTab,
      updatePreviewTab,
      onOpenPanel,
      ops,
      groupRoots: [
        { id: `${project_id}:group`, root: '' },
        { id: `${project_id}:artifacts`, root: 'artifacts' },
        ...(objective_id
          ? [
              {
                id: `${project_id}:objective:${objective_id}`,
                root: `objectives/${objective_id}`,
              },
            ]
          : []),
      ],
      onMove: setMoveRequest,
      connectionMode,
      deepLinks,
      favorites: fileFavorites,
    };
    return [
      ...(objective_id
        ? [
            createGroupSource({
              ...groupSourceDeps,
              id: `${project_id}:objective:${objective_id}`,
              label: 'Objective',
              root: `objectives/${objective_id}`,
            }),
          ]
        : []),
      {
        id: `${project_id}:repo:${repoConversationId ?? 'main'}`,
        label: 'Repo',
        list: (path, cursor) =>
          listRepoFiles(project_id, repoConversationId, { path, cursor }),
        search: (search, cursor) =>
          listRepoFiles(project_id, repoConversationId, { search, cursor }),
        thumbnailUrl: (entry) =>
          /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i.test(entry.path)
            ? `${API_BASE_URL}/api/projects/${project_id}${repoConversationId ? `/conversations/${repoConversationId}` : ''}/files/repo/content?path=${encodeURIComponent(entry.path)}&thumbnail=1`
            : undefined,
        imagePreviewUrl: (entry) =>
          /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i.test(entry.path)
            ? `${API_BASE_URL}/api/projects/${project_id}${repoConversationId ? `/conversations/${repoConversationId}` : ''}/files/repo/content?path=${encodeURIComponent(entry.path)}`
            : undefined,
        actions: {
          download: (entry) => ({
            url: `${API_BASE_URL}/api/projects/${project_id}${repoConversationId ? `/conversations/${repoConversationId}` : ''}/files/repo/content?path=${encodeURIComponent(entry.path)}`,
          }),
          link: deepLinks
            ? (entry) =>
                fileDeepLinkPath(
                  project_id,
                  { source: 'repo', path: entry.path },
                  repoConversationId,
                )
            : undefined,
          reference: (entry) => `@${dragPath(entry.path, entry)}`,
        },
        dragReference: (entry) => {
          const path = dragPath(entry.path, entry);
          return {
            payloads: {
              'application/x-carapa-file': path,
              'text/plain': `@${path}`,
            },
          };
        },
        open: (entry: FileExplorerEntry) => {
          const id = `repo:${repoConversationId ?? 'main'}:${entry.path}`;
          applyIfLeaveAllowed(
            openPreviewTab(project_id, {
              id,
              title: entry.name,
              kind: 'file',
              source: 'repo',
              path: entry.path,
              conversation_id: repoConversationId ?? undefined,
              openFileContextConversationId: conversation_id,
              repoContext: repoConversationId ? 'conversation' : 'main',
            }),
            () => {
              void hydrate(
                project_id,
                'repo',
                entry.path,
                repoConversationId,
                id,
                updatePreviewTab,
              );
              onOpenPanel?.();
            },
          );
        },
      },
      createGroupSource({
        ...groupSourceDeps,
        // The id must stay `${project_id}:artifacts`: `artifacts_changed`
        // invalidates the explorer queries keyed by it.
        id: `${project_id}:artifacts`,
        label: 'Artifacts',
        root: 'artifacts',
      }),
      createGroupSource({
        ...groupSourceDeps,
        id: `${project_id}:group`,
        label: 'Group folder',
        root: '',
      }),
    ];
  }, [
    project_id,
    conversation_id,
    objective_id,
    repoConversationId,
    openPreviewTab,
    updatePreviewTab,
    onOpenPanel,
    connectionMode,
    ops,
    deepLinks,
    fileFavorites,
  ]);
  const favoritesSource = useMemo<FileExplorerSource | undefined>(() => {
    if (!fileFavorites.favorites?.length) return undefined;
    const access = createGroupFileAccess({
      project_id,
      root: '',
      conversation_id,
      openPreviewTab,
      updatePreviewTab,
      onOpenPanel,
      connectionMode,
      deepLinks,
    });
    const knowledgeDoc = knowledgeDocumentRow(
      queryClient,
      project_id,
      project?.folder,
      onOpenPanel,
      true,
    );
    const loadFavorites = () =>
      queryClient.fetchQuery({
        queryKey: queryKeys.fileFavorites.all(project_id),
        queryFn: () => fetchFileFavorites(project_id),
        staleTime: 0,
      });
    const toEntries = async (
      favorites: FileFavorite[],
    ): Promise<FileExplorerEntry[]> => {
      const bases =
        project && favorites.some((favorite) => favorite.kind === 'knowledge')
          ? await fetchSharedBases(queryClient, project.folder).catch(() => [])
          : [];
      return favorites.map((favorite) =>
        favorite.kind === 'group'
          ? {
              kind: 'file',
              name: favorite.name,
              path: favorite.path,
              favorite,
              origin: groupOrigin(favorite.path),
            }
          : {
              kind: 'file',
              name: favorite.name,
              path: `${favorite.kbId}/${favorite.filename}`,
              favorite,
              origin:
                bases.find((kb) => kb.id === favorite.kbId)?.name ??
                'Knowledge',
            },
      );
    };
    const knowledgeOf = (entry: FileExplorerEntry) =>
      entry.favorite?.kind === 'knowledge'
        ? knowledgeDoc.reference(entry.favorite.kbId, entry.favorite.filename)
        : undefined;
    const isGroup = (entry: FileExplorerEntry) =>
      entry.favorite?.kind === 'group';
    return {
      id: favoritesSourceId(project_id),
      label: 'Favorites',
      list: async () => ({ entries: await toEntries(await loadFavorites()) }),
      // Favorites are one flat list, so searching filters it by file name.
      search: async (query) => ({
        entries: (await toEntries(await loadFavorites())).filter((entry) =>
          entry.name.toLowerCase().includes(query.toLowerCase()),
        ),
      }),
      thumbnailUrl: (entry) =>
        isGroup(entry) ? access.thumbnailUrl(entry) : undefined,
      imagePreviewUrl: (entry) =>
        isGroup(entry) ? access.imagePreviewUrl(entry) : undefined,
      actions: {
        download: (entry) =>
          isGroup(entry) ? access.actions.download(entry) : undefined,
        link: access.actions.link
          ? (entry) =>
              isGroup(entry) ? access.actions.link!(entry) : undefined
          : undefined,
        // Knowledge documents have no path to copy, as in their own section.
        reference: (entry) =>
          isGroup(entry) ? access.actions.reference(entry) : undefined,
        favorite: {
          isFavorite: () => true,
          toggle: (entry) => {
            const favorite = entry.favorite;
            if (favorite)
              void fileFavorites.toggle(
                favorite.kind === 'group'
                  ? { kind: 'group', path: favorite.path }
                  : {
                      kind: 'knowledge',
                      kbId: favorite.kbId,
                      filename: favorite.filename,
                    },
              );
          },
        },
      },
      dragReference: (entry) => {
        const ref = knowledgeOf(entry);
        return ref
          ? knowledgeDoc.dragReference(ref)
          : access.dragReference(entry);
      },
      open: (entry) => {
        const ref = knowledgeOf(entry);
        if (ref) knowledgeDoc.open(ref);
        else access.open(entry);
      },
      renderActions: (entry) => {
        const ref = knowledgeOf(entry);
        return ref ? knowledgeDoc.renderActions(ref) : null;
      },
    };
  }, [
    fileFavorites,
    project,
    project_id,
    conversation_id,
    openPreviewTab,
    updatePreviewTab,
    onOpenPanel,
    connectionMode,
    deepLinks,
    queryClient,
  ]);
  const objectiveSource = objective_id
    ? sources.find(
        (source) => source.id === `${project_id}:objective:${objective_id}`,
      )
    : undefined;
  const openObjectiveSourceRef = useRef(objectiveSource?.open);
  openObjectiveSourceRef.current = objectiveSource?.open;
  const onInitialReportOpenedRef = useRef(onInitialReportOpened);
  onInitialReportOpenedRef.current = onInitialReportOpened;
  const [missingReport, setMissingReport] = useState<string | null>(null);
  useEffect(() => {
    setMissingReport(null);
    if (!objective_id || !initial_report) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await apiFetch(
          `${API_BASE_URL}/api/projects/${project_id}/files/group/content?path=${encodeURIComponent(`objectives/${objective_id}/reports/${initial_report}`)}`,
          { method: 'HEAD' },
        );
        if (cancelled) return;
        if (response.ok) {
          openObjectiveSourceRef.current?.({
            kind: 'file',
            name: initial_report,
            path: `reports/${initial_report}`,
          });
          onInitialReportOpenedRef.current?.(initial_report);
        } else if (response.status === 404) setMissingReport(initial_report);
      } catch {
        // A failed probe leaves the explorer usable; only a 404 is reported.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project_id, objective_id, initial_report]);
  // Read-only sandbox folders (extra mounts and extra workspace roots) share
  // one source shape; only the routes and the preview-tab fields differ.
  const folderSource = useCallback(
    (folder: {
      id: string;
      label: string;
      containerPath: string;
      list: (options: {
        path?: string;
        cursor?: string;
        search?: string;
      }) => Promise<RepoFilesResponse>;
      contentUrl: (relPath: string) => string;
      tab: (
        entry: FileExplorerEntry,
      ) => Pick<PreviewTab, 'id' | 'source' | 'mountSlot' | 'rootIndex'>;
    }): FileExplorerSource => {
      const imageUrl = (entry: FileExplorerEntry, thumbnail = false) =>
        /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i.test(entry.path)
          ? folder.contentUrl(entry.path) + (thumbnail ? '&thumbnail=1' : '')
          : undefined;
      const absolutePath = (entry: FileExplorerEntry) =>
        dragPath(`${folder.containerPath}/${entry.path}`, entry);
      return {
        id: folder.id,
        label: folder.label,
        list: (path, cursor) => folder.list({ path, cursor }),
        search: (search, cursor) => folder.list({ search, cursor }),
        thumbnailUrl: (entry) => imageUrl(entry, true),
        imagePreviewUrl: (entry) => imageUrl(entry),
        actions: {
          download: (entry) => ({ url: folder.contentUrl(entry.path) }),
          reference: (entry) => `@${absolutePath(entry)}`,
        },
        // Dragged into the composer as an absolute in-container path so the
        // agent can read the file directly.
        dragReference: (entry) => ({
          payloads: {
            'application/x-carapa-file': absolutePath(entry),
            'text/plain': `@${absolutePath(entry)}`,
          },
        }),
        open: (entry: FileExplorerEntry) => {
          applyIfLeaveAllowed(
            openPreviewTab(project_id, {
              title: entry.name,
              kind: 'file',
              path: entry.path,
              containerPath: `${folder.containerPath}/${entry.path}`,
              ...folder.tab(entry),
            }),
            () => onOpenPanel?.(),
          );
        },
      };
    },
    [project_id, openPreviewTab, onOpenPanel],
  );
  const mountSources = useMemo<FileExplorerSource[]>(
    () =>
      (extraMounts ?? []).map((mount) =>
        folderSource({
          id: `${project_id}:mount:${mount.slot}`,
          label: mount.name,
          containerPath: mount.containerPath,
          list: (options) => listMountFiles(project_id, mount.slot, options),
          contentUrl: (relPath) =>
            mountFileContentUrl(project_id, mount.slot, relPath),
          tab: (entry) => ({
            id: `mount:${mount.slot}:${entry.path}`,
            source: 'mount',
            mountSlot: mount.slot,
          }),
        }),
      ),
    [extraMounts, project_id, folderSource],
  );
  const rootSources = useMemo<FileExplorerSource[]>(
    () =>
      (extraRoots ?? []).map((root) =>
        folderSource({
          id: `${project_id}:root:${root.index}`,
          label: root.containerPath,
          containerPath: root.containerPath,
          list: (options) => listRootFiles(project_id, root.index, options),
          contentUrl: (relPath) =>
            rootFileContentUrl(project_id, root.index, relPath),
          tab: (entry) => ({
            id: `root:${root.index}:${entry.path}`,
            source: 'root',
            rootIndex: root.index,
          }),
        }),
      ),
    [extraRoots, project_id, folderSource],
  );
  return (
    <div ref={rootRef}>
      {missingReport && (
        <div
          role="alert"
          data-ui="objective-report-not-found"
          className="pt-2 pb-2 text-xs text-destructive"
        >
          Report not found: {missingReport}
        </div>
      )}
      {moveRequest && (
        <MoveFileDialog
          project_id={project_id}
          request={moveRequest}
          childFolders={childFolders}
          onClose={() => setMoveRequest(null)}
        />
      )}
      {opened && (
        <FileExplorer
          sources={[
            ...(favoritesSource ? [favoritesSource] : []),
            ...sources,
            ...mountSources,
            ...rootSources,
            knowledgeSource,
          ]}
          storageKey={`file-explorer-mode:${project_id}`}
        />
      )}
    </div>
  );
}
