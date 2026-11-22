import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ObjectiveRun } from '@/lib/api';
import { RunsTab, runsRefetchInterval } from './runs-tab';

const baseRun: ObjectiveRun = {
  runId: 'run-legacy',
  timestamp: null,
  triggerType: 'task_completed',
  duration_ms: 1000,
  costUsd: null,
  numTurns: null,
  numSteps: null,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  model: null,
  exitCode: 0,
  rationale: null,
  hasTranscript: false,
  hasReflection: false,
  llmSteps: [],
};

const api = vi.hoisted(() => ({
  fetchObjectiveRuns: vi.fn(),
  fetchSessionTranscript: vi.fn(async () => ({ prompt: null, entries: [] })),
  fetchLiveObjectiveRunTranscript: vi.fn(async () => ({
    prompt: null,
    entries: [],
  })),
  fetchFileContent: vi.fn(),
}));

vi.mock('@/lib/api', () => api);
vi.mock('@/components/chat/chat-message-bubble', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/components/chat/chat-message-bubble')
  >()),
  ChatMessageBubble: ({ content }: { content: string }) => <p>{content}</p>,
}));
vi.mock('@/hooks/use-projects', () => ({
  useProject: () => ({ data: undefined }),
}));

describe('RunsTab model and telemetry', () => {
  it('shows the model on the row and chat-style telemetry when expanded', async () => {
    api.fetchObjectiveRuns.mockResolvedValue({
      total: 2,
      runs: [
        {
          ...baseRun,
          runId: 'run-current',
          model: 'claude-opus-5-5',
          costUsd: 9.47,
          duration_ms: 797475,
          inputTokens: 52,
          outputTokens: 18154,
          cacheReadTokens: 2929361,
          cacheCreationTokens: 519528,
        },
        baseRun,
      ],
    });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RunsTab project_id="p" objective_id="o" />
      </QueryClientProvider>,
    );

    expect(await screen.findByText('claude-opus-5-5')).toBeTruthy();
    expect(
      document.querySelectorAll('[data-ui="objective-run-model"]'),
    ).toHaveLength(1);

    await user.click(screen.getByText('run-current'));
    const telemetry = document.querySelector(
      '[data-ui="chat-message-telemetry"]',
    );
    expect(telemetry?.textContent).toContain('Claude opus-5-5');
    expect(telemetry?.textContent).toContain('Total: ↑3448941');
    expect(telemetry?.textContent).toContain('↓18154');
    expect(telemetry?.textContent).toMatch(/⚡2\.9M \(\d+\.\d%\)/);
    expect(telemetry?.textContent).toContain('$9.4700');

    // Legacy run: expands without a model line or telemetry bar.
    await user.click(screen.getByText('run-legacy'));
    expect(
      document.querySelector('[data-ui="chat-message-telemetry"]'),
    ).toBeNull();
    expect(
      document.querySelectorAll('[data-ui="objective-run-model"]'),
    ).toHaveLength(1);
  });
});

describe('RunsTab running run', () => {
  it('marks the current run and reads its transcript from the live endpoint', async () => {
    api.fetchObjectiveRuns.mockResolvedValue({
      total: 1,
      runs: [
        {
          ...baseRun,
          runId: 'run-live',
          exitCode: null,
          hasTranscript: true,
          running: true,
        },
      ],
    });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RunsTab project_id="p" objective_id="o" />
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Running')).toBeTruthy();
    await user.click(screen.getByText('run-live'));
    expect(await screen.findByText('No transcript data')).toBeTruthy();
    expect(api.fetchLiveObjectiveRunTranscript).toHaveBeenCalledWith(
      'p',
      'o',
      'run-live',
    );
    expect(api.fetchSessionTranscript).not.toHaveBeenCalledWith('run-live');
  });
});

describe('RunsTab transcript placeholder', () => {
  const finished = (runId: string) => ({
    ...baseRun,
    runId,
    hasTranscript: true,
  });
  const transcriptOf = (text: string) => ({
    id: 'x',
    source: 'objective',
    prompt: null,
    entries: [{ role: 'assistant', content: text }],
  });

  it('shows loading instead of the previous run transcript when switching runs', async () => {
    api.fetchObjectiveRuns.mockResolvedValue({
      total: 2,
      runs: [finished('run-a'), finished('run-b')],
    });
    let resolveB!: (value: ReturnType<typeof transcriptOf>) => void;
    api.fetchSessionTranscript.mockImplementation((async (id: string) =>
      id === 'run-a'
        ? transcriptOf('alpha-msg')
        : new Promise((resolve) => {
            resolveB = resolve;
          })) as never);
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RunsTab project_id="p" objective_id="o" />
      </QueryClientProvider>,
    );

    await user.click(await screen.findByText('run-a'));
    expect(await screen.findByText('alpha-msg')).toBeTruthy();
    await user.click(screen.getByText('run-b'));
    expect(await screen.findByText('Loading transcript...')).toBeTruthy();
    expect(screen.queryByText('alpha-msg')).toBeNull();
    resolveB(transcriptOf('beta-msg'));
    expect(await screen.findByText('beta-msg')).toBeTruthy();
  });

  it('keeps the live transcript visible while the same run flips to its saved transcript', async () => {
    const client = new QueryClient();
    const live = { ...finished('run-live'), running: true, exitCode: null };
    api.fetchObjectiveRuns.mockResolvedValue({ total: 1, runs: [live] });
    api.fetchLiveObjectiveRunTranscript.mockResolvedValue(
      transcriptOf('live-msg') as never,
    );
    api.fetchSessionTranscript.mockImplementation(
      (() => new Promise(() => {})) as never,
    );
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={client}>
        <RunsTab project_id="p" objective_id="o" />
      </QueryClientProvider>,
    );

    await user.click(await screen.findByText('run-live'));
    expect(await screen.findByText('live-msg')).toBeTruthy();

    api.fetchObjectiveRuns.mockResolvedValue({
      total: 1,
      runs: [{ ...live, running: false, exitCode: 0 }],
    });
    await client.invalidateQueries({ queryKey: ['objective-runs'] });
    await waitFor(() =>
      expect(api.fetchSessionTranscript).toHaveBeenCalledWith('run-live'),
    );
    expect(screen.getByText('live-msg')).toBeTruthy();
    expect(screen.queryByText('Loading transcript...')).toBeNull();
  });
});

describe('RunsTab polling interval', () => {
  const state = (running?: boolean) => ({
    state: {
      data: { pages: [{ runs: [{ running }, { running: true }] }] },
    },
  });

  it('polls every 5s while the first row is running and every 30s otherwise', () => {
    expect(runsRefetchInterval(state(true))).toBe(5_000);
    expect(runsRefetchInterval(state(undefined))).toBe(30_000);
    expect(runsRefetchInterval({ state: {} })).toBe(30_000);
  });
});
