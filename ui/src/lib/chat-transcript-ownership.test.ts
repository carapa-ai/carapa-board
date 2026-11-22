// @ts-nocheck
import { describe, expect, it } from 'bun:test';
import type { TranscriptEntry } from '@/types';
import {
  canonicalSteeringIdsWithContinuation,
  reconcileTranscriptOwnership,
} from './chat-transcript-ownership';
import { deduplicateCanonicalAssistantEntries } from './chat-transcript-rendering';

const message = (
  id: string | undefined,
  role: 'user' | 'assistant',
  content: string,
  created_at?: string,
): TranscriptEntry => ({ id, type: 'message', role, content, created_at });

describe('canonical steering ownership', () => {
  it('keeps the browser boundary until the canonical continuation exists', () => {
    const steered = {
      ...message('prompt-2', 'user', 'Steer now', '2026-01-01T00:00:02.000Z'),
      steeringDelivery: 'steered' as const,
    };
    const before = message(
      'main-1',
      'assistant',
      'Main response',
      '2026-01-01T00:00:01.000Z',
    );
    expect(canonicalSteeringIdsWithContinuation([before, steered])).toEqual(
      new Set(),
    );
    expect(
      canonicalSteeringIdsWithContinuation([
        before,
        steered,
        message(
          'main-2',
          'assistant',
          'After steering',
          '2026-01-01T00:00:03.000Z',
        ),
      ]),
    ).toEqual(new Set(['prompt-2']));
  });

  it('does not transfer any boundary until every live boundary continues', () => {
    const first = {
      ...message('prompt-1', 'user', 'First steer', '2026-01-01T00:00:01.000Z'),
      steeringDelivery: 'steered' as const,
    };
    const second = {
      ...message(
        'prompt-2',
        'user',
        'Second steer',
        '2026-01-01T00:00:02.000Z',
      ),
      steeringDelivery: 'steered' as const,
    };
    const entries = [
      first,
      message(
        'main-1',
        'assistant',
        'First continuation',
        '2026-01-01T00:00:03.000Z',
      ),
      second,
    ];
    expect(
      canonicalSteeringIdsWithContinuation(
        entries,
        new Set(),
        new Set(['prompt-1', 'prompt-2']),
      ),
    ).toEqual(new Set());
    expect(
      canonicalSteeringIdsWithContinuation(
        [
          ...entries,
          message(
            'main-2',
            'assistant',
            'Second continuation',
            '2026-01-01T00:00:04.000Z',
          ),
        ],
        new Set(),
        new Set(['prompt-1', 'prompt-2']),
      ),
    ).toEqual(new Set(['prompt-1', 'prompt-2']));
  });

  it('hands consecutive steers to history before a subsequent prompt', () => {
    const steers = ['steer-1', 'steer-2', 'steer-3'].map((id) => ({
      ...message(id, 'user', id),
      steeringDelivery: 'steered' as const,
    }));
    const required = new Set(steers.map((entry) => entry.id));
    const acknowledged = new Set(['steer-2']);
    // The POST acknowledgement can precede the transcript delivery metadata.
    delete steers[1].steeringDelivery;
    const ownership = (entries: TranscriptEntry[]) =>
      canonicalSteeringIdsWithContinuation(entries, acknowledged, required);

    expect(ownership(steers)).toEqual(new Set());
    expect(
      ownership([...steers, message('reply', 'assistant', 'Shared reply')]),
    ).toEqual(required);
    // A stopped run may have no assistant continuation at all.
    expect(
      ownership([...steers, message('next-prompt', 'user', 'Next turn')]),
    ).toEqual(required);
    expect(
      ownership([
        ...steers,
        {
          ...message('pending', 'user', 'Still applying'),
          steeringDelivery: 'pending',
        },
      ]),
    ).toEqual(new Set());
  });
});

