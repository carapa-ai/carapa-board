/**
 * Unit tests for stages.ts
 *
 * All pure functions — no DB or I/O required.
 */

import { describe, test, expect } from 'bun:test';
import {
  DEFAULT_STAGES,
  addedGatedSkipStages,
  getActiveProjectStages,
  getDoneStage,
  getInitialStage,
  getFirstExecutableStage,
  getNextActiveStage,
  getGroupStages,
  getProjectStages,
  getStageAlternatives,
  listVariantSuffixes,
  resolveStageForTask,
  isActiveStage,
  isReviewStage,
  isTestingStage,
  validateCoStages,
  validateStages,
} from './stages.js';
import { resolveCoReviewStages } from './task/review-chain.js';
import type { StageDefinition } from './types.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Minimal valid 3-stage set (queue → active → done). */
const MINIMAL: StageDefinition[] = [
  { id: 'todo', title: 'To Do', type: 'queue', color: '#888' },
  { id: 'doing', title: 'Doing', type: 'active', color: '#33f' },
  { id: 'done', title: 'Done', type: 'done', color: '#3f3' },
];

/** Stages with a review step. */
const WITH_REVIEW: StageDefinition[] = [
  { id: 'todo', title: 'To Do', type: 'queue', color: '#888' },
  { id: 'doing', title: 'Doing', type: 'active', color: '#33f' },
  { id: 'review', title: 'Review', type: 'review', color: '#f80' },
  { id: 'done', title: 'Done', type: 'done', color: '#3f3' },
];

const WITH_TESTING: StageDefinition[] = [
  { id: 'todo', title: 'To Do', type: 'queue', color: '#888' },
  { id: 'doing', title: 'Doing', type: 'active', color: '#33f' },
  { id: 'testing', title: 'Testing', type: 'testing', color: '#a3f' },
  { id: 'review', title: 'Review', type: 'review', color: '#f80' },
  { id: 'done', title: 'Done', type: 'done', color: '#3f3' },
];

// ─── DEFAULT_STAGES ───────────────────────────────────────────────────────────

describe('DEFAULT_STAGES', () => {
  test('passes validateStages', () => {
    expect(validateStages(DEFAULT_STAGES)).toBeNull();
  });
});

describe('getGroupStages', () => {
  const parent = {
    name: 'Parent',
    folder: 'parent',
    trigger: '@Capa',
    added_at: 'now',
    settings: { stages: WITH_REVIEW },
  };

  test('inherits parent stages when the child has no local override', () => {
    const child = {
      name: 'Child',
      folder: 'child',
      parentId: 'parent',
      trigger: '@Capa',
      added_at: 'now',
      settings: {},
    };
    expect(
      getGroupStages(child, (folder) =>
        folder === 'parent' ? parent : undefined,
      ),
    ).toEqual(WITH_REVIEW);
  });

  test('prefers a child stage override and resets to inheritance with an empty list', () => {
    const lookup = (folder: string) =>
      folder === 'parent' ? parent : undefined;
    expect(
      getGroupStages(
        {
          name: 'Child',
          folder: 'child',
          parentId: 'parent',
          trigger: '@Capa',
          added_at: 'now',
          settings: { stages: MINIMAL },
        },
        lookup,
      ),
    ).toEqual(MINIMAL);
    expect(
      getGroupStages(
        {
          name: 'Child',
          folder: 'child',
          parentId: 'parent',
          trigger: '@Capa',
          added_at: 'now',
          settings: { stages: [] },
        },
        lookup,
      ),
    ).toEqual(WITH_REVIEW);
  });
});

// ─── getActiveProjectStages ───────────────────────────────────────────────────

describe('getActiveProjectStages', () => {
  test('excludes stages marked inactive', () => {
    const stages: StageDefinition[] = [
      ...MINIMAL,
      {
        id: 'hidden',
        title: 'Hidden',
        type: 'queue',
        color: '#ccc',
        inactive: true,
      },
    ];
    const active = getActiveProjectStages({ stages });
    expect(active.some((s) => s.id === 'hidden')).toBe(false);
    expect(active).toHaveLength(3);
  });
});

