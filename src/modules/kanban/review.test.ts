/**
 * Tests for src/lib/review.ts — parseReviewDecision.
 */

import { describe, test, expect } from 'bun:test';
import {
  parseReviewDecision,
  appendReviewVerdictFormatBlock,
  buildReviewFormatRepairPrompt,
  parseReviewDecisionWithRepair,
  parseReviewComparison,
  buildReviewReworkPrompt,
  buildReviewGitContextBlock,
  readReviewHistory,
  shouldStartFreshReviewSession,
  MAX_REVIEW_FORMAT_RETRIES,
  type ReviewHistoryEntry,
} from './review.js';

// ─── parseReviewDecision ─────────────────────────────────────────────────────

describe('parseReviewDecision', () => {
  function makeOutput(json: object): string {
    return '```json\n' + JSON.stringify(json) + '\n```';
  }

  test('returns null for malformed JSON in fence', () => {
    expect(parseReviewDecision('```json\n{broken\n```')).toBeNull();
  });

  test('returns null when decision is not approve/reject', () => {
    const out = makeOutput({ decision: 'maybe', score: 7 });
    expect(parseReviewDecision(out)).toBeNull();
  });

  test('returns null when score is not a number', () => {
    const out = makeOutput({ decision: 'approve', score: 'high' });
    expect(parseReviewDecision(out)).toBeNull();
  });

  test('parses a valid approve decision with canonical issues', () => {
    const payload = {
      decision: 'approve',
      score: 9,
      issues: [{ title: 'Fix typo', description: 'Correct line 5' }],
      summary: 'Looks good',
    };
    const result = parseReviewDecision(makeOutput(payload));
    expect(result).not.toBeNull();
    expect(result).toEqual({
      decision: 'approve',
      score: 9,
      issues: [{ title: 'Fix typo', description: 'Correct line 5' }],
      summary: 'Looks good',
    });
  });

  test('normalizes legacy minor_issues into issues', () => {
    const payload = {
      decision: 'approve',
      score: 8,
      issues: [],
      minor_issues: [
        { title: 'Fix typo', description: 'Line 5' },
        { notATitle: 'ignored' },
        null,
        'Legacy string finding',
      ],
      summary: '',
    };
    const result = parseReviewDecision(makeOutput(payload));
    expect(result!.issues).toEqual([
      { title: 'Fix typo', description: 'Line 5' },
      { title: 'Legacy string finding', description: '' },
    ]);
  });

  test('allows a clean approval to omit issues', () => {
    const payload = { decision: 'approve', score: 5, summary: 'ok' };
    const result = parseReviewDecision(makeOutput(payload));
    expect(result).toEqual({
      decision: 'approve',
      score: 5,
      issues: [],
      summary: 'ok',
    });
  });

  test('rejects a non-empty issues array with no actionable finding', () => {
    const output = makeOutput({
      decision: 'approve',
      score: 6,
      issues: [{ description: 'Missing a title' }, '   '],
      summary: 'Has malformed findings',
    });
    expect(parseReviewDecision(output)).toBeNull();
  });

  test('uses the LAST json fence when multiple are present', () => {
    const first = makeOutput({
      decision: 'reject',
      score: 2,
      issues: [{ title: 'Fix first issue', description: 'First verdict' }],
      summary: 'first',
    });
    const second = makeOutput({
      decision: 'approve',
      score: 8,
      summary: 'second',
    });
    const result = parseReviewDecision(`${first}\n\nSome text\n\n${second}`);
    expect(result!.decision).toBe('approve');
    expect(result!.summary).toBe('second');
  });

  test('does not fall back to an earlier verdict when the final fence is invalid', () => {
    const earlierApproval = makeOutput({
      decision: 'approve',
      score: 9,
      summary: 'Earlier approval',
    });
    const finalRejection = makeOutput({
      decision: 'reject',
      score: 4,
      issues: [],
      summary: 'Final rejection needs an issue',
    });

    expect(
      parseReviewDecision(`${earlierApproval}\n${finalRejection}`),
    ).toBeNull();
  });

  test('keeps canonical structured issues and normalizes strings', () => {
    const payload = {
      decision: 'reject',
      score: 4,
      issues: [
        { title: 'Improve performance', description: 'The path is too slow' },
        'Add regression coverage',
      ],
      summary: '',
    };
    const result = parseReviewDecision(makeOutput(payload));
    expect(result!.issues).toEqual([
      { title: 'Improve performance', description: 'The path is too slow' },
      { title: 'Add regression coverage', description: '' },
    ]);
  });

  // ─── bare JSON (no code fence) ────────────────────────────────────────────

  test('parses a bare-JSON legacy reject decision (no code fence)', () => {
    const bare = `Here is my review:\n\n{\n  "decision": "reject",\n  "score": 1,\n  "issues": ["Implement the requested behavior"],\n  "summary": "No code landed"\n}`;
    const result = parseReviewDecision(bare);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe('reject');
    expect(result!.score).toBe(1);
    expect(result!.issues[0].title).toBe('Implement the requested behavior');
  });

  test('ignores non-decision braces and uses the trailing decision object', () => {
    const bare =
      'Some tool call output { "foo": "bar" } and notes.\n\n{ "decision": "reject", "score": 2, "issues": [{"title":"Fix trailing issue","description":"It remains broken"}], "summary": "bad" }';
    const result = parseReviewDecision(bare);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe('reject');
    expect(result!.summary).toBe('bad');
  });

  test('does not fall back to an earlier bare verdict when the final verdict is invalid', () => {
    const output = [
      '{"decision":"approve","score":9,"summary":"Earlier approval"}',
      '{"decision":"reject","score":4,"issues":[],"summary":"Final rejection"}',
      '{"tool":"completed"}',
    ].join('\n');

    expect(parseReviewDecision(output)).toBeNull();
  });

  test('handles bare JSON with nested braces in strings', () => {
    const bare =
      '{ "decision": "approve", "score": 8, "summary": "use {placeholder} syntax" }';
    const result = parseReviewDecision(bare);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe('approve');
    expect(result!.summary).toBe('use {placeholder} syntax');
  });

  test('prefers the fenced block over a bare object when both present', () => {
    const out =
      '{ "decision": "reject", "score": 1, "summary": "bare" }\n\n' +
      makeOutput({ decision: 'approve', score: 8, summary: 'fenced' });
    const result = parseReviewDecision(out);
    expect(result!.decision).toBe('approve');
    expect(result!.summary).toBe('fenced');
  });

  test('returns null when no parseable decision is present (prose only)', () => {
    expect(
      parseReviewDecision('I reviewed the code and it looks fine to me.'),
    ).toBeNull();
  });
});

