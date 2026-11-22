import { afterEach, describe, expect, test } from 'bun:test';
import OpenAI from 'openai';

import {
  startDirectLlmSimulator,
  type DirectLlmSimulator,
  type SimulatorRequestSnapshot,
} from './direct-llm-simulator.js';

const simulators: DirectLlmSimulator[] = [];

async function requestSnapshots(
  simulator: DirectLlmSimulator,
): Promise<SimulatorRequestSnapshot[]> {
  const response = await fetch(`${simulator.controlUrl}/requests`);
  expect(response.ok).toBe(true);
  return (await response.json()) as SimulatorRequestSnapshot[];
}

afterEach(() => {
  for (const simulator of simulators.splice(0)) simulator.stop();
});

describe('UI sandbox Direct-LLM simulator', () => {
  test('binds isolated loopback ports and speaks the Responses streaming contract', async () => {
    const first = startDirectLlmSimulator();
    const second = startDirectLlmSimulator();
    simulators.push(first, second);
    expect(first.port).not.toBe(second.port);
    expect(first.baseUrl).toBe(`http://127.0.0.1:${first.port}/v1`);

    const client = new OpenAI({
      baseURL: first.baseUrl,
      apiKey: 'sandbox-test',
    });
    const stream = await client.responses.create({
      model: 'ui-simulator',
      input: [{ role: 'user', content: 'hold this request' }],
      stream: true,
    });
    expect(await requestSnapshots(first)).toEqual([
      expect.objectContaining({
        id: 1,
        status: 'connected',
        model: 'ui-simulator',
        lastUserText: 'hold this request',
      }),
    ]);

    const chunk = await fetch(`${first.controlUrl}/requests/1/chunk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'first ' }),
    });
    expect(chunk.ok).toBe(true);
    const released = await fetch(`${first.controlUrl}/requests/1/release`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'second' }),
    });
    expect(released.ok).toBe(true);

    const events: Record<string, unknown>[] = [];
    for await (const event of stream)
      events.push(event as unknown as Record<string, unknown>);
    expect(events.map((event) => event.type)).toEqual([
      'response.created',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.completed',
    ]);
    expect((await requestSnapshots(first))[0]?.status).toBe('completed');
    expect(await requestSnapshots(second)).toEqual([]);
  });

  test('emits a provider failure and rejects controls after the terminal event', async () => {
    const simulator = startDirectLlmSimulator();
    simulators.push(simulator);
    const client = new OpenAI({
      baseURL: simulator.baseUrl,
      apiKey: 'sandbox-test',
    });
    const stream = await client.responses.create({
      model: 'ui-simulator',
      input: [{ role: 'user', content: 'fail this request' }],
      stream: true,
    });

    const failed = await fetch(`${simulator.controlUrl}/requests/1/fail`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'deterministic failure' }),
    });
    expect(failed.ok).toBe(true);
    const events: Record<string, any>[] = [];
    for await (const event of stream) events.push(event as Record<string, any>);
    expect(events.at(-1)).toMatchObject({
      type: 'response.failed',
      response: { error: { message: 'deterministic failure' } },
    });
    expect((await requestSnapshots(simulator))[0]?.status).toBe('failed');
    expect(
      (
        await fetch(`${simulator.controlUrl}/requests/1/release`, {
          method: 'POST',
          body: '{}',
        })
      ).status,
    ).toBe(409);
  });

  test('observes client abort and closes its port on teardown', async () => {
    const aborted = Promise.withResolvers<void>();
    const simulator = startDirectLlmSimulator(0, () => aborted.resolve());
    simulators.push(simulator);
    const controller = new AbortController();
    const response = await fetch(`${simulator.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sandbox-test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'ui-simulator', input: [], stream: true }),
      signal: controller.signal,
    });
    expect(response.ok).toBe(true);
    controller.abort();
    await response.body?.cancel().catch(() => undefined);
    await aborted.promise;
    expect((await requestSnapshots(simulator))[0]?.status).toBe('aborted');

    const healthUrl = `http://127.0.0.1:${simulator.port}/health`;
    simulator.stop();
    simulators.splice(simulators.indexOf(simulator), 1);
    await expect(fetch(healthUrl)).rejects.toThrow();
  });

  test('auto-release completes requests until toggled off at runtime', async () => {
    const simulator = startDirectLlmSimulator(0, undefined, {
      autoRelease: true,
    });
    simulators.push(simulator);
    const client = new OpenAI({
      baseURL: simulator.baseUrl,
      apiKey: 'sandbox-test',
    });
    const collect = async (content: string) => {
      const events: Record<string, any>[] = [];
      for await (const event of await client.responses.create({
        model: 'ui-simulator',
        input: [{ role: 'user', content }],
        stream: true,
      }))
        events.push(event as Record<string, any>);
      return events;
    };
    const setAutoRelease = (body: object) =>
      fetch(`${simulator.controlUrl}/auto-release`, {
        method: 'POST',
        body: JSON.stringify(body),
      });

    const echoed = await collect('hello');
    expect(echoed.map((event) => event.type)).toEqual([
      'response.created',
      'response.output_text.delta',
      'response.completed',
    ]);
    expect(echoed[1]?.delta).toBe('Simulated response to: hello');

    await setAutoRelease({ enabled: true, text: 'fixed' });
    expect((await collect('again'))[1]?.delta).toBe('fixed');
    expect(
      await (await fetch(`${simulator.controlUrl}/auto-release`)).json(),
    ).toEqual({ enabled: true, text: 'fixed' });
    expect(
      (await requestSnapshots(simulator)).map((request) => request.status),
    ).toEqual(['completed', 'completed']);

    await setAutoRelease({ enabled: false });
    const held = await client.responses.create({
      model: 'ui-simulator',
      input: [{ role: 'user', content: 'held again' }],
      stream: true,
    });
    expect((await requestSnapshots(simulator))[2]?.status).toBe('connected');
    await fetch(`${simulator.controlUrl}/requests/3/release`, {
      method: 'POST',
      body: '{}',
    });
    for await (const _ of held);
    expect((await setAutoRelease({ enabled: 'yes' })).status).toBe(400);
  });
});