// ─── isActiveStage ────────────────────────────────────────────────────────────

describe('isActiveStage', () => {
  test('returns true for an active-type stage', () => {
    expect(isActiveStage(MINIMAL, 'doing')).toBe(true);
  });

  test('returns true for a review-type stage', () => {
    expect(isActiveStage(WITH_REVIEW, 'review')).toBe(true);
  });

  test('returns false when the active stage is marked inactive', () => {
    const stages: StageDefinition[] = [
      ...MINIMAL,
      { id: 'ci', title: 'CI', type: 'active', color: '#09f', inactive: true },
    ];
    expect(isActiveStage(stages, 'ci')).toBe(false);
  });
});

// ─── isReviewStage ────────────────────────────────────────────────────────────

describe('isReviewStage', () => {
  test('returns true for a review-type stage', () => {
    expect(isReviewStage(WITH_REVIEW, 'review')).toBe(true);
  });

  test('returns false for an inactive review stage', () => {
    const stages: StageDefinition[] = [
      ...MINIMAL,
      {
        id: 'review',
        title: 'Review',
        type: 'review',
        color: '#f80',
        inactive: true,
      },
    ];
    expect(isReviewStage(stages, 'review')).toBe(false);
  });
});

// ─── getDoneStage ─────────────────────────────────────────────────────────────

describe('getDoneStage', () => {
  test('skips inactive done stages and returns the first active one', () => {
    const stages: StageDefinition[] = [
      { id: 'todo', title: 'To Do', type: 'queue', color: '#888' },
      { id: 'doing', title: 'Doing', type: 'active', color: '#33f' },
      {
        id: 'archived',
        title: 'Archived',
        type: 'done',
        color: '#aaa',
        inactive: true,
      },
      { id: 'done', title: 'Done', type: 'done', color: '#3f3' },
    ];
    expect(getDoneStage(stages)?.id).toBe('done');
  });

  test('returns undefined when all done stages are inactive', () => {
    const stages: StageDefinition[] = [
      { id: 'todo', title: 'To Do', type: 'queue', color: '#888' },
      { id: 'doing', title: 'Doing', type: 'active', color: '#33f' },
      {
        id: 'done',
        title: 'Done',
        type: 'done',
        color: '#3f3',
        inactive: true,
      },
    ];
    expect(getDoneStage(stages)).toBeUndefined();
  });
});

// ─── getInitialStage ──────────────────────────────────────────────────────────

describe('getInitialStage', () => {
  test('skips inactive queue stages', () => {
    const stages: StageDefinition[] = [
      {
        id: 'hidden',
        title: 'Hidden',
        type: 'queue',
        color: '#ccc',
        inactive: true,
      },
      { id: 'todo', title: 'To Do', type: 'queue', color: '#888' },
      { id: 'doing', title: 'Doing', type: 'active', color: '#33f' },
      { id: 'done', title: 'Done', type: 'done', color: '#3f3' },
    ];
    expect(getInitialStage(stages)!.id).toBe('todo');
  });

  test('falls back to first non-inactive stage when no queue stage is active', () => {
    const stages: StageDefinition[] = [
      {
        id: 'todo',
        title: 'To Do',
        type: 'queue',
        color: '#888',
        inactive: true,
      },
      { id: 'doing', title: 'Doing', type: 'active', color: '#33f' },
      { id: 'done', title: 'Done', type: 'done', color: '#3f3' },
    ];
    expect(getInitialStage(stages)!.id).toBe('doing');
  });
});

describe('getFirstExecutableStage', () => {
  test('does not fall back to a queue stage when no executable stage exists', () => {
    expect(
      getFirstExecutableStage([
        { id: 'todo', title: 'To Do', type: 'queue', color: '#888' },
        { id: 'done', title: 'Done', type: 'done', color: '#888' },
      ]),
    ).toBeUndefined();
  });

  test('skips inactive active stages', () => {
    expect(
      getFirstExecutableStage([
        {
          id: 'blocked',
          title: 'Blocked',
          type: 'active',
          color: '#888',
          inactive: true,
        },
        { id: 'doing', title: 'Doing', type: 'active', color: '#888' },
      ])?.id,
    ).toBe('doing');
  });
});

