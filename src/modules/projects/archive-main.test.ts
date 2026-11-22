import { describe, expect, test } from 'bun:test';

import type { RegisteredGroup } from '../../types.js';
import { getSandboxClient } from '../../lib/mcp-client.js';
import { trackSandboxStart } from '../../lib/sandbox-start-fence.js';
import {
  archivePersonalMain,
  MainArchiveRefusedError,
  withMainRunsFenced,
  type ArchiveMainDeps,
} from './archive-main.js';

const OLD_JID = 'main-alice';
const ARCHIVE_ID = 'archived-main-alice-1000';

function harness(overrides: Partial<ArchiveMainDeps> = {}) {
  const calls: string[] = [];
  const group: RegisteredGroup = {
    name: 'Alice',
    folder: 'main-alice',
    trigger: '!',
    added_at: '2026-01-01',
    is_main: true,
    user_id: 'user-alice',
  };
  const deps: Partial<ArchiveMainDeps> = {
    now: () => 1000,
    usesFolderSandbox: () => true,
    // Never reach a live CarapaBox from the archive's key cleanup.
    deleteIntegrationKeys: async () => 0,
    getEntry: (folder) =>
      folder === 'main-alice' ? { jid: OLD_JID, group } : undefined,
    hasRunningTasks: async () => false,
    withDescendantsIdle: async (_folder, operation) => operation(),
    oldDirectoryExists: async () => false,
    disableAppPublication: async () => {},
    stopAllProjectTasks: async () => 0,
    killChatAgentProcess: async () => {},
    fenceRuns: async () => {
      calls.push('fence');
      return () => void calls.push('unfence');
    },
    stopSandbox: async () => {
      calls.push('stop sandbox');
    },
    archiveIpcStorage: async (_group, archiveId) => {
      calls.push(`ipc main-alice -> ${archiveId}`);
      return {
        rollback: async () => void calls.push(`ipc ${archiveId} -> main-alice`),
        close: async () => void calls.push('ipc closed'),
      };
    },
    revokeGroupTokens: async () => 0,
    revokeTokensGrantingFolder: async (folder) => {
      calls.push(`revoke tokens naming ${folder}`);
      return 0;
    },
    renameDir: async (from, to) => {
      calls.push(`dir ${from} -> ${to}`);
      return {
        rollback: async () => void calls.push(`dir ${to} -> ${from}`),
        close: async () => void calls.push('dir closed'),
      };
    },
    renameProjectFolder: async (from, to, options) => {
      calls.push(`db ${from} -> ${to} jid=${options.jid}`);
    },
    rekeyGroup: (from, to, folder) => {
      calls.push(`rekey ${from} -> ${to} folder=${folder}`);
    },
    migrateGroupSession: (from, to) => {
      calls.push(`session ${from} -> ${to}`);
    },
    rewriteRenamedProjectReferences: async (from, to) => {
      calls.push(`refs ${from} -> ${to}`);
    },
    updateGroup: async (jid, updates) => {
      calls.push(`update ${jid} user_id=${updates.user_id}`);
    },
    detachMemorySources: async () => {
      calls.push('detach');
      return async () => void calls.push('reattach');
    },
    revokeProjectAccess: async () => {
      calls.push('revoke access');
      return {
        projectMembers: [],
        conversationMembers: [],
        publicShareConversationIds: [],
      };
    },
    restoreProjectAccess: async () => {
      calls.push('restore access');
    },
    retireFolderIdentity: async (folder) => {
      calls.push(`retire identity ${folder}`);
    },
    blockExecution: async (folder) => {
      calls.push(`block ${folder}`);
      return async () => void calls.push(`unblock ${folder}`);
    },
    pauseProjectAutomation: async () => {
      calls.push('pause');
      return {
        scheduledTaskIds: ['s1'],
        cronjobIds: [],
        datasetTaskIds: [],
        objectives: [],
      };
    },
    restoreProjectAutomation: async () => {
      calls.push('restore');
    },
    renameGroupMemoryGraph: async (from, to) => {
      calls.push(`graph ${from} -> ${to}`);
      return 3;
    },
    ...overrides,
  };
  return { calls, deps };
}

