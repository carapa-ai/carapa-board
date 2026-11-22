import { afterEach, describe, expect, test } from 'bun:test';
import {
  clearLiveActivitiesForTest,
  getLiveActivities,
  LiveMarkerParser,
  stripLiveMarkers,
  upsertLiveActivity,
  validateLiveStatus,
} from './live-activity.js';
import {
  loadState,
  registerGroup,
  unregisterGroup,
} from '../../state-manager.js';
import {
  filterLiveActivitiesForAccess,
  liveActivityProjectFolder,
} from '../objectives/ws-events.js';

afterEach(() => clearLiveActivitiesForTest());

describe('live marker protocol', () => {
  test('strips a split exact marker and emits only its bounded status', () => {
    const parser = new LiveMarkerParser();
    expect(parser.push('Hello [[live: Inspecting').visible).toBe('Hello ');
    const second = parser.push(' files]] world');
    expect(second).toEqual({
      visible: ' world',
      statuses: ['Inspecting files'],
    });
    expect(parser.finish()).toEqual({ visible: '', statuses: [] });
  });

  test('does not publish malformed marker text', () => {
    expect(validateLiveStatus('line one\nline two')).toBeNull();
    expect(stripLiveMarkers('A [[live: bad\nstatus]] B').content).toBe(
      'A [[live: bad\nstatus]] B',
    );
  });

  test('strips and emits a long marker split across stream chunks', () => {
    const status =
      `Reviewing the implementation. ${'Long status sentence. '.repeat(20)}`.trim();
    expect(status.length).toBeGreaterThan(240);
    const parser = new LiveMarkerParser();
    expect(parser.push(`Before [[live: ${status.slice(0, 180)}`).visible).toBe(
      'Before ',
    );
    expect(parser.push(`${status.slice(180)}]] after`)).toEqual({
      visible: ' after',
      statuses: [status],
    });
    expect(parser.finish()).toEqual({ visible: '', statuses: [] });
  });

  test('silently consumes the protocol example placeholder', () => {
    expect(validateLiveStatus('concise status')).toBeNull();
    expect(validateLiveStatus('  CONCISE   STATUS  ')).toBeNull();
    expect(stripLiveMarkers('[[live: concise status]]')).toEqual({
      content: '',
      statuses: [],
    });
    expect(stripLiveMarkers('before [[live: CONCISE STATUS]] after')).toEqual({
      content: 'before  after',
      statuses: [],
    });
  });

  test('preserves marker-like text in inline code', () => {
    expect(stripLiveMarkers('Use `[[live: ...]]` to report progress.')).toEqual(
      {
        content: 'Use `[[live: ...]]` to report progress.',
        statuses: [],
      },
    );
    const parser = new LiveMarkerParser();
    expect(parser.push('Use `[[li').visible).toBe('Use `');
    expect(parser.push('ve: example]]` here.')).toEqual({
      visible: '[[live: example]]` here.',
      statuses: [],
    });
  });

  test('preserves every byte of unfinished and malformed marker candidates', () => {
    const render = (...chunks: string[]) => {
      const parser = new LiveMarkerParser();
      const output =
        chunks.map((chunk) => parser.push(chunk).visible).join('') +
        parser.finish().visible;
      return output;
    };
    const unfinished = 'before [[live: investigating files';
    expect(render(unfinished)).toBe(unfinished);
    expect(render('[[live: ', 'prefix followed by prose')).toBe(
      '[[live: prefix followed by prose',
    );
    expect(render('[[live: valid-looking]x')).toBe('[[live: valid-looking]x');
    const longUnfinished = `[[live: ${'x'.repeat(2_000)}`;
    expect(render(longUnfinished)).toBe(longUnfinished);
  });
});

