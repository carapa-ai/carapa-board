import { describe, expect, test } from 'bun:test';
import type { RegisteredGroup } from '../../types.js';
import {
  buildRepositoryScanCommand,
  inspectRepositoryCandidates,
  normalizeDiscoveryOptions,
  parseRepositoryScanOutput,
  REPOSITORY_SCANNER_PATH,
  reconcileDiscoveredRepositories,
  resolveRegisteredRepositoryPaths,
  validateDiscoveryRequest,
} from './repository-discovery.js';

describe('repository workspace scanner', () => {
  test('invokes the immutable scanner with root, bounded depth, and repeated exclusions', () => {
    const command = buildRepositoryScanCommand('/workspace/repos with spaces', {
      maxDepth: 5,
      exclusions: ['node_modules', '.worktrees'],
    });
    expect(command).toBe(
      `${REPOSITORY_SCANNER_PATH} '/workspace/repos with spaces' 5 'node_modules' '.worktrees'`,
    );
  });

  test('parses the scanner NUL-delimited absolute path protocol', async () => {
    const output = '/workspace/repos/direct\0/workspace/repos/nested\0';
    const result = parseRepositoryScanOutput(output);
    expect(result.repositories).toEqual([
      { containerPath: '/workspace/repos/direct' },
      { containerPath: '/workspace/repos/nested' },
    ]);
    expect(result.ignored).toEqual([]);
    expect(result.errors).toEqual([]);

    const inspected = await inspectRepositoryCandidates(result, async () => ({
      valid: true,
      originUrl: 'git@example.test:direct.git',
    }));
    expect(inspected.repositories[0].originUrl).toBe(
      'git@example.test:direct.git',
    );
  });

  test('rejects a relative path in the scanner protocol', () => {
    const result = parseRepositoryScanOutput('relative/repository\0');
    expect(result.repositories).toEqual([]);
    expect(result.errors).toEqual([
      {
        relativePath: 'relative/repository',
        reason: 'Invalid repository scan record',
      },
    ]);
  });

  test('classifies inaccessible Git validation output as an error, never a repository', () => {
    const field = (value: string) => Buffer.from(value).toString('base64');
    const result = parseRepositoryScanOutput(
      `D1\tA\t${field('/workspace/private')}\t${field('Git metadata is inaccessible')}\n`,
    );
    expect(result.repositories).toEqual([]);
    expect(result.errors).toEqual([
      {
        relativePath: '/workspace/private',
        reason: 'Git metadata is inaccessible',
      },
    ]);
  });

  test('normalizes depth and rejects path-like custom exclusions', () => {
    const options = normalizeDiscoveryOptions({
      maxDepth: 99,
      exclusions: ['custom-cache', '../escape', 'nested/cache'],
    });
    expect(options.maxDepth).toBe(12);
    expect(options.exclusions).toContain('custom-cache');
    expect(options.exclusions).not.toContain('../escape');
    expect(options.exclusions).not.toContain('nested/cache');
    expect(options.exclusions).not.toContain('node_modules');
    expect(normalizeDiscoveryOptions({}).exclusions).toContain('node_modules');
  });

  test('validates API depth and exclusion boundaries', () => {
    expect(validateDiscoveryRequest({ maxDepth: 0 })).toContain(
      'integer from 1',
    );
    expect(
      validateDiscoveryRequest({
        maxDepth: 4,
        exclusions: ['cache', '../escape'],
      }),
    ).toContain('directory names');
    expect(
      validateDiscoveryRequest({ maxDepth: 4, exclusions: ['cache'] }),
    ).toBeUndefined();
    expect(
      validateDiscoveryRequest({ maxDepth: 4, exclusions: ['__pycache__'] }),
    ).toBeUndefined();
    expect(
      validateDiscoveryRequest({ maxDepth: 4, exclusions: ['.git'] }),
    ).toContain('directory names');
  });
});

