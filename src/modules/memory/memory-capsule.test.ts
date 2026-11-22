import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDatabase, insertMemory } from '../../db.js';
import { getGroupDir } from '../../group-dir.js';
import { truncateTestDb } from '../../test-helpers.js';
import type { RegisteredGroup } from '../../types.js';
import { estimateTokens } from './transcript-chunk.js';
import { parseTranscript } from './transcript-parser.js';
import {
  buildMemoryCapsule,
  parseMemoryContext,
  resolveAuthorizedRelatedGroups,
  stripMemoryCapsules,
  type MemoryCapsuleCandidate,
  type MemoryCapsuleJudge,
} from './memory-capsule.js';

const CURRENT = 'capsule-current';
const RELATED = 'capsule-related';
const UNRELATED = 'capsule-unrelated';
const currentGroup: RegisteredGroup = {
  name: 'Current',
  folder: CURRENT,
  trigger: '',
  added_at: '',
  parentId: 'capsule-parent',
  settings: { memorySourceProjects: [RELATED] },
};
const selectAllJudge: MemoryCapsuleJudge = async (_prompt, candidates) =>
  candidates.map((candidate) => candidate.id);

beforeAll(async () => {
  await initDatabase(':memory:');
  await truncateTestDb();
});

afterAll(() => {
  fs.rmSync(getGroupDir(CURRENT), { recursive: true, force: true });
  fs.rmSync(getGroupDir(RELATED), { recursive: true, force: true });
});

describe('memory context request parsing', () => {
  test('supports + as Minimal while explicit context takes precedence', () => {
    expect(parseMemoryContext(undefined, '+ remember this')).toEqual({
      content: 'remember this',
      level: 'minimal',
      invalid: false,
    });
    expect(parseMemoryContext({ level: 'deep' }, '+ literal plus')).toEqual({
      content: '+ literal plus',
      level: 'deep',
      invalid: false,
    });
    expect(parseMemoryContext({ level: 'huge' }, 'hello').invalid).toBe(true);
  });
});

