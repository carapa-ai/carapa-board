import { describe, expect, test } from 'bun:test';
import {
  MEMORY_AUDIT_JSON_SCHEMA,
  requestValidMemoryAuditJson,
} from './memory-audit-json.js';

describe('memory audit JSON repair', () => {
  test('reprompts malformed output with the schema and accepted IDs', async () => {
    const prompts: Array<{ prompt: string; repair: boolean }> = [];
    const responses = ['not json', '{"items":[{"memory_id":"mem-1"}]}'];
    const parsed = await requestValidMemoryAuditJson({
      originalPrompt: 'Audit this memory.',
      allowedMemoryIds: ['mem-1'],
      invoke: async (prompt, repair) => {
        prompts.push({ prompt, repair });
        return responses.shift()!;
      },
      validate: (output) => {
        const value = JSON.parse(output);
        if (value.items?.[0]?.memory_id !== 'mem-1') {
          throw new Error('missing mem-1');
        }
        return value;
      },
    });

    expect(parsed.items[0].memory_id).toBe('mem-1');
    expect(prompts).toHaveLength(2);
    expect(prompts[0]?.repair).toBe(false);
    expect(prompts[1]?.repair).toBe(true);
    expect(prompts[1]?.prompt).toContain('not json');
    expect(prompts[1]?.prompt).toContain('mem-1');
    expect(prompts[1]?.prompt).toContain(MEMORY_AUDIT_JSON_SCHEMA);
  });

  test('reprompts asynchronous evidence validation failures', async () => {
    let calls = 0;
    const result = await requestValidMemoryAuditJson({
      originalPrompt: 'Audit.',
      allowedMemoryIds: ['mem-1'],
      invoke: async () => {
        calls += 1;
        return calls === 1 ? '{"path":"missing.ts"}' : '{"path":"real.ts"}';
      },
      validate: async (output) => {
        const parsed = JSON.parse(output);
        if (parsed.path !== 'real.ts') {
          throw new Error('Evidence excerpt was not found');
        }
        return parsed;
      },
    });

    expect(result.path).toBe('real.ts');
    expect(calls).toBe(2);
  });

  test('bounds repair attempts and returns the last validation error', async () => {
    let calls = 0;
    await expect(
      requestValidMemoryAuditJson({
        originalPrompt: 'Audit.',
        allowedMemoryIds: ['mem-1'],
        maxReprompts: 2,
        invoke: async () => {
          calls += 1;
          return '{}';
        },
        validate: () => {
          throw new Error('items must cover mem-1');
        },
      }),
    ).rejects.toThrow('items must cover mem-1');
    expect(calls).toBe(3);
  });

  test('reports every rejected attempt without logging response content', async () => {
    const diagnostics: Array<
      Parameters<
        NonNullable<
          Parameters<
            typeof requestValidMemoryAuditJson
          >[0]['onValidationFailure']
        >
      >[0]
    > = [];
    const secret = 'private-memory-content';
    const result = await requestValidMemoryAuditJson({
      originalPrompt: 'Audit.',
      allowedMemoryIds: ['mem-1'],
      invoke: async (_prompt, repair) =>
        repair ? '{"items":[]}' : `before {"items":["${secret}"],}`,
      validate: (output) => JSON.parse(output.slice(output.indexOf('{'))),
      onValidationFailure: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
    });

    expect(result).toEqual({ items: [] });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.attempt).toBe(1);
    expect(diagnostics[0]?.maxAttempts).toBe(3);
    expect(diagnostics[0]?.responseFormat).toBe('wrapped-json-object');
    expect(diagnostics[0]?.responseLength).toBeGreaterThan(0);
    expect(diagnostics[0]?.responseSha256).toHaveLength(64);
    expect(diagnostics[0]?.structuralExcerpt).not.toContain(secret);
  });
});
