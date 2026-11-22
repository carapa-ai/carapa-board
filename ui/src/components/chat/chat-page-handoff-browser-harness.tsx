import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useLocation,
  useParams,
} from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChatPage } from './chat-page';
import { ChatRouteContent } from '@/routes/chat.$projectId';
import { queryKeys } from '@/lib/query-keys';

import {
  markLivePersonaPlaybackStarted,
  updateLivePersonaPlayback,
} from '@/lib/live-persona-reveal';
import { useStore } from '@/store';
import {
  handleWebSocketConnected,
  handleWebSocketEvent,
  setWebSocketQueryClientForTest,
} from '@/lib/websocket';

let mountedRoot: Root | null = null;
const projectId = 'handoff-browser-project';
const conversationId = 'handoff-browser-conversation';
const streamKey = 'handoff-browser-stream';
const ordinaryFollowUpStreamKey = 'handoff-browser-ordinary-follow-up';
const routeProjectFixtures = [
  {
    projectId: 'handoff-browser-project-a',
    conversationId: 'handoff-browser-conversation-a',
    streamKey: 'handoff-browser-stream-a',
    projectName: 'Handoff A',
    prompt: 'Project A prompt',
    response: 'Project A response',
  },
  {
    projectId: 'handoff-browser-project-b',
    conversationId: 'handoff-browser-conversation-b',
    streamKey: 'handoff-browser-stream-b',
    projectName: 'Handoff B',
    prompt: 'Project B prompt',
    response: 'Project B response',
  },
] as const;
function MountedChatRouteContent() {
  const { projectId: routeProjectId } = useParams({ strict: false });
  const routeLocation = useLocation({ select: (location) => location.href });
  return (
    <div data-ui="chat-route-content" data-route-location={routeLocation}>
      <ChatRouteContent projectId={String(routeProjectId)} />
    </div>
  );
}

const transcript = {
  pages: [
    {
      entries: [
        {
          id: 'prompt-1',
          type: 'message',
          role: 'user',
          content: 'Ask everyone',
          created_at: '2026-01-01T00:00:00.000Z',
          source: 'web',
        },
        {
          id: 'main-1',
          type: 'message',
          role: 'assistant',
          content: 'Main response',
          created_at: '2026-01-01T00:00:01.000Z',
          source: 'web',
        },
      ],
      nextOffset: null,
    },
  ],
  pageParams: [undefined],
};

const configuredMainPersona = {
  id: 'main',
  name: 'Main persona',
  identity: 'main-persona',
  avatarUrl: null,
  turn: 'main',
};

const beforePersona = {
  id: 'before',
  name: 'Before persona',
  identity: 'before-persona',
  avatarUrl: null,
  turn: 'before',
};

const afterPersona = {
  id: 'after',
  name: 'After persona',
  identity: 'after-persona',
  avatarUrl: null,
  turn: 'after',
};

