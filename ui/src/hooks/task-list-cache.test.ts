// Bun supplies these test globals at runtime; the UI package intentionally
// does not depend on Bun's type declarations.
// @ts-nocheck
import { expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import {
  patchTaskLists,
  restoreTaskListSnapshots,
  snapshotTaskLists,
} from './use-task-mutations';

test('task list cache helpers patch every filtered tasks.list entry and restore on rollback', () => {
  const pid = 'p1';
  const qc = new QueryClient();
  const task = (id: string) => ({ id, running: false });
  const allKey = queryKeys.tasks.list(pid);
  const ownerKey = queryKeys.tasks.list(pid, { ownerUserId: 'u' });
  const detailKey = queryKeys.tasks.detail(pid, 't1');
  qc.setQueryData(allKey, [task('t1'), task('t2')]);
  qc.setQueryData(ownerKey, [task('t1')]);
  qc.setQueryData(detailKey, task('t1'));

  const snapshots = snapshotTaskLists(qc, pid);
  patchTaskLists(qc, pid, (tasks) => tasks.filter((t) => t.id !== 't1'));
  expect(qc.getQueryData(allKey).map((t) => t.id)).toEqual(['t2']);
  expect(qc.getQueryData(ownerKey)).toEqual([]);
  expect(qc.getQueryData(detailKey)).toEqual(task('t1'));

  restoreTaskListSnapshots(qc, snapshots);
  expect(qc.getQueryData(allKey).map((t) => t.id)).toEqual(['t1', 't2']);
  expect(qc.getQueryData(ownerKey).map((t) => t.id)).toEqual(['t1']);

  patchTaskLists(qc, pid, (tasks) =>
    tasks.map((t) => (t.id === 't1' ? { ...t, running: true } : t)),
  );
  expect(qc.getQueryData(allKey)[0].running).toBe(true);
  expect(qc.getQueryData(ownerKey)[0].running).toBe(true);
  expect(qc.getQueryData(detailKey).running).toBe(false);
});
