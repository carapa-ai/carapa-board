import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import express from 'express';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { DATA_DIR, GROUPS_DIR } from '../config.js';
import { createUser, getUserById, initDatabase } from '../db.js';
import { getGroupDir, setGroupLookup } from '../group-dir.js';
import { getSandboxClient } from '../lib/mcp-client.js';
import {
  getGroupByFolder,
  loadState,
  registerGroup,
  unregisterGroup,
} from '../state-manager.js';
import { resolveEffectiveSandbox } from '../sandbox/effective-settings.js';
import { groupReplica } from '../sandbox/ipc-replica.js';
import {
  getDisabledSkills,
  reconcileDisabledSkills,
  refreshProjectAgentView,
  replayPendingDisabledSkills,
  syncAllDisabledSkillsFiles,
  withoutDisabledSkills,
} from '../sandbox/disabled-skills.js';
import conversationsRouter from './conversations.js';
import projectsRouter from './projects.js';

const pid = `disabled-skills-route-${process.pid}`;
const jid = `${pid}@web`;
let server: Server;
let baseUrl: string;
let adminId: string;

const skillsFile = () =>
  path.join(getGroupDir(pid), '.carapa', 'disabled-skills.json');
const readSkillsFile = () => JSON.parse(fs.readFileSync(skillsFile(), 'utf-8'));

async function setStored(disabledSkills?: string[]) {
  await unregisterGroup(jid);
  await registerGroup(jid, {
    jid,
    name: 'Skills route',
    folder: pid,
    trigger: '@skills',
    added_at: new Date().toISOString(),
    settings: {
      status: 'running',
      ...(disabledSkills ? { disabledSkills } : {}),
    },
  });
}

