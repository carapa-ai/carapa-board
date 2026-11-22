import { formatAskUserQuestionBlock } from '../lib/ask-user-question.js';

export type AgentDisplayFragment =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | {
      type: 'tool_use';
      name: string;
      input: Record<string, unknown>;
      title?: string;
      id?: string;
      phase?: 'started' | 'completed';
    }
  | { type: 'tool_result'; content: unknown; isError?: boolean; id?: string }
  | { type: 'file_change'; path: string; kind?: string }
  | { type: 'error'; message: string; label?: string; id?: string }
  | { type: 'codex_mcp_use'; item: Record<string, unknown> }
  | { type: 'codex_mcp_result'; item: Record<string, unknown> };

/** Tracks announced Cursor tool calls so terminal updates keep their identity. */
export type CursorToolTrackState = {
  pending: Map<string, { name: string; input: Record<string, unknown> }>;
};

export function createCursorToolTrackState(): CursorToolTrackState {
  return { pending: new Map() };
}
/** Cursor `thinking` stream-json events (not used by Claude/Codex top-level). */
function hasCursorThinkingShape(parsed: Record<string, unknown>): boolean {
  return (
    parsed.type === 'thinking' &&
    (parsed.subtype === 'delta' || parsed.subtype === 'completed')
  );
}

/** Cursor `tool_call` stream-json events (`globToolCall`, `readToolCall`, …). */
function hasCursorToolCallShape(parsed: Record<string, unknown>): boolean {
  return (
    parsed.type === 'tool_call' &&
    parsed.call_id != null &&
    parsed.tool_call != null &&
    typeof parsed.tool_call === 'object'
  );
}

/** Cursor echoes the injected board prompt as a top-level `user` text event. */
function hasCursorUserEchoShape(parsed: Record<string, unknown>): boolean {
  if (parsed.type !== 'user') return false;
  const blocks = (
    parsed.message as
      | { content?: Array<{ type?: string; text?: string }> }
      | undefined
  )?.content;
  if (!Array.isArray(blocks)) return false;
  if (blocks.every((b) => b?.type === 'tool_result')) return false;
  return blocks.some(
    (b) =>
      b?.type === 'text' &&
      (String(b.text || '').includes('[AGENT_CONTEXT') ||
        String(b.text || '').includes('App preview URL for this run')),
  );
}

/**
 * Cursor Agent CLI events carry `agent_name: "cursor"` once archived, but live
 * `output.jsonl` from `agent --print` omits it — detect by event shape too.
 */
export function isCursorStreamEvent(parsed: Record<string, unknown>): boolean {
  if (parsed.agent_name === 'cursor') return true;
  return (
    hasCursorThinkingShape(parsed) ||
    hasCursorToolCallShape(parsed) ||
    hasCursorUserEchoShape(parsed)
  );
}

/**
 * Cursor `--stream-partial-output` emits per-token deltas, then a full-message
 * echo. Returns only the not-yet-emitted suffix and the updated accumulator.
 */
