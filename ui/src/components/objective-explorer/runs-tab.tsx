import React, { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  fetchLiveObjectiveRunTranscript,
  fetchObjectiveRuns,
  fetchSessionTranscript,
  fetchFileContent,
  type ObjectiveRun,
} from '@/lib/api';
import {
  ChatMessageBubble,
  TelemetryBar,
} from '@/components/chat/chat-message-bubble';
import { COST_TEXT_CLASS } from '@/lib/cost-display';
import { useProject } from '@/hooks/use-projects';
import { transcriptToBubbleItems } from '@/lib/chat-transcript-render-items';
import { resolveToolCallDisplay } from '@/types';
import {
  countLoadedObjectiveRows,
  mergeObjectivePages,
  nextObjectiveOffset,
} from './pagination';

interface Props {
  project_id: string;
  objective_id: string;
}

function hasRunTelemetry(run: ObjectiveRun) {
  return (
    !!run.model ||
    run.inputTokens > 0 ||
    run.outputTokens > 0 ||
    run.cacheReadTokens > 0 ||
    run.cacheCreationTokens > 0
  );
}

/** Maps run-stats fields onto the chat telemetry shape rendered by TelemetryBar. */
function runTelemetry(run: ObjectiveRun): Record<string, unknown> {
  return {
    model_name: run.model ?? undefined,
    tok_input: run.inputTokens,
    tok_output: run.outputTokens,
    tok_cache_read: run.cacheReadTokens,
    tok_cache_write: run.cacheCreationTokens,
    duration_ms: run.duration_ms ?? undefined,
    cost_usd: run.costUsd ?? undefined,
    // Claude runs report only fresh input (cache read dwarfs it).
    inputTokenSemantics:
      run.inputTokens < run.cacheReadTokens ? 'fresh' : 'total',
  };
}

const RUNNING_REFETCH_MS = 5_000;
const IDLE_REFETCH_MS = 30_000;

/** Poll quickly only while the current run (always listed first) is running. */
export function runsRefetchInterval(query: {
  state: { data?: { pages: { runs: { running?: boolean }[] }[] } };
}): number {
  return query.state.data?.pages[0]?.runs[0]?.running
    ? RUNNING_REFETCH_MS
    : IDLE_REFETCH_MS;
}

