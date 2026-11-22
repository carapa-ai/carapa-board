// @ts-nocheck
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { useStore } from '@/store';
import { submitLiveModeTranscriptWithQueueOwnership } from './live-mode-queue';

afterEach(() => {
  useStore.setState({ queuedPromptsByConv: {} });
  mock.restore();
});

describe('Live Mode queued transcript ownership', () => {
  test('retains one stable prompt when an accepted acknowledgement is lost', async () => {
    let resolveRequest: ((value: any) => void) | undefined;
    const request = new Promise((resolve) => {
      resolveRequest = resolve;
    });
    const calls: any[][] = [];
    const send = mock(async (...args: any[]) => {
      calls.push(args);
      return request;
    });
    const submission = submitLiveModeTranscriptWithQueueOwnership({
      projectId: 'project-live',
      conversationId: 'conversation-live',
      text: 'voice transcript',
      agentCmd: 'codex',
      liveModeSessionId: 'session-live',
      liveModeKind: 'work',
      send,
    });

    const pending =
      useStore.getState().queuedPromptsByConv['conversation-live'][0];
    expect(pending).toMatchObject({
      content: 'voice transcript',
      awaitingAcknowledgement: true,
      liveMode: true,
      liveModeSessionId: 'session-live',
      liveModeKind: 'work',
    });
    expect(calls[0][13]).toBe(pending.id);
    expect(calls[0][14]).toEqual([pending.id]);

    resolveRequest?.(Promise.reject(new TypeError('response lost')));
    await expect(submission).rejects.toThrow('response lost');
    expect(
      useStore.getState().queuedPromptsByConv['conversation-live'],
    ).toEqual([{ ...pending, awaitingAcknowledgement: false }]);
  });

  test('transfers the stable browser copy to a durable persona owner', async () => {
    const send = mock(async () => ({
      conversation_id: 'conversation-live',
      delivery: 'queued' as const,
      queueOwner: 'persona' as const,
      queuedMessageId: 'durable-live-prompt',
    }));
    await submitLiveModeTranscriptWithQueueOwnership({
      projectId: 'project-live',
      conversationId: 'conversation-live',
      text: 'persona boundary transcript',
      liveModeSessionId: 'session-live',
      liveModeKind: 'personas',
      send,
    });

    expect(
      useStore.getState().queuedPromptsByConv['conversation-live'],
    ).toEqual([
      expect.objectContaining({
        id: 'durable-live-prompt',
        serverOwned: true,
        serverQueueOwner: 'persona',
        awaitingAcknowledgement: false,
      }),
    ]);
  });

  describe('ordered submission', () => {
    const submit = (conversationId: string, text: string, send: any) =>
      submitLiveModeTranscriptWithQueueOwnership({
        projectId: 'project-live',
        conversationId,
        text,
        liveModeSessionId: 'session-live',
        liveModeKind: 'work',
        send,
      });
    const deferred = () => {
      let resolve!: (value: any) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<any>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };
    const started = { conversation_id: 'c', delivery: 'started' as const };

    test('POSTs phrases one at a time in spoken order while showing them at once', async () => {
      const gates = [deferred(), deferred(), deferred()];
      const callStarted = [deferred(), deferred(), deferred()];
      const calls: string[] = [];
      const send = mock(async (_p: string, text: string) => {
        calls.push(text);
        callStarted[calls.length - 1].resolve(undefined);
        return gates[calls.length - 1].promise;
      });
      const submissions = ['one', 'two', 'three'].map((text) =>
        submit('conv-order', text, send),
      );
      expect(
        useStore
          .getState()
          .queuedPromptsByConv['conv-order'].map((p) => p.content),
      ).toEqual(['one', 'two', 'three']);
      // The first POST starts at once; the others wait for it to settle.
      await callStarted[0].promise;
      expect(calls).toEqual(['one']);
      gates[0].resolve(started);
      await callStarted[1].promise;
      expect(calls).toEqual(['one', 'two']);
      gates[1].resolve(started);
      await callStarted[2].promise;
      gates[2].resolve(started);
      await Promise.all(submissions);
      expect(calls).toEqual(['one', 'two', 'three']);
      expect(
        useStore.getState().queuedPromptsByConv['conv-order'],
      ).toBeUndefined();
    });

    test('keeps later phrases local, in order, behind a failed send', async () => {
      const send = mock(async () => {
        throw new TypeError('offline');
      });
      const [first, ...rest] = ['one', 'two', 'three'].map((text) =>
        submit('conv-fail', text, send),
      );
      await expect(first).rejects.toThrow('offline');
      await Promise.all(rest);
      expect(send).toHaveBeenCalledTimes(1);
      // A phrase spoken after the chain drained must not overtake either.
      await submit('conv-fail', 'four', send);
      expect(send).toHaveBeenCalledTimes(1);
      expect(
        useStore
          .getState()
          .queuedPromptsByConv[
            'conv-fail'
          ].map((p) => [p.content, p.awaitingAcknowledgement]),
      ).toEqual([
        ['one', false],
        ['two', false],
        ['three', false],
        ['four', false],
      ]);
    });

    test('does not POST chained phrases after Live Mode ownership is rejected', async () => {
      const send = mock(async () => ({
        conversation_id: 'c',
        delivery: 'started' as const,
        liveModeRejected: true,
      }));
      await Promise.all(
        ['one', 'two', 'three'].map((text) =>
          submit('conv-reject', text, send),
        ),
      );
      expect(send).toHaveBeenCalledTimes(1);
      expect(
        useStore
          .getState()
          .queuedPromptsByConv[
            'conv-reject'
          ].map((p) => [p.content, p.awaitingAcknowledgement]),
      ).toEqual([
        ['two', false],
        ['three', false],
      ]);
    });

    test('does not serialize different conversations against each other', async () => {
      const gate = deferred();
      const calls: string[] = [];
      const send = mock(async (_p: string, text: string) => {
        calls.push(text);
        return text === 'slow' ? gate.promise : started;
      });
      const slow = submit('conv-a', 'slow', send);
      await submit('conv-b', 'fast', send);
      expect(calls).toEqual(['slow', 'fast']);
      gate.resolve(started);
      await slow;
    });
  });
});
