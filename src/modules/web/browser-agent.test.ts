import { describe, expect, test } from 'bun:test';
import type { ChatAgentRunResult } from '../../agent-runner.js';
import type { SandboxExecutionTarget } from '../../mcp/mcp-runner.js';
import {
  retrieveWithBrowserAgent,
  validateBrowserAgentMarkdown,
  type BrowserAgentDependencies,
} from './browser-agent.js';

const target: SandboxExecutionTarget = {
  stack: 'test-stack',
  service: 'agent',
  instance: 'test-instance',
};
const group = { folder: 'web-project', settings: {} } as any;
const runtime = {
  id: 'codex:test',
  agentCmd: 'codex',
  harnessKind: 'cli',
} as any;
const sessionId = 'web-view-test-session';

function result(value: string | null, failed = false): ChatAgentRunResult {
  return { result: value, failed, telemetry: undefined, isLlm: false };
}

function successEnvelope(content: string): string {
  return `<<<CARAPA_WEB_VIEW_SUCCESS ${sessionId}>>>\n${content}\n<<<CARAPA_WEB_VIEW_END ${sessionId}>>>`;
}

function dependencies(
  overrides: Partial<BrowserAgentDependencies> = {},
): BrowserAgentDependencies {
  return {
    getGroup: () => group,
    resolveRuntime: (() => runtime) as any,
    createSessionId: () => sessionId,
    timeoutMs: 2_000,
    createBrowser: async () => ({
      PLAYWRIGHT_MCP_CDP_ENDPOINT: 'ws://test/cdp',
    }),
    closeBrowser: async () => {},
    execInSandbox: async () => ({ stdout: '', isError: false }),
    runAgent: async () => result(null),
    ...overrides,
  };
}