describe('related memory scope', () => {
  test('uses only authorized parent, children, and direct memory sources', async () => {
    const groups: RegisteredGroup[] = [
      currentGroup,
      { name: 'Parent', folder: 'capsule-parent', trigger: '', added_at: '' },
      {
        name: 'Child',
        folder: 'capsule-child',
        parentId: CURRENT,
        trigger: '',
        added_at: '',
      },
      { name: 'Source', folder: RELATED, trigger: '', added_at: '' },
      { name: 'Other', folder: UNRELATED, trigger: '', added_at: '' },
    ];
    const result = await resolveAuthorizedRelatedGroups(
      currentGroup,
      groups,
      async (folder) => folder !== 'capsule-child',
    );
    expect(result.map((group) => group.folder).sort()).toEqual(
      ['capsule-parent', RELATED].sort(),
    );
  });

  test('excludes privacy-protected sources unless the reader is strict', async () => {
    const groups: RegisteredGroup[] = [
      {
        ...currentGroup,
        settings: { memorySourceProjects: [RELATED] },
      },
      {
        name: 'Source',
        folder: RELATED,
        trigger: '',
        added_at: '',
        settings: { privacyMode: 'strict' },
      },
      {
        name: 'Child',
        folder: 'capsule-child',
        parentId: currentGroup.folder,
        trigger: '',
        added_at: '',
        settings: { privacyMode: 'local_memory' },
      },
    ];
    const allow = async () => true;
    const offReader = await resolveAuthorizedRelatedGroups(
      groups[0],
      groups,
      allow,
    );
    expect(offReader).toEqual([]);
    const strictReader = await resolveAuthorizedRelatedGroups(
      {
        ...groups[0],
        settings: { ...groups[0].settings, privacyMode: 'strict' },
      },
      groups,
      allow,
    );
    expect(strictReader.map((group) => group.folder).sort()).toEqual(
      ['capsule-child', RELATED].sort(),
    );
  });

  test('uses every authorized project for the main project', async () => {
    const main: RegisteredGroup = {
      name: 'Main',
      folder: 'capsule-main',
      trigger: '',
      added_at: '',
      is_main: true,
    };
    const groups: RegisteredGroup[] = [
      main,
      { name: 'Project A', folder: 'project-a', trigger: '', added_at: '' },
      { name: 'Project B', folder: 'project-b', trigger: '', added_at: '' },
      { name: 'Denied', folder: 'project-denied', trigger: '', added_at: '' },
    ];
    const result = await resolveAuthorizedRelatedGroups(
      main,
      groups,
      async (folder) => folder !== 'project-denied',
    );

    expect(result.map((group) => group.folder)).toEqual([
      'project-a',
      'project-b',
    ]);
  });

  test('standard scope uses children and direct memory sources but not the parent', async () => {
    const groups: RegisteredGroup[] = [
      currentGroup,
      { name: 'Parent', folder: 'capsule-parent', trigger: '', added_at: '' },
      {
        name: 'Child',
        folder: 'capsule-child',
        parentId: CURRENT,
        trigger: '',
        added_at: '',
      },
      {
        name: 'Denied child',
        folder: 'capsule-denied-child',
        parentId: CURRENT,
        trigger: '',
        added_at: '',
      },
      { name: 'Source', folder: RELATED, trigger: '', added_at: '' },
      { name: 'Other', folder: UNRELATED, trigger: '', added_at: '' },
    ];
    const result = await resolveAuthorizedRelatedGroups(
      currentGroup,
      groups,
      async (folder) => folder !== 'capsule-denied-child',
      'standard',
    );
    expect(result.map((group) => group.folder).sort()).toEqual(
      ['capsule-child', RELATED].sort(),
    );
  });

  test('standard scope for the main project is limited to its children and memory sources', async () => {
    const main: RegisteredGroup = {
      name: 'Main',
      folder: 'capsule-main',
      trigger: '',
      added_at: '',
      is_main: true,
      settings: { memorySourceProjects: ['project-b'] },
    };
    const groups: RegisteredGroup[] = [
      main,
      {
        name: 'Project A',
        folder: 'project-a',
        parentId: 'capsule-main',
        trigger: '',
        added_at: '',
      },
      { name: 'Project B', folder: 'project-b', trigger: '', added_at: '' },
      { name: 'Project C', folder: 'project-c', trigger: '', added_at: '' },
    ];
    const result = await resolveAuthorizedRelatedGroups(
      main,
      groups,
      async () => true,
      'standard',
    );
    expect(result.map((group) => group.folder)).toEqual([
      'project-a',
      'project-b',
    ]);
  });

  test('standard scope still applies the privacy filter', async () => {
    const reader: RegisteredGroup = {
      ...currentGroup,
      settings: { memorySourceProjects: [RELATED] },
    };
    const groups: RegisteredGroup[] = [
      reader,
      {
        name: 'Source',
        folder: RELATED,
        trigger: '',
        added_at: '',
        settings: { privacyMode: 'strict' },
      },
      {
        name: 'Child',
        folder: 'capsule-child',
        parentId: reader.folder,
        trigger: '',
        added_at: '',
      },
    ];
    const result = await resolveAuthorizedRelatedGroups(
      reader,
      groups,
      async () => true,
      'standard',
    );
    expect(result.map((group) => group.folder)).toEqual(['capsule-child']);
  });
});