describe('appendReviewVerdictFormatBlock', () => {
  test('ends the prompt with the schema shared with the repair prompt', () => {
    const prompt = appendReviewVerdictFormatBlock('Review task ABC.');
    const schema = prompt.slice(
      prompt.indexOf('{\n'),
      prompt.lastIndexOf('}') + 1,
    );

    expect(prompt.startsWith('Review task ABC.')).toBe(true);
    expect(prompt.trimEnd().endsWith('```')).toBe(true);
    expect(buildReviewFormatRepairPrompt('ctx', 'bad', 1)).toContain(schema);
  });
});

describe('parseReviewDecisionWithRepair', () => {
  test('does not request repair for an already valid verdict', async () => {
    let calls = 0;
    const valid =
      '{"decision":"approve","score":9,"issues":[],"summary":"Good"}';

    const result = await parseReviewDecisionWithRepair(
      valid,
      'task context',
      async () => {
        calls += 1;
        return '';
      },
    );

    expect(result.decision?.decision).toBe('approve');
    expect(result.repairAttempts).toBe(0);
    expect(calls).toBe(0);
  });

  test('repairs a rejection that omits actionable issues', async () => {
    const prompts: string[] = [];
    const result = await parseReviewDecisionWithRepair(
      '{"decision":"reject","score":4,"summary":"Needs work"}',
      'Review task ABC.',
      async (prompt) => {
        prompts.push(prompt);
        return '{"decision":"reject","score":4,"issues":[{"title":"Fix bug","description":"src/a.ts still returns the wrong value"}],"summary":"Needs work"}';
      },
    );

    expect(result.decision?.issues[0].title).toBe('Fix bug');
    expect(result.repairAttempts).toBe(1);
    expect(prompts[0]).toContain('Review task ABC.');
  });

  test('repairs an invalid final rejection instead of accepting an earlier approval', async () => {
    let calls = 0;
    const output = [
      '```json',
      '{"decision":"approve","score":9,"summary":"Earlier approval"}',
      '```',
      '```json',
      '{"decision":"reject","score":4,"issues":[],"summary":"Final rejection"}',
      '```',
    ].join('\n');

    const result = await parseReviewDecisionWithRepair(
      output,
      'Review task ABC.',
      async () => {
        calls += 1;
        return '{"decision":"reject","score":4,"issues":[{"title":"Fix final issue","description":"The final implementation remains incorrect"}],"summary":"Final rejection"}';
      },
    );

    expect(calls).toBe(1);
    expect(result.repairAttempts).toBe(1);
    expect(result.decision?.decision).toBe('reject');
    expect(result.decision?.issues[0].title).toBe('Fix final issue');
  });

  test('repairs an invalid final bare rejection instead of accepting an earlier approval', async () => {
    let calls = 0;
    const output = [
      '{"decision":"approve","score":9,"summary":"Earlier approval"}',
      '{"decision":"reject","score":4,"issues":[],"summary":"Final rejection"}',
    ].join('\n');

    const result = await parseReviewDecisionWithRepair(
      output,
      'Review task ABC.',
      async () => {
        calls += 1;
        return '{"decision":"reject","score":4,"issues":[{"title":"Fix bare issue","description":"The final bare verdict remains blocking"}],"summary":"Final rejection"}';
      },
    );

    expect(calls).toBe(1);
    expect(result.repairAttempts).toBe(1);
    expect(result.decision?.decision).toBe('reject');
    expect(result.decision?.issues[0].title).toBe('Fix bare issue');
  });

  test('returns the exact repair run that produced the accepted verdict', async () => {
    const result = await parseReviewDecisionWithRepair(
      'Malformed original response.',
      'task context',
      async () => ({
        output: '{"decision":"approve","score":8,"issues":[],"summary":"Good"}',
        runId: 'review-repair-run',
      }),
      MAX_REVIEW_FORMAT_RETRIES,
      'review-malformed-run',
    );

    expect(result.decision?.score).toBe(8);
    expect(result.runId).toBe('review-repair-run');
  });

  test('stops after the bounded number of repair attempts', async () => {
    let calls = 0;
    const result = await parseReviewDecisionWithRepair(
      '',
      'task context',
      async () => {
        calls += 1;
        return 'invalid';
      },
    );

    expect(result.decision).toBeNull();
    expect(result.repairAttempts).toBe(MAX_REVIEW_FORMAT_RETRIES);
    expect(calls).toBe(MAX_REVIEW_FORMAT_RETRIES);
  });
});

