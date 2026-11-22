// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import {
  discardQueuedPromptBatch,
  isDeletableQueuedPrompt,
  isMutableQueuedPrompt,
  markQueuedPromptBatchAwaitingAcknowledgement,
  reconcileQueuedPromptReceipts,
  releaseQueuedPromptBatchForDrain,
  removeAcknowledgedQueuedPromptBatch,
  replaceQueuedPromptBatchWithServerOwned,
  restoreFailedQueuedPromptBatch,
} from './queued-prompt-lifecycle';

describe('page queued prompt failure restoration', () => {
  test('restores the exact failed batch ahead of later work without duplication', () => {
    const first = {
      id: 'first',
      content: 'first',
      bubbleContent: 'first',
      memoryContextLevel: 'deep' as const,
      liveMode: true,
      liveModeSessionId: 'session-1',
      liveModeKind: 'work' as const,
    };
    const second = {
      id: 'second',
      content: 'second',
      bubbleContent: 'second',
      memoryContextLevel: 'off' as const,
    };
    const later = {
      id: 'later',
      content: 'later',
      bubbleContent: 'later',
      memoryContextLevel: 'standard' as const,
    };

    expect(restoreFailedQueuedPromptBatch([later], [first, second])).toEqual([
      first,
      second,
      later,
    ]);
    expect(
      restoreFailedQueuedPromptBatch([first, second], [first, second]),
    ).toEqual([first, second]);
    const firstQueuedResponse = restoreFailedQueuedPromptBatch(
      [],
      [first, second],
    );
    const repeatedQueuedResponse = restoreFailedQueuedPromptBatch(
      [],
      firstQueuedResponse,
    );
    expect(repeatedQueuedResponse.map((prompt) => prompt.id).join('|')).toBe(
      'first|second',
    );
  });
});

test('discards the complete terminal batch without removing later work', () => {
  const first = {
    id: 'stale-1',
    content: 'first stale prompt',
    bubbleContent: 'first stale prompt',
    awaitingAcknowledgement: true,
  };
  const second = {
    id: 'stale-2',
    content: 'second stale prompt',
    bubbleContent: 'second stale prompt',
    awaitingAcknowledgement: true,
  };
  const later = {
    id: 'later',
    content: 'later prompt',
    bubbleContent: 'later prompt',
  };

  expect(
    discardQueuedPromptBatch([first, second, later], [first, second]),
  ).toEqual([later]);
});

test('discards an id-less legacy batch after acknowledgement marking clones it', () => {
  const stale = {
    content: 'legacy stale prompt',
    bubbleContent: 'legacy stale prompt',
    attachments: [{ type: 'file' as const, path: 'notes.txt' }],
  };
  const laterDuplicate = { ...stale };
  const marked = markQueuedPromptBatchAwaitingAcknowledgement(
    [stale, laterDuplicate],
    [stale],
  );

  expect(marked[0]).not.toBe(stale);
  expect(discardQueuedPromptBatch(marked, [stale])).toEqual([laterDuplicate]);
});

test('persona ownership atomically replaces every browser batch item', () => {
  const first = { id: 'first', content: 'one', bubbleContent: 'one' };
  const second = { id: 'second', content: 'two', bubbleContent: 'two' };
  const later = { id: 'later', content: 'later', bubbleContent: 'later' };
  const durable = {
    id: 'first',
    content: 'one\n\ntwo',
    bubbleContent: 'one\n\ntwo',
    serverOwned: true,
  };
  expect(
    replaceQueuedPromptBatchWithServerOwned(
      [first, second, later],
      [first, second],
      durable,
    ),
  ).toEqual([durable, later]);
  expect(
    replaceQueuedPromptBatchWithServerOwned([], [first, second], durable),
  ).toEqual([]);
});

