import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import type { RegisteredGroup } from '../../types.js';
import { TOOLSET_MODULES } from '../tools/registry.js';
import { registerToolsToMcp } from '../tools/index.js';
import { buildMailToolset, mailToolDeps } from './tools.js';

// ── Per-user authorization for cross-project mail tool calls ────────────────

const schema = { type: 'object', properties: {} };
const remoteTools = [
  'carapamail_read_email',
  'carapamail_send',
  'carapamail_download_attachment',
  'carapamail_list_accounts',
].map((name) => ({ name, description: '', inputSchema: schema }));

const mailGroup = (
  folder: string,
  extra: Partial<RegisteredGroup> = {},
): RegisteredGroup => ({
  name: folder,
  folder,
  trigger: '@Capa',
  added_at: new Date().toISOString(),
  settings: { carapaMailEnabled: true, carapaMailToken: `tok-${folder}` },
  ...extra,
});

const groups: Record<string, RegisteredGroup> = {
  'main-alice': mailGroup('main-alice', {
    is_main: true,
    user_id: 'alice',
    settings: {},
  }),
  'main-unowned': mailGroup('main-unowned', { is_main: true, settings: {} }),
  'mail-alice': mailGroup('mail-alice'),
  'mail-bob': mailGroup('mail-bob'),
  'mail-shared-view': mailGroup('mail-shared-view'),
  'mail-shared-edit': mailGroup('mail-shared-edit'),
  plain: mailGroup('plain', { settings: {} }),
  'main-bob': mailGroup('main-bob', { is_main: true, user_id: 'bob' }),
};
const users: Record<string, { id: string; role: string }> = {
  alice: { id: 'alice', role: 'user' },
  admin: { id: 'admin', role: 'admin' },
};
const access: Record<string, any> = {
  'alice:mail-alice': { kind: 'explicit', level: 'owner' },
  'alice:mail-shared-view': { kind: 'explicit', level: 'viewer' },
  'alice:mail-shared-edit': { kind: 'explicit', level: 'editor' },
};

let calls: string[] = [];
let failFolder: string | undefined;
const original = { ...mailToolDeps };

beforeAll(() => {
  Object.assign(mailToolDeps, {
    getGroupByFolder: (f: string) => groups[f],
    listGroups: () => Object.values(groups),
    getUserById: async (id: string) => users[id],
    getProjectAccess: async (uid: string, pid: string) =>
      access[`${uid}:${pid}`] ?? null,
    callTool: async (folder: string, name: string) => {
      if (folder === failFolder) throw new Error('boom');
      calls.push(`${folder}:${name}`);
      return `ok:${folder}:${name}`;
    },
  });
});
afterAll(() => Object.assign(mailToolDeps, original));
beforeEach(() => {
  calls = [];
  failFolder = undefined;
});

function run(caller: string, tool: string, args: any = {}) {
  const t = buildMailToolset(remoteTools).find((x) => x.name === tool)!;
  return (t.handler as any)(
    args,
    {},
    {
      group_folder: caller,
      permissions: groups[caller]?.is_main ? { '*': ['*:*'] } : {},
    },
  ) as Promise<string>;
}
const denied = (p: string) =>
  `Error: not authorized to access mail for project "${p}"`;

test('a per-user main cannot reach another users mail project', async () => {
  const bob = { project_id: 'mail-bob' };
  expect(await run('main-alice', 'carapamail_read_email', bob)).toBe(
    denied('mail-bob'),
  );
  expect(await run('main-alice', 'carapamail_send', bob)).toBe(
    denied('mail-bob'),
  );
  expect(await run('main-alice', 'carapamail_download_attachment', bob)).toBe(
    denied('mail-bob'),
  );
  expect(await run('main-alice', 'carapamail_list_accounts', bob)).toBe(
    denied('mail-bob'),
  );
  expect(calls).toEqual([]);
});

test('list_accounts fan-out lists only authorized projects and survives a failure', async () => {
  const out = await run('main-alice', 'carapamail_list_accounts');
  expect(out).toContain('## Project: mail-alice');
  expect(out).toContain('## Project: mail-shared-view');
  expect(out).not.toContain('mail-bob');
  expect(out).not.toContain('main-bob');

  failFolder = 'mail-alice';
  const partial = await run('main-alice', 'carapamail_list_accounts');
  expect(partial).toContain('## Project: mail-alice\nError: boom');
  expect(partial).toContain('ok:mail-shared-view');
});

test('explicit membership: viewer reads but cannot send; editor can send', async () => {
  expect(
    await run('main-alice', 'carapamail_read_email', {
      project_id: 'mail-shared-view',
    }),
  ).toBe('ok:mail-shared-view:carapamail_read_email');
  expect(
    await run('main-alice', 'carapamail_send', {
      project_id: 'mail-shared-view',
    }),
  ).toBe(denied('mail-shared-view'));
  expect(
    await run('main-alice', 'carapamail_send', {
      project_id: 'mail-shared-edit',
    }),
  ).toBe('ok:mail-shared-edit:carapamail_send');
});