describe('discovery reconciliation', () => {
  const parent: RegisteredGroup = {
    name: 'Workspace',
    folder: 'workspace',
    trigger: '@Capa',
    added_at: 'now',
    user_id: 'owner',
    settings: {
      isParent: true,
      sandboxOwnership: 'shared',
      sharedWorkspaceHostLocation: '/host/repos',
      sharedWorkspaceContainerRoot: '/workspace/repos',
    },
  };

  test('creates collision-safe children once and reports missing children without deleting them', async () => {
    const groups: RegisteredGroup[] = [
      parent,
      {
        name: 'api',
        folder: 'api',
        trigger: '@Capa',
        added_at: 'now',
        settings: {},
      },
      {
        name: 'Gone',
        folder: 'gone',
        parentId: 'workspace',
        trigger: '@Capa',
        added_at: 'now',
        settings: {
          repositoryLocation: '/host/repos/gone',
          workspacePath: '/workspace/repos/gone',
          repositoryRelativePath: 'gone',
        },
      },
    ];
    const scan = {
      repositories: [
        {
          containerPath: '/workspace/repos/services/api',
          originUrl: 'git@example.test:api.git',
        },
      ],
      ignored: [],
      errors: [],
    };
    const create = async (group: RegisteredGroup) => {
      groups.push(group);
    };
    const first = await reconcileDiscoveredRepositories({
      parent,
      groups,
      scan,
      create,
    });

    expect(first.created).toHaveLength(1);
    expect(first.created[0].projectId).toBe('workspace-api');
    expect(first.created[0].reason).toContain('Collision resolved');
    expect(groups.at(-1)?.settings).toEqual({
      mode: 'chat',
      repositoryLocation: '/host/repos/services/api',
      workspacePath: '/workspace/repos/services/api',
      repositoryRelativePath: 'services/api',
    });
    expect(first.created[0].originUrl).toBe('git@example.test:api.git');
    expect(first.missing.map((entry) => entry.projectId)).toEqual(['gone']);

    const second = await reconcileDiscoveredRepositories({
      parent,
      groups,
      scan,
      create,
    });
    expect(second.created).toEqual([]);
    expect(second.existing.map((entry) => entry.projectId)).toEqual([
      'workspace-api',
    ]);
    expect(
      groups.filter((group) => group.folder === 'workspace-api'),
    ).toHaveLength(1);
  });

  test('never persists an agent-written origin as the trusted repositoryUrl pin', async () => {
    const created: RegisteredGroup[] = [];
    const report = await reconcileDiscoveredRepositories({
      parent,
      groups: [parent],
      scan: {
        repositories: [
          {
            containerPath: '/workspace/repos/attacker-ssh',
            originUrl: 'git@attacker.example:x.git',
          },
          {
            containerPath: '/workspace/repos/attacker-https',
            originUrl: 'https://attacker.example/x.git',
          },
        ],
        ignored: [],
        errors: [],
      },
      create: async (group) => {
        created.push(group);
      },
    });

    expect(report.created.map((entry) => entry.originUrl)).toEqual([
      'git@attacker.example:x.git',
      'https://attacker.example/x.git',
    ]);
    expect(created).toHaveLength(2);
    for (const group of created) {
      expect(group.settings).not.toHaveProperty('repositoryUrl');
    }
  });

  test('never assigns a reserved collection-route folder to a discovered repository', async () => {
    const created: RegisteredGroup[] = [];
    const report = await reconcileDiscoveredRepositories({
      parent,
      groups: [parent],
      scan: {
        repositories: [{ containerPath: '/workspace/repos/attention' }],
        ignored: [],
        errors: [],
      },
      create: async (group) => {
        created.push(group);
      },
    });

    expect(report.created).toHaveLength(1);
    expect(created[0].folder).toBe(`${parent.folder}-attention`);
  });

  test.each([
    ['an ordinary parent', parent, `${parent.folder}-main-foo`],
    [
      'a per-user main parent',
      { ...parent, folder: 'main-owner' },
      'repo-main-foo',
    ],
  ])(
    'never assigns the main- prefix to a discovered repository under %s',
    async (_label, owner, expected) => {
      const created: RegisteredGroup[] = [];
      const report = await reconcileDiscoveredRepositories({
        parent: owner,
        groups: [owner],
        scan: {
          repositories: [{ containerPath: '/workspace/repos/main-foo' }],
          ignored: [],
          errors: [],
        },
        create: async (group) => {
          created.push(group);
        },
      });

      expect(report.created).toHaveLength(1);
      expect(created[0].folder).toBe(expected);
    },
  );

  test('recognizes existing children through relative, absolute, metadata, and default workspace paths', async () => {
    const children: RegisteredGroup[] = [
      {
        name: 'Relative',
        folder: 'relative',
        parentId: parent.folder,
        trigger: '@Capa',
        added_at: 'now',
        settings: { workspacePath: 'services/api' },
      },
      {
        name: 'Absolute',
        folder: 'absolute',
        parentId: parent.folder,
        trigger: '@Capa',
        added_at: 'now',
        settings: { workspacePath: '/workspace/repos/apps/web' },
      },
      {
        name: 'Metadata',
        folder: 'metadata',
        parentId: parent.folder,
        trigger: '@Capa',
        added_at: 'now',
        settings: { repositoryRelativePath: 'packages/worker' },
      },
      {
        name: 'Default',
        folder: 'default-child',
        parentId: parent.folder,
        trigger: '@Capa',
        added_at: 'now',
        settings: {},
      },
    ];
    const scan = {
      repositories: [
        { containerPath: '/workspace/repos/services/api' },
        { containerPath: '/workspace/repos/apps/web' },
        { containerPath: '/workspace/repos/packages/worker' },
        { containerPath: '/workspace/repos/default-child' },
      ],
      ignored: [],
      errors: [],
    };
    let creates = 0;
    const report = await reconcileDiscoveredRepositories({
      parent,
      groups: [parent, ...children],
      scan,
      create: async () => {
        creates++;
      },
    });

    expect(creates).toBe(0);
    expect(report.created).toEqual([]);
    expect(report.existing.map((entry) => entry.projectId).sort()).toEqual([
      'absolute',
      'default-child',
      'metadata',
      'relative',
    ]);
  });

  test('reports missing children configured only by workspacePath or its folder default', async () => {
    const children: RegisteredGroup[] = [
      {
        name: 'Relative missing',
        folder: 'relative-missing',
        parentId: parent.folder,
        trigger: '@Capa',
        added_at: 'now',
        settings: { workspacePath: 'services/missing' },
      },
      {
        name: 'Absolute missing',
        folder: 'absolute-missing',
        parentId: parent.folder,
        trigger: '@Capa',
        added_at: 'now',
        settings: { workspacePath: '/workspace/repos/apps/missing' },
      },
      {
        name: 'Default missing',
        folder: 'default-missing',
        parentId: parent.folder,
        trigger: '@Capa',
        added_at: 'now',
        settings: {},
      },
    ];
    const report = await reconcileDiscoveredRepositories({
      parent,
      groups: [parent, ...children],
      scan: { repositories: [], ignored: [], errors: [] },
      create: async () => {},
    });

    expect(
      report.missing
        .map((entry) => [entry.projectId, entry.relativePath])
        .sort(),
    ).toEqual([
      ['absolute-missing', 'apps/missing'],
      ['default-missing', 'default-missing'],
      ['relative-missing', 'services/missing'],
    ]);
  });

  test('falls back to the child folder for an escaping legacy workspacePath', () => {
    const child: RegisteredGroup = {
      name: 'Legacy',
      folder: 'legacy',
      parentId: parent.folder,
      trigger: '@Capa',
      added_at: 'now',
      settings: { workspacePath: '../outside' },
    };
    expect([
      ...resolveRegisteredRepositoryPaths(child, parent).containerPaths,
    ]).toContain('/workspace/repos/legacy');
  });

  test('reports repositories registered outside the parent and does not create them', async () => {
    const groups: RegisteredGroup[] = [
      parent,
      {
        name: 'Foreign',
        folder: 'foreign',
        trigger: '@Capa',
        added_at: 'now',
        settings: { repositoryLocation: '/host/repos/foreign' },
      },
    ];
    let creates = 0;
    const report = await reconcileDiscoveredRepositories({
      parent,
      groups,
      scan: {
        repositories: [{ containerPath: '/workspace/repos/foreign' }],
        ignored: [],
        errors: [],
      },
      create: async () => {
        creates++;
      },
    });
    expect(creates).toBe(0);
    expect(report.ambiguous[0].reason).toContain('outside parent');
  });

  test('does not report a child as created when durable registration fails', async () => {
    const report = await reconcileDiscoveredRepositories({
      parent,
      groups: [parent],
      scan: {
        repositories: [{ containerPath: '/workspace/repos/api' }],
        ignored: [],
        errors: [],
      },
      create: async () => {
        throw new Error('persistence failed');
      },
    });
    expect(report.created).toEqual([]);
    expect(report.ambiguous).toHaveLength(1);
    expect(report.ambiguous[0].reason).toContain('persistence failed');
  });
});