export function RunsTab({ project_id, objective_id }: Props) {
  const { data: project } = useProject(project_id);
  const toolCallDisplay = resolveToolCallDisplay(
    project?.settings?.toolCallDisplay,
  );
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const [expandedView, setExpandedView] = useState<'transcript' | 'reflection'>(
    'transcript',
  );
  const limit = 30;

  const {
    data,
    isLoading,
    isError,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['objective-runs', project_id, objective_id],
    queryFn: ({ pageParam }) =>
      fetchObjectiveRuns(project_id, objective_id, {
        limit,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      nextObjectiveOffset(
        countLoadedObjectiveRows(allPages.map((page) => page.runs)),
        lastPage.total,
      ),
    // Picks up a newly started run and the end of the current one.
    refetchInterval: runsRefetchInterval,
  });
  const runs = data
    ? mergeObjectivePages(
        data.pages.map((page) => page.runs),
        (run) => run.runId,
      )
    : [];
  const remaining = data
    ? data.pages[data.pages.length - 1]!.total -
      countLoadedObjectiveRows(data.pages.map((page) => page.runs))
    : 0;

  const expandedRunning = runs.some(
    (run) => run.runId === expandedRun && run.running,
  );
  const { data: transcript, isLoading: transcriptLoading } = useQuery({
    // The running flag is part of the key so the saved transcript is fetched
    // once the run completes.
    queryKey: ['session-transcript', expandedRun, expandedRunning],
    queryFn: () =>
      expandedRunning
        ? fetchLiveObjectiveRunTranscript(
            project_id,
            objective_id,
            expandedRun!,
          )
        : fetchSessionTranscript(expandedRun!),
    enabled: !!expandedRun && expandedView === 'transcript',
    refetchInterval: expandedRunning ? 2_000 : false,
    // Keep the previous data only for the same run (live -> saved flip), never
    // across runs, so a newly expanded run shows its own loading state.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === expandedRun ? previous : undefined,
  });

  // Follow a live transcript while the reader stays at the bottom.
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const followTranscript = useRef(true);
  const transcriptLength = transcript?.entries.length ?? 0;
  useEffect(() => {
    const element = transcriptScrollRef.current;
    if (element && expandedRunning && followTranscript.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [transcriptLength, expandedRunning]);

  const { data: reflection, isLoading: reflectionLoading } = useQuery({
    queryKey: ['run-reflection', project_id, objective_id, expandedRun],
    queryFn: () =>
      fetchFileContent(
        project_id,
        objective_id,
        'reflections',
        `${expandedRun}.md`,
      ),
    enabled: !!expandedRun && expandedView === 'reflection',
  });

  if (isLoading)
    return (
      <div className="text-muted-foreground text-sm p-4">Loading runs...</div>
    );
  if (isError)
    return (
      <div className="text-destructive text-sm py-2">
        Error loading runs: {(error as Error)?.message || 'Unknown error'}
      </div>
    );
  if (!runs.length)
    return (
      <div className="text-muted-foreground text-sm p-4">
        No runs recorded yet
      </div>
    );

  const formatDuration = (ms: number | null) => {
    if (ms == null) return '-';
    if (ms < 60000) return `${Math.round(ms / 1000)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
  };

  const formatCost = (usd: number | null) =>
    usd != null ? `$${usd.toFixed(2)}` : '-';

  const formatTime = (ts: string | null) => {
    if (!ts) return '-';
    const d = new Date(ts);
    return d.toLocaleString('en-GB', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="text-sm [container-type:inline-size]">
      <table className="w-full">
        <thead>
          <tr className="text-xs text-muted-foreground border-b border-border">
            <th className="text-left py-1.5 px-1 font-medium">Run</th>
            <th className="text-left py-1.5 px-1 font-medium">Time</th>
            <th className="text-left py-1.5 px-1 font-medium">Trigger</th>
            <th className="text-right py-1.5 px-1 font-medium">Duration</th>
            <th className="text-right py-1.5 px-1 font-medium">Cost</th>
            <th className="text-right py-1.5 px-1 font-medium">Steps</th>
            <th className="text-right py-1.5 px-1 font-medium">Status</th>
            <th className="text-center py-1.5 px-1 font-medium">Links</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <React.Fragment key={run.runId}>
              <tr
                className="border-b border-border/50 hover:bg-muted/50 cursor-pointer"
                onClick={() => {
                  if (expandedRun === run.runId) {
                    setExpandedRun(null);
                  } else {
                    setExpandedRun(run.runId);
                    setExpandedView('transcript');
                    followTranscript.current = true;
                  }
                }}
              >
                <td className="py-1.5 px-1 max-w-[160px]">
                  <div
                    className="font-mono text-xs text-muted-foreground truncate"
                    title={run.runId}
                  >
                    {run.runId}
                  </div>
                  {run.model && (
                    <div
                      className="font-mono text-[11px] text-muted-foreground truncate"
                      data-ui="objective-run-model"
                      title={run.model}
                    >
                      {run.model}
                    </div>
                  )}
                </td>
                <td className="py-1.5 px-1 font-mono text-xs">
                  {formatTime(run.timestamp)}
                </td>
                <td className="py-1.5 px-1">
                  {run.triggerType?.replace(/_/g, ' ') ?? '-'}
                </td>
                <td className="py-1.5 px-1 text-right">
                  {formatDuration(run.duration_ms)}
                </td>
                <td
                  className={`py-1.5 px-1 text-right ${run.costUsd != null ? COST_TEXT_CLASS : ''}`}
                >
                  {formatCost(run.costUsd)}
                </td>
                <td
                  className="py-1.5 px-1 text-right"
                  title={
                    run.numSteps != null
                      ? 'Completed Codex stream items'
                      : 'Harness-reported turns'
                  }
                >
                  {run.numSteps ?? run.numTurns ?? '-'}
                </td>
                <td
                  className={`py-1.5 px-1 text-right ${run.running ? 'text-blue-600 dark:text-blue-400' : run.exitCode === 0 ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}
                  data-ui={run.running ? 'objective-run-running' : undefined}
                >
                  {run.running
                    ? 'Running'
                    : run.exitCode === 0
                      ? 'OK'
                      : run.exitCode == null
                        ? '-'
                        : `Failed (${run.exitCode})`}
                </td>
                <td className="py-1.5 px-1 text-center space-x-1">
                  {run.hasTranscript && <span title="Has transcript">📄</span>}
                  {run.hasReflection && <span title="Has reflection">🧠</span>}
                </td>
              </tr>
              {run.llmSteps.map((step) => (
                <React.Fragment key={step.stepId}>
                  <tr
                    className={`border-b border-border/30 bg-muted/20 text-xs ${step.output ? 'cursor-pointer hover:bg-muted/40' : ''}`}
                    onClick={() => {
                      if (step.output)
                        setExpandedStep(
                          expandedStep === step.stepId ? null : step.stepId,
                        );
                    }}
                  >
                    <td className="py-1.5 px-1 pl-5">
                      <div className="font-medium">
                        ↳ {step.kind}
                        {step.attempt > 1 ? ` #${step.attempt}` : ''}
                      </div>
                      <div
                        className="font-mono text-[11px] text-muted-foreground"
                        title={step.baseUrl}
                      >
                        {step.model} · {step.reasoningEffort ?? 'default'}
                      </div>
                    </td>
                    <td className="py-1.5 px-1 font-mono">
                      {formatTime(step.timestamp)}
                    </td>
                    <td className="py-1.5 px-1 text-muted-foreground">
                      {step.wireApi.replace(/_/g, ' ')}
                    </td>
                    <td className="py-1.5 px-1 text-right">
                      {formatDuration(step.durationMs)}
                    </td>
                    <td
                      className={`py-1.5 px-1 text-right ${step.costUsd != null ? COST_TEXT_CLASS : 'text-muted-foreground'}`}
                      title={
                        step.costUsd != null
                          ? 'Estimated from model and token usage; not included in parent run cost'
                          : undefined
                      }
                    >
                      {formatCost(step.costUsd)}
                    </td>
                    <td
                      className="py-1.5 px-1 text-right"
                      title={`${step.inputTokens ?? 0} input + ${step.outputTokens ?? 0} output tokens`}
                    >
                      {step.totalTokens != null
                        ? `${step.totalTokens.toLocaleString()} tok`
                        : '-'}
                    </td>
                    <td
                      className={`py-1.5 px-1 text-right ${step.status === 'completed' ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}
                      title={step.error ?? undefined}
                    >
                      {step.status === 'completed' ? 'OK' : 'Failed'}
                    </td>
                    <td
                      className="py-1.5 px-1 text-center"
                      title={step.error ?? undefined}
                    >
                      {step.output ? (
                        <span title="View output">📄</span>
                      ) : step.error ? (
                        '⚠️'
                      ) : (
                        ''
                      )}
                    </td>
                  </tr>
                  {expandedStep === step.stepId && step.output && (
                    <tr>
                      <td colSpan={8} className="p-0">
                        <div className="max-h-96 overflow-auto whitespace-pre-wrap border-b border-border bg-muted/30 p-3 text-xs">
                          <div className="mb-2 font-medium text-muted-foreground">
                            {step.kind === 'curator'
                              ? 'Curator brief'
                              : 'Reflection output'}
                          </div>
                          {step.output}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
              {expandedRun === run.runId && (
                <tr key={`${run.runId}-expanded`}>
                  <td colSpan={9} className="p-0 max-w-0">
                    {/* The run table is wider than a narrow explorer pane and
                        scrolls sideways; keep the open run as wide as the pane
                        and pinned to its left edge so the transcript is never
                        clipped or reachable only by scrolling the table. */}
                    <div className="sticky left-0 w-[100cqw] min-w-0 max-w-full overflow-hidden bg-muted/30 border-b border-border p-3">
                      {hasRunTelemetry(run) && (
                        <div
                          className="mb-2 flex"
                          data-ui="objective-run-telemetry"
                          data-run-id={run.runId}
                        >
                          <TelemetryBar telemetry={runTelemetry(run)} />
                        </div>
                      )}
                      <div className="flex gap-2 mb-2">
                        {run.hasTranscript && (
                          <button
                            className={`text-xs px-2 py-0.5 rounded ${expandedView === 'transcript' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedView('transcript');
                            }}
                          >
                            📄 Transcript
                          </button>
                        )}
                        {run.hasReflection && (
                          <button
                            className={`text-xs px-2 py-0.5 rounded ${expandedView === 'reflection' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedView('reflection');
                            }}
                          >
                            🧠 Reflection
                          </button>
                        )}
                        {run.rationale && (
                          <span className="text-xs text-muted-foreground ml-auto">
                            Rationale: {run.rationale}
                          </span>
                        )}
                      </div>
                      <div
                        ref={transcriptScrollRef}
                        onScroll={(e) => {
                          const el = e.currentTarget;
                          followTranscript.current =
                            el.scrollHeight - el.scrollTop - el.clientHeight <
                            40;
                        }}
                        className="min-w-0 max-w-full max-h-96 overflow-auto rounded bg-background/50 p-2 text-xs"
                      >
                        {expandedView === 'transcript' &&
                          (transcriptLoading ? (
                            <span className="text-muted-foreground">
                              Loading transcript...
                            </span>
                          ) : transcript &&
                            (transcript.prompt || transcript.entries.length) ? (
                            <div className="min-w-0 max-w-full space-y-3 font-sans">
                              {transcript.prompt &&
                                !transcript.entries.some(
                                  (entry) =>
                                    entry.role === 'user' &&
                                    entry.content.trim() ===
                                      transcript.prompt?.trim(),
                                ) && (
                                  <ChatMessageBubble
                                    id={`${expandedRun}-prompt`}
                                    role="user"
                                    content={transcript.prompt}
                                    project_id={project_id}
                                  />
                                )}
                              {transcriptToBubbleItems(transcript.entries).map(
                                (item) => (
                                  <ChatMessageBubble
                                    key={`${expandedRun}-${item.id}`}
                                    id={item.id}
                                    role={item.role}
                                    content={item.content}
                                    created_at={item.created_at}
                                    agent_name={item.agent_name}
                                    thinking={item.thinking}
                                    attachments={item.attachments}
                                    telemetry={item.telemetry}
                                    isError={item.isError}
                                    toolCallDisplay={toolCallDisplay}
                                    project_id={project_id}
                                  />
                                ),
                              )}
                            </div>
                          ) : (
                            <span className="text-muted-foreground">
                              No transcript data
                            </span>
                          ))}
                        {expandedView === 'reflection' &&
                          (reflectionLoading ? (
                            <span className="text-muted-foreground">
                              Loading reflection...
                            </span>
                          ) : reflection?.content ? (
                            reflection.content
                          ) : (
                            <span className="text-muted-foreground">
                              No reflection data
                            </span>
                          ))}
                      </div>
                    </div>
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>

      {hasNextPage && (
        <button
          className="w-full text-center text-xs text-muted-foreground hover:text-foreground py-2"
          disabled={isFetchingNextPage}
          onClick={() => void fetchNextPage()}
        >
          Load more ({remaining} remaining)
        </button>
      )}
    </div>
  );
}
