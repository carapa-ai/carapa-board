import { afterAll, beforeAll, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  initDatabase,
  updateProjectSettingsWithAdmissionLock,
  commitProjectStageMigration,
} from '../db.js';
import { drizzleDbRef } from '../db/drizzle-client.js';
import { projects } from '../db/schema.js';
import {
  registeredGroups,
  applyGroupUpdateInMemory,
  updateGroup,
  unregisterGroup,
} from '../state-manager.js';
import type { RegisteredGroup } from '../types.js';
import {
  appPublicationInput,
  getAppPublication,
  setAppPublication,
} from './app-publication.js';

const folder = `app-publication-${process.pid}`;
const jid = `${folder}@board`;
const group: RegisteredGroup = {
  folder,
  name: 'Published app',
  trigger: '@test',
  added_at: '',
  settings: {
    defaultSandbox: 'carapa-bot',
    defaultSandboxInstance: 'app-test',
    defaultSandboxService: 'agent',
  },
};
beforeAll(async () => {
  await initDatabase(':memory:');
  await drizzleDbRef.current.insert(projects).values({
    id: folder,
    jid,
    name: group.name,
    folder,
    trigger: group.trigger,
    added_at: group.added_at,
    settings: JSON.stringify(group.settings),
  });
  registeredGroups[jid] = group;
  applyGroupUpdateInMemory(jid, {});
}, 30_000);
afterAll(async () => {
  await unregisterGroup(jid);
});

test('publication requests cannot choose another sandbox or expose SSH', () => {
  expect(
    appPublicationInput.safeParse({ enabled: true, targetPort: 2222 }).success,
  ).toBe(false);
  expect(
    appPublicationInput.safeParse({
      enabled: true,
      targetPort: 3000,
      binding: { instance: 'another-project' },
    }).success,
  ).toBe(false);
  expect(
    appPublicationInput.safeParse({
      enabled: true,
      targetPort: 3000,
      hostname: 'https://app.test/',
    }).success,
  ).toBe(false);
});

test('failed publish remains revocable; ordinary and stage saves preserve its pinned binding', async () => {
  let fail = true;
  const actions: string[] = [];
  const client = {
    sandboxPublishApp: async (stack: string, options: any) => {
      expect(stack).toBe('carapa-bot');
      expect(options.instance).toBe('app-test');
      expect(options.service).toBe('agent');
      expect(options.id).toMatch(/^board-[a-f0-9]{24}$/);
      expect(group.settings?.appPublication?.binding.instance).toBe('app-test');
      actions.push(options.action);
      return {
        stdout: fail
          ? 'connection lost'
          : JSON.stringify({
              enabled: options.action !== 'unpublish',
              ready: options.action !== 'unpublish',
              targetPort: 3000,
              url: 'http://example.test:22000/',
            }),
        isError: fail,
      };
    },
  };
  await expect(
    setAppPublication(group, { enabled: true, targetPort: 3000 }, client),
  ).rejects.toThrow('connection lost');
  expect(group.settings?.appPublication?.enabled).toBe(true);
  const saved = group.settings!.appPublication;
  await updateProjectSettingsWithAdmissionLock(
    folder,
    JSON.stringify({
      ...group.settings,
      appPublication: undefined,
      webRootPath: 'public',
    }),
  );
  const read = async () =>
    JSON.parse(
      (
        await drizzleDbRef.current
          .select()
          .from(projects)
          .where(eq(projects.id, folder))
      )[0].settings!,
    );
  expect((await read()).appPublication).toEqual(saved);
  await updateGroup(jid, {
    settings: { ...group.settings, appPublication: undefined },
  });
  expect((await read()).appPublication).toEqual(saved);
  expect(group.settings?.appPublication).toEqual(saved);
  await commitProjectStageMigration(
    folder,
    JSON.stringify({ ...group.settings, appPublication: undefined }),
    [],
  );
  expect((await read()).appPublication).toEqual(saved);
  await expect(
    setAppPublication(group, { enabled: false }, client),
  ).rejects.toThrow('connection lost');
  expect(group.settings?.appPublication?.enabled).toBe(true);
  fail = false;
  expect((await getAppPublication(group, client)).ready).toBe(true);
  expect(
    (await setAppPublication(group, { enabled: false }, client)).enabled,
  ).toBe(false);
  expect(group.settings?.appPublication).toMatchObject({
    enabled: false,
    targetPort: 3000,
    binding: saved!.binding,
  });
  expect(actions).toEqual(['publish', 'unpublish', 'status', 'unpublish']);
});