// ─── getNextActiveStage ───────────────────────────────────────────────────────

describe('getNextActiveStage', () => {
  test('returns the next active stage after a queue stage', () => {
    expect(getNextActiveStage(MINIMAL, 'todo')?.id).toBe('doing');
  });

  test('includes testing in executable forward progression', () => {
    expect(getNextActiveStage(WITH_TESTING, 'doing')?.id).toBe('testing');
    expect(getNextActiveStage(WITH_TESTING, 'testing')?.id).toBe('review');
    expect(isActiveStage(WITH_TESTING, 'testing')).toBe(true);
    expect(isTestingStage(WITH_TESTING, 'testing')).toBe(true);
  });

  test('returns undefined when there is no active stage after the current', () => {
    expect(getNextActiveStage(MINIMAL, 'doing')).toBeUndefined();
  });

  test('skips inactive stages when finding next active', () => {
    const stages: StageDefinition[] = [
      { id: 'todo', title: 'To Do', type: 'queue', color: '#888' },
      { id: 'ci', title: 'CI', type: 'active', color: '#09f', inactive: true },
      { id: 'doing', title: 'Doing', type: 'active', color: '#33f' },
      { id: 'done', title: 'Done', type: 'done', color: '#3f3' },
    ];
    expect(getNextActiveStage(stages, 'todo')?.id).toBe('doing');
  });
});

// ─── getNextActiveStage with skip_stages ────────────────────────────────────
//
// `skip_stages` is the per-task override that lets a task skip past named
// stages during forward auto-advance. Tested here in isolation (no DB / no
// project lookups); the caller (pipeline.ts) is responsible for fetching
// `task.skip_stages` and passing it through.

describe('getNextActiveStage with skip_stages', () => {
  const STAGES: StageDefinition[] = [
    { id: 'todo', title: 'To Do', type: 'queue', color: '#888' },
    { id: 'doing', title: 'Doing', type: 'active', color: '#33f' },
    { id: 'testing', title: 'Testing', type: 'active', color: '#09f' },
    { id: 'review', title: 'Review', type: 'review', color: '#f80' },
    { id: 'done', title: 'Done', type: 'done', color: '#3f3' },
  ];

  test('skips a single stage listed in skip_stages', () => {
    expect(getNextActiveStage(STAGES, 'doing', ['testing'])?.id).toBe('review');
  });

  test('skips multiple stages listed in skip_stages', () => {
    // From 'doing', skipping testing + review → no remaining active/review
    // stage → undefined (caller falls back to done).
    expect(
      getNextActiveStage(STAGES, 'doing', ['testing', 'review']),
    ).toBeUndefined();
  });

  test('does not skip inactive or non-active/review stages', () => {
    // 'done' is type=done (not active/review) — must not be matched even if
    // listed. 'todo' is type=queue. Only the active/review stages are
    // considered for skipping here.
    expect(getNextActiveStage(STAGES, 'doing', ['done', 'todo'])?.id).toBe(
      'testing',
    );
  });
});

// ─── validateStages ───────────────────────────────────────────────────────────

