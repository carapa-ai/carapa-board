import { describe, expect, test } from 'bun:test';
import {
  consumeChatStreamTurn,
  consumeResponsesStreamTurn,
} from './direct-llm.js';

/** The shared Codex thinking format: `> _…_` blockquote, whitespace collapsed. */
const thinking = (note: string) => `\n\n> _${note}_\n\n`;

/** Collect `text` chunk contents in stream order. */
function makeOnChunk() {
  const chunks: string[] = [];
  const onChunk = (chunk: { type: string; content?: string }) => {
    if (chunk.type === 'text' && typeof chunk.content === 'string')
      chunks.push(chunk.content);
  };
  return { chunks, onChunk };
}

function responsesStream(events: any[]) {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

function chatStream(chunks: any[]) {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

describe('DirectLLM Responses wire reasoning', () => {
  test('emits the thinking blockquote once, before streamed text', async () => {
    const { chunks, onChunk } = makeOnChunk();
    const turn = await consumeResponsesStreamTurn(
      responsesStream([
        {
          type: 'response.output_item.added',
          item: { type: 'reasoning', id: 'rs_1', summary: [] },
        },
        {
          type: 'response.reasoning_summary_part.added',
          item_id: 'rs_1',
          summary_index: 0,
          part: { type: 'summary_text', text: '' },
        },
        {
          type: 'response.reasoning_summary_text.delta',
          item_id: 'rs_1',
          summary_index: 0,
          delta: 'Let me ',
        },
        {
          type: 'response.reasoning_summary_text.delta',
          item_id: 'rs_1',
          summary_index: 0,
          delta: 'check the  \nfiles first',
        },
        {
          type: 'response.reasoning_summary_part.done',
          item_id: 'rs_1',
          summary_index: 0,
          part: { type: 'summary_text', text: 'Let me check the files first' },
        },
        {
          type: 'response.output_item.done',
          item: {
            type: 'reasoning',
            id: 'rs_1',
            summary: [
              { type: 'summary_text', text: 'Let me check the files first' },
            ],
            encrypted_content: 'enc_1',
          },
        },
        {
          type: 'response.output_item.added',
          item: { type: 'message', id: 'msg_1', content: [] },
        },
        {
          type: 'response.output_text.delta',
          item_id: 'msg_1',
          delta: 'Hello ',
        },
        {
          type: 'response.output_text.delta',
          item_id: 'msg_1',
          delta: 'world',
        },
        {
          type: 'response.output_item.done',
          item: {
            type: 'message',
            id: 'msg_1',
            content: [{ type: 'output_text', text: 'Hello world' }],
          },
        },
      ]),
      onChunk,
      'test-model',
    );

    expect(chunks[0]).toBe(thinking('Let me check the files first'));
    expect(chunks.slice(1).join('')).toBe('Hello world');
    // Thinking never enters the assistant text used for history/result.
    expect(turn.text).toBe('Hello world');
    expect(turn.toolCalls).toEqual([]);
    // Output items still replay for multi-turn reasoning continuity.
    expect(turn.outputItems.map((item) => item.type)).toEqual([
      'reasoning',
      'message',
    ]);
  });

  test.each(['summary', 'content'] as const)(
    'joins multiple reasoning %s parts in order',
    async (kind) => {
      const { chunks, onChunk } = makeOnChunk();
      await consumeResponsesStreamTurn(
        responsesStream([
          {
            type:
              kind === 'summary'
                ? 'response.reasoning_summary_text.delta'
                : 'response.reasoning_text.delta',
            item_id: 'rs_1',
            ...(kind === 'summary'
              ? { summary_index: 0 }
              : { content_index: 0 }),
            delta: 'Part one',
          },
          {
            type:
              kind === 'summary'
                ? 'response.reasoning_summary_text.delta'
                : 'response.reasoning_text.delta',
            item_id: 'rs_1',
            ...(kind === 'summary'
              ? { summary_index: 1 }
              : { content_index: 1 }),
            delta: 'part two',
          },
          {
            type: 'response.output_item.done',
            item: {
              type: 'reasoning',
              id: 'rs_1',
              summary: [],
            },
          },
          { type: 'response.output_text.delta', delta: 'ok' },
        ]),
        onChunk,
        'test-model',
      );
      expect(chunks).toEqual([thinking('Part one part two'), 'ok']);
    },
  );

  test.each(['summary', 'content'] as const)(
    'falls back to the item %s when no deltas were streamed',
    async (kind) => {
      const { chunks, onChunk } = makeOnChunk();
      await consumeResponsesStreamTurn(
        responsesStream([
          {
            type: 'response.output_item.done',
            item: {
              type: 'reasoning',
              id: 'rs_1',
              summary:
                kind === 'summary'
                  ? [{ type: 'summary_text', text: 'Silent thought' }]
                  : [],
              ...(kind === 'content'
                ? {
                    content: [
                      { type: 'reasoning_text', text: 'Silent thought' },
                    ],
                  }
                : {}),
            },
          },
          { type: 'response.output_text.delta', delta: 'ok' },
        ]),
        onChunk,
        'test-model',
      );
      expect(chunks).toEqual([thinking('Silent thought'), 'ok']);
    },
  );

  test('still maps usage and throws on failed/incomplete streams', async () => {
    const { onChunk } = makeOnChunk();
    const turn = await consumeResponsesStreamTurn(
      responsesStream([
        { type: 'response.output_text.delta', delta: 'done' },
        {
          type: 'response.completed',
          response: {
            usage: {
              input_tokens: 12,
              output_tokens: 7,
              input_tokens_details: { cached_tokens: 3, cache_write_tokens: 1 },
              output_tokens_details: { reasoning_tokens: 4 },
            },
          },
        },
      ]),
      onChunk,
      'test-model',
    );
    expect(turn.hasUsage).toBe(true);
    expect(turn.usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 7,
      reasoningTokens: 4,
      cachedInputTokens: 3,
      cacheWriteTokens: 1,
    });

    await expect(
      consumeResponsesStreamTurn(
        responsesStream([
          {
            type: 'response.incomplete',
            response: { incomplete_details: { reason: 'max_output_tokens' } },
          },
        ]),
        onChunk,
        'test-model',
      ),
    ).rejects.toThrow('unsuccessfully: max_output_tokens');
  });

  test('collects function calls alongside reasoning without duplicates', async () => {
    const { chunks, onChunk } = makeOnChunk();
    const turn = await consumeResponsesStreamTurn(
      responsesStream([
        {
          type: 'response.reasoning_summary_text.delta',
          item_id: 'rs_1',
          delta: 'use the tool',
        },
        {
          type: 'response.output_item.done',
          item: {
            type: 'reasoning',
            id: 'rs_1',
            summary: [{ type: 'summary_text', text: 'use the tool' }],
          },
        },
        {
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            call_id: 'call_1',
            name: 'do_thing',
            arguments: '{"a":1}',
          },
        },
      ]),
      onChunk,
      'test-model',
    );
    expect(chunks[0]).toBe(thinking('use the tool'));
    expect(turn.toolCalls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'do_thing', arguments: '{"a":1}' },
      },
    ]);
  });
});

