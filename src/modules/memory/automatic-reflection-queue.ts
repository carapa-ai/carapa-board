import {
  canStartBackgroundWork,
  onBackgroundWorkResumed,
} from '../../lib/background-work-gate.js';

export interface AutomaticReflectionJob {
  sourceKey: string;
  /** Identity of the work; a job whose key is already queued or running is dropped. */
  jobKey?: string;
  process: () => Promise<unknown>;
  onIncomplete?: (error?: unknown) => void;
}

interface AutomaticReflectionQueueState {
  jobs: AutomaticReflectionJob[];
  running: boolean;
  retryTimer?: ReturnType<typeof setTimeout>;
  rateLimitAttempts: number;
}

export function isIncompleteAutomaticReflection(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    'completed' in result &&
    result.completed === false
  );
}

export function isRateLimitedAutomaticReflection(value: unknown): boolean {
  if (typeof value === 'object' && value !== null) {
    const status = (value as { status?: unknown }).status;
    if (status === 429) return true;
  }
  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? '';
    } catch {
      text = String(value);
    }
  }
  return /\b429\b|rate[\s_-]*limit|server[\s_-]*overloaded|too many requests/i.test(
    text,
  );
}

/**
 * Serializes bounded automatic transcript ranges per source. Incomplete work
 * remains at the head of its queue so a later range cannot overtake it.
 */
export class AutomaticReflectionQueue {
  private readonly states = new Map<string, AutomaticReflectionQueueState>();
  private runningCount = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly retryDelayMs: number,
    private readonly maxConcurrent = 1,
    private readonly rateLimitBaseMs = 15_000,
    private readonly rateLimitMaxMs = 5 * 60 * 1000,
    private readonly random = Math.random,
    private readonly scheduleRetry: (
      callback: () => void,
      delayMs: number,
    ) => ReturnType<typeof setTimeout> = setTimeout,
  ) {}

  /**
   * Queue a job behind its source's earlier ranges. A source parked behind a
   * retry timer stays parked, so new work never bypasses retry backoff.
   * `retryNow` is for a caller that knows the parked failure's cause has
   * cleared (e.g. a foreign lease expired): it cancels the timer so the head
   * job is retried immediately. Returns `false` when a job with the same
   * `jobKey` is already queued or running in any source, so nothing was added.
   */
  enqueue(
    job: AutomaticReflectionJob,
    options: { retryNow?: boolean } = {},
  ): boolean {
    if (job.jobKey !== undefined && this.hasJobKey(job.jobKey)) return false;
    const state = this.states.get(job.sourceKey) ?? {
      jobs: [],
      running: false,
      rateLimitAttempts: 0,
    };
    state.jobs.push(job);
    this.states.set(job.sourceKey, state);

    if (options.retryNow && state.retryTimer) {
      clearTimeout(state.retryTimer);
      state.retryTimer = undefined;
    }
    this.startAvailable();
    return true;
  }

  private hasJobKey(jobKey: string): boolean {
    for (const state of this.states.values()) {
      if (state.jobs.some((queued) => queued.jobKey === jobKey)) return true;
    }
    return false;
  }

  /**
   * Resolves once no job is running and no work remains queued. Work parked
   * behind a retry timer is not idle, so this never resolves early for it.
   */
  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private isIdle(): boolean {
    return this.runningCount === 0 && this.states.size === 0;
  }

  /** Restart parked jobs after the background-work gate reopens. */
  resume(): void {
    this.startAvailable();
  }

  private startAvailable(): void {
    // Paused: leave jobs queued; `resume()` starts them again.
    if (!canStartBackgroundWork()) return;
    if (this.runningCount >= this.maxConcurrent) return;

    for (const [sourceKey, state] of this.states) {
      if (this.runningCount >= this.maxConcurrent) break;
      if (state.running || state.retryTimer || state.jobs.length === 0) {
        continue;
      }
      void this.drain(sourceKey, state);
    }
  }

  private async drain(
    sourceKey: string,
    state: AutomaticReflectionQueueState,
  ): Promise<void> {
    if (state.running || this.runningCount >= this.maxConcurrent) return;
    state.running = true;
    this.runningCount++;
    let needsRetry = false;
    let rateLimited = false;

    try {
      // Stop at the next job boundary while paused; the job stays queued.
      while (state.jobs.length > 0 && canStartBackgroundWork()) {
        const job = state.jobs[0]!;
        try {
          const result = await job.process();
          if (isIncompleteAutomaticReflection(result)) {
            rateLimited = isRateLimitedAutomaticReflection(result);
            job.onIncomplete?.(result);
            needsRetry = true;
            break;
          }
          state.jobs.shift();
          state.rateLimitAttempts = 0;
        } catch (error) {
          rateLimited = isRateLimitedAutomaticReflection(error);
          job.onIncomplete?.(error);
          needsRetry = true;
          break;
        }
      }
    } finally {
      state.running = false;
      this.runningCount--;
      if (state.jobs.length === 0) {
        this.states.delete(sourceKey);
      } else if (needsRetry) {
        const delayMs = rateLimited
          ? this.rateLimitBackoffMs(state)
          : this.retryDelayMs;
        state.retryTimer = this.scheduleRetry(() => {
          state.retryTimer = undefined;
          this.startAvailable();
        }, delayMs);
        state.retryTimer.unref?.();
      }
      this.startAvailable();
      if (this.isIdle()) {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const resolve of waiters) resolve();
      }
    }
  }

  private rateLimitBackoffMs(state: AutomaticReflectionQueueState): number {
    state.rateLimitAttempts++;
    const exponential = Math.min(
      this.rateLimitMaxMs,
      this.rateLimitBaseMs * 2 ** Math.min(state.rateLimitAttempts - 1, 30),
    );
    const jitter = Math.floor(exponential * 0.25 * this.random());
    return Math.min(this.rateLimitMaxMs, exponential + jitter);
  }
}

export const automaticTranscriptReflectionQueue = new AutomaticReflectionQueue(
  5 * 60 * 1000,
);
onBackgroundWorkResumed(() => automaticTranscriptReflectionQueue.resume());