export function cursorAssistantDelta(
  accumulated: string,
  incoming: string,
): { delta: string; next: string } {
  if (!incoming) return { delta: '', next: accumulated };
  if (incoming === accumulated) return { delta: '', next: accumulated };
  if (accumulated && incoming.startsWith(accumulated)) {
    return { delta: incoming.slice(accumulated.length), next: incoming };
  }
  return { delta: incoming, next: accumulated + incoming };
}
function parseCursorToolCallEvent(parsed: Record<string, unknown>): {
  callId: string;
  isStarted: boolean;
  name: string;
  input: Record<string, unknown>;
  output?: string;
  isError?: boolean;
} | null {
  if (parsed.type !== 'tool_call' || !isCursorStreamEvent(parsed)) return null;
  const subtype = String(parsed.subtype || '');
  const isStarted = subtype === 'started';
  const isCompleted = subtype === 'completed';
  if (!isStarted && !isCompleted) return null;

  const tc = parsed.tool_call as Record<string, unknown> | undefined;
  if (!tc) return null;
  const callId = String(parsed.call_id || '');

  if (tc.globToolCall) {
    const g = tc.globToolCall as {
      args?: Record<string, unknown>;
      result?: { success?: { files?: string[]; totalFiles?: number } };
    };
    const args = g.args || {};
    const input = {
      globPattern: args.globPattern,
      pattern: args.globPattern,
      targetDirectory: args.targetDirectory,
    };
    let output: string | undefined;
    if (isCompleted && g.result?.success) {
      const n =
        g.result.success.totalFiles ?? g.result.success.files?.length ?? 0;
      output = `${n} files`;
    }
    return { callId, isStarted, name: 'glob', input, output };
  }

  if (tc.readToolCall) {
    const r = tc.readToolCall as {
      args?: Record<string, unknown>;
      result?: {
        success?: { content?: string };
        error?: { errorMessage?: string; message?: string };
      };
    };
    const args = r.args || {};
    const input = { path: args.path, file_path: args.path, limit: args.limit };
    let output: string | undefined;
    let isError: boolean | undefined;
    if (isCompleted && r.result) {
      if (r.result.success?.content != null) {
        output = String(r.result.success.content);
      } else if (r.result.error) {
        output = String(
          r.result.error.errorMessage ||
            r.result.error.message ||
            'Read failed',
        );
        isError = true;
      }
    }
    return { callId, isStarted, name: 'read', input, output, isError };
  }

  if (tc.mcpToolCall) {
    const m = tc.mcpToolCall as {
      args?: Record<string, unknown>;
      result?: { success?: { content?: unknown; isError?: boolean } };
    };
    const args = m.args || {};
    const toolName = String(args.toolName || args.name || 'mcp').replace(
      /^carapa-board-/,
      '',
    );
    const input = (args.args || {}) as Record<string, unknown>;
    let output: string | undefined;
    let isError: boolean | undefined;
    if (isCompleted && m.result?.success) {
      isError = Boolean(m.result.success.isError);
      const content = m.result.success.content;
      if (Array.isArray(content)) {
        output = content
          .map((c) => {
            const row = c as { text?: { text?: string } };
            return row.text?.text ?? JSON.stringify(c);
          })
          .join('\n');
      } else if (content != null) {
        output = String(content);
      }
    }
    return { callId, isStarted, name: toolName, input, output, isError };
  }

  if (tc.shellToolCall || tc.runTerminalToolCall) {
    const s = (tc.shellToolCall || tc.runTerminalToolCall) as {
      args?: Record<string, unknown>;
      result?: { success?: { output?: string; exitCode?: number } };
    };
    const args = s.args || {};
    const input = { command: args.command || args.cmd };
    let output: string | undefined;
    let isError: boolean | undefined;
    if (isCompleted && s.result?.success) {
      output = String(s.result.success.output || '');
      const code = s.result.success.exitCode;
      isError = typeof code === 'number' ? code !== 0 : false;
    }
    return { callId, isStarted, name: 'bash', input, output, isError };
  }

  if (tc.grepToolCall) {
    const g = tc.grepToolCall as {
      args?: Record<string, unknown>;
      result?: {
        success?: {
          workspaceResults?: Record<
            string,
            {
              content?: {
                matches?: Array<{ matches?: unknown[] }>;
                totalMatchedLines?: number;
              };
            }
          >;
        };
        error?: { error?: string };
      };
    };
    const args = g.args || {};
    const input = normalizeCursorToolArgs({
      pattern: args.pattern,
      grepPattern: args.pattern,
      glob: args.glob,
      path: args.path,
    });
    let output: string | undefined;
    let isError: boolean | undefined;
    if (isCompleted && g.result) {
      if (g.result.error) {
        output = String(g.result.error.error || 'Grep failed');
        isError = true;
      } else if (g.result.success?.workspaceResults) {
        let files = 0;
        let lines = 0;
        for (const ws of Object.values(g.result.success.workspaceResults)) {
          const matches = ws.content?.matches;
          if (!Array.isArray(matches)) continue;
          files += matches.length;
          for (const m of matches) {
            lines += Array.isArray(m.matches) ? m.matches.length : 0;
          }
        }
        output =
          files > 0 ? `${lines} matches in ${files} files` : 'no matches';
      }
    }
    return { callId, isStarted, name: 'grep', input, output, isError };
  }

  if (tc.editToolCall) {
    const e = tc.editToolCall as {
      args?: Record<string, unknown>;
      result?: {
        success?: { path?: string; linesAdded?: number; linesRemoved?: number };
        error?: { error?: string };
      };
    };
    const args = e.args || {};
    const input = normalizeCursorToolArgs({
      path: args.path,
      file_path: args.path,
    });
    let output: string | undefined;
    let isError: boolean | undefined;
    if (isCompleted && e.result) {
      if (e.result.error) {
        output = String(e.result.error.error || 'Edit failed');
        isError = true;
      } else if (e.result.success) {
        const added = e.result.success.linesAdded ?? 0;
        const removed = e.result.success.linesRemoved ?? 0;
        output = `+${added}/-${removed}`;
      }
    }
    return { callId, isStarted, name: 'edit', input, output, isError };
  }

  if (tc.writeToolCall) {
    const w = tc.writeToolCall as {
      args?: Record<string, unknown>;
      result?: {
        success?: { path?: string; linesCreated?: number };
        error?: { error?: string };
      };
    };
    const args = w.args || {};
    const input = normalizeCursorToolArgs({
      path: args.path,
      file_path: args.path,
      fileText: args.fileText ?? args.contents,
    });
    let output: string | undefined;
    let isError: boolean | undefined;
    if (isCompleted && w.result) {
      if (w.result.error) {
        output = String(w.result.error.error || 'Write failed');
        isError = true;
      } else if (w.result.success) {
        const lines = w.result.success.linesCreated;
        output = typeof lines === 'number' ? `${lines} lines` : undefined;
      }
    }
    return { callId, isStarted, name: 'write', input, output, isError };
  }

  const kind = Object.keys(tc).find((k) => k.endsWith('ToolCall')) || 'tool';
  const toolData = (kind !== 'tool' ? tc[kind] : undefined) as
    | { args?: Record<string, unknown> }
    | undefined;
  const name = kind
    .replace(/ToolCall$/, '')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase();
  return {
    callId,
    isStarted,
    name,
    input: normalizeCursorToolArgs(toolData?.args || {}),
    output: undefined,
  };
}

