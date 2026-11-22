import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';

import {
  ripgrepTool,
  peekFilesTool,
  normalizeFsToolStdout,
  type FsToolDependencies,
} from '../fs/tools.js';
import {
  listTranscriptsTool,
  getTranscriptTool,
  searchTranscriptsTool,
} from '../transcripts/tools.js';
import { getOpenAITools, registerToolsToMcp } from './index.js';
import {
  TOOLSET_MODULES,
  activeToolsets,
  getActiveToolsets,
  getToolsetsSystemPrompt,
  resetToolsets,
} from './registry.js';
import { resolveAgentQueryRuntime } from './core-tools.js';

// ripgrep and peek_files now dispatch to the per-group sandbox via MCP
// (`fs-tool.sh ripgrep|read-file ...` over `sandboxExec`). These tests run
// inside the board container with no real sandbox available, so we mock the
// boundary: a configurable fake `sandboxExec`, plus stubs for the group/agent
// lookups the handlers depend on.
let mockSandboxExec: (
  cmd: string,
) => Promise<{ stdout: string; isError: boolean }> = async () => ({
  stdout: '',
  isError: false,
});
const sandboxExecCalls: string[] = [];
const sandboxExecTargets: string[] = [];
let mockDisabledToolsets: string[] | undefined;
let mockCarapaMailEnabled = false;
let mockPeekFilesSelection: { harnessId: string; modelId: string } | undefined;
const mockChatAgents = [
  {
    id: 'test-llm',
    baseUrl: 'http://test',
    apiKey: 'test-key',
    model: 'test-model',
    modelId: 'test-model',
    harnessId: 'direct',
    harnessKind: 'direct' as const,
  },
  {
    id: 'cli-with-url',
    baseUrl: 'http://test',
    apiKey: 'test-key',
    model: 'test-model',
    modelId: 'test-model',
    harnessId: 'cli',
    harnessKind: 'cli' as const,
  },
];
const mockRuntimeCatalog = {
  presets: [] as Array<{
    id: string;
    label: string;
    selection: { harnessId: string; modelId: string };
  }>,
  defaults: {
    chat: { harnessId: 'direct', modelId: 'test-model' },
    get peekFiles() {
      return mockPeekFilesSelection;
    },
  },
};
let kanbanSelectionCalls: any[][] = [];
let mockKanbanRuntime = {
  agent: {
    id: 'codex:gpt-5.6-sol',
    agentCmd: 'codex',
    harnessKind: 'cli' as const,
  },
};

mock.module('../../state-manager.js', () => ({
  // `defaultSandboxInstance` makes `fixedInstance` true so
  // `ensureSandboxRunning` returns early and never tries to start a container.
  // Strict registry: only 'test-group' is registered in this suite. A
  // catch-all (any folder -> fabricated group) would leak through Bun's
  // process-global mock.module() into later test files and mask 404s.
  getGroupByFolder: (folder: string) => {
    if (folder !== 'test-group') return undefined;
    return {
      folder,
      settings: {
        workspacePath: folder,
        defaultSandboxInstance: 'test-instance',
        disabledToolsets: mockDisabledToolsets,
        carapaMailEnabled: mockCarapaMailEnabled,
      },
      is_main: false,
    };
  },
}));

const peekLlmOptions: unknown[] = [];
const peekLlmPrompts: string[] = [];
const fsToolDependencies: FsToolDependencies = {
  prepareGroupSandbox: async (folder) =>
    ({
      stack: 'carapa-bot',
      service: 'agent',
      instance: 'test-instance',
      workspaceRoot: `/workspace/${folder}`,
      extraRoots: [],
    }) as any,
  getSandboxClient: () =>
    ({
      sandboxExec: async (
        stack: string,
        service: string,
        cmd: string,
        options: { instance?: string },
      ) => {
        sandboxExecCalls.push(cmd);
        sandboxExecTargets.push(`${stack}/${service}/${options.instance}`);
        return mockSandboxExec(cmd);
      },
    }) as any,
  getChatAgents: () => mockChatAgents as any,
  getRuntimeCatalog: () => mockRuntimeCatalog as any,
  resolveRuntimeSelection: (selection) =>
    (selection?.harnessId === 'direct'
      ? mockChatAgents[0]
      : mockChatAgents[1]) as any,
  llmComplete: async (_config, _system, prompt, options) => {
    peekLlmOptions.push(options);
    peekLlmPrompts.push(prompt);
    if (prompt.includes('FULL_CONTENT')) return { content: 'full' };
    if (prompt.includes('NO_CONTENT')) return { content: 'none' };
    return { content: 'Filtered Content Snippet' };
  },
};
const toolDeps = { fsTools: fsToolDependencies } as any;

