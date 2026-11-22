import { expect, test } from 'bun:test';
import {
  applyDiscoveredModels,
  type DiscoveryCache,
} from './discovered-models.js';
import { normalizeBoardAgentsText } from './chat-agents.js';

const raw = {
  harnesses: {
    claude: {
      discover: { account: 'anthropic', model: '${id}[1m]', env: { A: '1' } },
    },
    'antigravity-acp': {
      discover: { account: 'antigravity', from: 'harness' },
    },
    // No list reported yet: the account's models alone must not be offered.
    'muse-acp': { discover: { account: 'antigravity', from: 'harness' } },
  },
  models: {
    // Curated override: only the env and label it sets win.
    'claude-sonnet-5-5': {
      label: 'Sonnet',
      bindings: { claude: { env: { B: '2' } } },
    },
  },
  defaults: { chat: { harnessId: 'claude', modelId: 'claude-opus-5' } },
};
const cache: DiscoveryCache = {
  version: 1,
  accounts: {
    anthropic: {
      at: 1,
      models: [
        {
          id: 'claude-opus-5-5',
          name: 'Claude Opus 5.5',
          contextSize: 1000000,
        },
        { id: 'claude-opus-5', name: 'Claude Opus 5' },
        { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
      ],
      retired: [{ id: 'claude-sonnet-5-5' }],
    },
    antigravity: {
      at: 1,
      models: [
        {
          id: 'gemini-3.8-flash-high',
          name: 'Gemini 3.8 Flash (High)',
          harnessModel: 'gemini-3.7-flash-high',
        },
        { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
      ],
    },
  },
  harnesses: {
    'antigravity-acp': {
      at: 1,
      models: [
        { id: 'gemini-3.7-flash-high' },
        { id: 'gemini-3.6-flash-high' },
      ],
    },
  },
};

test('discovered models fill the catalog without overriding board_agents.jsonc or dropping pinned models', () => {
  const { raw: merged, flags } = applyDiscoveredModels(raw, cache);
  // Newest of the family, plus the older model the chat default names; never 4.8.
  expect(Object.keys(merged.models).sort()).toEqual([
    'claude-opus-5',
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'gemini-3.8-flash-high',
  ]);
  expect(merged.models['claude-opus-5-5'].bindings.claude).toEqual({
    env: { A: '1' },
    model: 'claude-opus-5-5[1m]',
    contextSize: 1000000,
  });
  expect(merged.models['claude-sonnet-5-5']).toMatchObject({
    label: 'Sonnet',
    bindings: {
      claude: { model: 'claude-sonnet-5-5[1m]', env: { A: '1', B: '2' } },
    },
  });
  // The harness accepts only its retired name; the catalog keeps the account's id.
  expect(merged.models['gemini-3.8-flash-high']).toMatchObject({
    label: 'Gemini 3.8 Flash (High)',
    bindings: { 'antigravity-acp': { model: 'gemini-3.7-flash-high' } },
  });
  expect(flags).toEqual({
    'claude-opus-5-5': 'discovered',
    'claude-opus-5': 'discovered',
    'claude-sonnet-5-5': 'unavailable',
    'gemini-3.8-flash-high': 'discovered',
  });
});

test('a harness-reported list can never take down the hand-written catalog', () => {
  // Cursor ids carry settings in brackets; the catalog keys them by name.
  const cursor = applyDiscoveredModels(
    {
      harnesses: { 'cursor-acp': { discover: { from: 'harness' } } },
      models: {},
    },
    {
      version: 1,
      accounts: {},
      harnesses: {
        'cursor-acp': {
          at: 1,
          models: [
            { id: 'default[]', name: 'Auto' },
            { id: 'gpt-5.6-sol[reasoning=medium]', name: 'gpt-5.6-sol' },
            { id: 'bad id[]' },
          ],
        },
      },
    },
  ).raw.models;
  expect(Object.keys(cursor).sort()).toEqual(['default', 'gpt-5.6-sol']);
  expect(cursor['gpt-5.6-sol'].bindings['cursor-acp'].model).toBe(
    'gpt-5.6-sol[reasoning=medium]',
  );

  // Anything else the discovered models break falls back to the file alone.
  const text = JSON.stringify({
    version: 2,
    harnesses: {
      direct: { label: 'Direct', kind: 'direct' },
      claude: {
        label: 'Claude Code',
        kind: 'cli',
        agentCmd: 'claude',
        discover: {
          account: 'anthropic',
          reasoning: { options: ['low'], default: 'high' },
        },
      },
    },
    models: {
      m: {
        label: 'M',
        bindings: { direct: { model: 'm', baseUrl: 'http://x' } },
      },
    },
    defaults: {
      chat: { harnessId: 'direct', modelId: 'm' },
      kanban: { fallback: { harnessId: 'direct', modelId: 'm' } },
    },
  });
  const { snapshot } = normalizeBoardAgentsText(text, undefined, {
    version: 1,
    accounts: { anthropic: { at: 1, models: [{ id: 'claude-sonnet-5-5' }] } },
    harnesses: {},
  });
  expect(snapshot.catalog.models.map((m) => m.id)).toEqual(['m']);
});

test('effort variants become one model whose reasoning choice picks the harness model', () => {
  const { raw: merged } = applyDiscoveredModels(
    {
      harnesses: {
        'antigravity-acp': {
          discover: {
            account: 'antigravity',
            from: 'harness',
            effortVariants: ['low', 'medium', 'high'],
          },
        },
      },
      models: {},
    },
    {
      version: 1,
      accounts: {
        antigravity: {
          at: 1,
          models: [
            ...['low', 'high'].map((effort) => ({
              id: `gemini-4-argon-${effort}`,
              name: `Gemini 4 Argon (${effort === 'low' ? 'Low' : 'High'})`,
              harnessModel: `gemini-3.1-pro-${effort}`,
            })),
            {
              id: 'gemini-4-argon-medium',
              name: 'Gemini 4 Argon (Medium)',
              harnessModel: 'gemini-3.6-flash-medium',
            },
          ],
        },
      },
      harnesses: {
        'antigravity-acp': {
          at: 1,
          models: [
            { id: 'gemini-3.1-pro-low' },
            { id: 'gemini-3.1-pro-high' },
            { id: 'gemini-3.6-flash-medium' },
          ],
        },
      },
    },
  );
  expect(Object.keys(merged.models)).toEqual(['gemini-4-argon']);
  expect(merged.models['gemini-4-argon']).toMatchObject({
    label: 'Gemini 4 Argon',
    bindings: {
      'antigravity-acp': {
        model: 'gemini-3.6-flash-medium',
        reasoning: {
          options: ['low', 'medium', 'high'],
          default: 'medium',
          models: {
            low: 'gemini-3.1-pro-low',
            medium: 'gemini-3.6-flash-medium',
            high: 'gemini-3.1-pro-high',
          },
        },
      },
    },
  });
});
