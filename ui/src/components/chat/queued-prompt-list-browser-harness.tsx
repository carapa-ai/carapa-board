import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueuedPromptList } from './queued-prompt-list';
import type { QueuedPrompt } from '@/store';

declare global {
  interface Window {
    queuedPromptHarness?: { drain: () => void; drainCount: () => number };
  }
}

function Harness() {
  const [prompts, setPrompts] = useState<QueuedPrompt[]>([
    {
      id: 'server-owned-1',
      contextKey: 'project-a',
      content: 'queued voice turn',
      bubbleContent: 'queued voice turn',
      memoryContextLevel: 'off',
      serverOwned: true,
      serverQueueOwner: 'persona',
      liveMode: true,
      liveModeSessionId: 'session-1',
      liveModeKind: 'work',
    },
  ]);
  const [drains, setDrains] = useState(0);
  window.queuedPromptHarness = {
    drain: () =>
      setPrompts((current) => {
        if (current.length === 0) return current;
        setDrains((value) => value + 1);
        return [];
      }),
    drainCount: () => drains,
  };
  return (
    <QueuedPromptList
      prompts={prompts}
      isAgentRunning
      canSteer
      onSteer={() => {}}
      onEdit={() => {}}
      onDelete={() => {}}
    />
  );
}

export function mountQueuedPromptListHarness(element: HTMLElement) {
  createRoot(element).render(<Harness />);
}