/** Map Cursor tool `args` keys to the names `formatToolUse` expects. */
function normalizeCursorToolArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const input = { ...args };
  if (args.path != null && input.file_path == null) input.file_path = args.path;
  if (args.globPattern != null && input.pattern == null)
    input.pattern = args.globPattern;
  if (args.pattern != null && input.grepPattern == null)
    input.grepPattern = args.pattern;
  return input;
}
/** Header + optional result body for one Cursor tool round-trip. */
export function formatCursorToolBlock(
  name: string,
  input: Record<string, unknown>,
  output?: string,
  isError?: boolean,
  toolId?: string,
): string {
  const parts: string[] = [];
  const header = formatToolUse(name, input, undefined, undefined, toolId);
  if (header) parts.push(header);
  if (output) {
    const md = formatToolResult(output, isError, toolId);
    if (md) parts.push(md);
  }
  return parts.join('');
}

function shellCommandsLooselyMatch(a: string, b: string): boolean {
  const na = formatShellCommand(a).replace(/\s+/g, ' ').trim();
  const nb = formatShellCommand(b).replace(/\s+/g, ' ').trim();
  if (na === nb) return true;
  const stripEnv = (s: string) =>
    s
      .split(/\s*&&\s*/)
      .map((seg) => seg.replace(/^(\s*[A-Z_][A-Z0-9_]*=\S+\s*)+/, '').trim())
      .join(' && ');
  const sa = stripEnv(na);
  const sb = stripEnv(nb);
  if (sa === sb) return true;
  return sa.includes(sb) || sb.includes(sa);
}

/**
 * When a Cursor shell tool aborts without a `completed` event, stream output may
 * include `{type:"error", message:"… Stuck on: <cmd>"}` (legacy watchdog shape).
 * Attach that to the pending bash call so the error sits under the right header.
 */
export function tryAttachCursorStuckShellError(
  message: string,
  state: CursorToolTrackState,
): string | null {
  const m = message.match(/Stuck on:\s*(.+)$/s);
  if (!m) return null;
  const stuckCmd = m[1].trim();
  for (const [callId, tool] of state.pending) {
    if (tool.name !== 'bash') continue;
    const cmd = String(tool.input.command || tool.input.cmd || '');
    if (!shellCommandsLooselyMatch(cmd, stuckCmd)) continue;
    state.pending.delete(callId);
    const body = message.replace(/\s*Stuck on:\s*.+$/, '').trim();
    return formatToolResult(body, true, callId) || null;
  }
  return null;
}

/** Apply Cursor start/completion pairing to already-normalized fragments. */
export function processCursorDisplayFragments(
  fragments: AgentDisplayFragment[],
  state: CursorToolTrackState,
): string | null {
  const tool = fragments.find(
    (
      fragment,
    ): fragment is Extract<AgentDisplayFragment, { type: 'tool_use' }> =>
      fragment.type === 'tool_use' &&
      Boolean(fragment.id) &&
      Boolean(fragment.phase),
  );
  if (!tool?.id) return formatDisplayFragments(fragments) || null;
  if (tool.phase === 'started') {
    if (state.pending.has(tool.id)) return null;
    state.pending.set(tool.id, { name: tool.name, input: tool.input });
    return formatDisplayFragments(fragments) || null;
  }
  const wasAnnounced = state.pending.delete(tool.id);
  return formatDisplayFragments(
    wasAnnounced
      ? fragments.filter((fragment) => fragment.type !== 'tool_use')
      : fragments,
  );
}

const TOOL_RESULT_PREVIEW_BYTES = 4 * 1024;

export function codexCommandKey(item: Record<string, unknown>): string {
  return String(item.id || item.command || 'command_execution');
}

function codexDisplayToolId(item: Record<string, unknown>): string | undefined {
  return typeof item.id === 'string' && item.id ? item.id : undefined;
}

