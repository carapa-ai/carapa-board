import { expect, spyOn, test } from 'bun:test';
import * as stateManager from '../../state-manager.js';
import { generateImageTool } from '../image-generation/tools.js';
import {
  dispatchToolCall,
  getOpenAITools,
  registerToolsToMcp,
} from './index.js';
import type { ReflectorMemoryExecutionContext } from '../memory/execution-context.js';
import {
  retireFolderIdentity,
  trackGrants,
} from '../../lib/folder-identity.js';
import {
  getPrivacyErasureEpoch,
  markPrivacyErasureStarted,
} from '../memory/privacy-epoch.js';
import { TOOLSET_MODULES, getConfigurableToolsets } from './registry.js';
import whatsappModule, {
  registerWhatsAppMessaging,
} from '../whatsapp/index.js';
import {
  getMessagingProvider,
  setMessagingProvider,
} from '../messaging/registry.js';
import { getAgentPermissions, type McpServerDeps } from '../../mcp/auth.js';
import type { RegisteredGroup } from '../../types.js';

test('WhatsApp contributes group registration to project setup; agent tokens cannot call it', async () => {
  const previousTools = TOOLSET_MODULES.project_setup;
  const previousProvider = getMessagingProvider();
  const groupDefaults = {
    name: 'Tool permissions test',
    trigger: '@Capa',
    added_at: '2026-09-20T00:00:00.000Z',
  };
  const groups: Record<string, RegisteredGroup> = {
    main: {
      ...groupDefaults,
      folder: 'main-tools-test',
      is_main: true,
      user_id: 'tools-test-owner',
    },
    parent: {
      ...groupDefaults,
      folder: 'parent-tools-test',
      settings: { isParent: true },
    },
    child: {
      ...groupDefaults,
      folder: 'child-tools-test',
      parentId: 'parent-tools-test',
    },
  };
  const registered: string[] = [];
  const deps: McpServerDeps = {
    getRegisteredGroups: () => groups,
    registerGroup: (jid) => {
      registered.push(jid);
    },
    updateGroup: () => {},
    sendMessage: async () => {},
  };
  const args = {
    jid: '120363336345536173@g.us',
    name: 'Registered group',
    folder: 'registered-group',
    trigger: '@Capa',
  };
  const main = {
    group_folder: groups.main.folder,
    permissions: getAgentPermissions(groups.main, groups),
  };
  try {
    registerWhatsAppMessaging();
    registerWhatsAppMessaging();
    expect(getConfigurableToolsets()).not.toContain('advanced');
    expect(TOOLSET_MODULES.project_setup).toEqual([
      ...previousTools,
      expect.objectContaining({ name: 'register_group' }),
    ]);
    for (const scope of [
      main,
      ...[groups.parent, groups.child].map((group) => ({
        group_folder: group.folder,
        permissions: getAgentPermissions(group, groups),
      })),
      {
        group_folder: groups.child.folder,
        permissions: { [groups.child.folder]: ['*:*'] },
      },
    ]) {
      expect(getOpenAITools(scope, ['register_group'])).toEqual([]);
      const mcpNames: string[] = [];
      registerToolsToMcp(
        { registerTool: (name: string) => mcpNames.push(name) } as any,
        deps,
        scope,
      );
      expect(mcpNames.includes('register_group')).toBe(false);
      const result = await dispatchToolCall(
        'register_group',
        args,
        deps,
        scope,
      ).catch((error) => error.message);
      expect(result).toContain('not found');
    }
    expect(registered).toEqual([]);

    await whatsappModule.shutdown!();
    expect(TOOLSET_MODULES.project_setup).toEqual(previousTools);
    expect(getOpenAITools(main, ['register_group'])).toEqual([]);
  } finally {
    TOOLSET_MODULES.project_setup = previousTools;
    setMessagingProvider(previousProvider);
  }
});

