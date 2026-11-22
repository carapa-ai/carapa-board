import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import fs from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { GROUPS_DIR } from '../config.js';
import { initDatabase } from '../db.js';
import { getGroupDir } from '../group-dir.js';
import { groupFsTestHooks } from '../lib/group-fs.js';
import { getObjectiveDir } from '../modules/objectives/objective-folder.js';
import { createObjective } from '../modules/objectives/db-objectives.js';
import { loadState, registerGroup, unregisterGroup } from '../state-manager.js';
import objectivesRouter from './objectives.js';

const SECRET = 'TOP-SECRET-OUTSIDE-BYTES';
const suffix = `${process.pid}`;
const otherGroup = `containment-other-${suffix}`;
const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'obj-contain-'));
let server: Server;
let port: number;

type Mode = { name: string; projectId: string };
const modes: Mode[] = [
  { name: 'plain group dir', projectId: `containment-plain-${suffix}` },
];
const jid = (m: Mode) => `${m.projectId}@web`;

const get = async (url: string) => {
  const res = await fetch(`http://127.0.0.1:${port}${url}`);
  const text = await res.text();
  return { status: res.status, text };
};

beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
  fs.mkdirSync(path.join(GROUPS_DIR, otherGroup, 'private'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(GROUPS_DIR, otherGroup, 'private', 'secret.md'),
    SECRET,
  );
  fs.writeFileSync(path.join(outsideRoot, 'secret.md'), SECRET);
  fs.writeFileSync(
    path.join(outsideRoot, 'events.jsonl'),
    `{"type":"${SECRET}"}\n`,
  );
  fs.mkdirSync(path.join(outsideRoot, 'dir'));
  fs.writeFileSync(path.join(outsideRoot, 'dir', 'leak.md'), SECRET);

  for (const m of modes) {
    await registerGroup(jid(m), {
      jid: jid(m),
      name: m.name,
      folder: m.projectId,
      trigger: '@containment',
      added_at: new Date().toISOString(),
      settings: { status: 'running' },
    });
    const groupDir = getGroupDir(m.projectId);
    fs.rmSync(groupDir, { recursive: true, force: true });
    fs.mkdirSync(groupDir, { recursive: true });
  }

  const app = express();
  app.use(objectivesRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.close();
  for (const m of modes) {
    await unregisterGroup(jid(m));
    fs.rmSync(getGroupDir(m.projectId), { recursive: true, force: true });
  }
  fs.rmSync(path.join(GROUPS_DIR, otherGroup), {
    recursive: true,
    force: true,
  });
  fs.rmSync(outsideRoot, { recursive: true, force: true });
});

async function newObjective(m: Mode) {
  const id = (
    await createObjective({
      project_id: m.projectId,
      title: 'Containment fixture',
      description: '',
      status: 'active',
      priority: 0,
      deadline: null,
      progress: 0,
      metadata: null,
      trigger_config: null,
      eventRuntimeSelection: null,
    })
  ).id;
  const dir = getObjectiveDir(m.projectId, id);
  fs.mkdirSync(dir, { recursive: true });
  return { id, dir, base: `/projects/${m.projectId}/objectives/${id}` };
}