export function codexCommandOutputDelta(
  event: Record<string, any>,
): { itemId: string; delta: string } | null {
  const eventName = String(event.method || event.type || '');
  const isOutputDelta =
    eventName === 'item/commandExecution/outputDelta' ||
    eventName === 'item.commandExecution.outputDelta' ||
    eventName === 'item.command_execution.output_delta' ||
    (eventName === 'item.updated' && event.item?.type === 'command_execution');
  if (!isOutputDelta) return null;

  const payload =
    event.params && typeof event.params === 'object' ? event.params : event;
  const itemId = String(
    payload.itemId ||
      payload.item_id ||
      payload.item?.id ||
      event.item?.id ||
      '',
  );
  const delta =
    typeof payload.delta === 'string'
      ? payload.delta
      : typeof payload.item?.delta === 'string'
        ? payload.item.delta
        : typeof event.item?.delta === 'string'
          ? event.item.delta
          : '';
  return itemId && delta ? { itemId, delta } : null;
}

export function mergeCodexCommandOutput(
  event: Record<string, any>,
  accumulatedOutput: string | undefined,
): Record<string, any> {
  if (!accumulatedOutput || event.item?.type !== 'command_execution') {
    return event;
  }
  const item = event.item as Record<string, unknown>;
  const finalOutput =
    item.aggregated_output ?? item.output ?? item.stdout ?? item.stderr;
  if (
    (typeof finalOutput === 'string' && finalOutput.length > 0) ||
    (Array.isArray(finalOutput) && finalOutput.length > 0)
  ) {
    return event;
  }
  return {
    ...event,
    item: { ...item, aggregated_output: accumulatedOutput },
  };
}

export function codexMcpCallKey(item: Record<string, unknown>): string {
  return String(
    item.id ||
      `${item.server || ''}:${item.tool || ''}:${JSON.stringify(item.arguments ?? {})}`,
  );
}

function safeParseToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function formatThinkingMarkdown(raw: unknown): string {
  const note = String(raw ?? '')
    // Live Mode markers are hidden control syntax; models sometimes draft them
    // inside reasoning, where they would split the quoted thinking block.
    .replace(/\[\[live:[^\]\r\n]*\]\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return note ? `\n\n> _${note}_\n\n` : '';
}
type ToolActivityMarkerKind = 'request' | 'result' | 'error';

function markToolActivity(
  kind: ToolActivityMarkerKind,
  markdown: string,
  toolId?: string,
): string {
  if (!markdown) return '';
  const identity = toolId ? ` tool-id="${encodeURIComponent(toolId)}"` : '';
  const marker = `<!-- carapa-tool:${kind}${identity} -->`;
  return markdown.startsWith('\n\n')
    ? `\n\n${marker}\n${markdown.slice(2)}`
    : `${marker}\n${markdown}`;
}

/** Remove Board-owned display provenance while preserving authored comments. */
export function stripToolActivityMarkers(markdown: string): string {
  return markdown.replace(
    /^[\t ]*<!--\s*carapa-tool:(?:request|result|error)(?:\s+tool-id="[^"]+")?\s*-->[\t ]*(?:\r?\n|$)/gim,
    '',
  );
}

export function formatToolResult(
  rawContent: unknown,
  isError?: boolean,
  toolId?: string,
): string {
  const raw =
    typeof rawContent === 'string'
      ? rawContent
      : Array.isArray(rawContent)
        ? (rawContent as Array<{ text?: string }>)
            .map((c) => c.text || '')
            .join('')
        : '';
  // Terminal progress output can contain bare carriage returns. Markdown
  // treats them as line breaks, so quote them before rendering the result.
  const trimmed = raw.replace(/\r\n?/g, '\n').trim();
  // CarapaBox and Pi represent a successful command with empty stdout using
  // this sentinel. It is transport metadata, not output the user should see.
  // An identified terminal event must still survive as status metadata so a
  // delayed completion can update its original request (and so steering offset
  // replay retains the completion position for outputless Cursor calls).
  if (!trimmed || trimmed === '(no output)') {
    return toolId
      ? markToolActivity(
          isError ? 'error' : 'result',
          `\n\n> **${isError ? 'Failed' : 'Completed'}**\n\n`,
          toolId,
        )
      : '';
  }
  const truncated = trimmed.length > TOOL_RESULT_PREVIEW_BYTES;
  const body = truncated
    ? `${trimmed.slice(0, TOOL_RESULT_PREVIEW_BYTES)}\n… (${trimmed.length - TOOL_RESULT_PREVIEW_BYTES} more bytes truncated)`
    : trimmed;
  const quoted = body
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return markToolActivity(
    isError ? 'error' : 'result',
    `\n\n${isError ? '> ⚠️\n' : ''}${quoted}\n\n`,
    toolId,
  );
}

export function formatShellCommand(command: string): string {
  let cmd = command.trim();
  for (const re of [
    /^\/bin\/bash -lc (["'])([\s\S]*)\1$/,
    /^bash -lc (["'])([\s\S]*)\1$/,
    /^\/bin\/sh -lc (["'])([\s\S]*)\1$/,
    /^sh -lc (["'])([\s\S]*)\1$/,
  ]) {
    const match = cmd.match(re);
    if (match?.[2]) {
      cmd = match[2];
      break;
    }
  }
  return cmd.replace(/\s+/g, ' ').trim();
}

export function formatToolUse(
  name: string,
  input: Record<string, unknown>,
  title?: string,
  output?: string,
  toolId?: string,
): string {
  const get = (...keys: string[]): unknown => {
    for (const key of keys) if (input[key] != null) return input[key];
    return undefined;
  };
  const formatResult = (result?: string) =>
    result
      ? markToolActivity(
          'result',
          `\n\n> **Tool Result**:\n${result
            .replace(/\r\n?/g, '\n')
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n')}\n\n`,
          toolId,
        )
      : '';
  const stripWorkspace = (value: unknown) =>
    String(value).replace(/^\/workspace\//, '');
  let header = '';

  switch (name.toLowerCase()) {
    case 'edit':
    case 'replace':
      header = `\n\n> **Edit** \`${stripWorkspace(get('file_path', 'filePath') || '?')}\`\n\n`;
      break;
    case 'write':
    case 'write_file':
      header = `\n\n> **Write** \`${stripWorkspace(get('file_path', 'filePath') || '?')}\`\n\n`;
      break;
    case 'delete':
      header = `\n\n> **Delete** \`${stripWorkspace(get('file_path', 'filePath', 'path') || '?')}\`\n\n`;
      break;
    case 'read':
    case 'read_file':
      header = `\n\n> **Read** \`${stripWorkspace(get('file_path', 'filePath', 'path') || '?')}\`\n\n`;
      break;
    case 'bash':
    case 'run_shell_command': {
      const command = String(get('command', 'cmd', 'description') || '');
      if (command.includes('\n')) {
        const safe = command.replace(/```/g, '`​``');
        header = `\n\n> **Bash**\n${['```bash', ...safe.split('\n'), '```'].map((line) => `> ${line}`).join('\n')}\n\n`;
      } else {
        header = `\n\n> **Bash** \`${command.replace(/`/g, '​`')}\`\n\n`;
      }
      break;
    }
    case 'glob':
    case 'list_directory':
      header = `\n\n> **Glob** \`${stripWorkspace(get('pattern', 'globPattern') || '?')}\`\n\n`;
      break;
    case 'grep':
    case 'grep_search':
      header = `\n\n> **Grep** \`${stripWorkspace(get('pattern', 'grepPattern') || '?')}\`\n\n`;
      break;
    case 'agent':
    case 'task': {
      const description = String(get('description') || '')
        .replace(/\s+/g, ' ')
        .trim();
      const subagent = String(get('subagent_type') || '').trim();
      const tag = subagent ? ` \`${subagent}\`` : '';
      header = description
        ? `\n\n> **Agent**${tag} _${description}_\n\n`
        : `\n\n> **Agent**${tag}\n\n`;
      break;
    }
    case 'askuserquestion':
      return formatAskUserQuestionBlock(input) || `\n\n> **Question**\n\n`;
    case 'skill': {
      const skill = get('skill', 'name');
      header = skill ? `\n\n> **Skill** _${skill}_\n\n` : `\n\n> **Skill**\n\n`;
      break;
    }
    case 'load_toolset': {
      const sets = get('toolsets');
      const label = Array.isArray(sets)
        ? sets.map(String).join(', ')
        : sets != null
          ? String(sets)
          : '';
      header = label
        ? `\n\n> **Load toolset** \`${label}\`\n\n`
        : `\n\n> **Load toolset**\n\n`;
      break;
    }
    case 'recall': {
      const query = String(get('query') || '')
        .replace(/\s+/g, ' ')
        .trim();
      header = query
        ? `\n\n> **Recall** _${query}_\n\n`
        : `\n\n> **Recall**\n\n`;
      break;
    }
    case 'memorize': {
      const content = String(get('content') || '')
        .replace(/\s+/g, ' ')
        .trim();
      const preview =
        content.length > 80 ? `${content.slice(0, 80)}…` : content;
      header = preview
        ? `\n\n> **Memorize** _${preview}_\n\n`
        : `\n\n> **Memorize**\n\n`;
      break;
    }
    case 'forget': {
      const id = String(get('id', 'memory_id') || '').trim();
      header = id ? `\n\n> **Forget** \`${id}\`\n\n` : `\n\n> **Forget**\n\n`;
      break;
    }
    case 'mcp': {
      const server = String(get('server') || '').trim();
      const action = String(get('action', 'tool') || '').trim();
      const search = String(get('search') || '')
        .replace(/\s+/g, ' ')
        .trim();
      const describe = String(get('describe') || '').trim();
      const argsRaw = String(get('args') || '').trim();
      let detail = '';
      if (action === 'search' && search)
        detail = ` _${search.length > 80 ? `${search.slice(0, 80)}…` : search}_`;
      else if (action === 'describe' && describe) detail = ` _${describe}_`;
      else if (action && action !== 'status') detail = ` _${action}_`;
      let preview = '';
      if (argsRaw) {
        try {
          const parsed = JSON.parse(argsRaw);
          const candidate =
            parsed.content ||
            parsed.query ||
            parsed.prompt ||
            parsed.url ||
            parsed.path ||
            parsed.pattern ||
            parsed.description;
          if (candidate != null) {
            const value = String(candidate).replace(/\s+/g, ' ').trim();
            preview =
              value.length > 80 ? ` _${value.slice(0, 80)}…_` : ` _${value}_`;
          }
        } catch {
          const value = argsRaw.replace(/\s+/g, ' ').trim();
          if (value && value.length <= 80) preview = ` _${value}_`;
        }
      }
      header = `\n\n> **MCP**${server ? ` \`${server}\`` : ''}${detail}${preview}\n\n`;
      break;
    }
    default: {
      const displayName = name.replace(/^mcp__[^_]+__/, '');
      if (title && title !== name)
        header = `\n\n> **${displayName}** _${title}_\n\n`;
      else {
        let summary = '';
        for (const key of [
          'query',
          'prompt',
          'path',
          'file_path',
          'filePath',
          'pattern',
          'description',
          'url',
        ]) {
          const value = get(key);
          if (value != null && String(value).trim()) {
            summary = String(value).replace(/\s+/g, ' ').trim();
            if (summary.length > 80) summary = `${summary.slice(0, 80)}…`;
            break;
          }
        }
        header = summary
          ? `\n\n> **${displayName}** _${summary}_\n\n`
          : `\n\n> **${displayName}**\n\n`;
      }
    }
  }
  return markToolActivity('request', header, toolId) + formatResult(output);
}

function formatCodexMcpToolCallHeader(item: Record<string, unknown>): string {
  const inline = (value: unknown) => String(value ?? '').replace(/`/g, '​`');
  let rawArgs: string;
  try {
    rawArgs =
      typeof item.arguments === 'string'
        ? JSON.stringify(JSON.parse(item.arguments), null, 2)
        : JSON.stringify(item.arguments ?? {}, null, 2);
  } catch {
    rawArgs = JSON.stringify(String(item.arguments));
  }
  const args =
    rawArgs.length > TOOL_RESULT_PREVIEW_BYTES
      ? `${rawArgs.slice(0, TOOL_RESULT_PREVIEW_BYTES)}\n… (${rawArgs.length - TOOL_RESULT_PREVIEW_BYTES} more bytes truncated)`
      : rawArgs;
  const quoted = args
    .replace(/```/g, '`​``')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return markToolActivity(
    'request',
    `\n\n> **MCP** \`${inline(item.server || 'unknown')}\` · \`${inline(item.tool || 'tool')}\`\n> \`\`\`json\n${quoted}\n> \`\`\`\n\n`,
    codexDisplayToolId(item),
  );
}

function formatCodexMcpToolCallResult(item: Record<string, unknown>): string {
  const failed =
    item.status === 'error' || item.status === 'failed' || item.error != null;
  const value = failed ? (item.error ?? item.result) : item.result;
  if (value == null)
    return formatToolResult(undefined, failed, codexDisplayToolId(item));
  let content: string;
  if (typeof value === 'string') content = value;
  else {
    try {
      content = JSON.stringify(value, null, 2);
    } catch {
      content = String(value);
    }
  }
  return formatToolResult(content, failed, codexDisplayToolId(item));
}

export function formatDisplayFragment(fragment: AgentDisplayFragment): string {
  switch (fragment.type) {
    case 'text':
      return fragment.text;
    case 'thinking':
      return formatThinkingMarkdown(fragment.text);
    case 'tool_use':
      return formatToolUse(
        fragment.name,
        fragment.input,
        fragment.title,
        undefined,
        fragment.id,
      );
    case 'tool_result':
      return formatToolResult(fragment.content, fragment.isError, fragment.id);
    case 'file_change': {
      const kind = String(fragment.kind || 'update').toLowerCase();
      const verb =
        kind === 'create' ? 'Write' : kind === 'delete' ? 'Delete' : 'Edit';
      return formatToolUse(verb, { file_path: fragment.path });
    }
    case 'error':
      return markToolActivity(
        'error',
        `\n\n> **${fragment.label || 'Error'}** ${fragment.message}\n\n`,
        fragment.id,
      );
    case 'codex_mcp_use':
      return formatCodexMcpToolCallHeader(fragment.item);
    case 'codex_mcp_result':
      return formatCodexMcpToolCallResult(fragment.item);
  }
}

export function formatDisplayFragments(
  fragments: AgentDisplayFragment[],
): string {
  return fragments.map(formatDisplayFragment).join('');
}

function normalizeContentBlocks(blocks: unknown): AgentDisplayFragment[] {
  if (!Array.isArray(blocks)) return [];
  const fragments: AgentDisplayFragment[] = [];
  for (const value of blocks) {
    if (!value || typeof value !== 'object') continue;
    const block = value as Record<string, unknown>;
    if (block.type === 'text' && block.text)
      fragments.push({ type: 'text', text: String(block.text) });
    else if (block.type === 'thinking' && block.thinking)
      fragments.push({ type: 'thinking', text: String(block.thinking) });
    else if (block.type === 'tool_use' || block.type === 'toolCall') {
      const rawInput = block.input ?? block.arguments;
      const input =
        rawInput && typeof rawInput === 'object'
          ? (rawInput as Record<string, unknown>)
          : typeof rawInput === 'string'
            ? safeParseToolArgs(rawInput)
            : {};
      fragments.push({
        type: 'tool_use',
        name: String(block.name || 'unknown'),
        input,
        id: block.id ? String(block.id) : undefined,
      });
    } else if (block.type === 'tool_result') {
      fragments.push({
        type: 'tool_result',
        content: block.content,
        isError: Boolean(block.is_error),
        id: block.tool_use_id ? String(block.tool_use_id) : undefined,
      });
    }
  }
  return fragments;
}

/** Stateless protocol normalization. Delta pairing and duplicate suppression stay with callers. */
export function normalizeAgentEvent(
  event: Record<string, unknown>,
): AgentDisplayFragment[] {
  const message =
    event.message && typeof event.message === 'object'
      ? (event.message as Record<string, unknown>)
      : undefined;
  const item =
    event.item && typeof event.item === 'object'
      ? (event.item as Record<string, unknown>)
      : undefined;

  if (event.type === 'thinking' && isCursorStreamEvent(event)) {
    return event.text ? [{ type: 'thinking', text: String(event.text) }] : [];
  }
  if (event.type === 'tool_call' && isCursorStreamEvent(event)) {
    const info = parseCursorToolCallEvent(event);
    if (!info) return [];
    const fragments: AgentDisplayFragment[] = [
      {
        type: 'tool_use',
        name: info.name,
        input: info.input,
        id: info.callId,
        phase: info.isStarted ? 'started' : 'completed',
      },
    ];
    if (!info.isStarted) {
      fragments.push({
        type: 'tool_result',
        content: info.output,
        isError: info.isError,
        id: info.callId,
      });
    }
    return fragments;
  }

  if (
    (event.type === 'assistant' ||
      event.type === 'message_end' ||
      event.type === 'message') &&
    message?.content &&
    message.role !== 'user'
  ) {
    const fragments = normalizeContentBlocks(message?.content);
    if (message?.stopReason === 'error' && message.errorMessage) {
      fragments.push({ type: 'error', message: String(message.errorMessage) });
    }
    return fragments;
  }
  if (event.type === 'user' && message?.content) {
    return normalizeContentBlocks(message.content).filter(
      (fragment) => fragment.type === 'tool_result',
    );
  }
  if (event.type === 'message' && event.role === 'assistant' && event.content) {
    return [{ type: 'text', text: String(event.content) }];
  }
  if (event.type === 'tool_use' && event.tool_name) {
    return [
      {
        type: 'tool_use',
        name: String(event.tool_name),
        input: (event.parameters || {}) as Record<string, unknown>,
        id: event.id ? String(event.id) : undefined,
      },
    ];
  }
  if (
    event.type === 'text' &&
    (event.part as Record<string, unknown> | undefined)?.type === 'text'
  ) {
    const text = (event.part as Record<string, unknown>).text;
    return text ? [{ type: 'text', text: String(text) }] : [];
  }
  if (
    event.type === 'tool_use' &&
    (event.part as Record<string, unknown> | undefined)?.type === 'tool'
  ) {
    const part = event.part as Record<string, any>;
    const fragments: AgentDisplayFragment[] = [
      {
        type: 'tool_use',
        name: String(part.tool || 'tool'),
        input: part.state?.input || {},
        title: part.state?.title,
        id: part.id
          ? String(part.id)
          : part.callID
            ? String(part.callID)
            : undefined,
      },
    ];
    if (part.state?.status !== 'running') {
      if (part.state?.output != null) {
        fragments.push({
          type: 'tool_result',
          content: part.state.output,
          isError: part.state?.status === 'error',
          id: part.id
            ? String(part.id)
            : part.callID
              ? String(part.callID)
              : undefined,
        });
      } else if (part.state?.status === 'error' && part.state?.error) {
        fragments.push({
          type: 'error',
          message: String(part.state.error),
          id: part.id
            ? String(part.id)
            : part.callID
              ? String(part.callID)
              : undefined,
        });
      } else {
        fragments.push({
          type: 'tool_result',
          content: undefined,
          isError: part.state?.status === 'error',
          id: part.id
            ? String(part.id)
            : part.callID
              ? String(part.callID)
              : undefined,
        });
      }
    }
    return fragments;
  }
  if (event.type === 'tool_execution_start') {
    return [
      {
        type: 'tool_use',
        name: String(event.toolName || 'tool'),
        input:
          event.args && typeof event.args === 'object'
            ? (event.args as Record<string, unknown>)
            : {},
        id: event.toolCallId ? String(event.toolCallId) : undefined,
      },
    ];
  }
  if (event.type === 'tool_execution_end') {
    const result =
      event.result && typeof event.result === 'object'
        ? (event.result as Record<string, unknown>)
        : undefined;
    return [
      {
        type: 'tool_result',
        content: result?.content,
        isError: Boolean(event.isError),
        id: event.toolCallId ? String(event.toolCallId) : undefined,
      },
    ];
  }
  if (
    event.type === 'item.started' &&
    item?.type === 'command_execution' &&
    item.command
  ) {
    return [
      {
        type: 'tool_use',
        name: 'Bash',
        input: { command: formatShellCommand(String(item.command)) },
        id: codexDisplayToolId(item),
      },
    ];
  }
  if (event.type === 'item.started' && item?.type === 'mcp_tool_call') {
    return [{ type: 'codex_mcp_use', item }];
  }
  if (event.type === 'item.completed' && item) {
    if (item.type === 'agent_message' && item.text)
      return [{ type: 'text', text: String(item.text) }];
    if (item.type === 'reasoning' && item.text)
      return [
        { type: 'thinking', text: String(item.text).replace(/\*\*/g, '') },
      ];
    if (item.type === 'mcp_tool_call')
      return [{ type: 'codex_mcp_result', item }];
    if (item.type === 'command_execution') {
      const exitCode =
        typeof item.exit_code === 'number' ? item.exit_code : null;
      const output =
        item.aggregated_output ?? item.output ?? item.stdout ?? item.stderr;
      const fragments: AgentDisplayFragment[] = [];
      if (exitCode !== null && exitCode !== 0) {
        fragments.push({
          type: 'error',
          label: 'Bash failed',
          message: `\`exit ${exitCode}\` · \`${formatShellCommand(String(item.command || '')).replace(/`/g, '​`')}\``,
          id: codexDisplayToolId(item),
        });
      }
      const hasDisplayableOutput =
        typeof output === 'string'
          ? output.trim().length > 0
          : Array.isArray(output) &&
            output.some(
              (value) =>
                value &&
                typeof value === 'object' &&
                String((value as { text?: unknown }).text || '').trim(),
            );
      if (hasDisplayableOutput) {
        fragments.push({
          type: 'tool_result',
          content: output,
          isError: exitCode !== null && exitCode !== 0,
          id: codexDisplayToolId(item),
        });
      } else if (exitCode === null || exitCode === 0) {
        fragments.push({
          type: 'tool_result',
          content: undefined,
          id: codexDisplayToolId(item),
        });
      }
      return fragments;
    }
    if (item.type === 'file_change') {
      return (Array.isArray(item.changes) ? item.changes : [])
        .slice(0, 8)
        .map((change: any) => ({
          type: 'file_change' as const,
          path: String(change.path || '?').replace(/^\/workspace\//, ''),
          // Codex has emitted both the legacy string form (`"create"`) and
          // the current structured form (`{ type: "create", move_path: null }`).
          // Normalize both before the shared formatter chooses Write/Edit/Delete.
          kind:
            typeof change.kind === 'object' && change.kind !== null
              ? String(change.kind.type || 'update')
              : String(change.kind || 'update'),
        }));
    }
    if (item.type === 'error' && item.message)
      return [{ type: 'error', message: String(item.message) }];
  }
  if (
    event.type === 'turn.failed' &&
    (event.error as Record<string, unknown> | undefined)?.message
  ) {
    return [
      {
        type: 'error',
        label: 'Turn failed',
        message: String((event.error as Record<string, unknown>).message),
      },
    ];
  }
  if (
    event.type === 'result' &&
    (event.is_error === true || event.subtype === 'error') &&
    event.result
  ) {
    return [{ type: 'error', message: String(event.result) }];
  }
  if (event.type === 'error') {
    const error =
      event.error && typeof event.error === 'object'
        ? (event.error as Record<string, unknown>)
        : undefined;
    const data =
      error?.data && typeof error.data === 'object'
        ? (error.data as Record<string, unknown>)
        : undefined;
    return [
      {
        type: 'error',
        message: String(
          event.message || error?.message || data?.message || 'Unknown error',
        ),
      },
    ];
  }
  return [];
}