export async function mountChatPageHandoffHarness(
  element: HTMLElement,
  options: {
    ordinaryFollowUp?: boolean;
    configuredMainPersona?: boolean;
    liveMode?: boolean;
    initialEmptyConversation?: boolean;
    multiProjectRoute?: boolean;
    historicalTaskMilestones?: unknown[];
  } = {},
) {
  const commit = async (update: () => void) => {
    await act(async () => update());
  };
  const personaHandoffTranscript = options.configuredMainPersona
    ? {
        ...transcript,
        pages: [
          {
            ...transcript.pages[0],
            entries: [
              transcript.pages[0].entries[0],
              {
                id: 'before-1',
                type: 'message',
                role: 'assistant',
                content: 'Before response',
                senderUserId: 'ai:before',
                sender_name: 'Before persona',
                created_at: '2026-01-01T00:00:01.000Z',
                source: 'web',
              },
              {
                ...transcript.pages[0].entries[1],
                senderUserId: 'ai:main',
                sender_name: 'Main persona',
                created_at: '2026-01-01T00:00:02.000Z',
              },
            ],
          },
        ],
      }
    : transcript;
  const milestoneTranscript =
    options.historicalTaskMilestones &&
    options.historicalTaskMilestones.length > 0
      ? {
          ...personaHandoffTranscript,
          pages: [
            {
              ...personaHandoffTranscript.pages[0],
              entries: [
                ...personaHandoffTranscript.pages[0].entries,
                ...options.historicalTaskMilestones,
              ],
            },
          ],
        }
      : personaHandoffTranscript;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  setWebSocketQueryClientForTest(queryClient);
  const seedConversationDetail = (project: string, id: string) =>
    queryClient.setQueryData(['conversation-detail', project, id], {
      id,
      title: 'Handoff',
      status: 'idle',
    });
  queryClient.setQueryData(queryKeys.config, {
    assistantName: 'Main agent',
    enableChat: true,
  });
  queryClient.setQueryData(queryKeys.projects.all, [
    { id: projectId, name: 'Handoff', settings: {} },
  ]);
  if (options.configuredMainPersona) {
    queryClient.setQueryData(
      ['conversation-ai-users', projectId, conversationId],
      [beforePersona, afterPersona],
    );
    queryClient.setQueryData(
      ['conversation-ai-users', projectId, conversationId, 'main'],
      configuredMainPersona,
    );
  }
  queryClient.setQueryData(
    queryKeys.conversations.all(projectId),
    options.initialEmptyConversation
      ? { pages: [[]], pageParams: [undefined] }
      : {
          pages: [
            [
              {
                id: conversationId,
                title: 'Handoff',
                status: options.ordinaryFollowUp ? 'idle' : 'working',
              },
            ],
          ],
          pageParams: [undefined],
        },
  );
  // The page's list key also carries the owner user id, so the seed above does
  // not reach it; the detail query is what confirms a conversation here.
  if (!options.initialEmptyConversation) {
    seedConversationDetail(projectId, conversationId);
  }
  queryClient.setQueryData(
    queryKeys.chatTranscript.all(projectId, conversationId),
    options.ordinaryFollowUp
      ? {
          ...transcript,
          pages: [
            {
              ...transcript.pages[0],
              entries: [
                ...Array.from({ length: 8 }, (_, index) => [
                  {
                    id: `older-user-${index}`,
                    type: 'message',
                    role: 'user',
                    content: `Older prompt ${index}`,

                    created_at: `2025-12-31T23:59:${String(index * 2).padStart(2, '0')}.000Z`,
                    source: 'web',
                  },
                  {
                    id: `older-assistant-${index}`,
                    type: 'message',
                    role: 'assistant',
                    content: `Older response ${index}`,
                    created_at: `2025-12-31T23:59:${String(index * 2 + 1).padStart(2, '0')}.000Z`,
                    source: 'web',
                  },
                ]).flat(),
                ...transcript.pages[0].entries,
              ],
            },
          ],
        }
      : milestoneTranscript,
  );
  useStore.setState({
    activeConvByProject: options.initialEmptyConversation
      ? {}
      : { [projectId]: conversationId },
    activeStreamKeyByConv: { [conversationId]: streamKey },
    prevStreamKeyByConv: {},
    chatStreamRetiredByConv: {},
    queuedPromptsByConv: {},
    steeredChatMessageIds: {},
    chatStreamingOutput: { [streamKey]: 'Main response' },
    chatStreamingCompleted: options.ordinaryFollowUp
      ? { [streamKey]: true }
      : {},
    chatStreamPresentation: {
      [streamKey]: {
        personaDriven: !options.ordinaryFollowUp,
        virtualSender: options.configuredMainPersona
          ? configuredMainPersona
          : null,
      },
    },
    chatRunningByConv: { [conversationId]: !options.ordinaryFollowUp },
    liveModeEnabledByConversation:
      options.configuredMainPersona && options.liveMode !== false
        ? { [conversationId]: true }
        : {},
    liveModeKindByConversation:
      options.configuredMainPersona && options.liveMode !== false
        ? { [conversationId]: 'personas' }
        : {},
    liveModeEnabled:
      options.configuredMainPersona && options.liveMode !== false,
    liveModeFocusedConversationId:
      options.configuredMainPersona && options.liveMode !== false
        ? conversationId
        : null,
    liveModeCurrentProjectId:
      options.configuredMainPersona && options.liveMode !== false
        ? projectId
        : null,
  });
  if (options.multiProjectRoute) {
    queryClient.setQueryData(
      queryKeys.projects.all,
      routeProjectFixtures.map((fixture) => ({
        id: fixture.projectId,
        name: fixture.projectName,
        settings: { enabledModes: ['chat'] },
      })),
    );
    for (const fixture of routeProjectFixtures) {
      const conversation = {
        id: fixture.conversationId,
        title: fixture.projectName,
        status: 'working',
      };
      queryClient.setQueryData(queryKeys.conversations.all(fixture.projectId), {
        pages: [[conversation]],
        pageParams: [undefined],
      });
      seedConversationDetail(fixture.projectId, fixture.conversationId);
      queryClient.setQueryData(
        queryKeys.chatTranscript.all(fixture.projectId, fixture.conversationId),
        {
          pages: [
            {
              entries: [
                {
                  id: `${fixture.conversationId}-prompt`,
                  type: 'message',
                  role: 'user',
                  content: fixture.prompt,
                  created_at: '2026-01-01T00:00:00.000Z',
                  source: 'web',
                },
                {
                  id: `${fixture.conversationId}-response`,
                  type: 'message',
                  role: 'assistant',
                  content: fixture.response,
                  created_at: '2026-01-01T00:00:01.000Z',
                  source: 'web',
                },
              ],
              hasMore: false,
              nextOffset: null,
            },
          ],
          pageParams: [0],
        },
      );
      queryClient.setQueryData(
        ['conversation-ai-users', fixture.projectId, fixture.conversationId],
        [],
      );
      queryClient.setQueryData(
        [
          'conversation-ai-users',
          fixture.projectId,
          fixture.conversationId,
          'main',
        ],
        null,
      );
      queryClient.setQueryData(['project-members', fixture.projectId], []);
      queryClient.setQueryData(['project-commands', fixture.projectId], []);
      queryClient.setQueryData(['project-worktrees', fixture.projectId], []);
    }
    queryClient.setQueryData(queryKeys.runtimeCatalog, {
      version: 2,
      harnesses: [],
      models: [],
      presets: [],
      defaults: {},
    });
    useStore.setState({
      activeConvByProject: Object.fromEntries(
        routeProjectFixtures.map((fixture) => [
          fixture.projectId,
          fixture.conversationId,
        ]),
      ),
      activeStreamKeyByConv: Object.fromEntries(
        routeProjectFixtures.map((fixture) => [
          fixture.conversationId,
          fixture.streamKey,
        ]),
      ),
      prevStreamKeyByConv: {},
      chatStreamRetiredByConv: {},
      chatStreamingOutput: {},
      chatStreamingCompleted: {},
      chatStreamPresentation: Object.fromEntries(
        routeProjectFixtures.map((fixture) => [
          fixture.streamKey,
          { personaDriven: false, virtualSender: null },
        ]),
      ),
      chatRunningByConv: {},
      liveModeEnabled: false,
      liveModeFocusedConversationId: null,
      liveModeCurrentProjectId: null,
      liveModeEnabledByConversation: {},
      liveModeKindByConversation: {},
    });
  }

  const rootRoute = createRootRoute();
  const pageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: options.multiProjectRoute ? '/chat/$projectId' : '/',
    component: options.multiProjectRoute
      ? MountedChatRouteContent
      : () => (
          <ChatPage
            project_id={projectId}
            initialSendingByConv={
              options.initialEmptyConversation
                ? {}
                : options.ordinaryFollowUp
                  ? {}
                  : { [conversationId]: true }
            }
          />
        ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([pageRoute]),
    history: createMemoryHistory({
      initialEntries: options.multiProjectRoute
        ? [
            '/chat/handoff-browser-project-a?conversationId=handoff-browser-conversation-a',
          ]
        : ['/'],
    }),
  });
  mountedRoot?.unmount();
  mountedRoot = createRoot(element);
  await act(async () => {
    mountedRoot!.render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await router.load();
  });
  return {
    async navigate(url: string) {
      if (url.includes('?')) await router.navigate({ to: url });
      else await router.navigate({ to: url, search: {} });
      await router.load();
    },
    snapshotOwnership() {
      return Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-ui="chat-generic-main-stream"], [data-ui="chat-invited-persona-stream"], [data-ui="chat-canonical-persona-transcript-message"]',
        ),
      ).map((node) => ({
        ui: node.dataset.ui ?? null,
        messageId: node.dataset.messageId ?? null,
        projectId: node.dataset.projectId ?? null,
        conversationId: node.dataset.conversationId ?? null,
        streamKey: node.dataset.streamKey ?? null,
        text: node.textContent ?? '',
      }));
    },
    routeLocation() {
      return router.state.location.href;
    },
    setComposerContext(
      memoryContextLevel: 'off' | 'minimal' | 'standard' | 'deep',
      deepLinks: Array<{
        label: string;
        href: string;
        variant?: 'default' | 'outline' | 'destructive';
      }>,
    ) {
      return commit(() => {
        const state = useStore.getState();
        state.setMemoryLevelForComposer(
          `${projectId}:${conversationId}`,
          memoryContextLevel,
        );
        state.setDraftDeepLinksByKey(
          `${projectId}:${conversationId}`,
          deepLinks,
        );
      });
    },
    getComposerContext() {
      const state = useStore.getState();
      return {
        memoryContextLevel:
          state.memoryLevelByComposerKey[`${projectId}:${conversationId}`] ??
          'off',
        deepLinks:
          state.draftDeepLinksByKey[`${projectId}:${conversationId}`] ?? [],
      };
    },
    markQueuedPromptServerOwned(promptId: string) {
      return commit(() =>
        useStore.setState((state) => ({
          queuedPromptsByConv: {
            ...state.queuedPromptsByConv,
            [conversationId]: (
              state.queuedPromptsByConv[conversationId] ?? []
            ).map((prompt) =>
              prompt.id === promptId
                ? {
                    ...prompt,
                    serverOwned: true,
                    serverQueueOwner: 'persona' as const,
                  }
                : prompt,
            ),
          },
        })),
      );
    },
    dispatch(type: string, payload: Record<string, unknown>) {
      return commit(() => handleWebSocketEvent({ type, payload } as never));
    },
    stop() {
      // Stop itself does not replace the transcript. Keep the browser
      // simulation at that boundary so an asynchronous completion refetch
      // cannot mask whether existing live owners survive the stop action.
      return commit(() => {
        const state = useStore.getState();
        state.setChatRunning(conversationId, false);
        state.markChatOutputCompleted(streamKey);
      });
    },
    simulateRestartedRunWithoutStreamContent() {
      return commit(() =>
        useStore.setState((state) => {
          const nextOutput = { ...state.chatStreamingOutput };
          delete nextOutput[streamKey];
          return {
            chatStreamingOutput: nextOutput,
            chatRunningByConv: {
              ...state.chatRunningByConv,
              [conversationId]: true,
            },
          };
        }),
      );
    },
    startOrdinaryFollowUp(personaDriven = true) {
      return commit(() =>
        useStore.setState((state) => ({
          activeStreamKeyByConv: {
            ...state.activeStreamKeyByConv,
            [conversationId]: ordinaryFollowUpStreamKey,
          },
          chatStreamingOutput: {
            ...state.chatStreamingOutput,
            [ordinaryFollowUpStreamKey]: 'Ordinary follow-up response',
          },
          chatStreamingCompleted: {
            ...state.chatStreamingCompleted,
            [ordinaryFollowUpStreamKey]: false,
          },
          chatStreamPresentation: {
            ...state.chatStreamPresentation,
            [ordinaryFollowUpStreamKey]: {
              personaDriven,
              virtualSender: personaDriven ? configuredMainPersona : null,
            },
          },
          chatRunningByConv: {
            ...state.chatRunningByConv,
            [conversationId]: true,
          },
          liveModeEnabled: false,
          liveModeFocusedConversationId: null,
          liveModeCurrentProjectId: null,
          liveModeEnabledByConversation: {
            ...state.liveModeEnabledByConversation,
            [conversationId]: false,
          },
        })),
      );
    },
    replaceTranscriptEntries(entries: unknown[]) {
      return commit(() =>
        queryClient.setQueryData(
          queryKeys.chatTranscript.all(projectId, conversationId),
          (current: typeof transcript | undefined) =>
            current
              ? { ...current, pages: [{ ...current.pages[0], entries }] }
              : current,
        ),
      );
    },
    transcriptEntries() {
      const current = queryClient.getQueryData<typeof transcript>(
        queryKeys.chatTranscript.all(projectId, conversationId),
      );
      return current?.pages.flatMap((page) => page.entries) ?? [];
    },
    activateCachedConversation(id: string, entries: unknown[]) {
      return commit(() => {
        seedConversationDetail(projectId, id);
        queryClient.setQueryData(queryKeys.chatTranscript.all(projectId, id), {
          pages: [{ entries, hasMore: false, nextOffset: entries.length }],
          pageParams: [0],
        });
        useStore.setState((state) => ({
          activeConvByProject: {
            ...state.activeConvByProject,
            [projectId]: id,
          },
        }));
      });
    },
    setAiUsers(users: unknown[]) {
      return commit(() =>
        queryClient.setQueryData(
          ['conversation-ai-users', projectId, conversationId],
          users,
        ),
      );
    },
    selectConversation(id: string | null) {
      return commit(() =>
        useStore.getState().setActiveConvForProject(projectId, id),
      );
    },
    streamRetired() {
      return (
        useStore.getState().chatStreamRetiredByConv[conversationId] ?? false
      );
    },
    markPlaybackStarted(messageId: string) {
      return commit(() => markLivePersonaPlaybackStarted(messageId));
    },
    updatePlayback(messageId: string, progress: number) {
      return commit(() => updateLivePersonaPlayback(messageId, progress));
    },
    reconnectWebSocket() {
      handleWebSocketConnected();
    },
    projectId,
    conversationId,
    streamKey,
    previewTabs() {
      return useStore.getState().previewTabsByProject[projectId] ?? null;
    },
  };
}

declare global {
  interface Window {
    chatPageHandoffHarness?: Awaited<
      ReturnType<typeof mountChatPageHandoffHarness>
    >;
  }
}