describe('capsule construction', () => {
  test('respects budgets, objective scope, deduplication, and related journal isolation', async () => {
    await insertMemory({
      group_folder: CURRENT,
      objective_id: 'objective-1',
      content: 'Objective uses a blue deployment strategy',
      memory_type: 'decision',
      importance: 0.9,
      source: 'user',
      valid_from: '2026-07-20T00:00:00.000Z',
    });
    await insertMemory({
      group_folder: CURRENT,
      objective_id: 'objective-2',
      content: 'Other objective secret',
      memory_type: 'decision',
      importance: 0.9,
      source: 'user',
    });
    await insertMemory({
      group_folder: RELATED,
      content: 'Shared framework requires signed releases',
      memory_type: 'project',
      importance: 0.9,
      source: 'observer',
    });

    const minimal = await buildMemoryCapsule({
      level: 'minimal',
      prompt: 'How should blue deployment work?',
      currentGroup,
      objectiveId: 'objective-1',
      engine: 'llm',
      judge: selectAllJudge,
    });
    expect(minimal).toContain('[MEMORY_CAPSULE]');
    expect(minimal).toContain('Objective uses a blue deployment strategy');
    expect(minimal).not.toContain('Other objective secret');
    expect(minimal).not.toContain('Shared framework');
    expect(estimateTokens(minimal)).toBeLessThanOrEqual(400);

    const deep = await buildMemoryCapsule({
      level: 'deep',
      prompt: 'What signed releases and deployment rules apply?',
      currentGroup,
      objectiveId: 'objective-1',
      relatedGroups: [
        { name: 'Related', folder: RELATED, trigger: '', added_at: '' },
      ],
      engine: 'llm',
      judge: selectAllJudge,
    });
    expect(deep).toContain('Shared framework requires signed releases');
    expect(estimateTokens(deep)).toBeLessThanOrEqual(3_500);
  });

  test('standard capsules include labelled related memories capped at six; minimal ones do not', async () => {
    for (let i = 1; i <= 8; i++) {
      await insertMemory({
        group_folder: 'capsule-child-source',
        content: `Zebra rollout checklist item ${i}`,
        memory_type: 'project',
        importance: 0.9,
        source: 'observer',
      });
    }
    const relatedGroups: RegisteredGroup[] = [
      {
        name: 'Child Source',
        folder: 'capsule-child-source',
        parentId: CURRENT,
        trigger: '',
        added_at: '',
      },
    ];
    const seen: MemoryCapsuleCandidate[][] = [];
    const judge: MemoryCapsuleJudge = async (_prompt, candidates) => {
      seen.push(candidates);
      return candidates.map((candidate) => candidate.id);
    };
    const base = {
      prompt: 'Zebra rollout checklist',
      currentGroup,
      relatedGroups,
      engine: 'llm' as const,
      judge,
    };

    const standard = await buildMemoryCapsule({ ...base, level: 'standard' });
    expect(standard).toContain('Zebra rollout checklist item');
    expect(standard).toContain('Child Source');
    expect(
      seen[0].filter((candidate) => candidate.source === 'related'),
    ).toHaveLength(6);

    const minimal = await buildMemoryCapsule({ ...base, level: 'minimal' });
    expect(minimal).not.toContain('Zebra rollout checklist item');
  });

  test('uses the judge selection and excludes unrelated important memories', async () => {
    await insertMemory({
      group_folder: CURRENT,
      content: 'The office coffee machine uses paper filters',
      memory_type: 'decision',
      importance: 1,
      source: 'user',
    });
    const capsule = await buildMemoryCapsule({
      level: 'minimal',
      prompt: 'How should blue deployment work?',
      currentGroup,
      objectiveId: 'objective-1',
      engine: 'llm',
      judge: async (_prompt, candidates) =>
        candidates
          .filter((candidate) => candidate.content.includes('blue deployment'))
          .map((candidate) => candidate.id),
    });

    expect(capsule).toContain('Objective uses a blue deployment strategy');
    expect(capsule).not.toContain('coffee machine');
  });

  test('falls back to strict lexical matches when the judge fails', async () => {
    const capsule = await buildMemoryCapsule({
      level: 'minimal',
      prompt: 'blue deployment',
      currentGroup,
      objectiveId: 'objective-1',
      engine: 'llm',
      judge: async () => {
        throw new Error('judge unavailable');
      },
    });

    expect(capsule).toContain('Objective uses a blue deployment strategy');
    expect(capsule).not.toContain('coffee machine');
  });

  test('includes memory lines whole or omits them entirely when fitting the budget', async () => {
    await insertMemory({
      group_folder: CURRENT,
      content: `Oversized alpha memory ${'detail '.repeat(2_000)}`,
      memory_type: 'decision',
      importance: 1,
      source: 'user',
    });
    await insertMemory({
      group_folder: CURRENT,
      content: 'Compact alpha memory remains useful',
      memory_type: 'decision',
      importance: 0.99,
      source: 'user',
    });

    const capsule = await buildMemoryCapsule({
      level: 'minimal',
      prompt: 'alpha',
      currentGroup,
      engine: 'llm',
      judge: async (_prompt, candidates) =>
        candidates
          .filter((candidate) =>
            candidate.content.toLowerCase().includes('alpha'),
          )
          .map((candidate) => candidate.id),
    });

    expect(capsule).not.toContain('Oversized alpha memory');
    expect(capsule).toContain('Compact alpha memory remains useful');
    expect(capsule).not.toContain('…');
  });
});