test('page drain keeps a provisional batch visible until persona acknowledgement', () => {
  const first = { id: 'first', content: 'one', bubbleContent: 'one' };
  const second = { id: 'second', content: 'two', bubbleContent: 'two' };
  const durable = {
    id: 'first',
    content: 'one\n\ntwo',
    bubbleContent: 'one\n\ntwo',
    serverOwned: true,
  };
  const provisional = markQueuedPromptBatchAwaitingAcknowledgement(
    [first, second],
    [first, second],
  );
  expect(provisional).toEqual([
    { ...first, awaitingAcknowledgement: true },
    { ...second, awaitingAcknowledgement: true },
  ]);
  expect(
    replaceQueuedPromptBatchWithServerOwned(
      provisional,
      [first, second],
      durable,
    ),
  ).toEqual([durable]);
});

test('a terminal release wins over a late direct ownership acknowledgement', () => {
  const first = { id: 'first', content: 'one', bubbleContent: 'one' };
  const released = {
    ...first,
    serverReleased: true,
  };
  const result = replaceQueuedPromptBatchWithServerOwned([released], [first], {
    ...first,
    serverOwned: true,
  });
  expect(result).toEqual([
    expect.objectContaining({ id: first.id, serverReleased: true }),
  ]);
  expect(result[0]?.serverOwned).toBeUndefined();
});

test.each(['persona', 'direct'])(
  'a stale release from an earlier attempt yields to a %s server-owned replacement',
  (serverQueueOwner) => {
    const base = { id: 'p', content: 'x', bubbleContent: 'x' };
    const replacement = { ...base, serverOwned: true, serverQueueOwner };
    expect(
      replaceQueuedPromptBatchWithServerOwned(
        [{ ...base, serverReleased: true, awaitingAcknowledgement: true }],
        [base],
        replacement,
      ),
    ).toEqual([replacement]);
  },
);

test('a release received while the drain is in flight stays browser-owned', () => {
  const base = { id: 'p', content: 'x', bubbleContent: 'x' };
  const released = reconcileQueuedPromptReceipts(
    [{ ...base, awaitingAcknowledgement: true }],
    { consumed: [], released: ['p'] },
  );
  const result = replaceQueuedPromptBatchWithServerOwned(released, [base], {
    ...base,
    serverOwned: true,
    serverQueueOwner: 'persona',
  });
  expect(result).toEqual([expect.objectContaining({ serverReleased: true })]);
  expect(result[0]?.serverOwned).toBeUndefined();
});

test('releases a provisional batch without changing its stable identity', () => {
  const pending = {
    id: 'stable',
    content: 'pending',
    bubbleContent: 'pending',
    awaitingAcknowledgement: true,
  };
  expect(releaseQueuedPromptBatchForDrain([pending], [pending])).toEqual([
    {
      id: 'stable',
      content: 'pending',
      bubbleContent: 'pending',
    },
  ]);
});

test('direct HTTP ownership clears a provisional batch without a WebSocket event', () => {
  const first = {
    id: 'direct-1',
    content: 'first',
    bubbleContent: 'first',
    awaitingAcknowledgement: true,
  };
  const second = {
    id: 'direct-2',
    content: 'second',
    bubbleContent: 'second',
    awaitingAcknowledgement: true,
  };
  const later = { id: 'later', content: 'later', bubbleContent: 'later' };
  expect(
    removeAcknowledgedQueuedPromptBatch(
      [first, second, later],
      [first, second],
    ),
  ).toEqual([later]);
});

test('server consumption removes a Direct mirror and wins over stale release', () => {
  const direct = {
    id: 'direct-followup',
    content: 'owned follow-up',
    bubbleContent: 'owned follow-up',
    serverOwned: true,
    serverQueueOwner: 'direct' as const,
  };
  const browser = {
    id: 'browser-queued',
    content: 'browser queue',
    bubbleContent: 'browser queue',
  };

  expect(
    reconcileQueuedPromptReceipts([direct, browser], {
      consumed: [direct.id],
      released: [direct.id],
    }),
  ).toEqual([{ ...direct, consumedByServer: true }, browser]);
});
test('stale release cannot resurrect a consumed prompt', () => {
  const consumed = {
    id: 'consumed-before-release',
    content: 'already consumed',
    bubbleContent: 'already consumed',
    serverOwned: true,
    consumedByServer: true,
  };
  const current = [consumed];

  const reconciled = reconcileQueuedPromptReceipts(current, {
    consumed: [],
    released: [consumed.id],
  });

  expect(reconciled).toBe(current);
});