describe.each(modes)(
  'objective file routes symlink containment ($name)',
  (m) => {
    test('a symlinked report or rules file leaving the group dir is refused', async () => {
      const o = await newObjective(m);
      fs.mkdirSync(path.join(o.dir, 'reports'));
      fs.mkdirSync(path.join(o.dir, '.agent', 'rules'), { recursive: true });
      // Relative target in another group dir, and absolute target outside GROUPS_DIR.
      fs.symlinkSync(
        path.relative(
          fs.realpathSync(path.join(o.dir, 'reports')),
          path.join(GROUPS_DIR, otherGroup, 'private', 'secret.md'),
        ),
        path.join(o.dir, 'reports', 'rel.md'),
      );
      fs.symlinkSync(
        path.join(outsideRoot, 'secret.md'),
        path.join(o.dir, 'reports', 'abs.md'),
      );
      fs.symlinkSync(
        path.join(outsideRoot, 'secret.md'),
        path.join(o.dir, '.agent', 'rules', 'abs.md'),
      );

      for (const url of [
        `${o.base}/reports/rel.md`,
        `${o.base}/reports/abs.md`,
        `${o.base}/files/rules/abs.md`,
      ]) {
        const res = await get(url);
        expect(res.status).toBe(400);
        expect(res.text).not.toContain(SECRET);
      }
      const missing = await get(`${o.base}/reports/nope.md`);
      expect(missing.status).toBe(404);
      const rules = await get(`${o.base}/files?folder=rules`);
      expect(JSON.parse(rules.text).files).toEqual([]);
    });

    test('symlinked reports/ and .agent/rules directories list nothing and read as invalid', async () => {
      const o = await newObjective(m);
      fs.mkdirSync(path.join(o.dir, '.agent'));
      fs.symlinkSync(
        path.join(outsideRoot, 'dir'),
        path.join(o.dir, 'reports'),
      );
      fs.symlinkSync(
        path.join(outsideRoot, 'dir'),
        path.join(o.dir, '.agent', 'rules'),
      );

      const reports = await get(`${o.base}/reports`);
      expect(JSON.parse(reports.text)).toEqual({ reports: [], total: 0 });
      const rules = await get(`${o.base}/files?folder=rules`);
      expect(JSON.parse(rules.text).files).toEqual([]);
      for (const url of [
        `${o.base}/reports/leak.md`,
        `${o.base}/files/rules/leak.md`,
      ]) {
        const res = await get(url);
        expect(res.status).toBe(400);
        expect(res.text).not.toContain(SECRET);
      }
    });

    test('listing skips escaping entries, keeps normal and in-group symlinked ones', async () => {
      const o = await newObjective(m);
      const groupDir = getGroupDir(m.projectId);
      fs.mkdirSync(path.join(o.dir, 'reports'));
      fs.mkdirSync(path.join(o.dir, 'reports-old'));
      fs.writeFileSync(path.join(o.dir, 'reports', 'normal.md'), 'normal body');
      fs.writeFileSync(path.join(o.dir, 'reports-old', 'a.md'), 'old body');
      fs.symlinkSync(
        '../reports-old/a.md',
        path.join(o.dir, 'reports', 'a.md'),
      );
      fs.symlinkSync(
        path.join(outsideRoot, 'secret.md'),
        path.join(o.dir, 'reports', 'evil.md'),
      );
      fs.symlinkSync(
        path.join(groupDir, 'missing-target.md'),
        path.join(o.dir, 'reports', 'dangling.md'),
      );

      const list = await get(`${o.base}/reports`);
      expect(list.text).not.toContain(SECRET);
      const body = JSON.parse(list.text) as {
        reports: { filename: string; preview: string }[];
        total: number;
      };
      expect(body.reports.map((r) => r.filename).sort()).toEqual([
        'a.md',
        'normal.md',
      ]);
      expect(body.total).toBe(2);
      expect(
        body.reports.find((r) => r.filename === 'normal.md')?.preview,
      ).toBe('normal body');

      const linked = await get(`${o.base}/reports/a.md`);
      expect(linked.status).toBe(200);
      expect(JSON.parse(linked.text).content).toBe('old body');
    });

    test('a symlinked events.jsonl leaving the group dir reads as empty', async () => {
      const o = await newObjective(m);
      fs.symlinkSync(
        path.join(outsideRoot, 'events.jsonl'),
        path.join(o.dir, 'events.jsonl'),
      );
      const res = await get(`${o.base}/events?typesOnly=true`);
      expect(res.status).toBe(200);
      expect(res.text).not.toContain(SECRET);
      expect(JSON.parse(res.text).types).toEqual([]);
    });

    test('a run-stats runId with path segments never reads a file outside the objective', async () => {
      const o = await newObjective(m);
      const other = path.join(GROUPS_DIR, otherGroup, '.agent', 'rules');
      fs.mkdirSync(other, { recursive: true });
      fs.writeFileSync(path.join(other, 'x.md'), SECRET);
      const runId = `../../../../../${otherGroup}/.agent/rules/x`;
      fs.writeFileSync(
        path.join(o.dir, 'run-stats.jsonl'),
        `${JSON.stringify({ runId, timestamp: '2026-01-01T00:00:00Z' })}\n`,
      );
      fs.writeFileSync(
        path.join(o.dir, 'llm-steps.jsonl'),
        `${JSON.stringify({ parentRunId: runId, kind: 'reflection' })}\n`,
      );

      const res = await get(`${o.base}/runs`);
      expect(res.status).toBe(200);
      expect(res.text).not.toContain(SECRET);
      const run = JSON.parse(res.text).runs[0];
      expect(run.runId).toBe(runId);
      expect(run.hasReflection).toBe(false);
      expect(run.hasTranscript).toBe(false);
    });

    test('a reports dir swapped for a link while it is opened never serves its target', async () => {
      const o = await newObjective(m);
      fs.mkdirSync(path.join(o.dir, 'reports'));
      fs.writeFileSync(path.join(o.dir, 'reports', 'leak.md'), 'inside');
      try {
        let swapped = false;
        groupFsTestHooks.beforeOpen = (_label, segment) => {
          if (swapped || segment !== 'reports') return;
          swapped = true;
          fs.rmSync(path.join(o.dir, 'reports'), { recursive: true });
          fs.symlinkSync(
            path.join(outsideRoot, 'dir'),
            path.join(o.dir, 'reports'),
          );
        };
        const res = await get(`${o.base}/reports/leak.md`);
        expect(swapped).toBe(true);
        expect([400, 404]).toContain(res.status);
        expect(res.text).not.toContain(SECRET);
      } finally {
        groupFsTestHooks.beforeOpen = undefined;
      }
    });
  },
);