describe('web_view browser agent boundary', () => {
  test('opens an isolated page, lets the configured agent use playwright-cli, and closes it', async () => {
    const url = 'https://example.test/interactive';
    const commands: string[] = [];
    const content = `# Interactive article\n\n${'Useful retrieved article text. '.repeat(8)}`;
    const markdown = `> **Source**: ${url}\n\n${content}`;
    const output = await retrieveWithBrowserAgent(
      url,
      { group_folder: group.folder, conversation_id: 'conversation-1' },
      dependencies({
        execInSandbox: async (receivedTarget, command) => {
          expect(receivedTarget).toEqual(target);
          commands.push(command);
          return { stdout: '', isError: false };
        },
        runAgent: async (options) => {
          expect(options.agentConfig).toBe(runtime);
          expect(options.chatJid).toBe('web-view-agent:web-view-test-session');
          expect(options.checkoutConversationId).toBe('conversation-1');
          await options.onCheckoutReady({ run_id: 'test-run' } as any, target);
          return result(successEnvelope(content));
        },
      }),
    );

    expect(output).toBe(markdown.trim());
    expect(commands).toHaveLength(2);
    expect(commands[0]).toBe(
      "playwright-cli -s='web-view-test-session' open 'https://example.test/interactive'",
    );
    expect(commands[1]).toBe("playwright-cli -s='web-view-test-session' close");
  });

  test('gives concurrent detached workers distinct runner identities', async () => {
    let nextSession = 0;
    const chatJids: string[] = [];
    const extractionDependencies = dependencies({
      createSessionId: () => `web-view-concurrent-${++nextSession}`,
      runAgent: async (options) => {
        chatJids.push(options.chatJid);
        await options.onCheckoutReady({ run_id: 'test-run' } as any, target);
        const workerSession = options.chatJid.slice('web-view-agent:'.length);
        return result(
          `<<<CARAPA_WEB_VIEW_SUCCESS ${workerSession}>>>\nUseful content\n<<<CARAPA_WEB_VIEW_END ${workerSession}>>>`,
        );
      },
    });

    await Promise.all([
      retrieveWithBrowserAgent(
        'https://example.test/concurrent-one',
        { group_folder: group.folder },
        extractionDependencies,
      ),
      retrieveWithBrowserAgent(
        'https://example.test/concurrent-two',
        { group_folder: group.folder },
        extractionDependencies,
      ),
    ]);

    expect(chatJids).toEqual([
      'web-view-agent:web-view-concurrent-1',
      'web-view-agent:web-view-concurrent-2',
    ]);
  });

  test('requires one well-formed, non-empty success envelope', () => {
    const url = 'https://example.test/blocked';
    expect(() =>
      validateBrowserAgentMarkdown(result(null), url, sessionId),
    ).toThrow('returned no content');
    expect(() =>
      validateBrowserAgentMarkdown(
        result('I could not retrieve the page because login is required.'),
        url,
        sessionId,
      ),
    ).toThrow('could not retrieve useful page content');
    expect(() =>
      validateBrowserAgentMarkdown(
        result(`<<<CARAPA_WEB_VIEW_SUCCESS ${sessionId}>>>\nnot closed`),
        url,
        sessionId,
      ),
    ).toThrow('missing or malformed success envelope');
    expect(() =>
      validateBrowserAgentMarkdown(
        result(successEnvelope('   ')),
        url,
        sessionId,
      ),
    ).toThrow('success envelope was empty');
    expect(() =>
      validateBrowserAgentMarkdown(
        result(`${successEnvelope('first')}\n${successEnvelope('second')}`),
        url,
        sessionId,
      ),
    ).toThrow('missing or malformed success envelope');
    expect(() =>
      validateBrowserAgentMarkdown(
        result(successEnvelope('Useful content'), true),
        url,
        sessionId,
      ),
    ).toThrow('sandbox agent failed');
  });

  test('does not judge headings or prose inside the content payload', () => {
    const url = 'https://example.test/page-layout';
    const content = `# Page Layout Guide\n\n${'Useful guidance about responsive document layouts. '.repeat(4)}\n\n### Result\n\nThe author describes what happened.`;
    const markdown = `> **Source**: ${url}\n\n${content}`;

    expect(
      validateBrowserAgentMarkdown(
        result(successEnvelope(content)),
        url,
        sessionId,
      ),
    ).toBe(markdown.trim());
  });

  test('cleans up when the agent explains that retrieval failed', async () => {
    const commands: string[] = [];
    await expect(
      retrieveWithBrowserAgent(
        'https://example.test/login-wall',
        { group_folder: group.folder },
        dependencies({
          execInSandbox: async (_target, command) => {
            commands.push(command);
            return { stdout: '', isError: false };
          },
          runAgent: async (options) => {
            await options.onCheckoutReady(
              { run_id: 'test-run' } as any,
              target,
            );
            return result(
              'I could not retrieve the page because login is required.',
            );
          },
        }),
      ),
    ).rejects.toThrow('login is required');
    expect(commands.at(-1)).toBe(
      "playwright-cli -s='web-view-test-session' close",
    );
  });

  test('lets the agent recover when the browser opened but initial navigation failed', async () => {
    const url = 'https://example.test/retry-navigation';
    let agentRan = false;
    const content = `# Recovered after navigation\n\nUseful content loaded after the agent retried the page.`;
    const output = await retrieveWithBrowserAgent(
      url,
      { group_folder: group.folder },
      dependencies({
        execInSandbox: async (_target, command) =>
          command.endsWith(' close')
            ? { stdout: '', isError: false }
            : {
                stdout:
                  '### Browser `web-view-test-session` opened with pid 42.\nnet::ERR_FAILED',
                isError: true,
              },
        runAgent: async (options) => {
          await options.onCheckoutReady({ run_id: 'test-run' } as any, target);
          agentRan = true;
          return result(successEnvelope(content));
        },
      }),
    );

    expect(agentRan).toBe(true);
    expect(output).toContain('# Recovered after navigation');
  });

  test('propagates parent cancellation and still closes with a live cleanup signal', async () => {
    const controller = new AbortController();
    const commands: string[] = [];
    const receivedSignals: AbortSignal[] = [];
    const extraction = retrieveWithBrowserAgent(
      'https://example.test/slow',
      { group_folder: group.folder, signal: controller.signal },
      dependencies({
        execInSandbox: async (_target, command, _timeoutSeconds, signal) => {
          commands.push(command);
          receivedSignals.push(signal);
          if (command.endsWith(' close')) {
            expect(signal.aborted).toBe(false);
            return { stdout: '', isError: false };
          }
          queueMicrotask(() => controller.abort());
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          });
          return { stdout: '', isError: false };
        },
        runAgent: async (options) => {
          await options.onCheckoutReady({ run_id: 'test-run' } as any, target);
          return result(null);
        },
      }),
    );

    await expect(extraction).rejects.toThrow('cancelled by user');
    expect(commands.at(-1)).toBe(
      "playwright-cli -s='web-view-test-session' close",
    );
    expect(receivedSignals).toHaveLength(2);
    expect(receivedSignals[0].aborted).toBe(true);
    expect(receivedSignals[1].aborted).toBe(false);
    expect(receivedSignals[0]).not.toBe(receivedSignals[1]);
  });

  test('applies the overall timeout and still closes with a live cleanup signal', async () => {
    const commands: string[] = [];
    const receivedSignals: AbortSignal[] = [];
    const extraction = retrieveWithBrowserAgent(
      'https://example.test/timeout',
      { group_folder: group.folder },
      dependencies({
        timeoutMs: 10,
        execInSandbox: async (_target, command, _timeoutSeconds, signal) => {
          commands.push(command);
          receivedSignals.push(signal);
          if (command.endsWith(' close')) expect(signal.aborted).toBe(false);
          return { stdout: '', isError: false };
        },
        runAgent: async (options) => {
          await options.onCheckoutReady({ run_id: 'test-run' } as any, target);
          await new Promise<void>((_resolve, reject) => {
            if (options.signal.aborted) reject(options.signal.reason);
            else
              options.signal.addEventListener(
                'abort',
                () => reject(options.signal.reason),
                { once: true },
              );
          });
          return result(null);
        },
      }),
    );

    await expect(extraction).rejects.toThrow(
      'Browser extraction timed out after 10ms',
    );
    expect(commands.at(-1)).toBe(
      "playwright-cli -s='web-view-test-session' close",
    );
    expect(receivedSignals).toHaveLength(2);
    expect(receivedSignals[0].aborted).toBe(true);
    expect(receivedSignals[1].aborted).toBe(false);
    expect(receivedSignals[0]).not.toBe(receivedSignals[1]);
  });
});