describe('validateStages', () => {
  test('returns null for a valid set of stages', () => {
    expect(validateStages(MINIMAL)).toBeNull();
  });

  test('rejects an empty array', () => {
    expect(validateStages([])).toMatch(/required/i);
  });

  test('rejects duplicate stage IDs', () => {
    const stages: StageDefinition[] = [
      ...MINIMAL,
      { id: 'todo', title: 'Duplicate', type: 'queue', color: '#000' },
    ];
    expect(validateStages(stages)).toMatch(/unique/i);
  });

  test('rejects a stage ID that contains spaces or uppercase letters', () => {
    const stages: StageDefinition[] = [
      {
        id: 'In Progress',
        title: 'In Progress',
        type: 'active',
        color: '#33f',
      },
      { id: 'todo', title: 'To Do', type: 'queue', color: '#888' },
      { id: 'done', title: 'Done', type: 'done', color: '#3f3' },
    ];
    expect(validateStages(stages)).toMatch(/lowercase/i);
  });

  test('rejects a stage without a title', () => {
    const stages: StageDefinition[] = [
      { id: 'todo', title: '', type: 'queue', color: '#888' },
      { id: 'doing', title: 'Doing', type: 'active', color: '#33f' },
      { id: 'done', title: 'Done', type: 'done', color: '#3f3' },
    ];
    expect(validateStages(stages)).toMatch(/title/i);
  });

  test('rejects an invalid stage type', () => {
    const stages = [
      { id: 'todo', title: 'To Do', type: 'queue' as const, color: '#888' },
      {
        id: 'doing',
        title: 'Doing',
        type: 'superactive' as any,
        color: '#33f',
      },
      { id: 'done', title: 'Done', type: 'done' as const, color: '#3f3' },
    ];
    expect(validateStages(stages)).toMatch(/invalid/i);
  });

  test('rejects more than one active review stage', () => {
    const stages: StageDefinition[] = [
      { id: 'todo', title: 'To Do', type: 'queue', color: '#888' },
      { id: 'doing', title: 'Doing', type: 'active', color: '#33f' },
      { id: 'r1', title: 'Review 1', type: 'review', color: '#f80' },
      { id: 'r2', title: 'Review 2', type: 'review', color: '#f40' },
      { id: 'done', title: 'Done', type: 'done', color: '#3f3' },
    ];
    expect(validateStages(stages)).toMatch(/review/i);
  });

  test('allows a second review stage if it is inactive', () => {
    const stages: StageDefinition[] = [
      { id: 'todo', title: 'To Do', type: 'queue', color: '#888' },
      { id: 'doing', title: 'Doing', type: 'active', color: '#33f' },
      { id: 'r1', title: 'Review 1', type: 'review', color: '#f80' },
      {
        id: 'r2',
        title: 'Review 2',
        type: 'review',
        color: '#f40',
        inactive: true,
      },
      { id: 'done', title: 'Done', type: 'done', color: '#3f3' },
    ];
    expect(validateStages(stages)).toBeNull();
  });

  test('fails when only inactive queue stages remain', () => {
    const stages: StageDefinition[] = [
      {
        id: 'todo',
        title: 'To Do',
        type: 'queue',
        color: '#888',
        inactive: true,
      },
      { id: 'doing', title: 'Doing', type: 'active', color: '#33f' },
      { id: 'done', title: 'Done', type: 'done', color: '#3f3' },
    ];
    expect(validateStages(stages)).toMatch(/queue/i);
  });

  test('fails when only inactive done stages remain', () => {
    const stages: StageDefinition[] = [
      { id: 'todo', title: 'To Do', type: 'queue', color: '#888' },
      { id: 'doing', title: 'Doing', type: 'active', color: '#33f' },
      {
        id: 'done',
        title: 'Done',
        type: 'done',
        color: '#3f3',
        inactive: true,
      },
    ];
    expect(validateStages(stages)).toMatch(/done/i);
  });

  test('returns null for DEFAULT_STAGES', () => {
    expect(validateStages(DEFAULT_STAGES)).toBeNull();
  });

  test('rejects an active done-type Question stage', () => {
    const stages: StageDefinition[] = [
      { id: 'todo', title: 'To Do', type: 'queue', color: '#888' },
      { id: 'question', title: 'Question', type: 'done', color: '#f80' },
      { id: 'done', title: 'Done', type: 'done', color: '#3f3' },
    ];
    expect(validateStages(stages)).toMatch(/must be a queue stage/);
  });

  test('rejects an active active-type Question stage', () => {
    const stages: StageDefinition[] = [
      { id: 'todo', title: 'To Do', type: 'queue', color: '#888' },
      { id: 'question', title: 'Question', type: 'active', color: '#f80' },
      { id: 'done', title: 'Done', type: 'done', color: '#3f3' },
    ];
    expect(validateStages(stages)).toMatch(/must be a queue stage/);
  });

  test('accepts an active queue-type Question stage', () => {
    const stages: StageDefinition[] = [
      { id: 'todo', title: 'To Do', type: 'queue', color: '#888' },
      { id: 'question', title: 'Question', type: 'queue', color: '#f80' },
      { id: 'done', title: 'Done', type: 'done', color: '#3f3' },
    ];
    expect(validateStages(stages)).toBeNull();
  });

  test('accepts an inactive done-type Question stage', () => {
    const stages: StageDefinition[] = [
      { id: 'todo', title: 'To Do', type: 'queue', color: '#888' },
      {
        id: 'question',
        title: 'Question',
        type: 'done',
        color: '#f80',
        inactive: true,
      },
      { id: 'done', title: 'Done', type: 'done', color: '#3f3' },
    ];
    expect(validateStages(stages)).toBeNull();
  });

  test('rejects a stage whose title is Question with a non-queue type', () => {
    const stages: StageDefinition[] = [
      { id: 'todo', title: 'To Do', type: 'queue', color: '#888' },
      { id: 'ask_user', title: 'Question', type: 'done', color: '#f80' },
      { id: 'done', title: 'Done', type: 'done', color: '#3f3' },
    ];
    expect(validateStages(stages)).toMatch(/must be a queue stage/);
  });

  test('skips the Question-type rule with checkQuestionType: false', () => {
    const stages: StageDefinition[] = [
      { id: 'todo', title: 'To Do', type: 'queue', color: '#888' },
      { id: 'question', title: 'Question', type: 'done', color: '#f80' },
      { id: 'done', title: 'Done', type: 'done', color: '#3f3' },
    ];
    expect(validateStages(stages, { checkQuestionType: false })).toBeNull();
  });
});

