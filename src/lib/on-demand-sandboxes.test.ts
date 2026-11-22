/**
 * Tests for canonical on-disk loading in OnDemandSandboxes.loadIndexSync.
 *
 * The migration is the one non-trivial piece of behavior in
 * on-demand-sandboxes.ts: chat records have moved from
 * conversation-keyed to project-keyed storage, so an old on-disk file
 * (or one written by an old board) needs to be reconciled into the new
 * key shape on first load. The regression we're guarding against:
 * treating any record with `conversationId` set as legacy would
 * silently drop new-shape records (which still set `conversationId`
 * for telemetry) on every restart.
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  OnDemandSandboxes,
  type OnDemandSandboxRecord,
} from './on-demand-sandboxes.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'on-demand-test-'));
const indexPath = path.join(tmpDir, 'on-demand-sandboxes.json');

type PersistedOnDemandSandboxRecord = OnDemandSandboxRecord & {
  taskId?: string;
};

function writeIndex(
  records: Record<string, PersistedOnDemandSandboxRecord>,
): void {
  fs.writeFileSync(indexPath, JSON.stringify(records, null, 2), 'utf8');
}

function readIndex(): Record<string, OnDemandSandboxRecord> {
  return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
}

beforeEach(() => {
  if (fs.existsSync(indexPath)) fs.unlinkSync(indexPath);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('OnDemandSandboxes.loadIndexSync', () => {
  test('preserves new-shape single-shell chat records (no shellTabId, conversationId set)', () => {
    // Single-shell chat record — key is just the projectId, but
    // `conversationId` is still set for telemetry. Must NOT be re-keyed.
    writeIndex({
      'proj-1': {
        projectId: 'proj-1',
        conversationId: 'conv-1',
        stack: 'carapa-bot',
        service: 'agent',
        instance: 'proj-1-chat-abcdef',
        createdAt: 3,
      },
    });
    const tracker = new OnDemandSandboxes({ indexPath });
    expect(tracker.listByProject('proj-1')).toHaveLength(1);
    expect(tracker.listByProject('proj-1')[0].instance).toBe(
      'proj-1-chat-abcdef',
    );
  });

  test('ignores stale conversation-keyed records without rewriting them', () => {
    writeIndex({
      'conv-legacy': {
        projectId: 'proj-1',
        conversationId: 'conv-legacy',
        stack: 'carapa-bot',
        service: 'agent',
        instance: 'proj-1-chat-legacy',
        createdAt: 4,
      },
    });
    const tracker = new OnDemandSandboxes({ indexPath });
    expect(tracker.listByProject('proj-1')).toHaveLength(0);
    expect(readIndex()['conv-legacy']?.instance).toBe('proj-1-chat-legacy');
  });

  test('ignores stale records with a taskId marker instead of reusing them as chat shells', () => {
    // A legacy projectId must not make an unsupported record look like the
    // shared chat shell after the project-scoped migration.
    writeIndex({
      'proj-1': {
        taskId: 'task-legacy',
        projectId: 'proj-1',
        stack: 'carapa-bot',
        service: 'agent',
        instance: 'proj-1-task-legacy',
        createdAt: 6,
      },
    });
    const tracker = new OnDemandSandboxes({ indexPath });
    expect(tracker.getByProject('proj-1')).toBeUndefined();
    expect(tracker.listByProject('proj-1')).toEqual([]);
  });

  test('preserves mixed payloads (new-shape + legacy) in one load', () => {
    writeIndex({
      // new-shape multi-shell chat (regression: must be preserved)
      'proj-1:tab-keep': {
        projectId: 'proj-1',
        conversationId: 'conv-keep',
        shellTabId: 'tab-keep',
        stack: 'carapa-bot',
        service: 'agent',
        instance: 'proj-1-chat-conv-keep-tab-keep',
        createdAt: 2,
      },
      // legacy single-shell (ignored)
      'conv-legacy': {
        projectId: 'proj-1',
        conversationId: 'conv-legacy',
        stack: 'carapa-bot',
        service: 'agent',
        instance: 'proj-1-chat-legacy',
        createdAt: 3,
      },
      // legacy multi-shell (dropped)
      'conv-legacy:tab-drop': {
        projectId: 'proj-1',
        conversationId: 'conv-legacy',
        shellTabId: 'tab-drop',
        stack: 'carapa-bot',
        service: 'agent',
        instance: 'proj-1-chat-legacy-tab-drop',
        createdAt: 4,
      },
    });
    const tracker = new OnDemandSandboxes({ indexPath });
    // new-shape multi-shell preserved
    expect(tracker.getByProjectTab('proj-1', 'tab-keep')?.instance).toBe(
      'proj-1-chat-conv-keep-tab-keep',
    );
    // legacy single-shell ignored
    const list = tracker.listByProject('proj-1');
    const instances = list.map((r) => r.instance).sort();
    expect(instances).toEqual(['proj-1-chat-conv-keep-tab-keep']);
    // legacy multi-shell dropped from in-memory state. The on-disk
    // file isn't rewritten by loadIndexSync itself — persistIndex runs
    // only when something changes via record/forget — so the disk may
    // still carry the legacy key, but it's not in the live tracker.
    expect(
      tracker.listByProject('proj-1').map((r) => r.instance),
    ).not.toContain('proj-1-chat-legacy-tab-drop');
    expect(tracker.getByProjectTab('proj-1', 'tab-drop')).toBeUndefined();
  });

  test('rejects missing/empty index file cleanly (no records, no error)', () => {
    // No on-disk file at all — should produce an empty tracker.
    const tracker = new OnDemandSandboxes({ indexPath });
    expect(tracker.list()).toEqual({});
  });

  test('forgetProject removes only the shared record and tabs for that project', async () => {
    writeIndex({
      parent: {
        projectId: 'parent',
        stack: 'carapa-bot',
        service: 'agent',
        instance: 'shared-instance',
        createdAt: 1,
      },
      'parent:tab-a': {
        projectId: 'parent',
        shellTabId: 'tab-a',
        stack: 'carapa-bot',
        service: 'agent',
        instance: 'shared-instance',
        createdAt: 2,
      },
      'other:tab-b': {
        projectId: 'other',
        shellTabId: 'tab-b',
        stack: 'carapa-bot',
        service: 'agent',
        instance: 'other-instance',
        createdAt: 3,
      },
    });

    const tracker = new OnDemandSandboxes({ indexPath });
    const removed = await tracker.forgetProject('parent');

    expect(removed.map((record) => record.projectId)).toEqual([
      'parent',
      'parent',
    ]);
    expect(tracker.listByProject('parent')).toEqual([]);
    expect(Object.keys(readIndex())).toEqual(['other:tab-b']);
  });

  test('forgetByInstance closes every shell sharing a restarted container', async () => {
    writeIndex({
      parent: {
        projectId: 'parent',
        stack: 'carapa-bot',
        service: 'agent',
        instance: 'shared-instance',
        createdAt: 1,
      },
      'parent:tab-a': {
        projectId: 'parent',
        shellTabId: 'tab-a',
        stack: 'carapa-bot',
        service: 'agent',
        instance: 'shared-instance',
        createdAt: 2,
      },
      'other:tab-b': {
        projectId: 'other',
        shellTabId: 'tab-b',
        stack: 'carapa-bot',
        service: 'agent',
        instance: 'other-instance',
        createdAt: 3,
      },
    });

    const tracker = new OnDemandSandboxes({ indexPath });
    const removed = await tracker.forgetByInstance('shared-instance');

    expect(removed).toHaveLength(2);
    expect(tracker.listByProject('parent')).toEqual([]);
    expect(tracker.listByProject('other')).toHaveLength(1);
    expect(Object.keys(readIndex())).toEqual(['other:tab-b']);
  });
});