describe('shouldStartFreshReviewSession', () => {
  test('fresh review when re-entering from another stage', () => {
    expect(shouldStartFreshReviewSession(true, 'in_progress', 'review')).toBe(
      true,
    );
  });

  test('resume when interrupted mid-review in the same stage', () => {
    expect(shouldStartFreshReviewSession(true, 'review', 'review')).toBe(false);
  });
});

describe('review comparison', () => {
  test('builds an actionable rework handoff from the latest rejection', () => {
    const prompt = buildReviewReworkPrompt([
      {
        timestamp: '2026-07-22T00:00:00.000Z',
        commit: 'abc',
        issues: [
          { id: 'missing-test', text: 'Add coverage for the empty state' },
        ],
        summary: 'The empty state is not handled safely.',
        comparison: {
          decision: 'retry',
          progress: 'persistent_issue',
          reason:
            'The same missing empty-state behavior remains after the last attempt.',
        },
      },
    ]);

    expect(prompt).toContain('Add coverage for the empty state');
    expect(prompt).toContain('The empty state is not handled safely.');
    expect(prompt).toContain('The same missing empty-state behavior remains');
    expect(prompt).not.toContain('Non-blocking notes');

    const withAdvisory = buildReviewReworkPrompt([
      {
        timestamp: '2026-07-22T00:00:00.000Z',
        commit: 'abc',
        issues: [{ id: 'a', text: 'Blocking problem' }],
        summary: 'Blocking summary',
        advisory_issues: [{ id: 'b', text: '[opus] Rename the helper' }],
        advisory_summary: '[opus] Looks fine otherwise',
      },
    ])!;
    const notes = withAdvisory.indexOf('Non-blocking notes');
    expect(notes).toBeGreaterThan(withAdvisory.indexOf('Blocking problem'));
    expect(notes).toBeGreaterThan(withAdvisory.indexOf('Blocking summary'));
    expect(withAdvisory).toContain('- [opus] Rename the helper');
    expect(withAdvisory).toContain('[opus] Looks fine otherwise');
  });

  test('parses progress decisions', () => {
    const value = parseReviewComparison(
      JSON.stringify({
        decision: 'retry',
        progress: 'new_issue',
        resolved_issue_ids: [],
        persistent_issue_ids: [],
        new_issue_ids: ['race'],
        reason: 'new finding',
      }),
    );
    expect(value?.decision).toBe('retry');
    expect(value?.progress).toBe('new_issue');
  });

  const bare = JSON.stringify({
    decision: 'retry',
    progress: 'new_issue',
    resolved_issue_ids: [],
    persistent_issue_ids: [],
    new_issue_ids: [],
    reason: 'if (!x) { return; } is missing',
  });

  test('parses bare JSON whose reason contains braces', () => {
    expect(parseReviewComparison(bare)?.decision).toBe('retry');
  });

  test('parses bare JSON followed by prose with braces', () => {
    const value = parseReviewComparison(`${bare}\n\nNote: see {foo}.`);
    expect(value?.decision).toBe('retry');
  });

  test('returns null when there is no decision object', () => {
    expect(parseReviewComparison('no verdict {here} at all')).toBeNull();
    expect(parseReviewComparison('{"decision":"maybe"}')).toBeNull();
  });
});