describe('query planning', () => {
  const planGroup: RegisteredGroup = {
    name: 'Plan',
    folder: 'capsule-plan',
    trigger: '',
    added_at: '',
  };
  const prompt = 'did you try that other thing we talked about?';
  const planOptions = {
    level: 'minimal' as const,
    prompt,
    currentGroup: planGroup,
    engine: 'llm' as const,
    judge: selectAllJudge,
    queryPlan: 'on' as const,
    gate: async () => 2,
  };

  beforeAll(async () => {
    for (const content of [
      'Quokka migration was rolled back after the lock incident',
      'Wombat cache must be flushed before each release',
    ]) {
      await insertMemory({
        group_folder: planGroup.folder,
        content,
        memory_type: 'decision',
        importance: 0.5,
        source: 'user',
      });
    }
  });

  test('skips recall and the planner when the gate score is below the threshold', async () => {
    let planned = false;
    const capsule = await buildMemoryCapsule({
      ...planOptions,
      prompt: 'quokka migration',
      gate: async () => 0.2,
      planner: async () => {
        planned = true;
        return ['quokka'];
      },
    });
    expect(capsule).toBe('');
    expect(planned).toBe(false);
  });

  test('continues with recall when the gate fails', async () => {
    const capsule = await buildMemoryCapsule({
      ...planOptions,
      prompt: 'quokka migration',
      gate: async () => {
        throw new Error('jev down');
      },
      planner: async () => [],
    });
    expect(capsule).toContain('Quokka migration was rolled back');
  });

  test('attributes the gate and the Jev scorer to the capsule project', async () => {
    const gateContexts: unknown[] = [];
    const scorerOptions: unknown[] = [];
    await buildMemoryCapsule({
      ...planOptions,
      prompt: 'quokka migration',
      engine: 'jev',
      gate: async (_prompt, context) => {
        gateContexts.push(context);
        return 2;
      },
      jevScorer: async (_request, candidates, options) => {
        scorerOptions.push(options);
        return {
          scores: new Map(candidates.map((candidate) => [candidate.id, 2])),
          checkpoints: {},
        };
      },
      planner: async () => [],
    });
    expect(gateContexts).toEqual([{ groupFolder: planGroup.folder }]);
    expect(scorerOptions).toEqual([{ projectId: planGroup.folder }]);
  });

  test('attributes the detached Jev shadow scoring to the capsule project', async () => {
    let observed!: (options: unknown) => void;
    const scorerOptions = new Promise<unknown>((resolve) => {
      observed = resolve;
    });
    await buildMemoryCapsule({
      ...planOptions,
      prompt: 'quokka migration',
      engine: 'shadow',
      jevScorer: async (_request, candidates, options) => {
        observed(options);
        return {
          scores: new Map(candidates.map((candidate) => [candidate.id, 2])),
          checkpoints: {},
        };
      },
      planner: async () => [],
    });
    expect(await scorerOptions).toEqual({ projectId: planGroup.folder });
  });

  test('recalls once per planned query and unions the results', async () => {
    const withoutPlan = await buildMemoryCapsule({
      ...planOptions,
      planner: async () => [],
    });
    expect(withoutPlan).toBe('');

    const capsule = await buildMemoryCapsule({
      ...planOptions,
      planner: async () => ['quokka migration', 'wombat cache'],
    });
    expect(capsule).toContain('Quokka migration was rolled back');
    expect(capsule).toContain('Wombat cache must be flushed');
  });

  test.each([
    [
      'throws',
      async (): Promise<string[]> => {
        throw new Error('llm down');
      },
    ],
    ['times out', () => new Promise<string[]>(() => {})],
  ])('uses the raw prompt only when the planner %s', async (_name, planner) => {
    const capsule = await buildMemoryCapsule({
      ...planOptions,
      prompt: 'wombat cache',
      planner,
      planTimeoutMs: 1,
    });
    expect(capsule).toContain('Wombat cache must be flushed');
    expect(capsule).not.toContain('Quokka');
  });

  test('MEMORY_CAPSULE_QUERY_PLAN=off ignores the gate and planner', async () => {
    const capsule = await buildMemoryCapsule({
      ...planOptions,
      queryPlan: 'off',
      gate: async () => 0,
      planner: async () => ['quokka migration'],
    });
    expect(capsule).toBe('');
    const raw = await buildMemoryCapsule({
      ...planOptions,
      queryPlan: 'off',
      prompt: 'wombat cache',
      gate: async () => 0,
    });
    expect(raw).toContain('Wombat cache must be flushed');
  });
});

describe('transcript feedback-loop prevention', () => {
  test('strips capsules from direct strings and every parsed user-message shape', () => {
    const wrapped =
      '[MEMORY_CAPSULE]\n- old memory\n[/MEMORY_CAPSULE]\n\nActual request';
    expect(stripMemoryCapsules(wrapped)).toBe('Actual request');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capsule-transcript-'));
    const transcript = path.join(dir, 'output.jsonl');
    fs.writeFileSync(
      transcript,
      [
        JSON.stringify({ type: 'message', role: 'user', content: wrapped }),
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: wrapped }] },
        }),
      ].join('\n'),
    );
    try {
      const parsed = parseTranscript(transcript);
      expect(parsed.condensed).not.toContain('old memory');
      expect(parsed.condensed.match(/Actual request/g)?.length).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
