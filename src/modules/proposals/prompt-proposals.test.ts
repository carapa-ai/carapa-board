import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// Load the tool registry first (registry <-> tools import cycle).
import '../tools/registry.js';
import fs from 'node:fs';
import path from 'node:path';

import { GROUPS_DIR } from '../../config.js';
import { initDatabase } from '../../db.js';
import { drizzleDbRef } from '../../db/drizzle-client.js';
import { projects } from '../../db/schema.js';
import {
  applyGroupUpdateInMemory,
  registeredGroups,
} from '../../state-manager.js';
import { readPrompt } from '../../routes/_helpers.js';
import type { McpServerDeps } from '../../mcp/auth.js';
import { createUser, upsertProjectMember } from '../knowledge/db-kb.js';
import {
  findCurrentGroup,
  revisionFor,
} from '../project-setup/project-prompts.js';
import {
  getProjectSetupTool,
  setProjectPromptTool,
} from '../project-setup/tools.js';
import { getProposal } from './db-proposals.js';
import { assertPromptApprover } from './prompt-proposals.js';
import { decideProposal, presentProposal } from './service.js';
import { proposeChangesTool } from './tools.js';

const FOLDER = `prompt-proposals-${process.pid}`;
const TWIN = `${FOLDER}-twin`;
const OTHER_MAIN = `${FOLDER}-main`;

function register(folder: string, extra: Record<string, unknown> = {}) {
  registeredGroups[`${folder}-jid`] = {
    name: folder,
    folder,
    trigger: '@bot',
    added_at: new Date().toISOString(),
    ...extra,
  };
  applyGroupUpdateInMemory(`${folder}-jid`, {});
}

const projectRow = (folder: string) => ({
  jid: `${folder}@board`,
  name: folder,
  folder,
  trigger: '@bot',
  added_at: new Date().toISOString(),
});

const deps = {
  getRegisteredGroups: () => registeredGroups,
} as McpServerDeps;
const permissions = { [FOLDER]: ['chat:write', 'project_setup:read'] };

const setupRevisionOf = (folder: string, groups: typeof registeredGroups) =>
  revisionFor(findCurrentGroup(groups, folder).group, groups);
const revision = () => setupRevisionOf(FOLDER, registeredGroups);

async function propose(
  approve: Record<string, unknown>,
  name = 'worker',
  perms: Record<string, string[]> | undefined = permissions,
) {
  const result = await proposeChangesTool.handler(
    {
      title: 'Tune the worker prompt',
      proposals: [
        {
          rationale: 'Reviews keep rejecting the same thing',
          kind: 'prompt',
          name,
          target_layer: 'project',
          approve_action: approve,
        },
      ],
    },
    deps,
    { group_folder: FOLDER, run_id: 'run-1', permissions: perms },
  );
  return result.proposal_ids[0] as string;
}

const setPrompt = async (content: string | null) => ({
  type: 'set_prompt',
  target_project: FOLDER,
  expected_revision: await revision(),
  prompt_type: 'worker',
  content,
});

beforeAll(async () => {
  await initDatabase(':memory:');
  register(FOLDER);
  register(TWIN);
  for (const folder of [FOLDER, TWIN]) {
    await drizzleDbRef.current.insert(projects).values({
      ...projectRow(folder),
      id: folder,
    });
  }
}, 30_000);

afterAll(() => {
  for (const folder of [FOLDER, TWIN, OTHER_MAIN]) {
    fs.rmSync(path.join(GROUPS_DIR, folder), { recursive: true, force: true });
    delete registeredGroups[`${folder}-jid`];
  }
});