test('admin per-user main follows mailRole; a main without an owner is refused', async () => {
  groups['main-admin'] = mailGroup('main-admin', {
    is_main: true,
    user_id: 'admin',
    settings: {},
  });
  expect(
    await run('main-admin', 'carapamail_send', { project_id: 'mail-bob' }),
  ).toBe('ok:mail-bob:carapamail_send');
  // …but not another user's personal main project, even for admins.
  expect(
    await run('main-admin', 'carapamail_read_email', {
      project_id: 'main-bob',
    }),
  ).toBe(denied('main-bob'));
  delete groups['main-admin'];

  expect(
    await run('main-unowned', 'carapamail_send', { project_id: 'mail-bob' }),
  ).toBe(denied('mail-bob'));
  expect(await run('main-unowned', 'carapamail_list_accounts')).toBe(
    'No mail-enabled projects are configured.',
  );
});

test('same-project calls are unchanged', async () => {
  expect(await run('mail-bob', 'carapamail_send')).toBe(
    'ok:mail-bob:carapamail_send',
  );
  expect(
    await run('main-alice', 'carapamail_read_email', {
      project_id: 'mail-alice',
    }),
  ).toBe('ok:mail-alice:carapamail_read_email');
});

test('attachment download refuses a foreign-origin url and saves stubbed bytes as artifacts', async () => {
  const written: { folder: string; relPath: string; bytes: string }[] = [];
  const { callTool, download, writeArtifact } = mailToolDeps;
  const meta = (filename: string) => async () =>
    JSON.stringify({
      url: 'http://169.254.169.254/latest',
      filename,
      content_type: 'text/html',
    });
  try {
    mailToolDeps.writeArtifact = (async (
      folder: string,
      relPath: string,
      buf: Buffer,
    ) => {
      written.push({ folder, relPath, bytes: buf.toString() });
      return { relPath, url: `/artifacts/${folder}/${relPath}` };
    }) as any;

    // Real downloader: a foreign-origin url is refused and nothing is saved.
    mailToolDeps.callTool = meta('attach.html');
    const refused = await run('mail-alice', 'carapamail_download_attachment');
    expect(refused).toContain('could not fetch its bytes');
    expect(written).toEqual([]);

    mailToolDeps.download = async () => Buffer.from('<p>hi</p>');
    const ok = await run('mail-alice', 'carapamail_download_attachment');
    expect(ok).toContain('/artifacts/mail-alice/mail/');
    expect(written).toHaveLength(1);
    expect(written[0]!.relPath).toMatch(/^mail\/\d+-attach\.html$/);
    expect(written[0]!.bytes).toBe('<p>hi</p>');

    // Path separators in the attachment filename never leave mail/.
    written.length = 0;
    mailToolDeps.callTool = meta('../x/evil.html');
    await run('mail-alice', 'carapamail_download_attachment');
    expect(written).toHaveLength(1);
    expect(written[0]!.relPath).toMatch(/^mail\/\d+-evil\.html$/);

    // Oversized attachment: friendly message, nothing written.
    written.length = 0;
    mailToolDeps.download = async () => {
      throw Object.assign(new Error('too big'), { status: 413 });
    };
    const big = await run('mail-alice', 'carapamail_download_attachment');
    expect(big).toContain('too large (limit 25 MB)');
    expect(written).toEqual([]);
  } finally {
    Object.assign(mailToolDeps, { callTool, download, writeArtifact });
  }
});

// ── Mail tools over the board MCP server ────────────────────────────────────

describe('mail tools over MCP', () => {
  const allRemote = [
    ...remoteTools,
    ...[
      'list_folders',
      'list_emails',
      'search',
      'save_draft',
      'move',
      'delete',
      'mark_read',
      'stats',
    ].map((n) => ({
      name: `carapamail_${n}`,
      description: '',
      inputSchema: schema,
    })),
  ];
  const savedMail = TOOLSET_MODULES.mail;
  beforeAll(() => {
    TOOLSET_MODULES.mail = buildMailToolset(allRemote);
  });
  afterAll(() => {
    TOOLSET_MODULES.mail = savedMail;
  });

  function register(group_folder: string, kind?: string) {
    const registered = new Map<string, any>();
    registerToolsToMcp(
      {
        registerTool: (name: string, _cfg: any, cb: any) =>
          registered.set(name, cb),
      } as any,
      {} as any,
      { group_folder, permissions: {}, kind },
    );
    for (const name of registered.keys())
      if (!name.startsWith('carapamail_')) registered.delete(name);
    return registered;
  }

  test('a mail-enabled project token gets exactly the read and draft allowlist', () => {
    expect([...register('mail-alice').keys()].sort()).toEqual([
      'carapamail_download_attachment',
      'carapamail_list_emails',
      'carapamail_list_folders',
      'carapamail_read_email',
      'carapamail_save_draft',
      'carapamail_search',
    ]);
  });

  test('main, mail-disabled projects and human or OAuth tokens get none', () => {
    expect(register('main-alice').size).toBe(0);
    expect(register('plain').size).toBe(0);
    expect(register('mail-alice', 'oauth').size).toBe(0);
    expect(register('mail-alice', 'user').size).toBe(0);
  });

  test('calls stay on the token project and a foreign project_id is refused', async () => {
    const read = register('mail-alice').get('carapamail_read_email');
    const refused = await read({ project_id: 'mail-bob' }, {});
    expect(refused.isError).toBe(true);
    expect(calls).toEqual([]);

    await read({}, {});
    expect(calls).toEqual(['mail-alice:carapamail_read_email']);
  });
});