describe('DirectLLM Chat Completions wire reasoning', () => {
  test('emits reasoning_content before the streamed text', async () => {
    const { chunks, onChunk } = makeOnChunk();
    const turn = await consumeChatStreamTurn(
      chatStream([
        { choices: [{ delta: { reasoning_content: 'Hmm, ' } }] },
        { choices: [{ delta: { reasoning_content: 'the answer ' } }] },
        { choices: [{ delta: { content: 'is 42' } }] },
        {
          choices: [{ delta: {} }],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 2,
            prompt_tokens_details: { cached_tokens: 1, cache_write_tokens: 0 },
          },
        },
      ]),
      onChunk,
    );
    expect(chunks).toEqual([thinking('Hmm, the answer'), 'is 42']);
    expect(turn.text).toBe('is 42');
    expect(turn.hasUsage).toBe(true);
    expect(turn.usage).toMatchObject({
      inputTokens: 5,
      outputTokens: 2,
      cachedInputTokens: 1,
      cacheWriteTokens: 0,
    });
  });

  test('emits reasoning before tool calls and keeps accumulating them', async () => {
    const { chunks, onChunk } = makeOnChunk();
    const turn = await consumeChatStreamTurn(
      chatStream([
        { choices: [{ delta: { reasoning: 'think first' } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'c1',
                    function: { name: 'f', arguments: '' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { name: '', arguments: '{"x":1}' },
                  },
                ],
              },
            },
          ],
        },
      ]),
      onChunk,
    );
    expect(chunks).toEqual([thinking('think first')]);
    expect(turn.toolCalls).toEqual([
      {
        id: 'c1',
        type: 'function',
        function: { name: 'f', arguments: '{"x":1}' },
      },
    ]);
  });

  test('reads Mistral chunked content as thinking plus answer text', async () => {
    const { chunks, onChunk } = makeOnChunk();
    const piece = (text: string) => ({
      choices: [
        {
          delta: {
            content: [{ type: 'thinking', thinking: [{ type: 'text', text }] }],
          },
        },
      ],
    });
    const turn = await consumeChatStreamTurn(
      chatStream([
        { choices: [{ delta: { role: 'assistant', content: '' } }] },
        piece('Six '),
        piece('times seven'),
        { choices: [{ delta: { content: [{ type: 'text', text: '42' }] } }] },
      ]),
      onChunk,
    );
    expect(chunks).toEqual([thinking('Six times seven'), '42']);
    expect(turn.text).toBe('42');
  });

  test('stays clean when the provider sends no reasoning field', async () => {
    const { chunks, onChunk } = makeOnChunk();
    const turn = await consumeChatStreamTurn(
      chatStream([
        { choices: [{ delta: { content: 'plain' } }] },
        { choices: [{ delta: {} }] },
      ]),
      onChunk,
    );
    expect(chunks).toEqual(['plain']);
    expect(turn.text).toBe('plain');
    expect(turn.hasUsage).toBe(false);
  });
});
