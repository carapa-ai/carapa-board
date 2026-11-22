import { describe, expect, test } from 'bun:test';
import type { RegisteredGroup } from '../types.js';
import {
  computeEffectiveWorkspaceRoot,
  effectiveContainerGroupDir,
  effectiveContainerUploadDir,
  effectiveGitArgs,
  effectiveProjectUploadDir,
  effectiveSandboxIpcDir,
  effectiveRunSandboxStack,
  effectiveOperationInstance,
  lifecycleSandboxInstance,
  effectiveSandboxSettings,
  projectDeletionSandboxTarget,
  resolveEffectiveSandbox,
  sharedSandboxOwner,
  validateInheritedSandboxUpdate,
  uniqueEffectiveSandboxes,
} from './effective-settings.js';
import { getAgentPermissions } from '../mcp/auth.js';
import {
  buildRunTokenScope,
  mintRunScopedAgentToken,
  pwRecordingPaths,
  resolveAgentWorkDir,
  resolveRunAttachmentCopy,
} from './process.js';
import { resolveSandboxPath } from '../modules/fs/sandbox-fs.js';
import { buildSandboxEnv } from './sandbox-env.js';
import { getHostGroupDir } from '../group-dir.js';
import { verifyToken } from '../mcp/auth-tokens.js';

const parent: RegisteredGroup = {
  name: 'Workspace owner',
  folder: 'shared-owner-test',
  trigger: '@Capa',
  added_at: new Date().toISOString(),
  settings: {
    isParent: true,
    sandboxOwnership: 'shared',
    defaultSandbox: 'shared-stack',
    defaultSandboxInstance: 'shared-instance',
    defaultSandboxService: 'worker',
    autoStartStack: false,
    sharedWorkspaceHostLocation: '/host/projects',
    sharedWorkspaceContainerRoot: '/workspace/repos',
    webRootPath: 'child-repo/public',
    workspaceRoots: ['/workspace/common'],
  },
};

const child: RegisteredGroup = {
  name: 'Child repo',
  folder: 'shared-child-test',
  parentId: parent.folder,
  trigger: '@Capa',
  added_at: new Date().toISOString(),
  settings: {
    repositoryLocation: '/host/projects/child-repo',
    workspacePath: 'child-repo',
    // Legacy overrides must not affect effective owner configuration.
    defaultSandbox: 'ignored-child-stack',
  },
};

const lookup = (folder: string) =>
  folder === parent.folder ? parent : undefined;