describe('buildReviewGitContextBlock', () => {
  const baseBranch = 'develop';
  const stat = 'main repository\n src/a.ts | +3 -1';

  // Literal copy of the first-review block at HEAD.
  const firstReviewBlock = [
    '## Current change inventory',
    '',
    'The block below is a snapshot for orientation only. Re-read the current files',
    'and re-run the content diff before every verdict; never assume this snapshot',
    'or a prior review is still valid. CarapaBoard alone tracks repository identity.',
    'Do not inspect or reason about repository identity or history.',
    '',
    'Change inventory against `develop`:',
    '```',
    'main repository\n src/a.ts | +3 -1',
    '```',
    '',
    'Do **not** reject with "diff unchanged" or repeat a prior review without',
    're-verifying each issue against the current file contents.',
  ].join('\n');

  const single = { stageId: 'review', hasExtraReviewers: false };

  test('first review output is byte-identical with no or empty re-review context', () => {
    expect(buildReviewGitContextBlock(baseBranch, stat)).toBe(firstReviewBlock);
    expect(
      buildReviewGitContextBlock(baseBranch, stat, {
        history: [],
        delta: null,
        stageId: 'review',
        hasExtraReviewers: false,
      }),
    ).toBe(firstReviewBlock);
    // Approved multi-reviewer rounds are filtered out, so they also leave
    // the block byte-identical.
    const approveOnly = readReviewHistory({
      review_history: JSON.stringify([
        {
          timestamp: '2026-11-07T09:00:00.000Z',
          commit: 'a'.repeat(40),
          issues: [{ id: 'x', text: 'approver note' }],
          summary: 'approved',
          decision: 'approve',
        },
      ]),
    });
    expect(approveOnly).toEqual([]);
    expect(
      buildReviewGitContextBlock(baseBranch, stat, {
        history: approveOnly,
        delta: null,
        stageId: 'review',
        hasExtraReviewers: false,
      }),
    ).toBe(firstReviewBlock);
  });

  test('re-review appends rejected rounds and the delta without commit ids', () => {
    const commitA = 'a'.repeat(40);
    const commitB = 'b'.repeat(40);
    const history: ReviewHistoryEntry[] = [
      {
        timestamp: '2026-11-01T00:00:00.000Z',
        commit: commitA,
        issues: [
          { id: 'i1', text: 'First issue one' },
          { id: 'i2', text: 'First issue two' },
        ],
        summary: 'round one summary',
        advisory_issues: [{ id: 'adv', text: 'ADVISORY-NOTE-TEXT' }],
        advisory_summary: 'ADVISORY-SUMMARY-TEXT',
      },
      {
        timestamp: '2026-11-02T00:00:00.000Z',
        commit: commitB,
        issues: [
          { id: 'i3', text: 'Second issue one' },
          { id: 'i4', text: 'Second issue two' },
          { id: 'i5', text: 'Second issue three' },
          { id: 'i6', text: 'Second issue four' },
        ],
        summary: 'round two summary',
        comparison: {
          decision: 'retry',
          progress: 'persistent_issue',
          reason: 'same issue again',
        },
      },
    ];
    const block = buildReviewGitContextBlock(baseBranch, stat, {
      history,
      delta: ' src/b.ts | +1 -0',
      stageId: 'review',
      hasExtraReviewers: false,
    });

    expect(block.startsWith(firstReviewBlock)).toBe(true);
    expect(block).toContain('## Earlier rejected review rounds');
    expect(block).toContain('- Round 1: First issue one; First issue two');
    expect(block).toContain(
      '- Round 2 (persistent_issue): Second issue one; Second issue two; Second issue three; +1 more',
    );
    expect(block).toContain('Files changed since the last rejected round:');
    expect(block).toContain(' src/b.ts | +1 -0');
    expect(block).toContain('not a checklist');
    // No commit ids, no hex fragments, no "commit" wording, no advisory notes.
    expect(block).not.toContain(commitA);
    expect(block).not.toContain(commitB);
    expect(block).not.toMatch(/[0-9a-f]{7,}/);
    expect(block.toLowerCase()).not.toContain('commit');
    expect(block).not.toContain('ADVISORY-NOTE-TEXT');
    expect(block).not.toContain('ADVISORY-SUMMARY-TEXT');
    expect(block).not.toContain('round one summary');
  });

  test('delta placeholders for unavailable and empty deltas', () => {
    const history: ReviewHistoryEntry[] = [
      {
        timestamp: '2026-11-07T00:00:00.000Z',
        commit: 'c'.repeat(40),
        issues: [{ id: 'i', text: 'Still broken' }],
        summary: 's',
      },
    ];
    expect(
      buildReviewGitContextBlock(baseBranch, stat, {
        history,
        delta: null,
        ...single,
      }),
    ).toContain('(delta unavailable)');
    expect(
      buildReviewGitContextBlock(baseBranch, stat, {
        history,
        delta: '',
        ...single,
      }),
    ).toContain('(no changes since the last rejected round)');
    expect(
      buildReviewGitContextBlock(baseBranch, stat, {
        history,
        delta: '  \n ',
        stageId: 'review',
        hasExtraReviewers: false,
      }),
    ).toContain('(no changes since the last rejected round)');
  });

  describe('per-reviewer filtering', () => {
    const entry = (
      over: Partial<ReviewHistoryEntry> & Pick<ReviewHistoryEntry, 'issues'>,
    ): ReviewHistoryEntry => ({
      timestamp: '2026-11-01T00:00:00.000Z',
      commit: 'a'.repeat(40),
      summary: 's',
      ...over,
    });
    const issue = (text: string) => ({ id: text, text });
    const roundOf = (
      stageId: string,
      history: ReviewHistoryEntry[],
      hasExtraReviewers = true,
    ) =>
      buildReviewGitContextBlock(baseBranch, stat, {
        history,
        delta: ' src/b.ts | +1 -0',
        stageId,
        hasExtraReviewers,
      });
    const reviewer = (
      stage_id: string,
      decision: 'approve' | 'reject',
      issues: Array<{ id: string; text: string }>,
    ): NonNullable<ReviewHistoryEntry['reviewers']>[number] => ({
      reviewer: `model-${stage_id}`,
      decision,
      score: 5,
      issue_count: issues.length,
      stage_id,
      ...(decision === 'reject' ? { issues } : {}),
    });

    test('each reviewer sees only its own issues and keeps the delta block', () => {
      const onlyReview = entry({
        issues: [issue('[m] ISSUE-A')],
        reviewers: [
          reviewer('review', 'reject', [issue('ISSUE-A')]),
          reviewer('review.o', 'approve', []),
        ],
        comparison: { decision: 'retry', progress: 'new_issue', reason: 'r' },
      });
      const base = roundOf('review', [onlyReview]);
      expect(base).toContain('- Round 1: ISSUE-A');
      // Multi-reviewer rounds carry no round-level progress label.
      expect(base).not.toContain('new_issue');
      const extra = roundOf('review.o', [onlyReview]);
      expect(extra).not.toContain('## Earlier rejected review rounds');
      expect(extra).not.toContain('ISSUE-A');
      expect(extra).toContain('Files changed since the last rejected round:');
      expect(extra).toContain('not a checklist');

      const both = entry({
        issues: [issue('[m] ISSUE-A'), issue('[n] ISSUE-B')],
        reviewers: [
          reviewer('review', 'reject', [issue('ISSUE-A')]),
          reviewer('review.o', 'reject', [issue('ISSUE-B')]),
        ],
      });
      const history = [onlyReview, both];
      const baseBoth = roundOf('review', history);
      expect(baseBoth).toContain('ISSUE-A');
      expect(baseBoth).not.toContain('ISSUE-B');
      const extraBoth = roundOf('review.o', history);
      expect(extraBoth).toContain('- Round 2: ISSUE-B');
      expect(extraBoth).not.toContain('ISSUE-A');
      expect(extraBoth).not.toContain('Round 1');
    });

    test('single-reviewer rounds keep their progress labels and card round numbers', () => {
      const history = [
        entry({
          stage_id: 'review',
          issues: [issue('FIRST')],
          comparison: { decision: 'retry', progress: 'new_issue', reason: 'r' },
        }),
        entry({
          stage_id: 'review',
          issues: [issue('SECOND')],
          comparison: {
            decision: 'retry',
            progress: 'persistent_issue',
            reason: 'r',
          },
        }),
      ];
      const block = roundOf('review', history, false);
      expect(block).toContain('- Round 1 (new_issue): FIRST');
      expect(block).toContain('- Round 2 (persistent_issue): SECOND');
      // Another stage's single-reviewer round is not shown, and numbering has gaps.
      const mixed = [
        history[0],
        entry({ stage_id: 'review.o', issues: [issue('OTHER')] }),
        history[1],
      ];
      const gapped = roundOf('review', mixed, true);
      expect(gapped).not.toContain('OTHER');
      expect(gapped).toContain('- Round 3 (persistent_issue): SECOND');
    });

    test('unattributed entries are shown only when the round has no extra reviewers', () => {
      const legacy = [entry({ issues: [issue('LEGACY-ISSUE')] })];
      expect(roundOf('review', legacy, false)).toContain(
        '- Round 1: LEGACY-ISSUE',
      );
      for (const stageId of ['review', 'review.o']) {
        const block = roundOf(stageId, legacy, true);
        expect(block).not.toContain('LEGACY-ISSUE');
        expect(block).not.toContain('## Earlier rejected review rounds');
        expect(block).toContain('Files changed since the last rejected round:');
      }
    });
  });

  test('caps the rounds list at about 2500 chars and omits oldest rounds', () => {
    const history: ReviewHistoryEntry[] = Array.from(
      { length: 20 },
      (_, i) => ({
        timestamp: `2026-11-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
        commit: String(i).padStart(40, '0'),
        issues: Array.from({ length: 5 }, (_, j) => ({
          id: `r${i}-i${j}`,
          text: `Round ${i + 1} issue ${j + 1} ${'x'.repeat(180)}`,
        })),
        summary: 's',
      }),
    );
    // A long delta (60 numstat lines, ~3000 chars) renders outside the budget.
    const delta = Array.from(
      { length: 60 },
      (_, i) => ` src/deeply/nested/file-${i}.ts | +10 -2`,
    ).join('\n');
    const block = buildReviewGitContextBlock(baseBranch, stat, {
      history,
      delta,
      stageId: 'review',
      hasExtraReviewers: false,
    });
    // The budget covers only the rounds list (heading + omitted note + lines);
    // the delta sub-block and framing render outside it.
    const roundsPart = block.slice(
      block.indexOf('## Earlier rejected review rounds'),
      block.indexOf('Files changed since the last rejected round:'),
    );
    expect(roundsPart.length).toBeLessThanOrEqual(2500);
    const omitted = Number(
      roundsPart.match(/\((\d+) older rounds omitted\)/)?.[1],
    );
    expect(omitted).toBeGreaterThan(0);
    // The latest rejected round is never omitted, even against a long delta.
    expect(roundsPart).toContain('- Round 20:');
    expect(roundsPart).not.toContain('- Round 1:');
    // The delta and framing are still rendered in full.
    expect(block).toContain(' src/deeply/nested/file-59.ts | +10 -2');
    expect(block).toContain('not a checklist');
  });
});

describe('bounded bare-JSON scanning', () => {
  const decision = (extra: object = {}) =>
    JSON.stringify({
      decision: 'reject',
      score: 3,
      issues: [{ title: 'T', description: 'D' }],
      summary: 's',
      ...extra,
    });
  const comparison = JSON.stringify({
    decision: 'retry',
    progress: 'new_issue',
    reason: 'r',
  });
  const huge = 'line with an unclosed { brace\n'.repeat(140_000); // ~4 MB

  test('huge output with unclosed braces returns null quickly', () => {
    expect(huge.length).toBeGreaterThan(4_000_000);
    for (const parse of [parseReviewDecision, parseReviewComparison]) {
      const started = performance.now();
      expect(parse(huge)).toBeNull();
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  test('a suffix of unclosed braces before "decision" returns null quickly', () => {
    const suffix = `${'{'.repeat(64 * 1024)}"decision"`;
    for (const parse of [parseReviewDecision, parseReviewComparison]) {
      const started = performance.now();
      expect(parse(suffix)).toBeNull();
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  test('empty and brace-free output return null', () => {
    for (const parse of [parseReviewDecision, parseReviewComparison]) {
      expect(parse('')).toBeNull();
      expect(parse('no braces here')).toBeNull();
    }
  });

  test("truncated final JSON after a valid decision keeps today's result", () => {
    const out = `${decision()}\n\n{"decision":"approve","score":9,"summ`;
    expect(parseReviewDecision(out)?.decision).toBe('reject');
  });

  test('a json fence wins over bare JSON', () => {
    const out = `${decision({ decision: 'approve', score: 9 })}\n\`\`\`json\n${decision()}\n\`\`\``;
    expect(parseReviewDecision(out)?.decision).toBe('reject');
  });

  test('the last of two bare decisions wins', () => {
    const out = `${decision()} then ${decision({ decision: 'approve', score: 9 })}`;
    expect(parseReviewDecision(out)?.decision).toBe('approve');
  });

  test('a decision followed by under 64 KB of prose is still found', () => {
    const repeat = (unit: string) => unit.repeat((60 * 1024) / unit.length);
    const suffixes = [
      // Just under the limit: the opening brace sits more than 64 KB from the end.
      `\n${'x'.repeat(64 * 1024 - 100)}`,
      // Brace/quote/backslash patterns that defeat per-start rescans or caches.
      `\n${'{'.repeat(32)}"decision"${'x'.repeat(40_000)}`,
      `\n${repeat('{ prose ')}"decision" x`,
      `\n${repeat('{\\"')}`,
      `\n${repeat('{"\\')}`,
      `\n${repeat('"{\\')}`,
      `\n${repeat('{\\"decision"')}`,
      `\n${repeat('{"decision": ')}`,
    ];
    for (const suffix of suffixes) {
      const started = performance.now();
      expect(parseReviewDecision(`${decision()}${suffix}`)?.decision).toBe(
        'reject',
      );
      expect(parseReviewComparison(`${comparison}${suffix}`)?.decision).toBe(
        'retry',
      );
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  test('a decision followed by over 64 KB of prose is no longer found', () => {
    const prose = `\n${'x'.repeat(64 * 1024 + 100)}`;
    expect(parseReviewDecision(`${decision()}${prose}`)).toBeNull();
    expect(parseReviewComparison(`${comparison}${prose}`)).toBeNull();
  });

  test('prose quotes before or around a decision never hide it', () => {
    const quotedPrefix = `${JSON.stringify('x'.repeat(140_000))} Final verdict: `;
    for (const prefix of ['stray quote " then ', quotedPrefix]) {
      expect(parseReviewDecision(`${prefix}${decision()}`)?.decision).toBe(
        'reject',
      );
      expect(parseReviewComparison(`${prefix}${comparison}`)?.decision).toBe(
        'retry',
      );
    }
    const out = `${decision({ decision: 'approve', score: 9 })} "quoted" ${decision()}`;
    expect(parseReviewDecision(out)?.decision).toBe('reject');
  });

  test('deeply nested wrappers around a decision parse in bounded time', () => {
    const nested = `${'{"a":'.repeat(8_000)}${decision({ decision: 'bogus' })}${'}'.repeat(8_000)}`;
    const keyed = `${'{"decision":0,"a":'.repeat(3_000)}1${'}'.repeat(3_000)}`;
    for (const out of [nested, keyed]) {
      for (const parse of [parseReviewDecision, parseReviewComparison]) {
        const started = performance.now();
        parse(out);
        expect(performance.now() - started).toBeLessThan(500);
      }
    }
  });

  test('newer nested objects never hide an earlier in-window verdict', () => {
    const nested = `${'{"decision":0,"a":'.repeat(3_000)}1${'}'.repeat(3_000)}`;
    const shortNested = '{"decision":0,"a":{"decision":0,"a":1}}';
    for (const suffix of [shortNested, nested]) {
      expect(parseReviewComparison(`${comparison}${suffix}`)?.decision).toBe(
        'retry',
      );
    }
  });

  test('escaped decision keys are still recognised', () => {
    const escaped = (json: string) =>
      json.replace('"decision"', '"dec\\u0069sion"');
    expect(parseReviewDecision(`x ${escaped(decision())}`)?.decision).toBe(
      'reject',
    );
    expect(parseReviewComparison(`x ${escaped(comparison)}`)?.decision).toBe(
      'retry',
    );
  });

  test('a decision preceded by a huge unclosed prefix is found', () => {
    expect(parseReviewDecision(`${huge}${decision()}`)?.decision).toBe(
      'reject',
    );
    expect(parseReviewComparison(`${huge}${comparison}`)?.decision).toBe(
      'retry',
    );
  });
});
