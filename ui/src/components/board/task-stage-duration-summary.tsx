import { useEffect, useRef, useState } from 'react';
import type { StageDefinition, TaskRunStageDuration } from '@/types';
import { formatDuration } from '@/lib/utils';

interface TaskStageDurationSummaryProps {
  durations: TaskRunStageDuration[];
  stages: StageDefinition[];
}

function clampDuration(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function parseValidRunTimestamp(value: string): number | undefined {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(\.\d+)?(Z|[+-](0\d|1[0-3]):[0-5]\d|[+-]14:00)$/.exec(
      value,
    );
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || year > 9999 || month < 1 || month > 12) return undefined;
  const daysInMonth = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (day < 1 || day > daysInMonth[month - 1]) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function useLiveRunningDuration(duration: TaskRunStageDuration): number {
  const [, setTick] = useState(0);
  const receiptRef = useRef({
    reference: duration.runningReferenceAt,
    receivedAt: Date.now(),
  });
  if (receiptRef.current.reference !== duration.runningReferenceAt) {
    receiptRef.current = {
      reference: duration.runningReferenceAt,
      receivedAt: Date.now(),
    };
  }
  useEffect(() => {
    if (duration.runningStartedAt.length === 0) return;
    const interval = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(interval);
  }, [duration.runningStartedAt]);
  if (duration.runningStartedAt.length === 0) return 0;

  const sinceReceipt = clampDuration(
    Date.now() - receiptRef.current.receivedAt,
  );
  const referenceMs = parseValidRunTimestamp(duration.runningReferenceAt);
  if (referenceMs === undefined) return 0;
  // Calculate each row from its server-relative offset before applying the
  // client elapsed time. This keeps future rows at zero and avoids comparing
  // the server and client wall clocks directly.
  return duration.runningStartedAt.reduce((total, startedAt) => {
    const startedMs = parseValidRunTimestamp(startedAt);
    if (startedMs === undefined) return total;
    return total + clampDuration(referenceMs - startedMs + sinceReceipt);
  }, 0);
}

function StageDurationRow({
  duration,
  stage,
}: {
  duration: TaskRunStageDuration;
  stage?: StageDefinition;
}) {
  const totalDuration =
    clampDuration(duration.completedDurationMs) +
    useLiveRunningDuration(duration);
  const label = stage?.title ?? duration.stageId ?? 'Unknown';

  return (
    <div
      className="flex min-w-0 items-center justify-between gap-3 rounded-md px-2 py-1 text-xs"
      data-ui="task-stage-duration-row"
      data-stage-id={duration.stageId ?? 'unknown'}
    >
      <span className="flex min-w-0 items-center gap-2 truncate">
        <span
          // Fallback dot: light uses the status token, dark keeps the exact
          // pre-light-theme hex.
          className="size-2 shrink-0 rounded-full bg-[color:var(--status-backlog)] dark:bg-[#8B8FA3]"
          style={stage?.color ? { backgroundColor: stage.color } : undefined}
          aria-hidden="true"
        />
        <span className="truncate" title={duration.stageId ?? 'Unknown stage'}>
          {label}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-3 tabular-nums text-muted-foreground">
        {duration.costUsd != null && (
          <span data-ui="task-stage-duration-cost">
            ${duration.costUsd.toFixed(4)}
          </span>
        )}
        <span>{formatDuration(totalDuration)}</span>
      </span>
    </div>
  );
}

export function TaskStageDurationSummary({
  durations,
  stages,
}: TaskStageDurationSummaryProps) {
  const byStageId = new Map(
    durations.map((duration) => [duration.stageId, duration]),
  );
  const executableStages = stages.filter(
    (stage) =>
      (stage.type === 'active' ||
        stage.type === 'testing' ||
        stage.type === 'review') &&
      (!stage.inactive || byStageId.has(stage.id)),
  );
  const configuredRows = executableStages.map(
    (stage) =>
      byStageId.get(stage.id) ?? {
        stageId: stage.id,
        completedDurationMs: 0,
        runningStartedAt: [],
        runningDurationMs: 0,
        runningReferenceAt: new Date(0).toISOString(),
        costUsd: null,
      },
  );
  const configuredIds = new Set(executableStages.map((stage) => stage.id));
  const historicalRows = durations.filter(
    (duration) => !duration.stageId || !configuredIds.has(duration.stageId),
  );
  const hasMeasuredTime = durations.some(
    (duration) =>
      duration.completedDurationMs > 0 || duration.runningDurationMs > 0,
  );

  return (
    <section
      className="space-y-2 rounded-lg border bg-muted/20 p-3"
      data-ui="task-stage-duration-summary"
    >
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Time by stage
      </h3>
      {configuredRows.length === 0 && historicalRows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No measurable run time yet.
        </p>
      ) : (
        <div className="space-y-0.5">
          {configuredRows.map((duration) => (
            <StageDurationRow
              key={duration.stageId}
              duration={duration}
              stage={stages.find((stage) => stage.id === duration.stageId)}
            />
          ))}
          {historicalRows.map((duration, index) => (
            <StageDurationRow
              key={duration.stageId ?? `unknown-${index}`}
              duration={duration}
              stage={stages.find((stage) => stage.id === duration.stageId)}
            />
          ))}
        </div>
      )}
      {configuredRows.length > 0 &&
        !hasMeasuredTime &&
        historicalRows.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No measurable run time yet.
          </p>
        )}
    </section>
  );
}