test('registerToolsToMcp marks only authorized hot-set tools for the allow-listed project as always-loaded', () => {
  const deps = {} as McpServerDeps;
  const alwaysLoad = {
    projects: ['hot-project'],
    // load_toolset is mcpExempt, memorize is unauthorized for the token below
    // and the last name does not exist: none of them may be registered.
    tools: ['recall', 'get_task', 'memorize', 'load_toolset', 'no_such_tool'],
  };
  const register = (group_folder: string | undefined, preload = alwaysLoad) => {
    const configs = new Map<string, any>();
    registerToolsToMcp(
      {
        registerTool: (name: string, config: unknown) =>
          configs.set(name, config),
      } as any,
      deps,
      group_folder
        ? {
            group_folder,
            permissions: { [group_folder]: ['memories:read', 'tasks:read'] },
          }
        : undefined,
      preload,
    );
    return configs;
  };

  const hot = register('hot-project');
  const preloaded = [...hot]
    .filter(([, config]) => config._meta !== undefined)
    .map(([name]) => name);
  expect(preloaded.sort()).toEqual(['get_task', 'recall']);
  for (const name of preloaded) {
    expect(hot.get(name)._meta).toEqual({ 'anthropic/alwaysLoad': true });
  }
  for (const name of ['memorize', 'load_toolset', 'no_such_tool']) {
    expect(hot.has(name)).toBe(false);
  }

  for (const configs of [register('other-project'), register(undefined)]) {
    expect(configs.size).toBeGreaterThan(0);
    expect([...configs.values()].some((config) => '_meta' in config)).toBe(
      false,
    );
  }
  const off = register('hot-project', { projects: ['hot-project'], tools: [] });
  expect([...off.values()].some((config) => '_meta' in config)).toBe(false);
});

test('getOpenAITools output carries no MCP always-load metadata', () => {
  const serialized = JSON.stringify(
    getOpenAITools({
      group_folder: 'carapa',
      permissions: { carapa: ['*:*'] },
    }),
  );
  expect(serialized).not.toContain('_meta');
  expect(serialized).not.toContain('alwaysLoad');
});

function context() {
  const memoryExecution: ReflectorMemoryExecutionContext = {
    kind: 'reflector',
    mode: 'preview',
    runId: 'diagnostic-run',
    chunkKey: 'chunk-0',
    sourceRef: 'diagnostic-transcript',
    evidence: new Map(),
    hadToolError: false,
    completedOperationKeys: new Set(),
  };
  return {
    group_folder: 'diagnostic-project',
    permissions: { 'diagnostic-project': ['fs:read', 'memories:write'] },
    memoryExecution,
  };
}

test('reflector dispatch retains authorization, unknown-tool and handler failure reasons', async () => {
  const execution = context();
  await expect(
    dispatchToolCall('recall', {}, {} as any, execution),
  ).rejects.toThrow('Unauthorized');
  await expect(
    dispatchToolCall('missing_diagnostic_tool', {}, {} as any, execution),
  ).rejects.toThrow('not found');
  await expect(
    dispatchToolCall('memorize', {}, {} as any, {
      ...execution,
      allowedToolNames: ['recall'],
    }),
  ).rejects.toThrow('not allowed');
  // Both the handler executor and dispatcher see this same validation error.
  // Retrying it must not duplicate or replace the original diagnostics.
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(
      await dispatchToolCall('memorize', {}, {} as any, execution),
    ).toContain('Memory content is required');
  }
  expect(execution.memoryExecution.hadToolError).toBe(true);
  expect(execution.memoryExecution.toolErrors).toEqual([
    {
      tool: 'recall',
      message:
        'Unauthorized: missing "memories:read" permission for project "diagnostic-project"',
    },
    {
      tool: 'missing_diagnostic_tool',
      message: 'Tool "missing_diagnostic_tool" not found',
    },
    {
      tool: 'memorize',
      message: 'Tool "memorize" is not allowed in this execution context',
    },
    {
      tool: 'memorize',
      kind: 'input',
      message: 'Memory content is required and must be a non-empty string',
    },
  ]);
});