describe('shared sandbox effective settings', () => {
  test('resolves stack, instance, lifecycle, and roots from the parent owner', () => {
    expect(effectiveSandboxSettings(child, lookup)).toEqual({
      ownerProjectId: parent.folder,
      inherited: true,
      managed: true,
      stack: 'shared-stack',
      instance: 'shared-instance',
      service: 'worker',
      autoStart: false,
      hostWorkspaceLocation: '/host/projects',
      containerWorkspaceRoot: '/workspace/repos',
      webRootPath: 'child-repo/public',
      proxyHostnameAliases: [],
      workspaceRoot: '/workspace/repos/child-repo',
      workspaceRoots: ['/workspace/repos/child-repo', '/workspace/common'],
      extraMounts: [],
    });
  });

  test('canonicalises trailing slashes on extra workspace roots', () => {
    const group: RegisteredGroup = {
      ...parent,
      folder: 'trailing-slash-root-test',
      settings: {
        workspacePath: '/workspace/p1',
        workspaceRoots: ['/data/shared/'],
      },
    };
    const { extraRoots } = resolveEffectiveSandbox(group, () => undefined);
    expect(extraRoots).toEqual(['/data/shared']);
    const roots = { primary: '/workspace/p1', extra: extraRoots };
    expect(resolveSandboxPath(roots, '/data/shared/report.txt')).toBe(
      '/data/shared/report.txt',
    );
    expect(() => resolveSandboxPath(roots, '/data/sharedX/report.txt')).toThrow(
      'Unauthorized',
    );
  });

  test('keeps legacy nested shared-owner coordinates and workspace mounts on the same owner', () => {
    const grandparent: RegisteredGroup = {
      ...parent,
      folder: 'legacy-grandparent',
      settings: {
        ...parent.settings,
        defaultSandbox: 'grandparent-stack',
        defaultSandboxInstance: 'grandparent-instance',
        sharedWorkspaceHostLocation: '/host/grandparent',
        sharedWorkspaceContainerRoot: '/workspace/grandparent',
      },
    };
    const nestedOwner: RegisteredGroup = {
      ...parent,
      folder: 'legacy-nested-owner',
      parentId: grandparent.folder,
      settings: {
        ...parent.settings,
        defaultSandbox: 'nested-stack',
        defaultSandboxInstance: 'nested-instance',
        sharedWorkspaceHostLocation: '/host/nested',
        sharedWorkspaceContainerRoot: '/workspace/nested',
      },
    };
    const nestedChild: RegisteredGroup = {
      ...child,
      folder: 'legacy-nested-child',
      parentId: nestedOwner.folder,
      settings: { workspacePath: 'repo' },
    };
    const groups = [grandparent, nestedOwner, nestedChild];
    const nestedLookup = (folder: string) =>
      groups.find((candidate) => candidate.folder === folder);

    expect(resolveEffectiveSandbox(nestedOwner, nestedLookup)).toMatchObject({
      owner: { folder: nestedOwner.folder },
      stack: 'nested-stack',
      instance: 'nested-instance',
      hostWorkspaceLocation: '/host/nested',
      containerWorkspaceRoot: '/workspace/nested',
    });
    expect(resolveEffectiveSandbox(nestedChild, nestedLookup)).toMatchObject({
      owner: { folder: nestedOwner.folder },
      stack: 'nested-stack',
      instance: 'nested-instance',
      hostWorkspaceLocation: '/host/nested',
      containerWorkspaceRoot: '/workspace/nested',
      workspaceRoot: '/workspace/nested/repo',
    });
    expect(buildSandboxEnv(nestedOwner)).toMatchObject({
      LOCAL_REPO: '/host/nested',
      WORKSPACE_PATH: '/workspace/nested',
    });
  });

  test('a main mounts only its own group folder', () => {
    const userMain: RegisteredGroup = {
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      name: 'User main',
      folder: 'mount-scope-main-alice',
      is_main: true,
      user_id: 'alice',
    };
    expect(buildSandboxEnv(userMain).GROUP_DIR).toBe(
      getHostGroupDir(userMain.folder),
    );
    // A project on a remote box is always addressed by its own logical folder.
    const remote = { ...userMain, settings: { boxId: 'remote-box' } };
    expect(buildSandboxEnv(remote).GROUP_DIR).toBe(`@group/${userMain.folder}`);
  });

  test('passes the owner extra mounts to the sandbox as EXTRA_MOUNT_N', () => {
    const standalone: RegisteredGroup = {
      name: 'Standalone',
      folder: 'extra-mounts-test',
      trigger: '@Capa',
      added_at: new Date().toISOString(),
      settings: {
        repositoryLocation: '/host/standalone',
        extraMounts: ['/srv/a', '/srv/b'],
      },
    };
    expect(buildSandboxEnv(standalone)).toMatchObject({
      EXTRA_MOUNT_1: '/srv/a',
      EXTRA_MOUNT_2: '/srv/b',
    });
    expect(buildSandboxEnv(standalone)).toMatchObject({
      EXTRA_MOUNT_1_NAME: 'a',
      EXTRA_MOUNT_2_NAME: 'b',
    });
    // Leaf names that collide with the primary workspace or each other get
    // the slot number appended.
    standalone.settings!.extraMounts = [
      `/srv/${standalone.folder}`,
      '/data/docs',
    ];
    expect(buildSandboxEnv(standalone)).toMatchObject({
      EXTRA_MOUNT_1_NAME: `${standalone.folder}-1`,
      EXTRA_MOUNT_2_NAME: 'docs',
    });
    standalone.settings!.extraMounts = ['/a/docs', '/b/docs'];
    expect(buildSandboxEnv(standalone)).toMatchObject({
      EXTRA_MOUNT_1_NAME: 'docs',
      EXTRA_MOUNT_2_NAME: 'docs-2',
    });
    delete standalone.settings!.extraMounts;
    expect(buildSandboxEnv(standalone).EXTRA_MOUNT_1).toBeUndefined();
  });

  test('uses the owner custom instance for shared IPC files and lifecycle sweeps', () => {
    expect(effectiveSandboxIpcDir(child, '/board-data', lookup)).toBe(
      '/board-data/ipc/shared-stack-shared-instance',
    );

    const targets = uniqueEffectiveSandboxes([child, parent], lookup);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      stack: 'shared-stack',
      instance: 'shared-instance',
      service: 'worker',
      owner: { folder: parent.folder },
    });
  });

  test('routes a parent and two children through one IPC instance with isolated roots', () => {
    const sibling: RegisteredGroup = {
      ...child,
      name: 'Sibling repo',
      folder: 'shared-sibling-test',
      settings: {
        repositoryLocation: '/host/projects/sibling-repo',
        workspacePath: 'sibling-repo',
      },
    };
    const multiLookup = (folder: string) =>
      folder === parent.folder
        ? parent
        : folder === child.folder
          ? child
          : folder === sibling.folder
            ? sibling
            : undefined;

    const parentEffective = resolveEffectiveSandbox(parent, multiLookup);
    const childEffective = resolveEffectiveSandbox(child, multiLookup);
    const siblingEffective = resolveEffectiveSandbox(sibling, multiLookup);

    expect(
      [parentEffective, childEffective, siblingEffective].map(
        ({ stack, instance }) => `${stack}:${instance}`,
      ),
    ).toEqual([
      'shared-stack:shared-instance',
      'shared-stack:shared-instance',
      'shared-stack:shared-instance',
    ]);
    expect(
      [parentEffective, childEffective, siblingEffective].map(
        ({ workspaceRoot }) => workspaceRoot,
      ),
    ).toEqual([
      '/workspace/repos',
      '/workspace/repos/child-repo',
      '/workspace/repos/sibling-repo',
    ]);
    expect(effectiveContainerGroupDir(child, multiLookup)).toBe(
      '/workspace/group/shared-child-test',
    );
    expect(effectiveContainerGroupDir(sibling, multiLookup)).toBe(
      '/workspace/group/shared-sibling-test',
    );
    expect(
      uniqueEffectiveSandboxes([parent, child, sibling], multiLookup),
    ).toHaveLength(1);
  });

  test('namespaces shared uploads by project while preserving standalone paths', () => {
    const sibling = { ...child, folder: 'shared-sibling-test' };
    expect(effectiveProjectUploadDir(child, '/board-data', lookup)).toBe(
      '/board-data/ipc/shared-stack-shared-instance/uploads/shared-child-test',
    );
    expect(effectiveProjectUploadDir(sibling, '/board-data', lookup)).toBe(
      '/board-data/ipc/shared-stack-shared-instance/uploads/shared-sibling-test',
    );
    expect(effectiveContainerUploadDir(child, lookup)).toBe(
      '/workspace/ipc/uploads/shared-child-test',
    );
    expect(effectiveContainerGroupDir(parent, lookup)).toBe('/workspace/group');
    expect(effectiveContainerGroupDir(child, lookup)).toBe(
      '/workspace/group/shared-child-test',
    );

    const standalone = {
      ...child,
      parentId: undefined,
      settings: { defaultSandbox: 'standalone-stack' },
    };
    expect(effectiveProjectUploadDir(standalone, '/board-data')).toBe(
      '/board-data/ipc/standalone-stack-shared-child-test/uploads',
    );
    expect(effectiveContainerUploadDir(standalone)).toBe(
      '/workspace/ipc/uploads',
    );
    expect(effectiveContainerGroupDir(standalone)).toBe('/workspace/group');
  });

  test('ignores stage stack overrides for shared owners but preserves standalone overrides', () => {
    expect(
      effectiveRunSandboxStack(
        resolveEffectiveSandbox(child, lookup),
        'stage-override',
      ),
    ).toBe('shared-stack');

    const standalone = {
      ...child,
      parentId: undefined,
      settings: { defaultSandbox: 'standalone-stack' },
    };
    expect(
      effectiveRunSandboxStack(
        resolveEffectiveSandbox(standalone),
        'stage-override',
      ),
    ).toBe('stage-override');
  });

  test('ignores explicit child Git instances for shared owners', () => {
    const effective = resolveEffectiveSandbox(child, lookup);
    expect(effectiveOperationInstance(effective, child.folder)).toBe(
      'shared-instance',
    );

    const standalone = resolveEffectiveSandbox({
      ...child,
      parentId: undefined,
      settings: { defaultSandbox: 'standalone-stack' },
    });
    expect(effectiveOperationInstance(standalone, 'explicit-instance')).toBe(
      'explicit-instance',
    );
    expect(effectiveOperationInstance(standalone)).toBe(child.folder);
    const fixedStandalone = resolveEffectiveSandbox({
      ...child,
      parentId: undefined,
      settings: {
        defaultSandbox: 'standalone-stack',
        defaultSandboxInstance: 'configured-instance',
      },
    });
    expect(effectiveOperationInstance(fixedStandalone)).toBe(
      'configured-instance',
    );
    expect(
      effectiveOperationInstance(fixedStandalone, 'stale-task-instance'),
    ).toBe('configured-instance');
    expect(effectiveGitArgs(effective, 'status --short')).toBe(
      "-C '/workspace/repos/child-repo' status --short",
    );
    expect(
      effectiveGitArgs(
        { ...effective, workspaceRoot: "/workspace/repos/child's repo" },
        'status --short',
      ),
    ).toBe("-C '/workspace/repos/child'\\''s repo' status --short");
    expect(effectiveGitArgs(standalone, 'status --short')).toBe(
      'status --short',
    );
  });

  test('deletes only owned containers and uses a shared owner custom instance', () => {
    expect(projectDeletionSandboxTarget(parent, lookup)).toEqual({
      stack: 'shared-stack',
      instance: 'shared-instance',
    });
    expect(projectDeletionSandboxTarget(child, lookup)).toBeUndefined();

    const fixedStandalone = {
      ...child,
      parentId: undefined,
      folder: 'fixed-project',
      settings: {
        defaultSandbox: 'fixed-stack',
        defaultSandboxInstance: 'external-instance',
      },
    };
    expect(projectDeletionSandboxTarget(fixedStandalone)).toEqual({
      stack: 'fixed-stack',
      instance: 'fixed-project',
    });
  });

  test('treats a shared owner instance as managed, unlike a standalone fixed instance', () => {
    expect(resolveEffectiveSandbox(parent).fixedInstance).toBe(false);
    const standalone = {
      ...child,
      parentId: undefined,
      settings: { defaultSandboxInstance: 'external-instance' },
    };
    const resolved = resolveEffectiveSandbox(standalone);
    expect(resolved.fixedInstance).toBe(true);
    expect(resolved.managed).toBe(false);
    expect(lifecycleSandboxInstance(resolved)).toBe(standalone.folder);
    expect(lifecycleSandboxInstance(resolveEffectiveSandbox(parent))).toBe(
      'shared-instance',
    );
  });

  test('rejects owner-controlled child API fields but permits repository fields', () => {
    expect(
      validateInheritedSandboxUpdate(parent, { defaultSandbox: 'other' }),
    ).toContain('owned by parent project');
    expect(
      validateInheritedSandboxUpdate(parent, { autoStartStack: true }),
    ).toContain('owned by parent project');
    expect(
      validateInheritedSandboxUpdate(parent, { webRootPath: 'other/public' }),
    ).toContain('owned by parent project');
    expect(
      validateInheritedSandboxUpdate(parent, {
        repositoryLocation: '/host/projects/other-child',
        workspacePath: 'other-child',
      }),
    ).toBeUndefined();
    expect(
      validateInheritedSandboxUpdate(parent, { workspacePath: '/etc' }),
    ).toContain('parent container workspace root');
    expect(
      validateInheritedSandboxUpdate(parent, { workspacePath: '../../etc' }),
    ).toContain('parent container workspace root');
    expect(buildSandboxEnv(parent).WEB_ROOT_PATH).toBe('child-repo/public');
  });

  test('permits a child workspace below a parent root with a trailing slash', () => {
    const trailingRootParent: RegisteredGroup = {
      ...parent,
      settings: {
        ...parent.settings,
        sharedWorkspaceContainerRoot: '/var/www/shop/',
      },
    };
    expect(
      validateInheritedSandboxUpdate(trailingRootParent, {
        workspacePath: '/var/www/shop/admin-frontend',
      }),
    ).toBeUndefined();
    expect(
      validateInheritedSandboxUpdate(trailingRootParent, {
        workspacePath: '/var/www/shop-other/admin-frontend',
      }),
    ).toContain('parent container workspace root');
  });

  test('contains legacy relative traversal and scopes shared credentials through the owner', () => {
    const traversingChild = {
      ...child,
      settings: { ...child.settings, workspacePath: '../../etc' },
    };
    expect(computeEffectiveWorkspaceRoot(traversingChild, lookup)).toBe(
      '/workspace/repos/shared-child-test',
    );
    const owner = sharedSandboxOwner(child, lookup);
    expect(owner).toBe(parent);
    const permissions = getAgentPermissions(owner, {
      parent,
      child,
    });
    expect(permissions[parent.folder]).toBeDefined();
    expect(permissions[child.folder]).toBeDefined();
  });

  test('launches inherited child runs and worktrees from the child repository root', () => {
    const effective = resolveEffectiveSandbox(child, lookup);
    expect(resolveAgentWorkDir(effective, {})).toBe(
      '/workspace/repos/child-repo',
    );
    expect(
      resolveAgentWorkDir(effective, {
        worktree_path: '/host/projects/child-repo/.worktrees/task-branch',
        branch_name: 'task-branch',
      }),
    ).toBe('/workspace/repos/child-repo/.worktrees/task-branch');

    expect(
      resolveAgentWorkDir(
        { inherited: false, workspaceRoot: '/workspace/standalone' },
        {},
      ),
    ).toBeUndefined();
  });

  test('keeps per-run authorization and identities scoped to the originating child', async () => {
    const sibling: RegisteredGroup = {
      ...child,
      folder: 'shared-sibling-test',
      settings: { workspacePath: 'sibling-repo' },
    };
    const scope = await buildRunTokenScope(
      child,
      {
        task_id: 'task-child-1',
        conversation_id: 'conv-child-1',
        run_id: 'run-child-1',
      },
      { parent, child, sibling },
    );

    expect(scope).toMatchObject({
      group_folder: child.folder,
      task_id: 'task-child-1',
      conversation_id: 'conv-child-1',
      run_id: 'run-child-1',
    });
    expect(scope.permissions[child.folder]).toBeDefined();
    expect(scope.permissions[parent.folder]).toBeUndefined();
    expect(scope.permissions[sibling.folder]).toBeUndefined();
  });

  test('mints retry credentials with the replacement run identity', async () => {
    await mintRunScopedAgentToken(
      child,
      {
        task_id: 'task-child-1',
        conversation_id: 'conv-child-1',
        run_id: 'failed-original-run',
      },
      'fresh-retry-run',
    ).then((value) => {
      expect(verifyToken(value)).toMatchObject({
        group_folder: child.folder,
        task_id: 'task-child-1',
        conversation_id: 'conv-child-1',
        run_id: 'fresh-retry-run',
      });
    });
  });

  test('copies namespaced child uploads into a collision-free run path', () => {
    expect(
      resolveRunAttachmentCopy(
        '/board/ipc/shared/runs/run-child',
        '/board/ipc/shared',
        'shared-child-test/upload-123.png',
      ),
    ).toEqual({
      srcFile: '/board/ipc/shared/uploads/shared-child-test/upload-123.png',
      dstFile: '/board/ipc/shared/runs/run-child/upload-123.png',
      filename: 'upload-123.png',
    });
    expect(
      resolveRunAttachmentCopy(
        '/board/ipc/shared/runs/run-child',
        '/board/ipc/shared',
        '../shared-sibling-test/private.txt',
      ),
    ).toBeNull();
  });

  test('isolates sibling recording state without changing standalone paths', () => {
    expect(pwRecordingPaths('task/demo')).toMatchObject({
      recBranch: 'task-demo',
      recDir: '/workspace/ipc/recordings/task-demo',
      daemonDir: '/tmp/pwcli-task-demo',
    });
    expect(pwRecordingPaths('task/demo', 'shared-child-test')).toMatchObject({
      recBranch: 'shared-child-test--task-demo',
      recDir: '/workspace/ipc/recordings/shared-child-test--task-demo',
      daemonDir: '/tmp/pwcli-shared-child-test--task-demo',
    });
    expect(
      pwRecordingPaths('task/demo', 'shared-sibling-test').recDir,
    ).not.toBe(pwRecordingPaths('task/demo', 'shared-child-test').recDir);
    expect(pwRecordingPaths(undefined, undefined, 'task-123')).toMatchObject({
      recBranch: 'task-123',
      recDir: '/workspace/ipc/recordings/task-123',
      daemonDir: '/tmp/pwcli-task-123',
    });
    expect(
      pwRecordingPaths(undefined, 'shared-child-test', 'task-123').recBranch,
    ).toBe('shared-child-test--task-123');
  });

  test('isolates consecutive attempts for the same task by run ID', () => {
    const first = pwRecordingPaths(
      'shared-branch',
      undefined,
      'task-123',
      'run-100-first',
    );
    const retry = pwRecordingPaths(
      'shared-branch',
      undefined,
      'task-123',
      'run-101-retry',
    );

    expect(first).toMatchObject({
      recBranch: 'run-100-first',
      recDir: '/workspace/ipc/recordings/run-100-first',
      daemonDir: '/tmp/pwcli-run-100-first',
    });
    expect(retry.recDir).not.toBe(first.recDir);
    expect(retry.daemonDir).not.toBe(first.daemonDir);
  });
});