describe('pending steering ownership', () => {
  const pending = {
    ...message('pending-1', 'user', 'Typed mid-run'),
    steeringDelivery: 'pending' as const,
  };
  const ownership = (entries: TranscriptEntry[]) =>
    canonicalSteeringIdsWithContinuation(
      entries,
      new Set(),
      new Set(),
      new Set(['pending-1']),
    );

  it('hands a pending steer to the transcript once its own turn replied', () => {
    expect(ownership([pending])).toEqual(new Set());
    expect(
      ownership([pending, message('reply', 'assistant', 'Follow-up reply')]),
    ).toEqual(new Set(['pending-1']));
    expect(
      ownership([pending, message('next', 'user', 'Next prompt')]),
    ).toEqual(new Set(['pending-1']));
  });

  it('ignores a pending transcript row that is not in flight', () => {
    expect(
      canonicalSteeringIdsWithContinuation([
        pending,
        message('reply', 'assistant', 'Reply'),
      ]),
    ).toEqual(new Set());
  });
});

describe('reconcileTranscriptOwnership', () => {
  it('replaces an optimistic user entry with its canonical identity once', () => {
    const optimistic = message(
      'prompt-2',
      'user',
      'Follow up',
      '2026-01-01T00:00:02.000Z',
    );
    const canonical = message(
      'prompt-2',
      'user',
      'Follow up',
      '2026-01-01T00:00:02.100Z',
    );
    expect(reconcileTranscriptOwnership([optimistic], [canonical])).toEqual([
      canonical,
    ]);
  });

  it('replaces an optimistic attachment prompt with its canonical identity once', () => {
    const attachment = {
      type: 'image' as const,
      url: '/api/projects/project-1/attachments/image.png',
      mimetype: 'image/png',
      filename: 'image.png',
    };
    const optimistic: TranscriptEntry = {
      ...message(
        'prompt-2',
        'user',
        'Inspect this image\n📎 image.png',
        '2026-01-01T00:00:02.000Z',
      ),
      attachments: [attachment],
    };
    const canonical: TranscriptEntry = {
      ...message(
        'prompt-2',
        'user',
        'Inspect this image\n\n[Attached files]\n- image.png: /workspace/ipc/image.png',
        '2026-01-01T00:00:02.100Z',
      ),
      attachments: [attachment],
    };

    expect(reconcileTranscriptOwnership([optimistic], [canonical])).toEqual([
      canonical,
    ]);
  });

  it('keeps authoritative prepended-page order while restoring a missing turn', () => {
    const older = message('older', 'user', 'Older', '2026-01-01T00:00:00.000Z');
    const prompt = message(
      'prompt-1',
      'user',
      'Prompt',
      '2026-01-01T00:00:01.000Z',
    );
    const response = message(
      'main-1',
      'assistant',
      'Response',
      '2026-01-01T00:00:02.000Z',
    );
    const followUp = message(
      'prompt-2',
      'user',
      'Follow up',
      '2026-01-01T00:00:03.000Z',
    );
    expect(
      reconcileTranscriptOwnership(
        [prompt, response, followUp],
        [older, prompt, followUp],
      ),
    ).toEqual([older, prompt, response, followUp]);
  });

  it('matches unchanged id-less assistant entries without duplicating them', () => {
    const assistant = message(
      undefined,
      'assistant',
      'Stable response',
      '2026-01-01T00:00:02.000Z',
    );
    const incoming = [{ ...assistant }];
    expect(reconcileTranscriptOwnership([assistant], incoming)).toBe(incoming);
  });

  it('anchors a timestamp-less missing assistant before the next user turn', () => {
    const oldUser = message(
      'old-user',
      'user',
      'Earlier prompt',
      '2026-01-01T00:00:01.000Z',
    );
    const oldAssistant = message(
      'transcript-entry-1',
      'assistant',
      'OLD RESPONSE',
      undefined,
    );
    const newUser = message(
      'new-user',
      'user',
      'New prompt',
      '2026-01-01T00:00:03.000Z',
    );
    const newAssistant = message(
      'transcript-entry-3',
      'assistant',
      'NEW RESPONSE',
      undefined,
    );

    const reconciled = reconcileTranscriptOwnership(
      [oldUser, oldAssistant, newUser, newAssistant],
      [oldUser, newUser, { ...newAssistant, id: 'transcript-entry-1' }],
    );
    expect(reconciled).toEqual([
      oldUser,
      oldAssistant,
      newUser,
      { ...newAssistant, id: 'transcript-entry-1' },
    ]);
    const rendered = deduplicateCanonicalAssistantEntries(reconciled);
    expect(rendered).toEqual(reconciled);
    expect(
      rendered.filter((entry) => entry.content === 'NEW RESPONSE'),
    ).toHaveLength(1);
  });

  it('matches an unchanged id-less user row without coalescing distinct text matches', () => {
    const first = message(
      undefined,
      'user',
      'Repeat this',
      '2026-01-01T00:00:01.000Z',
    );
    const second = message(
      undefined,
      'user',
      'Repeat this',
      '2026-01-01T00:00:02.000Z',
    );
    const incoming = [{ ...first }, { ...second }];

    expect(reconcileTranscriptOwnership([first, second], incoming)).toBe(
      incoming,
    );
  });

  it('keeps one provider message through V1 refetch and canonical restore', () => {
    const runId = 'a789edd4-6ce4-426e-9463-0b6a04c1d5f6';
    const providerMessageId =
      'msg_05ce2c21ffadb308016a9739fceed487d28fc43cd2045c9d03';
    const canonical = message(
      providerMessageId,
      'assistant',
      'acum',
      '2026-09-01T23:47:00.000Z',
    );
    const projected = message(
      `${runId}-v1-5-${providerMessageId}`,
      'assistant',
      'acum',
      '2026-09-01T23:47:00.000Z',
    );
    const attribution = {
      id: providerMessageId,
      type: 'ai_user_attribution',
      role: 'assistant',
      content: '',
      created_at: '2026-09-01T23:47:00.000Z',
      agent_name: 'ai-main:angy',
    } as TranscriptEntry;

    const refetched = [projected, attribution];
    const stableAfterRefetch = reconcileTranscriptOwnership(
      [canonical],
      refetched,
    );
    expect(stableAfterRefetch).toBe(refetched);

    const restored = [canonical, attribution];
    expect(reconcileTranscriptOwnership(stableAfterRefetch, restored)).toBe(
      restored,
    );
    expect(
      restored.filter(
        (entry) => entry.type === 'message' && entry.role === 'assistant',
      ),
    ).toEqual([canonical]);
  });

  it('reconciles a terminal live message with an aggregated post-steering segment', () => {
    const providerMessageId = 'msg_terminal';
    const canonical = message(
      providerMessageId,
      'assistant',
      'Final',
      '2026-09-01T23:47:00.000Z',
    );
    const postSteering = {
      ...message(
        'run-v1-5-msg_first',
        'assistant',
        'TailFinal',
        '2026-09-01T23:47:00.000Z',
      ),
      canonicalMessageId: providerMessageId,
    };
    const attribution = {
      id: providerMessageId,
      type: 'ai_user_attribution',
      role: 'assistant',
      content: '',
    } as TranscriptEntry;
    const refetched = [postSteering, attribution];

    expect(reconcileTranscriptOwnership([canonical], refetched)).toBe(
      refetched,
    );
  });

  it('removes a cached terminal alias when replay contains its aggregated owner', () => {
    const providerMessageId =
      'msg_0a1c967f5b05d971016a974a8784dc87d29c10b5a0db93b3cd';
    const aggregate = {
      ...message(
        'e10cbadb-e48f-41f8-9d0a-1da63d72ad9d-v1-64-msg_first',
        'assistant',
        'Full multi-message run including the final answer',
        '2026-09-01T21:58:33.976Z',
      ),
      canonicalMessageId: providerMessageId,
    };
    const liveTerminal = message(
      providerMessageId,
      'assistant',
      'The final answer',
      '2026-09-01T21:58:33.976Z',
    );
    const attribution = {
      id: providerMessageId,
      type: 'ai_user_attribution',
      role: 'assistant',
      content: '',
    } as TranscriptEntry;
    const refetched = [aggregate, attribution];

    expect(
      reconcileTranscriptOwnership(
        [aggregate, liveTerminal, attribution],
        refetched,
      ),
    ).toBe(refetched);
  });
});
