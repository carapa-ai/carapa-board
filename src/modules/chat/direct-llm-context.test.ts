import { describe, expect, test } from 'bun:test';
import {
  budgetDirectLlmRequest,
  DirectLlmContextError,
  isContextOverflowError,
  isModelCapacityError,
  openStreamWithOverflowRetry,
} from './direct-llm.js';

describe('DirectLLM context budgeting', () => {
  test('recognizes capacity failures without treating generic provider errors as capacity', () => {
    expect(
      isModelCapacityError(
        new Error(
          'Selected model is at capacity. Please try a different model.',
        ),
      ),
    ).toBe(true);
    expect(isModelCapacityError({ error: { code: 'server_overloaded' } })).toBe(
      true,
    );
    expect(isModelCapacityError({ codexErrorInfo: 'serverOverloaded' })).toBe(
      true,
    );
    expect(
      isModelCapacityError({ status: 503, message: 'service unavailable' }),
    ).toBe(false);
    expect(
      isModelCapacityError({ status: 429, message: 'rate limit exceeded' }),
    ).toBe(false);
    expect(
      isModelCapacityError({ status: 401, message: 'invalid API key' }),
    ).toBe(false);
  });

  test('prunes old history under a configured context ceiling', () => {
    const result = budgetDirectLlmRequest(
      [
        { role: 'system', content: 'rules' },
        { role: 'user', content: 'old '.repeat(2000) },
        { role: 'assistant', content: 'answer '.repeat(2000) },
        { role: 'user', content: 'current' },
      ],
      [],
      2000,
      400,
    );
    expect(result.messages.at(-1)?.content).toBe('current');
    expect(result.prunedUnits).toBeGreaterThan(0);
    expect(result.estimatedInputTokens).toBeLessThanOrEqual(1600);
  });

  test('counts tool schemas and rejects an irreducible request precisely', () => {
    expect(() =>
      budgetDirectLlmRequest(
        [
          { role: 'system', content: 'rules' },
          { role: 'user', content: 'current' },
        ],
        [
          {
            type: 'function',
            function: { name: 'large', description: 'x'.repeat(6000) },
          },
        ],
        1000,
        200,
      ),
    ).toThrow(DirectLlmContextError);
  });

  test('truncates oversized tool results without orphaning calls or results', () => {
    const result = budgetDirectLlmRequest(
      [
        { role: 'system', content: 'rules' },
        { role: 'user', content: 'look it up' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call-1', function: { name: 'lookup', arguments: '{}' } },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call-1',
          content: 'result '.repeat(3000),
        },
        { role: 'user', content: 'current' },
      ],
      [],
      1800,
      300,
    );
    const assistant = result.messages.find((message) => message.tool_calls);
    const tool = result.messages.find((message) => message.role === 'tool');
    expect(Boolean(assistant)).toBe(Boolean(tool));
    if (tool) expect(tool.tool_call_id).toBe(assistant.tool_calls[0].id);
  });

  test('drops an incomplete multi-call turn and every partial result', () => {
    const result = budgetDirectLlmRequest(
      [
        { role: 'system', content: 'rules' },
        { role: 'user', content: 'look up both' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call-1', function: { name: 'first', arguments: '{}' } },
            { id: 'call-2', function: { name: 'second', arguments: '{}' } },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call-1',
          content: 'only first completed',
        },
        { role: 'user', content: 'current' },
      ],
      [],
      4000,
      500,
    );
    expect(result.messages.some((message) => message.tool_calls)).toBe(false);
    expect(result.messages.some((message) => message.role === 'tool')).toBe(
      false,
    );
    expect(result.messages.at(-1)?.content).toBe('current');
  });

  test('retains a complete multi-call turn with exactly all matching results', () => {
    const result = budgetDirectLlmRequest(
      [
        { role: 'system', content: 'rules' },
        { role: 'user', content: 'look up both' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call-1', function: { name: 'first', arguments: '{}' } },
            { id: 'call-2', function: { name: 'second', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call-1', content: 'first result' },
        { role: 'tool', tool_call_id: 'call-2', content: 'second result' },
        { role: 'user', content: 'current' },
      ],
      [],
      4000,
      500,
    );
    const assistant = result.messages.find((message) => message.tool_calls);
    const results = result.messages.filter(
      (message) => message.role === 'tool',
    );
    expect(assistant.tool_calls.map((call: any) => call.id)).toEqual([
      'call-1',
      'call-2',
    ]);
    expect(results.map((message) => message.tool_call_id)).toEqual([
      'call-1',
      'call-2',
    ]);
  });

  test('preserves active tool-continuation chronology after pruning history', () => {
    const activeTurn = [
      { role: 'user', content: 'current lookup' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'active-call',
            function: { name: 'lookup', arguments: '{"id":1}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'active-call', content: 'active result' },
    ];
    const result = budgetDirectLlmRequest(
      [
        { role: 'system', content: 'rules' },
        { role: 'user', content: 'old '.repeat(2000) },
        { role: 'assistant', content: 'old answer '.repeat(2000) },
        ...activeTurn,
      ],
      [],
      1800,
      300,
    );
    expect(result.prunedUnits).toBeGreaterThan(0);
    expect(result.messages.slice(-3)).toEqual(activeTurn);
    expect(result.messages.map((message) => message.role).slice(-3)).toEqual([
      'user',
      'assistant',
      'tool',
    ]);
  });

  test('counts Responses replay items including encrypted reasoning content', () => {
    const messages = [
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'current' },
    ];
    expect(() =>
      budgetDirectLlmRequest(messages, [], 1200, 200, 0, {
        previousResponseOutputItems: [
          { type: 'reasoning', encrypted_content: 'x'.repeat(5000) },
        ],
      }),
    ).toThrow(DirectLlmContextError);
  });

  test('budgets multimodal inputs conservatively', () => {
    expect(() =>
      budgetDirectLlmRequest(
        [
          { role: 'system', content: 'rules' },
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: 'data:image/png;base64,abc' },
              },
            ],
          },
        ],
        [],
        1000,
        200,
      ),
    ).toThrow(DirectLlmContextError);
  });

  test('recognizes common overflow shapes but not unrelated bad requests', () => {
    expect(
      isContextOverflowError({ status: 400, code: 'context_length_exceeded' }),
    ).toBe(true);
    expect(
      isContextOverflowError({
        statusCode: 413,
        message: 'prompt is too long',
      }),
    ).toBe(true);
    expect(
      isContextOverflowError({
        response: {
          status: 400,
          data: { error: { message: 'maximum context window exceeded' } },
        },
      }),
    ).toBe(true);
    expect(
      isContextOverflowError({ status: 400, message: 'invalid temperature' }),
    ).toBe(false);
  });

  test('more aggressive overflow retries retain less history', () => {
    const messages = [
      { role: 'system', content: 'rules' },
      ...Array.from({ length: 8 }, (_, index) => ({
        role: index % 2 ? 'assistant' : 'user',
        content: `history ${index} `.repeat(50),
      })),
      { role: 'user', content: 'current' },
    ];
    const initial = budgetDirectLlmRequest(messages, [], 3000, 500, 0);
    const retry = budgetDirectLlmRequest(messages, [], 3000, 500, 2);
    expect(retry.messages.length).toBeLessThan(initial.messages.length);
    expect(retry.messages.at(-1)?.content).toBe('current');
  });

  test('retries an overflow before response output', async () => {
    let attempts = 0;
    const retries: number[] = [];
    const stream = await openStreamWithOverflowRetry(
      async () => {
        attempts++;
        if (attempts < 3)
          throw Object.assign(new Error('maximum context length exceeded'), {
            status: 400,
          });
        return (async function* () {
          yield { text: 'ok' };
        })();
      },
      (retry) => retries.push(retry),
    );
    const output = [];
    for await (const item of stream) output.push(item);
    expect(attempts).toBe(3);
    expect(retries).toEqual([1, 2]);
    expect(output).toEqual([{ text: 'ok' }]);
  });

  test('retries an iterator overflow thrown after a metadata event', async () => {
    let attempts = 0;
    const stream = await openStreamWithOverflowRetry(
      async () => {
        attempts++;
        const attempt = attempts;
        return (async function* () {
          yield { type: 'metadata' };
          if (attempt === 1)
            throw Object.assign(new Error('context window exceeded'), {
              status: 400,
            });
          yield { type: 'content', text: 'ok' };
        })();
      },
      () => undefined,
      2,
      (event) => event.type === 'content',
    );
    const output = [];
    for await (const event of stream) output.push(event);
    expect(attempts).toBe(2);
    expect(output).toEqual([
      { type: 'metadata' },
      { type: 'content', text: 'ok' },
    ]);
  });

  test('retries a Responses overflow event emitted after response.created', async () => {
    let attempts = 0;
    const stream = await openStreamWithOverflowRetry(
      async () => {
        attempts++;
        const attempt = attempts;
        return (async function* () {
          yield { type: 'response.created' };
          if (attempt === 1) {
            yield {
              type: 'response.failed',
              response: {
                error: {
                  code: 'context_length_exceeded',
                  message: 'maximum context length exceeded',
                },
              },
            };
            return;
          }
          yield { type: 'response.output_text.delta', delta: 'ok' };
        })();
      },
      () => undefined,
      2,
      (event) => event.type === 'response.output_text.delta',
      (event) =>
        event.type === 'response.failed'
          ? Object.assign(new Error(event.response.error.message), {
              code: event.response.error.code,
            })
          : undefined,
    );
    const output = [];
    for await (const event of stream) output.push(event);
    expect(attempts).toBe(2);
    expect(output).toEqual([
      { type: 'response.created' },
      { type: 'response.output_text.delta', delta: 'ok' },
    ]);
  });

  test('does not retry an overflow after meaningful output has begun', async () => {
    let attempts = 0;
    const stream = await openStreamWithOverflowRetry(
      async () => {
        attempts++;
        return (async function* () {
          yield { type: 'content', text: 'started' };
          throw Object.assign(new Error('context window exceeded'), {
            status: 400,
          });
        })();
      },
      () => undefined,
      2,
      (event) => event.type === 'content',
    );
    await expect(async () => {
      for await (const _event of stream) {
        /* consume */
      }
    }).toThrow('context window exceeded');
    expect(attempts).toBe(1);
  });
});