test('reflector dispatch retains returned filesystem errors without leaking credentials', async () => {
  const execution = context();
  const deps = {
    fsTools: {
      prepareScopedSandbox: async () => {
        throw new Error(
          'Controller unavailable; token=private-controller-token',
        );
      },
    },
  } as any;
  const result = await dispatchToolCall(
    'ripgrep',
    { query: 'private-query' },
    deps,
    execution,
  );
  expect(result).toContain('Error preparing sandbox: Controller unavailable');
  expect(execution.memoryExecution.hadToolError).toBe(true);
  expect(execution.memoryExecution.toolErrors).toEqual([
    {
      tool: 'ripgrep',
      message:
        'Error preparing sandbox: Controller unavailable; token=[private value omitted]',
    },
  ]);
  expect(JSON.stringify(execution.memoryExecution.toolErrors)).not.toContain(
    'private-query',
  );
});

test('dispatching generate_image for a strict project returns a privacy refusal without calling the handler', async () => {
  const folder = 'index-privacy-strict';
  const lookup = spyOn(stateManager, 'getGroupByFolder').mockImplementation(
    () => ({ settings: { privacyMode: 'strict' } }) as any,
  );
  const handler = spyOn(generateImageTool, 'handler');
  try {
    const result = await dispatchToolCall(
      'generate_image',
      { prompt: 'a cat' },
      {} as any,
      {
        group_folder: folder,
        permissions: { [folder]: ['images:generate'] },
        allowedToolNames: ['generate_image'],
      },
    );
    expect(result).toStartWith(
      'Error: Privacy mode "strict" refuses image egress',
    );
    expect(handler).not.toHaveBeenCalled();
  } finally {
    handler.mockRestore();
    lookup.mockRestore();
  }
});

test('registerToolsToMcp rejects undeclared arguments before the handler and passes declared ones', async () => {
  const handlers = new Map<string, (args: any, extra?: any) => Promise<any>>();
  const configs = new Map<string, any>();
  registerToolsToMcp(
    {
      registerTool: (name: string, config: any, handler: any) => {
        configs.set(name, config);
        handlers.set(name, handler);
      },
    } as any,
    {} as McpServerDeps,
    { group_folder: 'p', permissions: { p: ['tasks:read'] } },
  );
  const handler = handlers.get('get_task')!;
  const rejected = await handler({ task_id: 't', project_id: 'secret-value' });
  expect(rejected.isError).toBe(true);
  expect(rejected.content[0].text).toContain('project_id');
  expect(rejected.content[0].text).not.toContain('secret-value');
  // Declared keys and empty args reach the handler (which then reports its own error).
  for (const args of [{ task_id: 't' }, {}, undefined]) {
    const result = await handler(args);
    expect(result.content[0].text).not.toContain('Unknown parameter');
  }
  // The advertised schema keeps undeclared keys so they can be rejected.
  expect(
    configs.get('get_task').inputSchema.parse({ task_id: 't', x: 1 }),
  ).toEqual({
    task_id: 't',
    x: 1,
  });
});

test('reflector dispatch refuses every tool once its project was retired', async () => {
  const execution = {
    ...context(),
    group_folder: 'retired-diagnostic-project',
    permissions: {
      'retired-diagnostic-project': ['memories:read', 'memories:write'],
    } as Record<string, string[]>,
  };
  execution.memoryExecution.privacyEpoch = getPrivacyErasureEpoch(
    'retired-diagnostic-project',
  );
  markPrivacyErasureStarted('retired-diagnostic-project');
  await expect(
    dispatchToolCall('recall', {}, {} as any, execution),
  ).rejects.toThrow('privacy erasure advanced');
  expect(execution.memoryExecution.hadToolError).toBe(true);
});

test('dispatch ignores a grant to a folder retired after the run began', async () => {
  const permissions = trackGrants({
    'retired-grant-project': ['memories:read'],
  });
  const run = {
    group_folder: 'retired-grant-project',
    permissions,
  };
  // Granted: the permission gate passes and the handler's own error surfaces.
  expect(await dispatchToolCall('recall', {}, {} as any, run)).not.toContain(
    'Unauthorized',
  );
  retireFolderIdentity('retired-grant-project');
  await expect(dispatchToolCall('recall', {}, {} as any, run)).rejects.toThrow(
    'Unauthorized',
  );
});
