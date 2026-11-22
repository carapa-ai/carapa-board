import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { ChatMessageBubble } from './chat-message-bubble';
import type { InnerScrollState } from './chat-message-bubble-scroll';
import { GlobalActionMenus } from '@/components/knowledge/global-action-menus';
import personaAvatar from '@/assets/carapa-bot.png';

declare global {
  interface Window {
    chatBubbleHarness?: {
      append: () => void;
      handoff: () => void;
      showStreaming: () => void;
      showCompleted: () => void;
      showIdentityCases: () => void;
      showTaskDetailUser: () => void;
      rerender: () => void;
      showToolActivity: (
        display: 'compact' | 'expanded',
        running?: boolean,
      ) => void;
      showOutputlessToolThinking: (display: 'compact' | 'expanded') => void;
      setToolDisplay: (display: 'compact' | 'expanded') => void;
    };
  }
}

const initialContent = Array.from(
  { length: 80 },
  (_, index) => `Streaming line ${index + 1}`,
).join('\n\n');

const toolActivityContent = [
  '<!-- carapa-tool:request -->\n> **Read** `src/components/a-very-long-mobile-tool-activity-file-name.tsx`',
  `<!-- carapa-tool:result -->\n> ${'Successful output '.repeat(80)}`,
  '<!-- carapa-tool:request -->\n> **webFetch**',
  '<!-- carapa-tool:result -->\n> 7 files',
  'The agent explains what it found before starting another tool round.',
  '<!-- carapa-tool:request -->\n> **Bash** `exit 1`',
  '<!-- carapa-tool:error -->\n> ⚠️\n> Permission denied while opening the configured workspace.',
  '<!-- carapa-tool:error -->\n> **Turn failed** Remote service failure.',
  '> **Important** _This is ordinary Markdown prose._',
  '> **Summary:** This is ordinary Markdown prose.',
  '> **Alice:** This is ordinary Markdown prose too.',
  '> A concise ordinary quotation.',
  `> ${'A long ordinary quotation remains authored content. '.repeat(20)}`,
  Array.from({ length: 60 }, (_, index) => `Regular line ${index + 1}.`).join(
    '\n\n',
  ),
].join('\n\n');

const outputlessToolThinkingContent = [
  '<!-- carapa-tool:request -->\n> **Bash** `git status --short`',
  '> _Inspecting current files for commit_',
].join('\n\n');

function Harness() {
  const [content, setContent] = useState(initialContent);
  const [mode, setMode] = useState<
    | 'streaming'
    | 'canonical'
    | 'completed'
    | 'task-detail-user'
    | 'tool-activity'
    | 'identity-cases'
  >('streaming');
  const [toolDisplay, setToolDisplay] = useState<'compact' | 'expanded'>(
    'compact',
  );
  const [toolRunning, setToolRunning] = useState(false);
  const [, setRenderVersion] = useState(0);
  const innerScrollStateRef = useRef<InnerScrollState | null>(null);

  useEffect(() => {
    window.chatBubbleHarness = {
      append: () =>
        setContent((value) => `${value}\n\nAdditional streamed output.`),
      handoff: () => setMode('canonical'),
      showStreaming: () => {
        setContent(initialContent);
        setMode('streaming');
      },
      showCompleted: () => setMode('completed'),
      showTaskDetailUser: () => setMode('task-detail-user'),
      rerender: () => setRenderVersion((version) => version + 1),
      showToolActivity: (display, running = false) => {
        setToolDisplay(display);
        setToolRunning(running);
        setContent(toolActivityContent);
        setMode('tool-activity');
      },
      showOutputlessToolThinking: (display) => {
        setToolDisplay(display);
        setToolRunning(false);
        setContent(outputlessToolThinkingContent);
        setMode('tool-activity');
      },
      setToolDisplay,
      showIdentityCases: () => setMode('identity-cases'),
    };
    return () => {
      delete window.chatBubbleHarness;
    };
  }, []);

  if (mode === 'identity-cases') {
    return (
      <div
        data-ui="chat-avatar-cases"
        className="flex w-full flex-col gap-4 p-4"
      >
        <ChatMessageBubble
          id="generic-assistant-message"
          role="assistant"
          source="web"
          assistantSenderName="Capa"
          content="Generic assistant response"
        />
        <ChatMessageBubble
          id="persona-assistant-message"
          role="assistant"
          source="web"
          virtualSenderName="Ada"
          senderUserId="ai:ada"
          virtualSenderAvatarUrl={personaAvatar}
          content="Configured persona response"
        />
        <ChatMessageBubble
          id="human-message"
          role="user"
          source="web"
          sender_name="Human"
          content="Human response"
        />
      </div>
    );
  }

  if (mode === 'task-detail-user') {
    return (
      <ChatMessageBubble
        id="task-detail-user-message-id"
        role="user"
        content="Task detail user message"
        project_id="browser-harness-project"
      />
    );
  }

  if (mode === 'tool-activity') {
    return (
      <ChatMessageBubble
        id="tool-activity-message-id"
        role="assistant"
        project_id="browser-harness-project"
        source="web"
        content={content}
        isStreaming={toolRunning}
        toolCallDisplay={toolDisplay}
        observeInnerScroll
        innerScrollStateRef={innerScrollStateRef}
      />
    );
  }

  return mode === 'canonical' ? (
    <ChatMessageBubble
      key="canonical-message-id"
      id="canonical-message-id"
      role="assistant"
      source="web"
      content={content}
      pinInnerToBottom
      innerScrollStateRef={innerScrollStateRef}
    />
  ) : mode === 'completed' ? (
    <ChatMessageBubble
      key="completed-message-id"
      id="completed-message-id"
      role="assistant"
      source="web"
      content={content}
    />
  ) : (
    <ChatMessageBubble
      key="stream-run-id"
      id="stream-run-id"
      role="assistant"
      source="web"
      content={content}
      isStreaming
      observeInnerScroll
      innerScrollStateRef={innerScrollStateRef}
    />
  );
}

const rootRoute = createRootRoute({ component: Outlet });
const route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: Harness,
});
const router = createRouter({ routeTree: rootRoute.addChildren([route]) });
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
queryClient.setQueryData(
  ['knowledge', 'shared', 'browser-harness-project'],
  [
    {
      id: 'marker-free-kb',
      name: 'Marker-free KB',
      description: 'Browser action target',
    },
  ],
);

export function mountChatMessageBubbleHarness(element: HTMLElement) {
  createRoot(element).render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <GlobalActionMenus />
    </QueryClientProvider>,
  );
}