async function patch(settings: Record<string, unknown>, folder = pid) {
  const response = await fetch(`${baseUrl}/projects/${folder}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings }),
  });
  return response.status;
}

const stored = () => getGroupByFolder(pid)?.settings?.disabledSkills;

beforeAll(async () => {
  await initDatabase(':memory:');
  await loadState();
  adminId = (await createUser(`${pid}-admin`, 'password', 'admin')).id;
  await setStored();

  const app = express();
  app.use(express.json());
  app.use(async (req: any, _res, next) => {
    req.authUser = await getUserById(adminId);
    next();
  });
  app.use(projectsRouter);
  app.use(conversationsRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await unregisterGroup(jid);
  fs.rmSync(getGroupDir(pid), { recursive: true, force: true });
});

const running = (stack: string) =>
  JSON.stringify([
    {
      name: `${stack}-${pid}`,
      stack,
      instance: pid,
      services: [
        { service: resolveEffectiveSandbox(pid).service, status: 'running' },
      ],
    },
  ]);

function mockBox(ps: string) {
  const client = getSandboxClient();
  const psSpy = spyOn(client, 'sandboxPs').mockResolvedValue({
    stdout: ps,
    isError: false,
  });
  // The configured stack is not running unless sandbox_ps lists it.
  spyOn(client, 'sandboxStatus').mockResolvedValue({
    stdout: 'not running',
    isError: false,
  });
  const exec = spyOn(client, 'sandboxExec').mockResolvedValue({
    stdout: '',
    isError: false,
  });
  return { psSpy, exec };
}

/** The test preload turns replication off; enable it for the given folders. */
function enableReplica(folders: string[]): () => void {
  const replica = groupReplica as unknown as { disabled: boolean };
  const was = replica.disabled;
  replica.disabled = false;
  groupReplica.setEnabled((folder) => folders.includes(folder));
  return () => {
    replica.disabled = was;
    groupReplica.setEnabled(() => false);
  };
}

afterEach(() => {
  spyOn(getSandboxClient(), 'sandboxPs').mockRestore();
  spyOn(getSandboxClient(), 'sandboxStatus').mockRestore();
  spyOn(getSandboxClient(), 'sandboxExec').mockRestore();
  spyOn(groupReplica, 'flushPath').mockRestore();
});

describe('PATCH /projects/:pid disabledSkills', () => {
  test('sets a normalized list, inherits when absent, and clears with an empty list', async () => {
    // Keep the background refresh off the network.
    mockBox('No running sandboxes found.');
    expect(await patch({ disabledSkills: ['b', 'a', 'b', ' '] })).toBe(200);
    expect(stored()).toEqual(['a', 'b']);
    expect(readSkillsFile()).toEqual({ disabledSkills: ['a', 'b'] });

    expect(await patch({ disableObservations: true })).toBe(200);
    expect(stored()).toEqual(['a', 'b']);
    expect(readSkillsFile()).toEqual({ disabledSkills: ['a', 'b'] });

    expect(await patch({ disabledSkills: [] })).toBe(200);
    expect(stored()).toEqual([]);
    expect(readSkillsFile()).toEqual({ disabledSkills: [] });
  });

  test('a failing refresh does not fail the save', async () => {
    const { exec } = mockBox(running('agents'));
    exec.mockRejectedValue(new Error('box down'));
    expect(await patch({ disabledSkills: ['z'] })).toBe(200);
    expect(stored()).toEqual(['z']);
  });
});

describe('refreshProjectAgentView', () => {
  test('execs the refresh in running stacks only, never in stopped services', async () => {
    await setStored(['a']);
    const { psSpy, exec } = mockBox('No running sandboxes found.');
    await refreshProjectAgentView(pid);
    expect(exec).not.toHaveBeenCalled();

    // The stack setting changed, but the old stack still runs; another stack
    // lists the instance with its service stopped.
    const service = resolveEffectiveSandbox(pid).service;
    psSpy.mockResolvedValue({
      stdout: JSON.stringify([
        {
          stack: 'old-stack',
          instance: pid,
          services: [{ service, status: 'running' }],
        },
        {
          stack: 'stopped-stack',
          instance: pid,
          services: [{ service, status: 'exited (0)' }],
        },
        { stack: 'other', instance: 'someone-else', services: [] },
      ]),
      isError: false,
    });
    await refreshProjectAgentView(pid);
    expect(exec).toHaveBeenCalledTimes(1);
    const [stack, execService, command, options] = exec.mock.calls[0];
    expect([stack, execService, command]).toEqual([
      'old-stack',
      service,
      'carapa-agent-view refresh',
    ]);
    expect(options).toMatchObject({ instance: pid, timeout: 30 });
  });
});

describe('reconcileDisabledSkills', () => {
  test('overlapping saves leave the latest list in the file and refresh after it', async () => {
    await setStored(['a']);
    const events: string[] = [];
    const { exec } = mockBox(running('agents'));
    exec.mockImplementation(async () => {
      events.push(`refresh:${JSON.stringify(readSkillsFile().disabledSkills)}`);
      return { stdout: '', isError: false };
    });
    const first = reconcileDisabledSkills(pid);
    // The second save lands while the first is still in flight.
    getGroupByFolder(pid)!.settings!.disabledSkills = ['b'];
    const second = reconcileDisabledSkills(pid);
    await Promise.all([first.done, second.done]);
    expect(readSkillsFile()).toEqual({ disabledSkills: ['b'] });
    expect(events.at(-1)).toBe('refresh:["b"]');
  });

  test('pushes the file to a remote box before refreshing', async () => {
    await setStored(['a']);
    fs.rmSync(path.dirname(skillsFile()), { recursive: true, force: true });
    const events: string[] = [];
    const { exec } = mockBox(running('agents'));
    exec.mockImplementation(async () => {
      events.push('refresh');
      return { stdout: '', isError: false };
    });
    spyOn(groupReplica, 'flushPath').mockImplementation(async () => {
      events.push('push');
    });
    const restore = enableReplica([pid]);
    try {
      await reconcileDisabledSkills(pid).done;
    } finally {
      restore();
    }
    expect(events).toEqual(['push', 'refresh']);
  });

  test('a refresh lost to an offline box at boot is replayed after it reconnects', async () => {
    await setStored(['a']);
    fs.rmSync(path.dirname(skillsFile()), { recursive: true, force: true });
    const { exec } = mockBox(running('agents'));
    const flush = spyOn(groupReplica, 'flushPath').mockRejectedValue(
      new Error('box offline'),
    );
    const restore = enableReplica([pid]);
    try {
      // Boot: the file is written locally but the push fails.
      await reconcileDisabledSkills(pid).done;
      expect(readSkillsFile()).toEqual({ disabledSkills: ['a'] });
      expect(exec).not.toHaveBeenCalled();

      // The box reconnects: the push succeeds and the refresh is dispatched.
      flush.mockResolvedValue(undefined);
      await replayPendingDisabledSkills();
      expect(flush).toHaveBeenCalledTimes(2);
      expect(exec).toHaveBeenCalledTimes(1);

      // Nothing is left to replay.
      await replayPendingDisabledSkills();
      expect(exec).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  test('boot reconciliation refreshes a surviving container whose file was outdated', async () => {
    await setStored(['a']);
    await reconcileDisabledSkills(pid).done;
    fs.writeFileSync(skillsFile(), '{"disabledSkills":[]}\n');
    const { exec } = mockBox(running('agents'));
    await syncAllDisabledSkillsFiles();
    await reconcileDisabledSkills(pid).done; // drains the queued refresh
    expect(readSkillsFile()).toEqual({ disabledSkills: ['a'] });
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe('settings save reconciles the file', () => {
  test('an unrelated save writes the missing file with an empty list', async () => {
    mockBox('No running sandboxes found.');
    await setStored();
    fs.rmSync(path.dirname(skillsFile()), { recursive: true, force: true });
    expect(await patch({ disableObservations: true })).toBe(200);
    expect(readSkillsFile()).toEqual({ disabledSkills: [] });
  });

  test('a FIFO planted at the file cannot hang reconciliation', async () => {
    await setStored(['a']);
    fs.mkdirSync(path.dirname(skillsFile()), { recursive: true });
    fs.rmSync(skillsFile(), { force: true });
    execFileSync('mkfifo', [skillsFile()]);
    mockBox('No running sandboxes found.');
    await reconcileDisabledSkills(pid).done;
    expect(readSkillsFile()).toEqual({ disabledSkills: ['a'] });
  });
});

describe('write containment and ordering', () => {
  test('a symlinked .carapa is refused and nothing is written through it', async () => {
    await setStored(['a']);
    const foreign = fs.mkdtempSync(path.join(getGroupDir(pid), 'foreign-'));
    fs.rmSync(path.dirname(skillsFile()), { recursive: true, force: true });
    fs.symlinkSync(foreign, path.dirname(skillsFile()));
    mockBox('No running sandboxes found.');
    await expect(reconcileDisabledSkills(pid).done).resolves.toBeUndefined();
    expect(fs.readdirSync(foreign)).toEqual([]);
    fs.rmSync(path.dirname(skillsFile()), { force: true });
    fs.rmSync(foreign, { recursive: true, force: true });
  });

  test('an older refresh does not consume a newer save whose push failed', async () => {
    await setStored(['a']);
    fs.rmSync(path.dirname(skillsFile()), { recursive: true, force: true });
    const { exec } = mockBox(running('agents'));
    // Save A pushes fine; while that push is in flight save B arrives, and
    // B's own push fails. A's refresh is queued behind B.
    let second: ReturnType<typeof reconcileDisabledSkills> | undefined;
    const flush = spyOn(groupReplica, 'flushPath')
      .mockImplementationOnce(async () => {
        getGroupByFolder(pid)!.settings!.disabledSkills = ['b'];
        second = reconcileDisabledSkills(pid);
      })
      .mockRejectedValueOnce(new Error('box offline'));
    const restore = enableReplica([pid]);
    try {
      const first = reconcileDisabledSkills(pid);
      await first.done;
      await second!.done;
      expect(readSkillsFile()).toEqual({ disabledSkills: ['b'] });
      expect(exec).toHaveBeenCalledTimes(1);

      // The box reconnects: B is pushed and its own refresh is dispatched.
      flush.mockResolvedValue(undefined);
      await replayPendingDisabledSkills();
      expect(exec).toHaveBeenCalledTimes(2);
    } finally {
      restore();
    }
  });
});

describe('GET /projects/:pid/commands', () => {
  test('lists project skills from the group directory, hiding disabled ones', async () => {
    await setStored(['hidden-skill']);
    for (const name of ['shown-skill', 'hidden-skill']) {
      const dir = path.join(getGroupDir(pid), '.agent', 'skills', name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        `---\nname: ${name}\ndescription: Demo ${name}\n---\n`,
      );
    }
    spyOn(getSandboxClient(), 'callTool').mockResolvedValue({
      stdout: '[]',
      isError: false,
    });
    try {
      const list = async (query: string) =>
        (
          (await (
            await fetch(`${baseUrl}/projects/${pid}/commands?reload=1${query}`)
          ).json()) as { name: string }[]
        ).map((c) => c.name);
      expect(await list('')).toEqual(['shown-skill']);
      expect(await list('&includeDisabled=1')).toEqual([
        'hidden-skill',
        'shown-skill',
      ]);
    } finally {
      spyOn(getSandboxClient(), 'callTool').mockRestore();
      fs.rmSync(path.join(getGroupDir(pid), '.agent'), {
        recursive: true,
        force: true,
      });
    }
  });
});

const getDisabledSkillsDir = (folder: string) =>
  path.join(getGroupDir(folder), '.carapa');

describe('container mount layouts', () => {
  const owner = `${pid}-owner`;
  const child = `${pid}-child`;
  const reg = (folder: string, extra: object, settings: object) =>
    registerGroup(`${folder}@web`, {
      jid: `${folder}@web`,
      name: folder,
      folder,
      trigger: `@${folder}`,
      added_at: new Date().toISOString(),
      ...extra,
      settings: { status: 'running', ...settings },
    });

  afterAll(async () => {
    for (const folder of [owner, child]) {
      await unregisterGroup(`${folder}@web`);
      fs.rmSync(getGroupDir(folder), { recursive: true, force: true });
    }
  });

  test('a project sharing its parent sandbox uses, and cannot change, the owner list', async () => {
    mockBox('No running sandboxes found.');
    await reg(
      owner,
      {},
      {
        isParent: true,
        sandboxOwnership: 'shared',
        disabledSkills: ['x'],
      },
    );
    await reg(child, { parentId: owner }, { disabledSkills: [] });
    expect(getDisabledSkills(child)).toEqual(['x']);
    expect(await patch({ disabledSkills: ['y'] }, child)).toBe(400);
    // Saving the child writes the file its container (the owner's) reads.
    expect(await patch({ disableObservations: true }, child)).toBe(200);
    const ownerFile = path.join(
      getDisabledSkillsDir(owner),
      'disabled-skills.json',
    );
    expect(JSON.parse(fs.readFileSync(ownerFile, 'utf-8'))).toEqual({
      disabledSkills: ['x'],
    });
    expect(
      fs.existsSync(
        path.join(getDisabledSkillsDir(child), 'disabled-skills.json'),
      ),
    ).toBe(false);
  });
});

describe('remote placement of a nested project', () => {
  const parent = `${pid}-rparent`;
  const nested = `${pid}-rchild`;

  afterAll(async () => {
    for (const folder of [parent, nested]) {
      await unregisterGroup(`${folder}@web`);
      fs.rmSync(getGroupDir(folder), { recursive: true, force: true });
    }
  });

  test('boot reconciliation writes a nested project at its real directory', async () => {
    const reg = (folder: string, extra: object) =>
      registerGroup(`${folder}@web`, {
        jid: `${folder}@web`,
        name: folder,
        folder,
        trigger: `@${folder}`,
        added_at: new Date().toISOString(),
        ...extra,
        settings: { status: 'running', disabledSkills: ['b', 'a'] },
      });
    await reg(parent, {});
    await reg(nested, { parentId: parent });
    mockBox('No running sandboxes found.');
    setGroupLookup(getGroupByFolder);
    try {
      fs.mkdirSync(getGroupDir(nested), { recursive: true });
      await syncAllDisabledSkillsFiles();
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(getGroupDir(nested), '.carapa', 'disabled-skills.json'),
            'utf-8',
          ),
        ),
      ).toEqual({ disabledSkills: ['a', 'b'] });
      expect(getGroupDir(nested)).toBe(path.join(GROUPS_DIR, parent, nested));
    } finally {
      setGroupLookup(() => undefined);
    }
  });

  test('pushes the file from the nested directory, survives a later sync, and refreshes after it', async () => {
    const reg = (folder: string, extra: object) =>
      registerGroup(`${folder}@web`, {
        jid: `${folder}@web`,
        name: folder,
        folder,
        trigger: `@${folder}`,
        added_at: new Date().toISOString(),
        ...extra,
        settings: { status: 'running', disabledSkills: ['n'] },
      });
    await reg(parent, {});
    await reg(nested, { parentId: parent });
    const events: string[] = [];
    const calls: Record<string, any>[] = [];
    spyOn(groupReplica, 'replicaId').mockReturnValue('test-replica');
    spyOn(groupReplica, 'clientFor').mockReturnValue({
      callTool: async (_name: string, args: Record<string, any>) => {
        calls.push(args);
        events.push('box');
        return {
          isError: false,
          stdout: JSON.stringify({
            pushed: (args.push ?? []).map(() => ({ ok: true })),
            files: [],
            dirs: [],
            deleted: [],
            more: false,
          }),
        };
      },
    });
    // Only the nested child is remote-placed; its local parent is not.
    // As at boot, nested folders resolve under their parent's directory.
    setGroupLookup(getGroupByFolder);
    groupReplica.setProjectDir(getGroupDir);
    const restore = enableReplica([nested]);
    const { exec } = mockBox(
      JSON.stringify([
        {
          stack: 'agents',
          instance: nested,
          services: [
            {
              service: resolveEffectiveSandbox(nested).service,
              status: 'running',
            },
          ],
        },
      ]),
    );
    exec.mockImplementation(async () => {
      events.push('refresh');
      return { stdout: '', isError: false };
    });
    const file = path.join(
      getGroupDir(nested),
      '.carapa',
      'disabled-skills.json',
    );
    try {
      await reconcileDisabledSkills(nested).done;
      const afterReconcile = calls.length;
      // A later background sync must keep, not delete, the remote file: the
      // replica's local directory is the nested one the file was written in.
      await groupReplica.flushPath(file, { strict: true });
      const later = calls.slice(afterReconcile);
      expect(later.length).toBeGreaterThan(0);
      expect(
        calls
          .flatMap((args) => args.push ?? [])
          .some((op) => op.op === 'remove'),
      ).toBe(false);
    } finally {
      restore();
      groupReplica.setProjectDir(null);
      setGroupLookup(() => undefined);
      spyOn(groupReplica, 'replicaId').mockRestore();
      spyOn(groupReplica, 'clientFor').mockRestore();
      const replicas = (groupReplica as any).projects as Map<string, any>;
      replicas.get(nested)?.saveNow();
      replicas.delete(nested);
      fs.rmSync(path.join(DATA_DIR, 'group-replica', `${nested}.json`), {
        force: true,
      });
    }
    const push = calls.find((args) => args.push?.length);
    expect(push).toMatchObject({
      project: nested,
      root: '',
      push: [{ op: 'write', path: '.carapa/disabled-skills.json' }],
    });
    expect(
      JSON.parse(Buffer.from(push!.push[0].data, 'base64').toString()),
    ).toEqual({ disabledSkills: ['n'] });
    expect(events.indexOf('refresh')).toBeGreaterThan(events.indexOf('box'));
  });
});

describe('refresh service discovery', () => {
  test("finds the agent among a surviving stack's custom services", async () => {
    await setStored(['a']);
    getGroupByFolder(pid)!.settings!.defaultSandboxService = 'worker';
    const { psSpy, exec } = mockBox('No running sandboxes found.');
    psSpy.mockResolvedValue({
      stdout: JSON.stringify([
        {
          stack: 'old-stack',
          instance: pid,
          services: [
            { service: 'db', status: 'running' },
            { service: 'coder', status: 'running' },
            { service: 'cache', status: 'exited (0)' },
          ],
        },
      ]),
      isError: false,
    });
    // Only the coder service has the command; the db fails harmlessly.
    exec.mockImplementation(async (_stack, service) => ({
      stdout: service === 'coder' ? '' : 'command not found',
      isError: service !== 'coder',
    }));
    await refreshProjectAgentView(pid);
    expect(exec.mock.calls.map((call) => call[1])).toEqual(['db', 'coder']);
  });
});

describe('withoutDisabledSkills', () => {
  test('hides disabled skills but keeps other skills and commands', () => {
    const commands = [
      { name: 'a', description: 'd', type: 'skill' },
      { name: 'b', description: 'd', type: 'skill' },
      { name: 'a', description: 'd', type: 'command' },
    ];
    expect(withoutDisabledSkills(commands, ['a'])).toEqual([
      commands[1],
      commands[2],
    ]);
    expect(withoutDisabledSkills(commands, [])).toBe(commands);
  });
});
