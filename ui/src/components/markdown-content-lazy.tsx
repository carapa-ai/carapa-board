import type { MarkdownFileOpenHandler } from '@/lib/project-file-links';
import {
  MarkdownContent as EagerMarkdownContent,
  type QuestionSendHandler,
  type PlanKanbanAction,
} from './markdown-content';
import type { ToolCallDisplay } from '@/types';
import { memo, useEffect, useRef, useState } from 'react';
import type { TaskOutputRenderChunk } from '@/lib/task-message-rendering';

export function MarkdownContent(props: {
  children: string;
  onSendMessage?: QuestionSendHandler;
  onImplementPlan?: (artifactPath: string) => void;
  onSendPlanToKanban?: (plan: PlanKanbanAction) => Promise<void>;
  onOpenArtifact?: MarkdownFileOpenHandler;
  projectFolder?: string;
  questionAnswer?: string;
  liveRevealProgress?: number;
  liveRevealPreserveLayout?: boolean;
  toolCallDisplay?: ToolCallDisplay;
  toolActivityRunning?: boolean;
  onToolDisclosureChange?: () => void;
  deferUntilVisible?: boolean;
}) {
  const { deferUntilVisible, children } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(
    () => !deferUntilVisible || typeof IntersectionObserver === 'undefined',
  );

  useEffect(() => {
    if (!deferUntilVisible || visible) return;
    const element = containerRef.current;
    if (!element || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setVisible(true);
        observer.disconnect();
      },
      { rootMargin: '384px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [deferUntilVisible, visible]);

  // Render the placeholder only while deferral is requested: `visible` is
  // latched once true, so a row that mounted deferred off-screen must still
  // switch to eager the moment `deferUntilVisible` turns false.
  if (!visible && deferUntilVisible) {
    return (
      <div
        ref={containerRef}
        data-ui="chat-deferred-markdown"
        className="whitespace-pre-wrap"
      >
        {children}
      </div>
    );
  }
  return <EagerMarkdownContent {...props} />;
}

type MarkdownContentProps = Parameters<typeof MarkdownContent>[0];

const MemoizedMarkdownContent = memo(MarkdownContent);

/**
 * Renders paged task output as independently memoized Markdown chunks, so a
 * newly loaded page or live entry parses only the chunk it changed.
 */
export function ChunkedMarkdownContent({
  chunks,
  ...props
}: Omit<MarkdownContentProps, 'children' | 'deferUntilVisible'> & {
  chunks: TaskOutputRenderChunk[];
}) {
  return (
    <>
      {chunks.map((chunk) => (
        <MemoizedMarkdownContent key={chunk.key} {...props}>
          {chunk.content}
        </MemoizedMarkdownContent>
      ))}
    </>
  );
}
