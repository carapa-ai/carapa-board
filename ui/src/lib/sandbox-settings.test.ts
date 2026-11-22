// Bun supplies these test globals at runtime; the UI package intentionally
// does not depend on Bun's type declarations.
// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import {
  sandboxLifecycleParams,
  sandboxLifecycleIsManaged,
  sandboxCoordinates,
  sandboxInheritanceForEdit,
  sandboxWorkspaceLocationValues,
  sharedSandboxParent,
  settingsForProjectUpdate,
  canEditRepositoryConnection,
  REPOSITORY_CONNECTION_FIELDS,
} from './sandbox-settings';

describe('shared sandbox settings updates', () => {
  test('omits inherited lifecycle fields while preserving child repository settings', () => {
    expect(
      settingsForProjectUpdate(
        {
          defaultSandbox: 'stale-child-value',
          defaultSandboxInstance: 'stale-instance',
          autoStartStack: true,
          webRootPath: 'stale/public',
          workspaceRoots: ['/stale'],
          repositoryLocation: '/host/workspace/child',
          workspacePath: 'child',
          defaultBranch: 'main',
        },
        true,
      ),
    ).toEqual({
      repositoryLocation: '/host/workspace/child',
      workspacePath: 'child',
      defaultBranch: 'main',
    });
  });

  test('strips repository connection fields only when the caller cannot edit them', () => {
    const settings = {
      repositoryLocation: '/repo',
      repositoryUrl: 'https://example.com/r',
      repositoryRelativePath: 'sub',
      sharedWorkspaceHostLocation: '/host',
      defaultBranch: 'main',
    };
    expect(settingsForProjectUpdate(settings, false, false)).toEqual({
      defaultBranch: 'main',
    });
    expect(settingsForProjectUpdate(settings, false)).toEqual(settings);
    expect(REPOSITORY_CONNECTION_FIELDS).toHaveLength(4);
  });

  test('allows repository connection edits for owners and admins only', () => {
    const user = { id: 'u1', role: 'user' };
    expect(canEditRepositoryConnection({ accessLevel: 'owner' }, user)).toBe(
      true,
    );
    expect(
      canEditRepositoryConnection(
        { accessLevel: 'editor', userId: 'u1' },
        user,
      ),
    ).toBe(false);
    expect(canEditRepositoryConnection({ accessLevel: 'viewer' }, user)).toBe(
      false,
    );
    expect(canEditRepositoryConnection({ userId: 'u1' }, user)).toBe(true);
    expect(canEditRepositoryConnection({ userId: 'u2' }, user)).toBe(false);
    expect(
      canEditRepositoryConnection(
        { accessLevel: 'editor', userId: 'u1' },
        { id: 'a', role: 'admin' },
      ),
    ).toBe(false);
    expect(
      canEditRepositoryConnection(
        { accessLevel: 'editor', userId: 'a' },
        { id: 'a', role: 'admin' },
      ),
    ).toBe(true);
    expect(
      canEditRepositoryConnection(
        { accessLevel: 'editor' },
        { id: 'a', role: 'admin' },
      ),
    ).toBe(true);
  });

  test('identifies the selected project only by group', () => {
    expect(sandboxLifecycleParams('child-project')).toBe(
      '?group=child-project',
    );
    expect(sandboxLifecycleParams()).toBe('');
  });

  test('treats a newly selected shared parent as inherited before saving', () => {
    const projects = [
      {
        id: 'parent',
        name: 'Parent',
        folder: 'parent',
        settings: { isParent: true, sandboxOwnership: 'shared' },
      },
    ];
    expect(sharedSandboxParent('parent', projects)?.id).toBe('parent');
    expect(
      settingsForProjectUpdate(
        { defaultSandbox: 'stale-child-stack', repositoryLocation: '/repo' },
        !!sharedSandboxParent('parent', projects),
      ),
    ).toEqual({ repositoryLocation: '/repo' });
  });

  test('uses effective coordinates for shared sandbox UI surfaces', () => {
    expect(
      sandboxCoordinates({
        id: 'child',
        name: 'Child',
        folder: 'child',
        settings: { defaultSandbox: 'stale-child-stack' },
        effectiveSandbox: {
          ownerProjectId: 'parent',
          inherited: true,
          managed: true,
          stack: 'parent-stack',
          instance: 'parent-instance',
          service: 'worker',
          autoStart: true,
          containerWorkspaceRoot: '/workspace/repos',
          workspaceRoot: '/workspace/repos/child',
          workspaceRoots: ['/workspace/repos/child'],
        },
      }),
    ).toEqual({ stack: 'parent-stack', instance: 'parent-instance' });
  });

  test('disables lifecycle controls for externally managed fixed instances', () => {
    expect(
      sandboxLifecycleIsManaged({
        id: 'fixed',
        name: 'Fixed',
        folder: 'fixed',
        effectiveSandbox: {
          ownerProjectId: 'fixed',
          inherited: false,
          managed: false,
          stack: 'external-stack',
          instance: 'external-instance',
          service: 'agent',
          autoStart: false,
          containerWorkspaceRoot: '/workspace',
          workspaceRoot: '/workspace',
          workspaceRoots: ['/workspace'],
        },
      }),
    ).toBe(false);
    expect(sandboxLifecycleIsManaged(undefined)).toBe(true);
  });

  test('keeps inherited fields read-only when the parent is absent from the filtered project list', () => {
    const child = {
      id: 'child',
      name: 'Child',
      folder: 'child',
      parentId: 'hidden-parent',
      settings: { defaultSandbox: 'stale-child-stack' },
      effectiveSandbox: {
        ownerProjectId: 'hidden-parent',
        inherited: true,
        managed: true,
        stack: 'parent-stack',
        instance: 'parent-instance',
        service: 'worker',
        autoStart: true,
        hostWorkspaceLocation: '/host/shared-workspace',
        containerWorkspaceRoot: '/workspace/repos',
        workspaceRoot: '/workspace/repos/child',
        workspaceRoots: ['/workspace/repos/child'],
      },
    };
    const inheritance = sandboxInheritanceForEdit(child, 'hidden-parent', [
      child,
    ]);
    expect(inheritance.inherited).toBe(true);
    expect(sandboxLifecycleIsManaged(child)).toBe(false);
    expect(inheritance.owner).toBeUndefined();
    expect(inheritance.effectiveSandbox?.instance).toBe('parent-instance');
    expect(
      sandboxWorkspaceLocationValues(
        child.settings,
        inheritance.effectiveSandbox,
        inheritance.inherited,
      ),
    ).toEqual({
      hostWorkspaceLocation: '/host/shared-workspace',
      containerWorkspaceRoot: '/workspace/repos',
    });
    expect(
      settingsForProjectUpdate(child.settings, inheritance.inherited),
    ).toEqual({});
  });
});