test('consumption transfers a released retry to a server-owned receipt', () => {
  const releasedRetry = {
    id: 'released-retry',
    content: 'retry me',
    bubbleContent: 'retry me',
    awaitingAcknowledgement: true,
    serverReleased: true,
  };

  expect(
    reconcileQueuedPromptReceipts([releasedRetry], {
      consumed: [releasedRetry.id],
      released: [],
    }),
  ).toEqual([
    {
      id: releasedRetry.id,
      content: releasedRetry.content,
      bubbleContent: releasedRetry.bubbleContent,
      serverOwned: true,
      serverQueueOwner: 'server',
      consumedByServer: true,
    },
  ]);
});

test('server release returns a durable mirror to browser drain ownership', () => {
  const persona = {
    id: 'persona-boundary',
    content: 'persona queue',
    bubbleContent: 'persona queue',
    serverOwned: true,
    awaitingAcknowledgement: true,
  };

  expect(
    reconcileQueuedPromptReceipts([persona], {
      consumed: [],
      released: [persona.id],
    }),
  ).toEqual([
    {
      id: persona.id,
      content: persona.content,
      bubbleContent: persona.bubbleContent,
      serverReleased: true,
    },
  ]);
});

test('server withdrawal removes a restored prompt owner', () => {
  const restored = {
    id: 'restored-persona-prompt',
    content: 'edit this after refresh',
    bubbleContent: 'edit this after refresh',
    serverOwned: true,
    serverQueueOwner: 'persona' as const,
  };

  expect(
    reconcileQueuedPromptReceipts([restored], {
      consumed: [],
      released: [],
      withdrawn: [restored.id],
    }),
  ).toEqual([]);
});

test('classifies ownerless legacy receipts from authoritative reconciliation', () => {
  const prompts = [
    {
      id: 'legacy-persona',
      content: 'persona pending',
      bubbleContent: 'persona pending',
      serverOwned: true,
    },
    {
      id: 'legacy-direct',
      content: 'direct pending',
      bubbleContent: 'direct pending',
      serverOwned: true,
    },
    {
      id: 'legacy-background',
      content: 'already accepted',
      bubbleContent: 'already accepted',
      serverOwned: true,
    },
  ];

  expect(
    reconcileQueuedPromptReceipts(prompts, {
      consumed: [],
      released: [],
      queueOwners: {
        'legacy-persona': 'persona',
        'legacy-direct': 'direct',
      },
    }),
  ).toEqual([
    { ...prompts[0], serverQueueOwner: 'persona' },
    { ...prompts[1], serverQueueOwner: 'direct' },
    { ...prompts[2], serverQueueOwner: 'server' },
  ]);
});

test('a server-owned Direct prompt is deletable but not editable', () => {
  const prompt = (serverQueueOwner?: 'persona' | 'direct' | 'server') => ({
    id: `prompt-${serverQueueOwner ?? 'browser'}`,
    content: 'queued',
    bubbleContent: 'queued',
    ...(serverQueueOwner ? { serverOwned: true, serverQueueOwner } : {}),
  });

  expect(isDeletableQueuedPrompt(prompt('direct'))).toBe(true);
  expect(isMutableQueuedPrompt(prompt('direct'))).toBe(false);
  expect(isDeletableQueuedPrompt(prompt())).toBe(true);
  expect(isDeletableQueuedPrompt(prompt('persona'))).toBe(true);
  expect(isDeletableQueuedPrompt(prompt('server'))).toBe(false);
});
