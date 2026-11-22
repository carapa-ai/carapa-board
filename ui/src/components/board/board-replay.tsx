import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { History, Pause, Play, RotateCcw, X } from 'lucide-react';
import { Select, SelectItem } from '@/components/ui/select';
import { fetchBoardReplay } from '@/lib/api';
import type { BoardReplayData, BoardReplayRun, TaskSummary } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  reconstructReplayTasks,
  replayDurationMs,
  replayRunsAt,
} from './board-replay-state';

const SPEEDS = [0.5, 1, 2, 4, 8] as const;

function localInputValue(iso: string): string {
  const date = new Date(iso);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function inputIso(value: string): string | null {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function defaultReplayRange(hours = 24): { from: string; to: string } {
  const to = new Date();
  return {
    from: new Date(to.getTime() - hours * 60 * 60_000).toISOString(),
    to: to.toISOString(),
  };
}

interface BoardReplayPlayerProps {
  projectId: string;
  range: { from: string; to: string };
  onRangeChange: (range: { from: string; to: string }) => void;
  onExit: () => void;
  onFrame: (
    tasks: TaskSummary[],
    runs: Map<string, BoardReplayRun>,
    data: BoardReplayData | undefined,
    at: number,
  ) => void;
}

export function BoardReplayPlayer({
  projectId,
  range,
  onRangeChange,
  onExit,
  onFrame,
}: BoardReplayPlayerProps) {
  const fromMs = new Date(range.from).getTime();
  const toMs = new Date(range.to).getTime();
  const validRange =
    Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs < toMs;
  const [at, setAt] = useState(fromMs);
  const [speed, setSpeed] = useState<number>(1);
  const [playing, setPlaying] = useState(false);
  const lastTick = useRef<number | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['board-replay', projectId, range.from, range.to],
    queryFn: () => fetchBoardReplay(projectId, range.from, range.to),
    enabled: validRange,
    staleTime: 10_000,
  });

  useEffect(() => {
    setAt(fromMs);
    setPlaying(false);
    lastTick.current = null;
  }, [fromMs, toMs]);

  useEffect(() => {
    const selectedDuration = toMs - fromMs;
    // Keep a completed outcome visible for roughly two real-time seconds at
    // 1×, then let the card return to its ordinary historical appearance.
    const outcomeWindow =
      (selectedDuration * 2_000) / replayDurationMs(selectedDuration);
    onFrame(
      reconstructReplayTasks(data, at),
      replayRunsAt(data, at, outcomeWindow),
      data,
      at,
    );
  }, [at, data, fromMs, onFrame, toMs]);

  useEffect(() => {
    if (!playing || !validRange) return;
    let frame = 0;
    const tick = (now: number) => {
      const previous = lastTick.current ?? now;
      lastTick.current = now;
      const selectedDuration = toMs - fromMs;
      const timelineDelta =
        ((now - previous) * selectedDuration * speed) /
        replayDurationMs(selectedDuration);
      setAt((current) => {
        const next = current + timelineDelta;
        if (next >= toMs) {
          setPlaying(false);
          lastTick.current = null;
          return toMs;
        }
        return next;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, validRange, fromMs, toMs, speed]);

  const progress = validRange
    ? Math.max(0, Math.min(100, ((at - fromMs) / (toMs - fromMs)) * 100))
    : 0;
  const exactLimited =
    data?.exactHistoryAvailableFrom &&
    new Date(data.exactHistoryAvailableFrom).getTime() > fromMs;
  const runsLimited =
    data?.runHistoryAvailableFrom &&
    new Date(data.runHistoryAvailableFrom).getTime() > fromMs;

  const presets = useMemo(
    () => [
      { label: '1h', hours: 1 },
      { label: '6h', hours: 6 },
      { label: '24h', hours: 24 },
      { label: '7d', hours: 24 * 7 },
    ],
    [],
  );

  return (
    <div className="mx-4 mt-3 rounded-lg border border-primary/30 bg-card px-3 py-2 shadow-sm flex-shrink-0">
      <div className="flex items-center gap-2 flex-wrap">
        <History className="size-4 text-primary" />
        <span className="text-sm font-medium">Board replay</span>
        {presets.map((preset) => (
          <Button
            key={preset.label}
            size="sm"
            variant="ghost"
            className="px-2 text-xs"
            onClick={() => onRangeChange(defaultReplayRange(preset.hours))}
          >
            {preset.label}
          </Button>
        ))}
        <Input
          type="datetime-local"
          aria-label="Replay start"
          value={localInputValue(range.from)}
          onChange={(event) => {
            const from = inputIso(event.target.value);
            if (from) onRangeChange({ ...range, from });
          }}
          compact
          className="w-auto"
        />
        <span className="text-xs text-muted-foreground">to</span>
        <Input
          type="datetime-local"
          aria-label="Replay end"
          value={localInputValue(range.to)}
          onChange={(event) => {
            const to = inputIso(event.target.value);
            if (to) onRangeChange({ ...range, to });
          }}
          compact
          className="w-auto"
        />
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-8 gap-1"
          onClick={onExit}
        >
          <X className="size-3.5" /> Exit
        </Button>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <Button
          size="icon"
          variant="outline"
          className="size-8"
          disabled={isLoading || !!error || !validRange}
          aria-label={playing ? 'Pause replay' : 'Play replay'}
          onClick={() => {
            if (at >= toMs) setAt(fromMs);
            lastTick.current = null;
            setPlaying((value) => !value);
          }}
        >
          {playing ? (
            <Pause className="size-3.5" />
          ) : (
            <Play className="size-3.5" />
          )}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          aria-label="Reset replay"
          onClick={() => {
            setPlaying(false);
            setAt(fromMs);
          }}
        >
          <RotateCcw className="size-3.5" />
        </Button>
        <input
          type="range"
          min={0}
          max={1000}
          value={Math.round(progress * 10)}
          onChange={(event) => {
            setPlaying(false);
            setAt(
              fromMs + (Number(event.target.value) / 1000) * (toMs - fromMs),
            );
          }}
          className="min-w-[180px] flex-1 accent-primary"
        />
        <span className="min-w-[165px] text-right text-xs tabular-nums text-muted-foreground">
          {new Date(at).toLocaleString()}
        </span>
        <Select
          compact
          aria-label="Replay speed"
          value={String(speed)}
          onValueChange={(nextValue) => setSpeed(Number(nextValue))}
        >
          {SPEEDS.map((value) => (
            <SelectItem key={value} value={String(value)}>
              {value}×
            </SelectItem>
          ))}
        </Select>
      </div>

      {(isLoading ||
        error ||
        exactLimited ||
        runsLimited ||
        (data && data.events.length === 0 && data.runs.length === 0)) && (
        <div className="mt-1.5 text-xs text-muted-foreground">
          {isLoading && 'Loading replay…'}
          {error &&
            `Could not load replay: ${error instanceof Error ? error.message : String(error)}`}
          {!isLoading &&
            !error &&
            exactLimited &&
            ' Exact board changes are available only from the recorded-history boundary.'}
          {!isLoading &&
            !error &&
            runsLimited &&
            ' Recorded run history for this project starts inside the selected period.'}
          {!isLoading &&
            !error &&
            data &&
            data.events.length === 0 &&
            data.runs.length === 0 &&
            ' No recorded activity in this period.'}
        </div>
      )}
    </div>
  );
}
