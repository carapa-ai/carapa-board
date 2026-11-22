/**
 * Serial multi-tester chain for a testing stage.
 *
 * A task with `co_stages` testing entries (e.g. `testing.u`) is tested by the
 * stage's own runtime first and then by each entry, one run at a time, all on
 * the same commit and tree. Unlike the review chain it short-circuits: only a
 * `pass` continues the chain, because a failure or block is objective and would
 * repeat. The chain exists in `custom_values.testing_chain` only while extra
 * testers remain; the card advances after the last tester passed.
 */
import type { RegisteredGroup } from '../../../types.js';
import type { Task } from '../types.js';
import { resolveCoStages } from '../stages.js';

export const TESTING_CHAIN_KEY = 'testing_chain';
/** Verdict of every tester that ran, kept next to the testing evidence. */
export const TESTING_VERDICTS_KEY = 'testing_verdicts';

export interface TestingChainVerdict {
  /** Stage id that ran: the testing stage itself or a `<stage>.<suffix>` alternative. */
  stage_id: string;
  /** Model (or agent) label that tested. */
  tester: string;
  decision: 'pass' | 'fail' | 'blocked';
  summary: string;
  /** Runs whose output produced this verdict, so a replayed run is not credited twice. */
  run_ids: string[];
}

export interface TestingChain {
  /** Commit and tree every tester of this chain must test. */
  head: string;
  tree: string;
  /** When the primary run began; extra testers see only older history. */
  started_at: string;
  /**
   * Latest run of the task when the chain was last written (or the extra
   * tester's run once it started). The chain continues only while that is still
   * the task's latest run; a coding run in between abandons the round.
   */
  after_run_id: string;
  /** Extra tester stage ids, in run order, frozen when the chain started. */
  stages: string[];
  /** One passing verdict per finished run: the primary first, then each extra. */
  verdicts: TestingChainVerdict[];
}

/** The testing role this run plays: the stage's own runtime or an extra tester. */
export type TestingChainPlan =
  | { role: 'primary'; stages: string[] }
  | { role: 'extra'; stages: string[]; stageId: string; chain: TestingChain };

/** Testing alternatives of `task.coStages` that run after `testingStageId`'s own runtime. */
export function resolveCoTestingStages(
  group: RegisteredGroup,
  task: Pick<Task, 'coStages' | 'stageVariant'>,
  testingStageId: string,
): string[] {
  return resolveCoStages(group, task, testingStageId, 'testing');
}

export function readTestingChain(
  customValues?: Record<string, string | number>,
): TestingChain | null {
  const raw = customValues?.[TESTING_CHAIN_KEY];
  if (typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw);
    if (
      value &&
      typeof value.head === 'string' &&
      typeof value.tree === 'string' &&
      typeof value.started_at === 'string' &&
      typeof value.after_run_id === 'string' &&
      Array.isArray(value.stages) &&
      Array.isArray(value.verdicts) &&
      value.verdicts.length > 0 &&
      value.verdicts.length <= value.stages.length
    ) {
      return value as TestingChain;
    }
  } catch {
    // A malformed or cleared chain is absent: testing starts over.
  }
  return null;
}

/** Stage id of the next extra tester of a stored chain. */
export function nextTestingChainStage(chain: TestingChain): string {
  return chain.stages[chain.verdicts.length - 1];
}

/**
 * Decide this run's role. A stored chain continues only directly after its own
 * last run (`restart` false); anything else begins a new chain with the
 * stage's own runtime.
 */
export function planTestingChain(
  coTestingStages: string[],
  chain: TestingChain | null,
  restart: boolean,
): TestingChainPlan | undefined {
  if (!restart && chain) {
    return {
      role: 'extra',
      stages: chain.stages,
      stageId: nextTestingChainStage(chain),
      chain,
    };
  }
  return coTestingStages.length > 0
    ? { role: 'primary', stages: coTestingStages }
    : undefined;
}

/** Whether `task` is tested by a chain at `testingStageId` (extra testers stored or configured). */
export function hasTestingChain(
  group: RegisteredGroup,
  task: Task,
  testingStageId: string,
): boolean {
  return (
    readTestingChain(task.custom_values) !== null ||
    resolveCoTestingStages(group, task, testingStageId).length > 0
  );
}

/**
 * Whether `runId` already produced a recorded verdict (in the running chain or
 * the last finished one). Restart recovery can replay a run whose verdict was
 * applied just before the crash; applying it again would credit the same run
 * to the next tester.
 */
export function testingRunAlreadyApplied(
  customValues: Record<string, string | number> | undefined,
  runId: string | undefined,
): boolean {
  if (!runId) return false;
  const recorded: TestingChainVerdict[] = [
    ...(readTestingChain(customValues)?.verdicts ?? []),
  ];
  try {
    const raw = customValues?.[TESTING_VERDICTS_KEY];
    const finished = typeof raw === 'string' && raw ? JSON.parse(raw) : [];
    if (Array.isArray(finished)) recorded.push(...finished);
  } catch {
    // An unreadable record attributes nothing.
  }
  return recorded.some((verdict) => verdict?.run_ids?.includes(runId));
}