const resolveKanbanRuntimeForTests = (selections: any[]) => {
  kanbanSelectionCalls.push(selections);
  return mockKanbanRuntime as any;
};

describe('Board Tools Feature Tests without mocking', () => {
  let context: any;
  const tmpDirBase = GROUPS_DIR;

  beforeEach(() => {
    mockPeekFilesSelection = undefined;
    // Setup a dummy group folder structure
    const groupPath = path.join(tmpDirBase, 'test-group');
    if (fs.existsSync(groupPath))
      fs.rmSync(groupPath, { recursive: true, force: true });
    fs.mkdirSync(groupPath, { recursive: true });
    fs.writeFileSync(path.join(groupPath, 'hello.txt'), 'Hello Ripgrep!');

    const transcriptDir = path.join(groupPath, 'transcripts');
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(
      path.join(transcriptDir, 'task-1.jsonl'),
      JSON.stringify({ role: 'user', content: 'hello transcript world' }) +
        '\n',
    );

    context = {
      group_folder: 'test-group',
      current_agent_id: 'test-llm',
      llmConfig: { model: 'test-model' },
      permissions: { 'test-group': ['fs:read'], 'chat-group': ['fs:read'] },
    };

    sandboxExecCalls.length = 0;
    sandboxExecTargets.length = 0;
    mockDisabledToolsets = undefined;
    kanbanSelectionCalls = [];
    mockKanbanRuntime = {
      agent: { id: 'codex:gpt-5.6-sol', agentCmd: 'codex', harnessKind: 'cli' },
    };
    mockSandboxExec = async () => ({ stdout: '', isError: false });
  });

  afterAll(() => {
    try {
      fs.rmSync(path.join(tmpDirBase, 'test-group'), {
        recursive: true,
        force: true,
      });
      fs.rmSync(path.join(tmpDirBase, 'chat-group'), {
        recursive: true,
        force: true,
      });
    } catch {}
  });

  describe('ripgrep', () => {
    test('forwards a search to fs-tool.sh inside the sandbox', async () => {
      mockSandboxExec = async () => ({
        stdout: '/workspace/test-group/hello.txt\n1:Hello Ripgrep!',
        isError: false,
      });
      const result = await ripgrepTool.handler(
        { query: 'Ripgrep' },
        toolDeps,
        context,
      );
      expect(result).toContain('Hello Ripgrep!');
      expect(sandboxExecCalls.at(-1)).toBe(
        "fs-tool.sh ripgrep '/workspace/test-group' 'Ripgrep'",
      );
    });

    test('blocks transcript searches before reaching the sandbox', async () => {
      const result = await ripgrepTool.handler(
        { query: 'secret', path: 'transcripts' },
        toolDeps,
        context,
      );
      expect(result).toContain('Error: Do not use ripgrep for transcripts');
      expect(sandboxExecCalls).toHaveLength(0);
    });

    test('searches the workspace root when no path is given', async () => {
      // CarapaBox turns rg's empty no-match output into a "(no output)" sentinel.
      mockSandboxExec = async () => ({ stdout: '(no output)', isError: true });
      const result = await ripgrepTool.handler(
        { query: 'HIDDEN_TRANSCRIPT' },
        toolDeps,
        context,
      );
      expect(result).toBe('No matches found.');
    });

    test.each([
      [
        'sentinel with whitespace',
        '  (no output)\n',
        true,
        'No matches found.',
      ],
      ['empty stdout', '', true, 'No matches found.'],
      [
        'sentinel without error flag',
        '(no output)',
        false,
        'No matches found.',
      ],
      [
        'real error output',
        'rg: regex parse error: unclosed group',
        true,
        'Error: rg: regex parse error: unclosed group',
      ],
      [
        'sentinel inside real output',
        'file.txt\n1:(no output)',
        false,
        'file.txt\n1:(no output)',
      ],
    ])('ripgrep result: %s', async (_name, stdout, isError, expected) => {
      mockSandboxExec = async () => ({ stdout, isError });
      const result = await ripgrepTool.handler(
        { query: 'anything' },
        toolDeps,
        context,
      );
      expect(result).toBe(expected);
    });

    test('binds reflector reads to the originating checkout', async () => {
      await ripgrepTool.handler({ query: 'origin' }, toolDeps, {
        ...context,
        memoryExecution: {
          kind: 'reflector',
          mode: 'live',
          runId: 'run-origin',
          chunkKey: 'chunk-0',
          sourceRef: 'transcript',
          evidence: new Map(),
          hadToolError: false,
          completedOperationKeys: new Set(),
          filesystem: {
            stack: 'origin-stack',
            service: 'origin-service',
            instance: 'origin-instance',
            workspaceRoot: '/workspace/project/.worktrees/origin',
          },
        },
      });

      expect(sandboxExecCalls.at(-1)).toBe(
        "fs-tool.sh ripgrep '/workspace/project/.worktrees/origin' 'origin'",
      );
      expect(sandboxExecTargets.at(-1)).toBe(
        'origin-stack/origin-service/origin-instance',
      );
    });
  });

  describe('normalizeFsToolStdout', () => {
    test('maps only a whole no-output sentinel to empty', () => {
      expect(normalizeFsToolStdout('(no output)')).toBe('');
      expect(normalizeFsToolStdout(' (no output)\n')).toBe('');
      expect(normalizeFsToolStdout(undefined)).toBe('');
      expect(normalizeFsToolStdout('  real text\n')).toBe('  real text\n');
      expect(normalizeFsToolStdout('a\n(no output)')).toBe('a\n(no output)');
    });
  });

  describe('peek_files', () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64');

    test('previews full content when model says "full"', async () => {
      mockSandboxExec = async () => ({
        stdout: b64('FULL_CONTENT\nThis is the whole story.'),
        isError: false,
      });
      const result = await peekFilesTool.handler(
        { files: ['full.md'] },
        toolDeps,
        context,
      );
      expect(result).toContain('Full Content');
      expect(result).toContain('whole story');
      expect(sandboxExecCalls.at(-1)).toBe(
        "fs-tool.sh read-file '/workspace/test-group/full.md'",
      );
      expect(peekLlmOptions.at(-1)).toEqual({
        projectId: 'test-group',
        privacyPurpose: 'helper',
      });
    });

    test('passes empty content for an empty file (no-output sentinel)', async () => {
      mockSandboxExec = async () => ({ stdout: '(no output)', isError: false });
      const result = await peekFilesTool.handler(
        { files: ['empty.md'] },
        toolDeps,
        context,
      );
      expect(peekLlmPrompts.at(-1)).toEndWith('CONTENT:\n');
      expect(result).not.toContain('Error');
    });

    test('previews filtered content', async () => {
      mockSandboxExec = async () => ({
        stdout: b64('Some content here.'),
        isError: false,
      });
      const result = await peekFilesTool.handler(
        { files: ['partial.md'] },
        toolDeps,
        context,
      );
      expect(result).toContain('Filtered Content Snippet');
    });

    test('handles single string input gracefully (normalization)', async () => {
      mockSandboxExec = async () => ({
        stdout: b64('Some content.'),
        isError: false,
      });
      const result = await peekFilesTool.handler(
        { files: 'single.md' as any },
        toolDeps,
        context,
      );
      expect(result).toContain('single.md');
      // One file, one read — not iterated over the characters of the string.
      expect(sandboxExecCalls).toHaveLength(1);
    });

    test('handles JSON-encoded string array gracefully', async () => {
      mockSandboxExec = async () => ({
        stdout: b64('Some JSON content.'),
        isError: false,
      });
      const result = await peekFilesTool.handler(
        { files: JSON.stringify(['json.md']) as any },
        toolDeps,
        context,
      );
      expect(result).toContain('json.md');
      expect(sandboxExecCalls).toHaveLength(1);
    });

    test('uses the configured peekFiles default', async () => {
      mockPeekFilesSelection = { harnessId: 'direct', modelId: 'test-model' };
      mockSandboxExec = async () => ({
        stdout: b64('Configured default content.'),
        isError: false,
      });
      const result = await peekFilesTool.handler(
        { files: ['configured.md'] },
        toolDeps,
        { ...context, current_agent_id: 'cli-with-url' },
      );
      expect(result).toContain('configured.md');
    });

    test('rejects a CLI runtime even when it inherits a base URL', async () => {
      const result = await peekFilesTool.handler(
        { files: ['cli.md'] },
        toolDeps,
        { ...context, current_agent_id: 'cli-with-url' },
      );
      expect(result).toContain('needs an HTTP-capable v2 runtime binding');
      expect(sandboxExecCalls).toHaveLength(0);
    });
  });

  describe('Transcript Tools', () => {
    test('list_transcripts returns the list of files', async () => {
      const result = await listTranscriptsTool.handler(
        { group: 'test-group' },
        {} as any,
        context,
      );
      expect(result).toContain('task-1');
    });

    test('get_transcript returns file content', async () => {
      const result = await getTranscriptTool.handler(
        { group: 'test-group', task_id: 'task-1' },
        {} as any,
        context,
      );
      expect(result).toContain('hello transcript world');
    });

    test('search_transcripts finds text across transcripts', async () => {
      const result = await searchTranscriptsTool.handler(
        { group: 'test-group', query: 'transcript world' },
        {} as any,
        context,
      );
      expect(result).toContain('task-1');
      expect(result).toContain('transcript world');
    });

    test('handles .output.jsonl (chat format) transcripts', async () => {
      const chatGroupPath = path.join(tmpDirBase, 'chat-group');
      const transcriptDir = path.join(chatGroupPath, 'transcripts');
      fs.mkdirSync(transcriptDir, { recursive: true });
      const chatFile = path.join(transcriptDir, 'chat-1.output.jsonl');
      fs.writeFileSync(
        chatFile,
        JSON.stringify({
          type: 'message',
          role: 'user',
          content: 'chat user msg',
        }) +
          '\n' +
          JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'chat assistant msg' }],
            },
          }) +
          '\n',
      );

      const result = await getTranscriptTool.handler(
        { group: 'chat-group', task_id: 'chat-1' },
        {} as any,
        context,
      );
      expect(result).toContain('chat user msg');
      expect(result).toContain('chat assistant msg');
    });
  });

  describe('Modular Toolsets', () => {
    beforeEach(() => {
      resetToolsets('test-group');
      activeToolsets.set('test-group', new Set(['core']));
      mockCarapaMailEnabled = false;
    });

    test('non-mail projects never receive or advertise the gated mail toolset', () => {
      const previousMailTools = TOOLSET_MODULES.mail;
      TOOLSET_MODULES.mail = [
        {
          name: 'carapamail_test',
          description: 'Test-only dynamically discovered mail tool',
          inputSchema: {},
          handler: async () => '',
        },
      ];

      try {
        const toolNames = getOpenAITools({ group_folder: 'test-group' }).map(
          (tool) => tool.function.name,
        );
        const prompt = getToolsetsSystemPrompt('test-group');

        expect(toolNames).not.toContain('carapamail_test');
        expect(prompt).not.toContain('- mail:');
        expect(prompt).not.toContain('- fs:');
      } finally {
        TOOLSET_MODULES.mail = previousMailTools;
        resetToolsets('test-group');
      }
    });

    test('mail-enabled projects receive mail tools without advertising mail as loadable', () => {
      const previousMailTools = TOOLSET_MODULES.mail;
      TOOLSET_MODULES.mail = [
        {
          name: 'carapamail_test',
          description: 'Test-only dynamically discovered mail tool',
          inputSchema: {},
          handler: async () => '',
        },
      ];
      mockCarapaMailEnabled = true;

      try {
        const toolNames = getOpenAITools({ group_folder: 'test-group' }).map(
          (tool) => tool.function.name,
        );
        const prompt = getToolsetsSystemPrompt('test-group');

        expect(toolNames).toContain('carapamail_test');
        expect(prompt).not.toContain('- mail:');
      } finally {
        TOOLSET_MODULES.mail = previousMailTools;
        resetToolsets('test-group');
      }
    });

    test('runtime toolsets cannot suppress global defaults', () => {
      const tools = getOpenAITools({ group_folder: 'test-group' });
      const toolNames = tools.map((t: any) => t.function.name);

      expect(toolNames).toContain('load_toolset');
      expect(toolNames).toContain('agent_query');
      expect(toolNames).toContain('ripgrep');
      expect(toolNames).toContain('search_transcripts');
      expect(toolNames).toContain('propose_memory');
      expect(toolNames).toContain('finish_indexing');
    });

    test('MCP registration deduplicates compatibility tool exports', () => {
      const registeredNames: string[] = [];
      const server = {
        registerTool: (name: string) => {
          if (registeredNames.includes(name)) {
            throw new Error(`duplicate tool: ${name}`);
          }
          registeredNames.push(name);
        },
      };

      expect(() =>
        registerToolsToMcp(server as any, toolDeps, {
          group_folder: 'test-group',
          permissions: { '*': ['*:*'] },
        }),
      ).not.toThrow();
      expect(
        registeredNames.filter(
          (name) => name === 'set_project_task_checkout_mode',
        ),
      ).toHaveLength(1);
      expect(new Set(registeredNames).size).toBe(registeredNames.length);
    });

    test('internal DirectLLM jobs can enforce an exact tool allowlist', () => {
      const tools = getOpenAITools({ group_folder: 'test-group' }, [
        'ripgrep',
        'propose_memory',
      ]);
      expect(tools.map((tool: any) => tool.function.name).sort()).toEqual([
        'propose_memory',
        'ripgrep',
      ]);
    });

    test('project-disabled toolsets are removed from global and runtime sets', () => {
      mockDisabledToolsets = ['fs', 'core'];
      activeToolsets.set('test-group', new Set(['core', 'fs']));

      const active = getActiveToolsets('test-group');

      expect(active).not.toContain('fs');
      expect(active).toContain('core');
    });

    test('loading a toolset makes its tools available', async () => {
      const loadTool = TOOLSET_MODULES.core.find(
        (t: any) => t.name === 'load_toolset',
      )!;
      await loadTool.handler(
        { toolsets: ['fs', 'transcripts'] },
        {} as any,
        context,
      );

      const tools = getOpenAITools({ group_folder: 'test-group' });
      const toolNames = tools.map((t: any) => t.function.name);

      expect(toolNames).toContain('ripgrep');
      expect(toolNames).toContain('peek_files');
      expect(toolNames).toContain('search_transcripts');
      expect(toolNames).toContain('get_transcript');
    });

    test('load_toolset handles JSON-encoded string input', async () => {
      resetToolsets('test-group');
      const loadTool = TOOLSET_MODULES.core.find(
        (t: any) => t.name === 'load_toolset',
      )!;
      // Simulate common LLM quirk: sending a string instead of an array
      await loadTool.handler(
        { toolsets: '["fs"]' },
        {} as any,
        { group_folder: 'test-group' } as any,
      );

      const tools = getOpenAITools({ group_folder: 'test-group' });
      expect(tools.find((t) => t.function.name === 'ripgrep')).toBeDefined();
    });

    test('load_toolset cannot override a project-disabled toolset', async () => {
      resetToolsets('test-group');
      mockDisabledToolsets = ['fs'];
      const loadTool = TOOLSET_MODULES.core.find(
        (t: any) => t.name === 'load_toolset',
      )!;

      const result = await loadTool.handler(
        { toolsets: ['fs'] },
        {} as any,
        { group_folder: 'test-group' } as any,
      );

      expect(getActiveToolsets('test-group')).not.toContain('fs');
      expect(result).toContain('Project settings disabled: fs');
    });
  });

  describe('agent_query runtime selection', () => {
    test('uses the materialized project Kanban binding', async () => {
      const configured = resolveAgentQueryRuntime(
        {
          settings: {
            kanbanRuntimeSelection: {
              harnessId: 'codex',
              modelId: 'gpt-5.6-sol',
            },
          },
        } as any,
        resolveKanbanRuntimeForTests,
      );

      expect(configured).toMatchObject(mockKanbanRuntime.agent);
      expect(kanbanSelectionCalls).toEqual([
        [{ harnessId: 'codex', modelId: 'gpt-5.6-sol' }],
      ]);
    });

    test('rejects a direct Kanban selection before attempting a sandbox launch', async () => {
      mockKanbanRuntime = {
        agent: { id: 'llm:direct:qwen', harnessKind: 'direct' },
      } as any;
      expect(() =>
        resolveAgentQueryRuntime(
          { settings: {} } as any,
          resolveKanbanRuntimeForTests,
        ),
      ).toThrow('agent_query requires a CLI Kanban runtime');
    });
  });
});