describe('addedGatedSkipStages', () => {
  test('returns only newly added review/testing IDs; ignores unknown and active IDs', () => {
    expect(
      addedGatedSkipStages(
        WITH_TESTING,
        ['review'],
        ['review', 'testing', 'doing', 'ghost'],
      ),
    ).toEqual(['testing']);
    expect(addedGatedSkipStages(WITH_TESTING, null, ['review'])).toEqual([
      'review',
    ]);
    expect(addedGatedSkipStages(WITH_TESTING, ['review'], null)).toEqual([]);
    expect(addedGatedSkipStages(WITH_TESTING, ['review'], [])).toEqual([]);
  });
});

describe('stage alternatives', () => {
  const BASE_STAGES: StageDefinition[] = [
    { id: 'backlog', title: 'Backlog', type: 'queue', color: '#888' },
    {
      id: 'coding',
      title: 'Coding',
      type: 'active',
      color: '#38f',
      runtimeSelection: { harnessId: 'codex', modelId: 'a-model' },
      workerSandbox: 'base-box',
    },
    { id: 'testing', title: 'Testing', type: 'testing', color: '#fa0' },
    { id: 'done', title: 'Done', type: 'done', color: '#2c5' },
  ];
  const codingB: StageDefinition = {
    id: 'coding.b',
    title: 'Coding B',
    type: 'active',
    color: '#f38',
    runtimeSelection: { harnessId: 'claude', modelId: 'b-model' },
    workerSandbox: 'b-box',
    record: true,
  };
  const group = (stages: StageDefinition[]) => ({
    name: 'Project',
    folder: 'project',
    trigger: '@Capa',
    added_at: 'now',
    settings: { stages },
  });

  test('validateStages accepts an alternative of an active, testing or review base', () => {
    expect(validateStages([...BASE_STAGES, codingB])).toBeNull();
    expect(
      validateStages([
        ...BASE_STAGES,
        { ...codingB, id: 'testing.c', title: '', color: '' },
      ]),
    ).toBeNull();
  });

  test('validateStages rejects malformed, reserved and misplaced alternatives', () => {
    expect(
      validateStages([...BASE_STAGES, { ...codingB, id: 'coding.a' }]),
    ).toContain('reserved');
    for (const id of ['coding.b.c', 'coding..b', 'coding.', 'coding.Bb']) {
      expect(validateStages([...BASE_STAGES, { ...codingB, id }])).toContain(
        'must be',
      );
    }
    expect(
      validateStages([...BASE_STAGES, { ...codingB, id: 'backlog.b' }]),
    ).toContain('active, testing or review base');
    expect(
      validateStages([...BASE_STAGES, { ...codingB, id: 'review.b' }]),
    ).toContain('needs its base stage');
  });

  test('alternatives are not columns, queue, done or review stages', () => {
    const stages = [...BASE_STAGES, codingB];
    expect(getGroupStages(group(stages) as never).map((s) => s.id)).toEqual([
      'backlog',
      'coding',
      'testing',
      'done',
    ]);
    expect(getProjectStages({ stages }).map((s) => s.id)).not.toContain(
      'coding.b',
    );
    expect(getStageAlternatives(group(stages) as never)).toEqual([codingB]);
    expect(listVariantSuffixes(group(stages) as never)).toEqual(['b']);
  });

  test('validateCoStages keeps review/testing alternatives in order and rejects the rest', () => {
    const stages: StageDefinition[] = [
      ...BASE_STAGES,
      { id: 'review', title: 'Review', type: 'review', color: '#a4f' },
      { id: 'review.o', title: 'Review O', type: 'review', color: '#a4f' },
      { id: 'testing.u', title: 'Testing U', type: 'testing', color: '#fa0' },
      codingB,
    ];
    const g = group(stages) as never;
    expect(validateCoStages(g, ['testing.u', 'review.o', 'testing.u'])).toEqual(
      {
        valid: true,
        coStages: ['testing.u', 'review.o'],
      },
    );
    expect(validateCoStages(g, [])).toEqual({ valid: true, coStages: null });
    expect(validateCoStages(g, null)).toEqual({ valid: true, coStages: null });
    for (const invalid of [
      ['review.zz'],
      ['coding.b'],
      ['review'],
      'review.o',
    ]) {
      expect(validateCoStages(g, invalid).valid).toBe(false);
    }
  });

  test('a card whose variant replaces the review stage ignores its co_stages', () => {
    const stages: StageDefinition[] = [
      ...BASE_STAGES,
      { id: 'review', title: 'Review', type: 'review', color: '#a4f' },
      { id: 'review.b', title: 'Review B', type: 'review', color: '#a4f' },
      { id: 'review.o', title: 'Review O', type: 'review', color: '#a4f' },
    ];
    const g = group(stages) as never;
    const coStages = ['review.o'];
    expect(
      resolveCoReviewStages(g, { coStages, stageVariant: null }, 'review'),
    ).toEqual(['review.o']);
    expect(
      resolveCoReviewStages(g, { coStages, stageVariant: 'b' }, 'review'),
    ).toEqual([]);
    // A variant without a review alternative still runs the co-reviewers.
    expect(
      resolveCoReviewStages(g, { coStages, stageVariant: 'c' }, 'review'),
    ).toEqual(['review.o']);
  });

  test('listVariantSuffixes returns the sorted union of suffixes', () => {
    const stages = [...BASE_STAGES, { ...codingB, id: 'testing.c' }, codingB];
    expect(listVariantSuffixes(group(stages) as never)).toEqual(['b', 'c']);
    expect(listVariantSuffixes(group(BASE_STAGES) as never)).toEqual([]);
  });

  test('resolveStageForTask overrides only run config and keeps the base identity', () => {
    const stages = [...BASE_STAGES, codingB];
    const resolved = resolveStageForTask(group(stages) as never, 'coding', 'b');
    expect(resolved).toMatchObject({
      id: 'coding',
      title: 'Coding',
      type: 'active',
      color: '#38f',
      runtimeSelection: { harnessId: 'claude', modelId: 'b-model' },
      workerSandbox: 'b-box',
      record: true,
    });
    expect(resolveStageForTask(group(stages) as never, 'coding', null)).toEqual(
      BASE_STAGES[1],
    );
  });

  test('resolveStageForTask falls back to the base stage when no alternative exists', () => {
    const stages = [...BASE_STAGES, codingB];
    expect(resolveStageForTask(group(stages) as never, 'testing', 'b')).toEqual(
      BASE_STAGES[2],
    );
    expect(
      resolveStageForTask(group(stages) as never, 'missing', 'b'),
    ).toBeUndefined();
  });
});
