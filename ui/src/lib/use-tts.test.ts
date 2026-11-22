// Bun supplies these test globals at runtime; the UI package intentionally
// does not depend on Bun's type declarations.
// @ts-nocheck
import { describe, expect, it } from 'bun:test';
import { liveStatusesFromMarkdown, speechForLiveActivity, validateLiveStatus } from './live-speech-protocol';
import { cancelSpeech, isBackgroundCompletionBlocked, queueSpeech, type SpeechItem } from './live-speech-queue';
import { synthesizeLiveStatus } from './live-speech-client';

describe('Live speech protocol', () => {
  it('keeps bootstrap state, previews, and historical titles silent', () => {
    expect(speechForLiveActivity({ conversationId: 'a', title: 'Historical title', state: 'idle', status: null }, 'a', false)).toBeNull();
    expect(speechForLiveActivity({ conversationId: 'a', title: 'Historical title', state: 'working', status: null }, 'a', false)).toBeNull();
    expect(speechForLiveActivity({ conversationId: 'a', title: 'Historical title', state: 'working', status: 'Working' }, 'a', false)).toBeNull();
    expect(speechForLiveActivity({ conversationId: 'a', title: 'Historical title', state: 'working', status: 'Running' }, 'a', false)).toBeNull();
    expect(speechForLiveActivity({ conversationId: 'a', title: 'Historical title', state: 'working', status: 'Running focused tests' }, 'a', false)).toEqual({ text: 'Running focused tests', priority: 'focused' });
    expect(speechForLiveActivity({ conversationId: 'b', title: 'Historical title', state: 'needs_input', status: null }, 'a', false)).toEqual({ text: 'A conversation needs input', priority: 'background-blocker' });
  });

  it('announces a background lifecycle completion only when enabled', () => {
    const activity = {
      conversationId: 'background',
      title: 'Background work',
      state: 'complete',
      status: null,
      completionSummary: 'Agent completed the response.',
    };
    expect(speechForLiveActivity(activity, 'focused', false)).toBeNull();
    expect(speechForLiveActivity(activity, 'focused', true)).toEqual({
      text: 'Agent completed the response.',
      priority: 'background-completion',
    });
    expect(speechForLiveActivity(activity, 'background', true)).toBeNull();
  });
  it('coalesces newer status and rejects whole responses', () => {
    expect(validateLiveStatus('Build is 42% complete')).toBe('Build is 42% complete');
    expect(validateLiveStatus('first\nsecond')).toBe('first second');
    expect(validateLiveStatus('a'.repeat(240))).toBe('a'.repeat(240));
    expect(validateLiveStatus('a'.repeat(2_000))).toBe('a'.repeat(2_000));
    expect(validateLiveStatus('```assistant\nwhole response\n```')).toBeNull();
    expect(validateLiveStatus('concise status')).toBeNull();
    expect(validateLiveStatus('  CONCISE   STATUS  ')).toBeNull();
    let queue: SpeechItem[] = [];
    queue = queueSpeech(queue, { conversationId: 'a', text: 'Working', priority: 'focused', sequence: 1 });
    queue = queueSpeech(queue, { conversationId: 'a', text: 'Needs input', priority: 'background-blocker', sequence: 2 });
    expect(queue).toHaveLength(1);
    expect(queue[0].text).toBe('Needs input');
  });

  it('extracts Live narration for replay without treating code examples as audio', () => {
    expect(liveStatusesFromMarkdown('[[live: First step]]\n\nAnswer\n\n[[live: Second step]]'))
      .toEqual(['First step', 'Second step']);
    expect(liveStatusesFromMarkdown('Use `[[live: example]]` in Live Mode.')).toEqual([]);
    expect(liveStatusesFromMarkdown('Use `\n\n[[live: example]]\n\n` in Live Mode.')).toEqual([]);
    const longStatus = `A long update. ${'Another complete sentence. '.repeat(20)}`.trim();
    expect(longStatus.length).toBeGreaterThan(240);
    expect(liveStatusesFromMarkdown(`[[live: ${longStatus}]]`)).toEqual([longStatus]);
  });

  it('drops only the switched conversation', () => {
    const queue = queueSpeech(queueSpeech([], { conversationId: 'old', text: 'Old', priority: 'focused', sequence: 1 }), { conversationId: 'other', text: 'Other', priority: 'focused', sequence: 2 });
    expect(cancelSpeech(queue, 'old').map((item) => item.conversationId)).toEqual(['other']);
  });

  it('cancels queued work on barge-in', () => {
    expect(cancelSpeech([{ conversationId: 'a', text: 'Working', priority: 'focused', sequence: 1 }])).toEqual([]);
  });

  it('orders blockers before focused work and defers completion', () => {
    let queue: SpeechItem[] = [];
    queue = queueSpeech(queue, { conversationId: 'bg', text: 'Done', priority: 'background-completion', sequence: 1 });
    queue = queueSpeech(queue, { conversationId: 'focus', text: 'Working', priority: 'focused', sequence: 2 });
    queue = queueSpeech(queue, { conversationId: 'block', text: 'Needs input', priority: 'background-blocker', sequence: 3 });
    expect(queue.map((item) => item.conversationId)).toEqual(['block', 'focus', 'bg']);
    expect(isBackgroundCompletionBlocked('focus', 'focus', queue)).toBe(true);
  });

  it('preserves completed reply order and deduplicates message ids', () => {
    let queue: SpeechItem[] = [];
    queue = queueSpeech(queue, { kind: 'status', conversationId: 'focus', text: 'Working', priority: 'focused', sequence: 1 });
    queue = queueSpeech(queue, { kind: 'reply', messageId: 'm1', conversationId: 'focus', text: 'First', priority: 'focused', sequence: 2 });
    queue = queueSpeech(queue, { kind: 'reply', messageId: 'm2', conversationId: 'focus', text: 'Second', priority: 'focused', sequence: 3 });
    queue = queueSpeech(queue, { kind: 'reply', messageId: 'm1', conversationId: 'focus', text: 'Duplicate', priority: 'focused', sequence: 4 });
    expect(queue.map((item) => item.messageId || item.text)).toEqual(['m1', 'm2', 'Working']);
  });

  it('keeps Work narration snippets in arrival order without coalescing', () => {
    let queue: SpeechItem[] = [];
    queue = queueSpeech(queue, { kind: 'narration', conversationId: 'work', text: 'First', priority: 'focused', sequence: 1 });
    queue = queueSpeech(queue, { kind: 'narration', conversationId: 'work', text: 'Second', priority: 'focused', sequence: 2 });
    queue = queueSpeech(queue, { kind: 'narration', conversationId: 'work', text: 'Third', priority: 'focused', sequence: 3 });
    expect(queue.map((item) => item.text)).toEqual(['First', 'Second', 'Third']);
  });

  it('synthesizes Work narration with the active persona voice profile', async () => {
    let requestBody: Record<string, unknown> | undefined;
    await synthesizeLiveStatus(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(new Uint8Array([1]), { status: 200 });
    }, '/api/tts/synthesize', 'conversation', 'Checking the implementation', 'registry', {
      voice: 'persona-voice',
      lang: 'ro',
    });
    expect(requestBody).toMatchObject({
      text: 'Checking the implementation',
      voice: 'persona-voice',
      lang: 'ro',
    });
  });
});