describe('archivePersonalMain', () => {
  test('renames directory, rows, jid and graph, and pauses automation', async () => {
    const { calls, deps } = harness();
    expect(await archivePersonalMain('main-alice', deps)).toBe(ARCHIVE_ID);
    expect(calls).toEqual([
      'fence',
      'detach',
      'revoke tokens naming main-alice',
      'stop sandbox',
      `ipc main-alice -> ${ARCHIVE_ID}`,
      `dir main-alice -> ${ARCHIVE_ID}`,
      `db main-alice -> ${ARCHIVE_ID} jid=${ARCHIVE_ID}`,
      `rekey ${OLD_JID} -> ${ARCHIVE_ID} folder=${ARCHIVE_ID}`,
      `session main-alice -> ${ARCHIVE_ID}`,
      `refs main-alice -> ${ARCHIVE_ID}`,
      `update ${ARCHIVE_ID} user_id=undefined`,
      `block ${ARCHIVE_ID}`,
      'pause',
      'revoke access',
      `graph main-alice -> ${ARCHIVE_ID}`,
      'retire identity main-alice',
      'ipc closed',
      'dir closed',
      'unfence',
    ]);
  });

  test('skips the graph when no vector store is configured', async () => {
    const { calls, deps } = harness({ renameGroupMemoryGraph: undefined });
    expect(await archivePersonalMain('main-alice', deps)).toBe(ARCHIVE_ID);
    expect(calls.some((c) => c.startsWith('graph'))).toBe(false);
  });

  test('returns null when there is no project', async () => {
    const { calls, deps } = harness();
    expect(await archivePersonalMain('main-nobody', deps)).toBeNull();
    expect(calls).toEqual([]);
  });

  test('refuses a project that is not a main', async () => {
    const { calls, deps } = harness();
    const entry = deps.getEntry!('main-alice')!;
    deps.getEntry = () => ({
      ...entry,
      group: { ...entry.group, is_main: false },
    });
    await expect(archivePersonalMain('main-alice', deps)).rejects.toMatchObject(
      { reason: 'not_main' },
    );
    expect(calls).toEqual([]);
  });

  test('refuses while tasks are running without touching anything', async () => {
    const { calls, deps } = harness({ hasRunningTasks: async () => true });
    const failure = archivePersonalMain('main-alice', deps);
    await expect(failure).rejects.toBeInstanceOf(MainArchiveRefusedError);
    await expect(failure).rejects.toMatchObject({ reason: 'tasks_running' });
    expect(calls).toEqual(['fence', 'unfence']);
  });

  test('rolls the directory back when the database rename fails', async () => {
    const { calls, deps } = harness({
      renameProjectFolder: async () => {
        throw new Error('db down');
      },
    });
    await expect(archivePersonalMain('main-alice', deps)).rejects.toThrow(
      'db down',
    );
    expect(calls).toEqual([
      'fence',
      'detach',
      'revoke tokens naming main-alice',
      'stop sandbox',
      `ipc main-alice -> ${ARCHIVE_ID}`,
      `dir main-alice -> ${ARCHIVE_ID}`,
      `dir ${ARCHIVE_ID} -> main-alice`,
      `ipc ${ARCHIVE_ID} -> main-alice`,
      'reattach',
      'ipc closed',
      'dir closed',
      'unfence',
    ]);
  });

  test('rolls everything back when the graph hook throws', async () => {
    const { calls, deps } = harness({
      renameGroupMemoryGraph: async () => {
        throw new Error('neo4j down');
      },
    });
    await expect(archivePersonalMain('main-alice', deps)).rejects.toThrow(
      'neo4j down',
    );
    expect(calls.some((c) => c.startsWith('retire identity'))).toBe(false);
    expect(calls.slice(-14)).toEqual([
      'restore access',
      'restore',
      `unblock ${ARCHIVE_ID}`,
      `session ${ARCHIVE_ID} -> main-alice`,
      `rekey ${ARCHIVE_ID} -> ${OLD_JID} folder=main-alice`,
      `db ${ARCHIVE_ID} -> main-alice jid=${OLD_JID}`,
      `dir ${ARCHIVE_ID} -> main-alice`,
      `ipc ${ARCHIVE_ID} -> main-alice`,
      'reattach',
      `refs ${ARCHIVE_ID} -> main-alice`,
      `update ${OLD_JID} user_id=user-alice`,
      'ipc closed',
      'dir closed',
      'unfence',
    ]);
  });

  test('republishes the app when the archive fails', async () => {
    const { calls, deps } = harness({
      disableAppPublication: async () => async () => {
        calls.push('republish');
      },
      renameProjectFolder: async () => {
        throw new Error('db down');
      },
    });
    await expect(archivePersonalMain('main-alice', deps)).rejects.toThrow(
      'db down',
    );
    expect(calls.at(-4)).toBe('republish');
  });

  test('moves nothing and rethrows when the sandbox stop is not confirmed', async () => {
    const { calls, deps } = harness({
      stopSandbox: async () => {
        throw new Error('still running');
      },
    });
    await expect(archivePersonalMain('main-alice', deps)).rejects.toThrow(
      'still running',
    );
    expect(
      calls.some((c) => c.startsWith('dir ') || c.startsWith('ipc ')),
    ).toBe(false);
    expect(calls.at(-2)).toBe('reattach');
    expect(calls.at(-1)).toBe('unfence');
  });

  test('rolls the directory and storage moves back when the IPC archive fails', async () => {
    const { calls, deps } = harness({
      archiveIpcStorage: async () => {
        throw new Error('remote box');
      },
    });
    await expect(archivePersonalMain('main-alice', deps)).rejects.toThrow(
      'remote box',
    );
    expect(calls.some((c) => c.startsWith('dir '))).toBe(false);
  });

  test('refuses sandbox starts of the instance while it is fenced', async () => {
    const client = getSandboxClient();
    let during: Awaited<ReturnType<typeof client.sandboxStart>> | undefined;
    await withMainRunsFenced('main-fenced-user', async () => {
      during = await client.sandboxStart('stack', {}, 'main-fenced-user');
    });
    expect(during).toMatchObject({ isError: true });
    expect(during?.stdout).toContain('being archived');
  });

  test('waits for a start accepted before the fence', async () => {
    let finishStart!: () => void;
    void trackSandboxStart(
      'main-settle-user',
      new Promise<void>((resolve) => (finishStart = resolve)),
    );
    const order: string[] = [];
    const fenced = withMainRunsFenced('main-settle-user', async () => {
      order.push('operation');
    });
    await Promise.resolve();
    order.push('start still running');
    finishStart();
    await fenced;
    expect(order).toEqual(['start still running', 'operation']);
  });

  test('refuses a main whose sandbox is not the folder-named one', async () => {
    const { calls, deps } = harness({ usesFolderSandbox: () => false });
    await expect(archivePersonalMain('main-alice', deps)).rejects.toMatchObject(
      { reason: 'custom_sandbox' },
    );
    expect(calls).toEqual([]);
  });

  test('archives a main once when two requests race', async () => {
    const { calls, deps } = harness();
    const entry = deps.getEntry!('main-alice');
    let archived = false;
    deps.getEntry = () => (archived ? undefined : entry);
    const rekey = deps.rekeyGroup!;
    deps.rekeyGroup = (...args) => {
      rekey(...args);
      archived = true;
    };
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const renameDir = deps.renameDir!;
    deps.renameDir = async (from, to) => {
      await gate;
      return renameDir(from, to);
    };
    const first = archivePersonalMain('main-alice', deps);
    const second = archivePersonalMain('main-alice', deps);
    await new Promise((resolve) => setTimeout(resolve, 20));
    open();
    expect(await Promise.all([first, second])).toEqual([ARCHIVE_ID, null]);
    expect(calls.filter((c) => c.startsWith('dir main-alice'))).toHaveLength(1);
  });
});