describe('live activity lifecycle and reconnect filtering', () => {
  test('records safe lifecycle fields only', () => {
    upsertLiveActivity({
      folder: 'alpha',
      conversation_id: 'one',
      state: 'working',
      preview: 'Question',
      status: 'Reading files',
    });
    upsertLiveActivity({
      folder: 'alpha',
      conversation_id: 'one',
      state: 'complete',
      completion_summary: 'Agent completed the response.',
    });
    expect(getLiveActivities()).toMatchObject([
      {
        folder: 'alpha',
        conversation_id: 'one',
        state: 'complete',
        preview: 'Question',
        completion_summary: 'Agent completed the response.',
      },
    ]);
  });

  test('reconnect snapshots keep implicit users to their shared conversations', () => {
    upsertLiveActivity({
      folder: 'alpha',
      conversation_id: 'shared',
      state: 'working',
    });
    upsertLiveActivity({
      folder: 'alpha',
      conversation_id: 'private',
      state: 'working',
    });
    upsertLiveActivity({
      folder: 'other',
      conversation_id: 'elsewhere',
      state: 'working',
    });
    const snapshot = filterLiveActivitiesForAccess(getLiveActivities(), {
      isAdmin: false,
      explicitProjects: new Set<string>(),
      implicitProjectConvIds: new Map([['alpha', new Set(['shared'])]]),
    });
    expect(snapshot.map((item) => item.conversation_id)).toEqual(['shared']);
  });

  test('admin reconnect snapshots drop another user’s personal main', async () => {
    const now = new Date().toISOString();
    await loadState();
    for (const [folder, userId] of [
      ['main-la-owner', 'la-owner'],
      ['main-la-admin', 'la-admin'],
      ['main-la-orphan', undefined],
    ] as const) {
      await registerGroup(`${folder}@kanban`, {
        name: folder,
        folder,
        jid: `${folder}@kanban`,
        trigger: '!',
        added_at: now,
        is_main: true,
        user_id: userId,
      });
    }
    try {
      for (const folder of [
        'main-la-owner',
        'main-la-admin',
        'main-la-orphan',
        'ordinary',
      ]) {
        upsertLiveActivity({
          folder,
          conversation_id: `c-${folder}`,
          state: 'working',
        });
      }
      const admin = {
        isAdmin: true,
        explicitProjects: new Set<string>(),
        implicitProjectConvIds: new Map<string, Set<string>>(),
      };
      const folders = (userId?: string) =>
        filterLiveActivitiesForAccess(getLiveActivities(), admin, userId)
          .map((item) => item.folder)
          .sort();
      // An ownerless main is foreign to any identified admin.
      expect(folders('la-admin')).toEqual(['main-la-admin', 'ordinary']);
      // Without a user id, owned mains are foreign to everyone.
      expect(folders()).not.toContain('main-la-owner');
      expect(folders()).not.toContain('main-la-admin');
      expect(folders()).toContain('ordinary');
    } finally {
      for (const folder of ['main-la-owner', 'main-la-admin', 'main-la-orphan'])
        await unregisterGroup(`${folder}@kanban`);
    }
  });

  test('reconnect snapshots fail closed when access cannot be loaded', () => {
    upsertLiveActivity({
      folder: 'alpha',
      conversation_id: 'private',
      state: 'working',
    });
    expect(filterLiveActivitiesForAccess(getLiveActivities(), null)).toEqual(
      [],
    );
  });

  test('objective streams retain objective folder while live state uses project scope', () => {
    const objectiveStream = { folder: 'objective-1', project_id: 'project-1' };
    const normalStream = { folder: 'project-2' };
    expect(liveActivityProjectFolder(objectiveStream)).toBe('project-1');
    expect(liveActivityProjectFolder(normalStream)).toBe('project-2');
    upsertLiveActivity({
      folder: liveActivityProjectFolder(objectiveStream)!,
      conversation_id: 'objective-conv',
      state: 'working',
    });
    expect(getLiveActivities()[0]).toMatchObject({
      folder: 'project-1',
      conversation_id: 'objective-conv',
    });
  });
});