describe('prompt proposals', () => {
  test('approving applies the same file and revision as set_project_prompt', async () => {
    const id = await propose(await setPrompt('Check the diff twice.'));
    const shown = await presentProposal((await getProposal(id))!);
    expect(shown.prompt).toEqual({
      targetProject: FOLDER,
      promptType: 'worker',
      stageId: null,
    });
    expect(shown.approve.files[0]).toMatchObject({
      path: 'worker.md',
      change: 'added',
    });
    expect(shown.approve.files[0].diff).toContain('+Check the diff twice.');

    const decided = await decideProposal(
      (await getProposal(id))!,
      'approve',
      'alice',
    );
    expect(decided.status).toBe('applied');
    expect(decided.decided_by).toBe('alice');
    expect(decided.decided_at).toBeTruthy();

    const direct = JSON.parse(
      await setProjectPromptTool.handler(
        {
          expected_revision: await setupRevisionOf(TWIN, registeredGroups),
          prompt_type: 'worker',
          content: 'Check the diff twice.',
        },
        deps,
        {
          group_folder: TWIN,
          permissions: { [TWIN]: ['project_setup:write'] },
        },
      ),
    );
    expect(decided.result).toBe(
      `Applied \`worker.md\` to \`${FOLDER}\`, setup revision \`${direct.revision}\``,
    );
    expect(await readPrompt(FOLDER, undefined, 'worker.md')).toBe(
      await readPrompt(TWIN, undefined, 'worker.md'),
    );
    const setup = JSON.parse(
      await getProjectSetupTool.handler({}, deps, {
        group_folder: FOLDER,
        permissions,
      }),
    );
    expect(setup.revision).toBe(direct.revision);
  });

  test('a prompt changed after proposing goes stale and stays unchanged', async () => {
    const id = await propose(await setPrompt('Proposed text'));
    await setProjectPromptTool.handler(
      {
        expected_revision: await revision(),
        prompt_type: 'worker',
        content: 'Edited meanwhile',
      },
      deps,
      {
        group_folder: FOLDER,
        permissions: { [FOLDER]: ['project_setup:write'] },
      },
    );
    expect(
      (await presentProposal((await getProposal(id))!)).targetChanged,
    ).toBe(true);

    const decided = await decideProposal(
      (await getProposal(id))!,
      'approve',
      'alice',
    );
    expect(decided.status).toBe('stale');
    expect(decided.result).toBe(
      'The prompt changed after this was proposed. Nothing was written.',
    );
    expect(await readPrompt(FOLDER, undefined, 'worker.md')).toBe(
      'Edited meanwhile',
    );
  });

  test('creation refuses a missing read permission, a stale revision and a bad stage', async () => {
    await expect(
      propose(await setPrompt('x'), 'worker', { [FOLDER]: ['chat:write'] }),
    ).rejects.toThrow('project_setup:read');
    await expect(
      propose({ ...(await setPrompt('x')), expected_revision: 'stale' }),
    ).rejects.toThrow('changed since it was inspected');
    await expect(
      propose(
        {
          ...(await setPrompt('x')),
          prompt_type: 'stage',
          stage_id: 'nope',
        },
        'stage-nope',
      ),
    ).rejects.toThrow('not an enabled executable or run-on-entry stage');
  });
});

describe('assertPromptApprover', () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    for (const name of ['owner', 'editor', 'viewer', 'stranger']) {
      ids[name] = (await createUser(`${FOLDER}-${name}`, 'pw-for-tests')).id;
    }
    await drizzleDbRef.current.insert(projects).values({
      ...projectRow(OTHER_MAIN),
      id: OTHER_MAIN,
      is_main: 1,
      user_id: ids.owner,
    });
    register(OTHER_MAIN, { is_main: true, user_id: ids.owner });
    await upsertProjectMember(ids.editor, FOLDER, 'editor');
    await upsertProjectMember(ids.owner, FOLDER, 'owner');
    await upsertProjectMember(ids.viewer, FOLDER, 'viewer');
  });

  test('allows owner, editor and an admin on an ordinary project', async () => {
    await assertPromptApprover({ id: ids.owner, role: 'user' }, FOLDER);
    await assertPromptApprover({ id: ids.editor, role: 'user' }, FOLDER);
    await assertPromptApprover({ id: ids.stranger, role: 'admin' }, FOLDER);
  });

  test('refuses everyone else, including lookup failures', async () => {
    const refused = (user: { id?: string; role?: string } | undefined) =>
      expect(assertPromptApprover(user, FOLDER)).rejects.toThrow();
    await refused({ id: ids.viewer, role: 'user' });
    await refused({ id: ids.stranger, role: 'user' });
    await refused({ id: 'no-such-user', role: 'user' });
    await refused(undefined);
    await refused({ role: 'admin' });
    // An admin may not reach another user's personal main project.
    await expect(
      assertPromptApprover({ id: ids.stranger, role: 'admin' }, OTHER_MAIN),
    ).rejects.toThrow();
    await expect(
      assertPromptApprover({ id: ids.editor, role: 'user' }, 'unknown-project'),
    ).rejects.toThrow();
  });
});
