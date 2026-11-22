import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { z } from 'zod';
import { logger } from '../../logger.js';
import { PrivacyRefusal, type PrivacyMode } from '../../lib/privacy-policy.js';
import * as stateManager from '../../state-manager.js';
import type { ToolDefinition } from './types.js';
import {
  executeToolHandler,
  startToolProgress,
  ToolTimeoutError,
} from './tool-execution.js';
import type { ReflectorMemoryExecutionContext } from '../memory/execution-context.js';

const context = {
  group_folder: 'test-project',
  permissions: { 'test-project': ['*:*'] },
};

function tool(
  handler: ToolDefinition['handler'],
  mcpTimeoutMs: number | null,
): ToolDefinition {
  return {
    name: 'test_tool',
    description: 'test',
    inputSchema: { value: z.string().optional() },
    mcpTimeoutMs,
    handler,
  };
}

describe('executeToolHandler', () => {
  test('times out, aborts the handler signal, and marks reflector failure', async () => {
    let observedAbort = false;
    const memoryExecution: ReflectorMemoryExecutionContext = {
      kind: 'reflector' as const,
      mode: 'live' as const,
      runId: 'timeout-run',
      chunkKey: 'chunk-0',
      sourceRef: 'transcripts/timeout.jsonl',
      evidence: new Map(),
      hadToolError: false,
      completedOperationKeys: new Set<string>(),
    };
    const pending = tool(
      async (_args, _deps, executionContext) =>
        await new Promise((_resolve, reject) => {
          executionContext.signal?.addEventListener(
            'abort',
            () => {
              observedAbort = true;
              reject(executionContext.signal?.reason);
            },
            { once: true },
          );
        }),
      10,
    );

    await expect(
      executeToolHandler(pending, {}, {} as any, {
        ...context,
        memoryExecution,
      }),
    ).rejects.toBeInstanceOf(ToolTimeoutError);
    expect(observedAbort).toBe(true);
    expect(memoryExecution.hadToolError).toBe(true);
    expect(memoryExecution.toolErrors).toEqual([
      { tool: 'test_tool', message: 'Tool "test_tool" timed out after 10ms' },
    ]);
  });

  describe('privacy mode', () => {
    const modes: Record<string, PrivacyMode> = {
      'privacy-strict': 'strict',
      'privacy-local-memory': 'local_memory',
      'privacy-off': 'off',
    };
    const lookup = spyOn(stateManager, 'getGroupByFolder').mockImplementation(
      (folder: string) => ({ settings: { privacyMode: modes[folder] } }) as any,
    );
    afterAll(() => lookup.mockRestore());

    test('refuses a remote-egress tool for strict projects and runs it otherwise', async () => {
      const strict = 'privacy-strict';
      const localMemory = 'privacy-local-memory';
      const off = 'privacy-off';
      let calls = 0;
      const web: ToolDefinition = {
        ...tool(async () => `called-${++calls}`, 1000),
        name: 'web_search',
        privacyPurpose: 'web',
      };
      const warn = spyOn(logger, 'warn');
      try {
        await expect(
          executeToolHandler(web, {}, {} as any, { group_folder: strict }),
        ).rejects.toBeInstanceOf(PrivacyRefusal);
        expect(calls).toBe(0);
        expect(
          warn.mock.calls.some(
            ([fields]) =>
              (fields as { event?: string })?.event === 'privacy_refusal',
          ),
        ).toBe(true);

        for (const group_folder of [localMemory, off]) {
          expect(
            await executeToolHandler(web, {}, {} as any, { group_folder }),
          ).toBe(`called-${calls}`);
        }
        expect(calls).toBe(2);
      } finally {
        warn.mockRestore();
      }
    });
  });
});

describe('startToolProgress', () => {
  test('reports increasing progress until stopped, so MCP clients keep waiting', async () => {
    const sent: any[] = [];
    const stop = startToolProgress(
      {
        _meta: { progressToken: 'tok' },
        sendNotification: async (n) => {
          sent.push(n);
        },
      },
      'working',
      5,
    );
    await new Promise((r) => setTimeout(r, 40));
    stop();
    const count = sent.length;
    expect(count).toBeGreaterThanOrEqual(2);
    expect(sent[0]).toEqual({
      method: 'notifications/progress',
      params: { progressToken: 'tok', progress: 1, message: 'working' },
    });
    expect(sent[1].params.progress).toBe(2);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.length).toBe(count);
  });

  test('does nothing when the client sent no progress token', async () => {
    const sent: any[] = [];
    const stop = startToolProgress(
      { sendNotification: async (n) => void sent.push(n) },
      'working',
      5,
    );
    await new Promise((r) => setTimeout(r, 20));
    stop();
    expect(sent).toHaveLength(0);
  });
});
