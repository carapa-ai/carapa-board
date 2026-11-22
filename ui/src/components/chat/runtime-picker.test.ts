// Bun supplies these test globals at runtime; the UI package intentionally
// does not depend on Bun's type declarations.
// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import type { RuntimeCatalog } from '@/lib/api';
import { normalizeRuntimePickerSelection } from './runtime-picker';

const catalog: RuntimeCatalog = {
  version: 2,
  harnesses: [
    { id: 'direct', label: 'Direct', kind: 'direct', sessionFamily: 'direct' },
    { id: 'cli', label: 'CLI', kind: 'cli', sessionFamily: 'cli' },
  ],
  models: [
    {
      id: 'model',
      label: 'Model',
      capabilities: [],
      bindings: [
        {
          harnessId: 'direct',
          runtimeId: 'direct:model',
          reasoning: { options: ['medium', 'high'], default: 'medium' },
        },
        {
          harnessId: 'cli',
          runtimeId: 'cli:model',
          reasoning: { options: ['medium', 'high'], default: 'medium' },
        },
      ],
    },
  ],
  presets: [],
  defaults: {
    chat: { harnessId: 'direct', modelId: 'model', reasoning: 'medium' },
    kanban: {
      fallback: { harnessId: 'direct', modelId: 'model', reasoning: 'high' },
      stages: {},
    },
  },
};

describe('RuntimePicker selection normalization', () => {
  test('keeps omitted reasoning omitted when changing a binding', () => {
    expect(
      normalizeRuntimePickerSelection(catalog, {
        harnessId: 'cli',
        modelId: 'model',
      }),
    ).toEqual({ harnessId: 'cli', modelId: 'model' });
  });

  test('uses the binding default when explicit reasoning becomes invalid', () => {
    expect(
      normalizeRuntimePickerSelection(catalog, {
        harnessId: 'cli',
        modelId: 'model',
        reasoning: 'unsupported',
      }),
    ).toEqual({ harnessId: 'cli', modelId: 'model', reasoning: 'medium' });
  });
});
