// @ts-nocheck
import { afterEach, describe, expect, it } from 'bun:test';
import { useStore } from './store';

afterEach(() =>
  useStore.setState({
    activeStreamKeyByConv: {},
    chatStreamRetiredByConv: {},
    prevStreamKeyByConv: {},
    composingNewConversationByProject: {},
  }),
);

describe('chat stream conversation isolation', () => {
  it('gives a run UUID to only its latest conversation owner', () => {
    const store = useStore.getState();
    store.setActiveStreamKeyForConv('conv-pw8j8k', 'run-shared');
    store.setActiveStreamKeyForConv('conv-79ox90', 'run-shared');

    expect(useStore.getState().activeStreamKeyByConv).toEqual({
      'conv-79ox90': 'run-shared',
    });
  });

  it('removes a stale previous-run alias from another conversation', () => {
    useStore.setState({
      activeStreamKeyByConv: { 'conv-pw8j8k': 'run-current' },
      prevStreamKeyByConv: { 'conv-pw8j8k': 'run-shared' },
    });

    useStore.getState().setActiveStreamKeyForConv('conv-79ox90', 'run-shared');

    expect(useStore.getState().prevStreamKeyByConv).toEqual({});
    expect(useStore.getState().activeStreamKeyByConv).toEqual({
      'conv-pw8j8k': 'run-current',
      'conv-79ox90': 'run-shared',
    });
  });

  it('retires stale stream ownership without deleting detached output', () => {
    const store = useStore.getState();
    store.setActiveStreamKeyForConv('conv-stale', 'run-stale');
    store.setPrevStreamKeyForConv('conv-stale', 'run-previous');
    store.setChatRunning('conv-stale', true);
    store.setChatOutput('run-stale', 'partial response');

    store.retireChatStreamForConv('conv-stale');

    const state = useStore.getState();
    expect(state.activeStreamKeyByConv['conv-stale']).toBeUndefined();
    expect(state.prevStreamKeyByConv['conv-stale']).toBeUndefined();
    expect(state.chatRunningByConv['conv-stale']).toBeUndefined();
    expect(state.chatStreamRetiredByConv['conv-stale']).toBe(true);
    expect(state.chatStreamingOutput['run-stale']).toBe('partial response');

    state.clearRetiredChatStreamForConv('conv-stale');
    expect(
      useStore.getState().chatStreamRetiredByConv['conv-stale'],
    ).toBeUndefined();

    state.setActiveStreamKeyForConv('conv-stale', 'run-reconnected');
    expect(
      useStore.getState().chatStreamRetiredByConv['conv-stale'],
    ).toBeUndefined();
  });

  it('clears retired stream markers on logout', () => {
    useStore.setState({ chatStreamRetiredByConv: { 'conv-user': true } });
    useStore.getState().resetForLogout();
    expect(useStore.getState().chatStreamRetiredByConv).toEqual({});
  });
});

it('keeps one oversized task entry whole in one snapshot', () => {
  const store = useStore.getState();
  store.claimTaskStream('task-snapshot', 'run-snapshot');
  store.appendOutput('task-snapshot', 'x'.repeat(40_000), 'message:large');

  expect(useStore.getState().streamingOutputSnapshots['task-snapshot']).toEqual(
    {
      content: 'x'.repeat(40_000),
      startOffset: 0,
      entries: [
        {
          id: 'message:large',
          content: 'x'.repeat(40_000),
          startOffset: 0,
          endOffset: 40_000,
          complete: true,
        },
      ],
    },
  );
  useStore.getState().clearOutput('task-snapshot');
});

it('groups interleaved task tool fragments by semantic entry identity', () => {
  const store = useStore.getState();
  store.claimTaskStream('task-interleaved', 'run-interleaved');
  store.appendOutput('task-interleaved', 'A-start', 'tool_call:A');
  store.appendOutput('task-interleaved', 'B-start', 'tool_call:B');
  store.appendOutput('task-interleaved', 'A-result', 'tool_call:A');
  store.appendOutput('task-interleaved', 'B-result', 'tool_call:B');

  expect(
    useStore.getState().streamingOutputSnapshots['task-interleaved'],
  ).toEqual({
    content: 'A-startA-resultB-startB-result',
    startOffset: 0,
    entries: [
      {
        id: 'tool_call:A',
        content: 'A-startA-result',
        startOffset: 0,
        endOffset: 15,
        complete: true,
      },
      {
        id: 'tool_call:B',
        content: 'B-startB-result',
        startOffset: 15,
        endOffset: 30,
        complete: true,
      },
    ],
  });
  store.clearOutput('task-interleaved');
});

it('keeps interleaved open task entries until their completion arrives', () => {
  const store = useStore.getState();
  store.claimTaskStream('task-open-entries', 'run-open-entries');
  store.appendOutput('task-open-entries', 'A-start', 'tool_call:A', false);
  store.appendOutput(
    'task-open-entries',
    'B'.repeat(40_000),
    'tool_call:B',
    false,
  );

  expect(
    useStore
      .getState()
      .streamingOutputEntries['task-open-entries'].map((entry) => entry.id),
  ).toEqual(['tool_call:A', 'tool_call:B']);
  store.appendOutput('task-open-entries', 'A-result', 'tool_call:A', true);
  const retained =
    useStore.getState().streamingOutputEntries['task-open-entries'];
  expect(retained).toHaveLength(1);
  expect(retained[0]).toMatchObject({ id: 'tool_call:B', complete: false });
  store.clearOutput('task-open-entries');
});

it('merges contiguous absolute task output ranges', () => {
  const store = useStore.getState();
  store.claimTaskStream('task-range', 'run-range');
  store.setTaskOutput('task-range', 'A'.repeat(10), 0);
  store.setTaskOutput('task-range', 'B'.repeat(10), 10);

  const state = useStore.getState();
  expect(state.streamingOutput['task-range']).toBe(
    'A'.repeat(10) + 'B'.repeat(10),
  );
  expect(state.streamingOutputStartOffsets['task-range']).toBe(0);
  store.clearOutput('task-range');
});
