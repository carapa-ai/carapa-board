import { expect, test } from 'bun:test';
import { resolveEffectiveSandbox } from './effective-settings.js';
import { setSandboxSsh } from './ssh-settings.js';
import type { RegisteredGroup } from '../types.js';

test('SSH updates serialize desired and actual state; a failed apply retains the saved preference', async () => {
  const group: RegisteredGroup = {
    folder: 'ssh-demo',
    name: 'SSH demo',
    trigger: '@Capa',
    added_at: '',
    settings: { defaultSandbox: 'carapa-bot' },
  };
  const target = resolveEffectiveSandbox(group, () => undefined);
  const writes: boolean[] = [];
  const actions: string[] = [];
  let fail = false;
  const connection = {
    supported: true,
    containerRunning: true,
    host: '192.168.1.10',
    port: 22017,
    command: 'ssh -p 22017 ubuntu@192.168.1.10',
    ingress: true,
    internalHost: '172.30.0.5',
  };
  const deps = {
    readSandboxSsh: async () => ({
      supported: true,
      containerRunning: true,
      running: false,
      service: target.service,
    }),
    updateProjectSshPreference: async (_id: string, value: boolean) => {
      writes.push(value);
    },
    getGroupByFolder: () => group,
    getSandboxClient: () => ({
      sandboxSsh: async (_stack: string, action: string, instance: string) => {
        expect(instance).toBe(target.instance);
        actions.push(action);
        return {
          isError: fail,
          stdout: fail
            ? 'daemon failed'
            : JSON.stringify({
                running: action === 'start',
                ...(action === 'start' ? connection : {}),
              }),
        };
      },
    }),
  } as unknown as NonNullable<Parameters<typeof setSandboxSsh>[2]>;
  const [started] = await Promise.all([
    setSandboxSsh(target, true, deps),
    setSandboxSsh(target, false, deps),
  ]);
  expect(started).toEqual({ running: true, ...connection });
  expect(writes).toEqual([true, false]);
  expect(actions).toEqual(['start', 'stop']);
  expect(group.settings?.sshEnabled).toBe(false);
  fail = true;
  await expect(setSandboxSsh(target, true, deps)).rejects.toThrow(
    'preference saved',
  );
  expect(group.settings?.sshEnabled).toBe(true);
});

test('an unsupported service cannot persist or enable SSH', async () => {
  const group: RegisteredGroup = {
    folder: 'unsupported-ssh',
    name: 'Unsupported',
    trigger: '@Capa',
    added_at: '',
  };
  let wrote = false;
  const deps = {
    readSandboxSsh: async () => ({
      supported: false,
      containerRunning: false,
      running: false,
    }),
    updateProjectSshPreference: async () => {
      wrote = true;
    },
  } as unknown as NonNullable<Parameters<typeof setSandboxSsh>[2]>;
  await expect(
    setSandboxSsh(
      resolveEffectiveSandbox(group, () => undefined),
      true,
      deps,
    ),
  ).rejects.toThrow('does not support');
  expect(wrote).toBe(false);
});
