import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { sha256Hex } from '../../lib/hash.js';
import { isRegularFileInside } from './archive-safety.js';

const TOOL_QUALITY_STATE_VERSION = 5;
const TOOL_QUALITY_CLASSIFIER_VERSION = '2026-07-22.8';

type ToolOutcome =
  | 'success'
  | 'invalid_invocation'
  | 'harness_error'
  | 'tool_execution_error'
  | 'code_failure'
  | 'transport_failure'
  | 'unknown';

export interface ToolAttempt {
  attemptId: string;
  eventIdentity: string;
  conversationId: string;
  runId?: string;
  timestamp?: string;
  timestampSource?: 'event' | 'run' | 'source';
  runtimeKind: 'direct' | 'cli' | 'unknown';
  harness: string;
  configuredModel?: string;
  reportedModel?: string;
  tool: string;
  input?: unknown;
  output?: unknown;
  explicitError?: boolean;
  outcome: ToolOutcome;
  confidence: number;
  reason: string;
  agentAttributable: boolean;
  classifierVersion: string;
  source: { path: string; member?: string; line: number; byteOffset: number };
  sources?: Array<{
    path: string;
    member?: string;
    line: number;
    byteOffset: number;
  }>;
  evidence: unknown;
}

interface PendingCall {
  attempt: ToolAttempt;
  pairKey: string;
}

interface SourceState {
  kind: 'live' | 'archive';
  project?: string;
  dateHint?: string;
  fingerprint?: string;
  byteOffset: number;
  lineCount: number;
  prefixHash: string;
  attemptIds: string[];
  occurrenceCounts: Record<string, number>;
  pending: Record<string, PendingCall>;
  identity: Identity;
  currentRunAttemptIds: string[];
}

interface AnalyzerState {
  version: number;
  sources: Record<string, SourceState>;
}

interface LedgerRecord {
  op: 'upsert' | 'delete';
  recordedAt: string;
  attemptId: string;
  attempt?: ToolAttempt;
  reason?: string;
}

export interface AnalyzerOptions {
  groupsDir: string;
  statePath: string;
  ledgerPath: string;
  reportDir: string;
  projects?: string[];
  since?: string;
  until?: string;
  archives?: boolean;
}

export interface AnalyzerRunResult {
  sourcesVisited: number;
  sourcesChanged: number;
  linesProcessed: number;
  ledgerRecordsAdded: number;
  activeAttempts: number;
}

interface SourceInput {
  key: string;
  displayPath: string;
  member?: string;
  project: string;
  kind: 'live' | 'archive';
  fingerprint?: string;
  dateHint: string;
  content: Buffer;
}

interface Identity {
  runtimeKind: ToolAttempt['runtimeKind'];
  harness: string;
  configuredModel?: string;
  reportedModel?: string;
  runId?: string;
  timestamp?: string;
}

interface CallEvent {
  pairKey: string;
  eventId?: string;
  tool: string;
  input?: unknown;
  output?: unknown;
  completed: boolean;
  explicitError?: boolean;
  timestamp?: string;
  evidence: unknown;
}

interface ResultEvent {
  pairKey: string;
  output?: unknown;
  explicitError?: boolean;
  evidence: unknown;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function modelFromAgentName(agentName?: string): string | undefined {
  if (!agentName?.startsWith('llm:')) return undefined;
  const runtimeAndModel = agentName.slice('llm:'.length);
  const harnessSeparator = runtimeAndModel.indexOf(':');
  return nonEmpty(
    harnessSeparator >= 0
      ? runtimeAndModel.slice(harnessSeparator + 1)
      : runtimeAndModel,
  );
}

function harnessFromAgentName(agentName?: string): string | undefined {
  if (!agentName) return undefined;
  const lower = agentName.toLowerCase();
  if (lower.startsWith('llm:') || lower === 'direct') return 'direct';
  if (lower.includes('claude')) return 'claude';
  if (lower.includes('codex')) return 'codex';
  if (lower.includes('gemini')) return 'gemini';
  if (lower.includes('opencode')) return 'opencode';
  if (lower.includes('cursor')) return 'cursor';
  if (lower === 'pi' || lower.startsWith('pi:')) return 'pi';
  return lower;
}

function inferHarness(event: any, current: Identity): string {
  const named = harnessFromAgentName(
    nonEmpty(event?.agent_name) || nonEmpty(event?.agentName),
  );
  if (named) return named;
  if (
    event?.type === 'item.started' ||
    event?.type === 'item.completed' ||
    event?.type === 'turn.started' ||
    event?.type === 'thread.started'
  )
    return 'codex';
  if (event?.type === 'tool_call' && event?.tool_call) return 'cursor';
  if (
    event?.type === 'agent_end' ||
    event?.type === 'tool_execution_start' ||
    event?.type === 'tool_execution_end'
  )
    return 'pi';
  if (event?.type === 'tool_use' && event?.part?.type === 'tool')
    return current.harness === 'direct' ? 'direct' : 'opencode';
  if (event?.type === 'tool_use' && event?.tool_name) return 'gemini';
  if (event?.type === 'assistant' && Array.isArray(event?.message?.content))
    return 'claude';
  return current.harness;
}

function updateIdentity(event: any, current: Identity): Identity {
  const harness = inferHarness(event, current) || 'unknown';
  const sameHarness = harness === current.harness;
  const agentName = nonEmpty(event?.agent_name) || nonEmpty(event?.agentName);
  const direct = harness === 'direct' || agentName?.startsWith('llm:');
  const selectionModel =
    nonEmpty(event?.runtimeSelection?.modelId) ||
    nonEmpty(event?.runtime_selection?.model_id);
  const configuredExplicit =
    nonEmpty(event?.configuredModel) ||
    nonEmpty(event?.configured_model) ||
    selectionModel;
  const telemetryModel = nonEmpty(event?.telemetry?.model_name);
  const lineModelName = nonEmpty(event?.model_name);
  const runConfiguredModel =
    event?.entry_type === 'run_start' ? lineModelName : undefined;
  const configuredModel =
    configuredExplicit ||
    runConfiguredModel ||
    modelFromAgentName(agentName) ||
    (direct ? telemetryModel || lineModelName : undefined) ||
    (sameHarness ? current.configuredModel : undefined);
  const reportedModel =
    nonEmpty(event?.reportedModel) ||
    nonEmpty(event?.reported_model) ||
    nonEmpty(event?.response?.model) ||
    nonEmpty(event?.message?.model) ||
    nonEmpty(event?.model) ||
    (!direct ? telemetryModel || lineModelName : undefined) ||
    (sameHarness ? current.reportedModel : undefined);
  const runId =
    nonEmpty(event?.run_id) ||
    nonEmpty(event?.runId) ||
    (sameHarness ? current.runId : undefined);
  const eventTimestamp =
    nonEmpty(event?.created_at) || nonEmpty(event?.timestamp);
  const timestamp =
    event?.entry_type === 'run_start'
      ? eventTimestamp
      : eventTimestamp || (sameHarness ? current.timestamp : undefined);
  return {
    runtimeKind: direct ? 'direct' : harness === 'unknown' ? 'unknown' : 'cli',
    harness,
    configuredModel,
    reportedModel,
    runId,
    timestamp,
  };
}

function codexTool(item: any): string {
  if (item?.type === 'command_execution') return 'Bash';
  if (item?.type === 'mcp_tool_call')
    return (
      nonEmpty(item.tool) ||
      nonEmpty(item.name) ||
      [item.server, item.tool_name].filter(Boolean).join('__') ||
      'mcp'
    );
  return (
    nonEmpty(item?.name) ||
    nonEmpty(item?.tool) ||
    nonEmpty(item?.type) ||
    'unknown'
  );
}

function codexInput(item: any): unknown {
  if (item?.type === 'command_execution') return { command: item.command };
  return item?.arguments ?? item?.input ?? item?.params;
}

function cursorPayload(toolCall: any): {
  tool: string;
  input?: unknown;
  output?: unknown;
  error?: boolean;
} {
  const entry = Object.entries(toolCall || {}).find(
    ([, value]) => value && typeof value === 'object',
  );
  if (!entry) return { tool: 'unknown' };
  const [kind, value] = entry as [string, any];
  const tool = kind
    .replace(/ToolCall$/, '')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase();
  const result = value.result;
  return {
    tool,
    input: value.args,
    output:
      result?.success?.content ??
      result?.success ??
      result?.failure?.error ??
      result?.failure ??
      result?.error?.errorMessage ??
      result?.error?.message ??
      result?.error ??
      result,
    error: !!result?.failure || !!result?.error,
  };
}

function extractEvents(event: any): {
  calls: CallEvent[];
  results: ResultEvent[];
} {
  const calls: CallEvent[] = [];
  const results: ResultEvent[] = [];
  if (
    event?.type === 'assistant' &&
    Array.isArray(event?.message?.tool_calls)
  ) {
    for (const toolCall of event.message.tool_calls) {
      const rawArguments = toolCall?.function?.arguments;
      let input: unknown = rawArguments;
      if (typeof rawArguments === 'string') {
        try {
          input = JSON.parse(rawArguments);
        } catch {
          input = { rawArguments, parseError: 'Malformed tool arguments' };
        }
      }
      const id =
        nonEmpty(toolCall?.id) ||
        sha256Hex(stable([toolCall?.function?.name, rawArguments]));
      calls.push({
        pairKey: id,
        eventId: nonEmpty(toolCall?.id),
        tool: nonEmpty(toolCall?.function?.name) || 'unknown',
        input,
        completed: false,
        timestamp: event.created_at,
        evidence: toolCall,
      });
    }
  }
  if (event?.type === 'assistant' && Array.isArray(event?.message?.content)) {
    for (const block of event.message.content)
      if (block?.type === 'tool_use') {
        const id =
          nonEmpty(block.id) || sha256Hex(stable([block.name, block.input]));
        calls.push({
          pairKey: id,
          eventId: nonEmpty(block.id),
          tool: nonEmpty(block.name) || 'unknown',
          input: block.input,
          completed: false,
          timestamp: event.created_at,
          evidence: block,
        });
      }
  }
  if (event?.type === 'user' && Array.isArray(event?.message?.content)) {
    for (const block of event.message.content)
      if (block?.type === 'tool_result') {
        const id = nonEmpty(block.tool_use_id) || nonEmpty(block.id);
        if (id)
          results.push({
            pairKey: id,
            output: block.content,
            explicitError: block.is_error === true,
            evidence: block,
          });
      }
  }
  if (event?.type === 'tool_use' && event?.part?.type === 'tool') {
    const state = event.part.state || {};
    const id =
      nonEmpty(event.part.id) ||
      nonEmpty(event.part.callID) ||
      sha256Hex(stable([event.part.tool, state.input]));
    calls.push({
      pairKey: id,
      eventId: nonEmpty(event.part.id) || nonEmpty(event.part.callID),
      tool: nonEmpty(event.part.tool) || 'unknown',
      input: state.input,
      output: state.output ?? state.error,
      completed: state.status !== 'running',
      explicitError: state.status === 'error' || state.error != null,
      timestamp: event.created_at,
      evidence: event.part,
    });
  }
  if (event?.type === 'tool_use' && event?.tool_name) {
    const id =
      nonEmpty(event.id) ||
      nonEmpty(event.call_id) ||
      sha256Hex(stable([event.tool_name, event.parameters]));
    calls.push({
      pairKey: id,
      eventId: nonEmpty(event.id) || nonEmpty(event.call_id),
      tool: event.tool_name,
      input: event.parameters,
      output: event.result ?? event.output,
      completed:
        event.result !== undefined ||
        event.output !== undefined ||
        event.status === 'completed' ||
        event.status === 'error',
      explicitError: event.status === 'error' || event.error != null,
      timestamp: event.timestamp || event.created_at,
      evidence: event,
    });
  }
  if (
    (event?.type === 'item.started' || event?.type === 'item.completed') &&
    ['command_execution', 'mcp_tool_call', 'function_call'].includes(
      event?.item?.type,
    )
  ) {
    const item = event.item;
    const id =
      nonEmpty(item.id) ||
      nonEmpty(item.call_id) ||
      sha256Hex(stable([codexTool(item), codexInput(item)]));
    const rawOutput =
      item.aggregated_output ?? item.output ?? item.result ?? item.error;
    const output =
      item.type === 'command_execution' && typeof item.exit_code === 'number'
        ? { exit_code: item.exit_code, output: rawOutput }
        : rawOutput;
    calls.push({
      pairKey: id,
      eventId: nonEmpty(item.id) || nonEmpty(item.call_id),
      tool: codexTool(item),
      input: codexInput(item),
      output,
      completed: event.type === 'item.completed',
      explicitError:
        item.status === 'failed' ||
        item.error != null ||
        (typeof item.exit_code === 'number' && item.exit_code !== 0),
      timestamp: event.timestamp || event.created_at,
      evidence: item,
    });
  }
  if (event?.type === 'tool_call' && event?.tool_call) {
    const payload = cursorPayload(event.tool_call);
    const id =
      nonEmpty(event.call_id) ||
      nonEmpty(event.id) ||
      sha256Hex(stable([payload.tool, payload.input]));
    calls.push({
      pairKey: id,
      eventId: nonEmpty(event.call_id) || nonEmpty(event.id),
      tool: payload.tool,
      input: payload.input,
      output: payload.output,
      completed: event.subtype === 'completed',
      explicitError: payload.error,
      timestamp: event.timestamp || event.created_at,
      evidence: event.tool_call,
    });
  }
  if (event?.type === 'tool_execution_start') {
    const id =
      nonEmpty(event.toolCallId) ||
      nonEmpty(event.tool_call_id) ||
      nonEmpty(event.id) ||
      sha256Hex(stable([event.toolName, event.args]));
    calls.push({
      pairKey: id,
      eventId:
        nonEmpty(event.toolCallId) ||
        nonEmpty(event.tool_call_id) ||
        nonEmpty(event.id),
      tool: nonEmpty(event.toolName) || nonEmpty(event.tool_name) || 'unknown',
      input: event.args ?? event.input,
      completed: false,
      timestamp: event.timestamp || event.created_at,
      evidence: event,
    });
  }
  if (event?.type === 'tool_execution_end') {
    const id =
      nonEmpty(event.toolCallId) ||
      nonEmpty(event.tool_call_id) ||
      nonEmpty(event.id);
    if (id)
      results.push({
        pairKey: id,
        output: event.result ?? event.output ?? event.error,
        explicitError: event.isError === true || event.error != null,
        evidence: event,
      });
  }
  if (event?.type === 'agent_end' && Array.isArray(event.messages)) {
    for (const message of event.messages)
      for (const block of Array.isArray(message?.content)
        ? message.content
        : []) {
        if (block?.type === 'toolCall' || block?.type === 'tool_use') {
          const id =
            nonEmpty(block.id) ||
            nonEmpty(block.toolCallId) ||
            sha256Hex(stable([block.name, block.arguments]));
          calls.push({
            pairKey: id,
            eventId: nonEmpty(block.id) || nonEmpty(block.toolCallId),
            tool: nonEmpty(block.name) || 'unknown',
            input: block.arguments ?? block.input,
            completed: false,
            timestamp: message.timestamp,
            evidence: block,
          });
        } else if (
          block?.type === 'toolResult' ||
          block?.type === 'tool_result'
        ) {
          const id =
            nonEmpty(block.toolCallId) ||
            nonEmpty(block.tool_use_id) ||
            nonEmpty(block.id);
          if (id)
            results.push({
              pairKey: id,
              output: block.content ?? block.result,
              explicitError: block.isError === true || block.is_error === true,
              evidence: block,
            });
        }
      }
  }
  return { calls, results };
}

const INVALID_RESULT_RE =
  /invalid (?:tool|argument|parameter|input)|unknown tool|tool (?:not found|does not exist)|missing required|malformed tool|failed to parse (?:tool )?arguments|schema validation|protocol.{0,30}(?:invalid|malformed)/i;
const MALFORMED_INPUT_RE = /parseError.{0,80}malformed tool arguments/i;
const HARNESS_RE =
  /adapter|dispatcher|dispatch unavailable|serialization|deserialization|stream parser|tool execution unavailable \(missing deps\)|protocol framing/i;
const TRANSPORT_RE =
  /timed? out|timeout|econn(?:reset|refused)|enotfound|network|service unavailable|temporarily unavailable|socket hang up|connection (?:closed|failed|refused)|503\b|502\b|504\b/i;
const COMMAND_TOOL_ALIASES = new Set([
  'bash',
  'shell',
  'command',
  'exec',
  'execute',
  'run_shell_command',
  'run_terminal',
]);

function isCommandTool(tool: string): boolean {
  return COMMAND_TOOL_ALIASES.has(tool.trim().toLowerCase());
}

export function classifyToolAttempt(
  tool: string,
  input: unknown,
  output: unknown,
  explicitError = false,
): Pick<
  ToolAttempt,
  'outcome' | 'confidence' | 'reason' | 'agentAttributable'
> {
  const inputEvidence = textOf(input);
  const outputEvidence = textOf(output);
  const record =
    output && typeof output === 'object' ? (output as Record<string, any>) : {};
  const exitCode =
    typeof record.exit_code === 'number'
      ? record.exit_code
      : typeof record.exitCode === 'number'
        ? record.exitCode
        : undefined;
  const textExitCode = textOf(output).match(
    /(?:exit(?:ed)?(?: with)? (?:status|code)|exit_code)[:= ]+(\d+)/i,
  )?.[1];
  const effectiveExitCode =
    exitCode ?? (textExitCode !== undefined ? Number(textExitCode) : undefined);
  const commandTool = isCommandTool(tool);
  const hasFailureEvidence =
    explicitError ||
    record.error != null ||
    record.failure != null ||
    record.success === false ||
    record.status === 'error' ||
    record.status === 'failed' ||
    (commandTool && effectiveExitCode !== undefined && effectiveExitCode !== 0);
  if (hasFailureEvidence && TRANSPORT_RE.test(outputEvidence))
    return {
      outcome: 'transport_failure',
      confidence: 0.9,
      reason:
        'The evidence indicates a timeout, network, or service availability failure.',
      agentAttributable: false,
    };
  if (hasFailureEvidence && HARNESS_RE.test(outputEvidence))
    return {
      outcome: 'harness_error',
      confidence: 0.88,
      reason: 'The harness adapter, dispatcher, or protocol framing failed.',
      agentAttributable: false,
    };
  if (commandTool && effectiveExitCode !== undefined) {
    if (effectiveExitCode === 0)
      return {
        outcome: 'success',
        confidence: 0.98,
        reason: 'A valid command ran and exited successfully.',
        agentAttributable: false,
      };
    return {
      outcome: 'code_failure',
      confidence: 0.98,
      reason: `A valid command ran and exited with code ${effectiveExitCode}.`,
      agentAttributable: false,
    };
  }
  if (
    !tool ||
    tool === 'unknown' ||
    MALFORMED_INPUT_RE.test(inputEvidence) ||
    (hasFailureEvidence && INVALID_RESULT_RE.test(outputEvidence))
  )
    return {
      outcome: 'invalid_invocation',
      confidence: 0.95,
      reason:
        !tool || tool === 'unknown'
          ? 'Tool name is missing or unknown.'
          : 'Invocation or parameter validation failed.',
      agentAttributable: true,
    };
  if (hasFailureEvidence)
    return {
      outcome: 'tool_execution_error',
      confidence: 0.82,
      reason:
        'A valid invocation reached the tool and failed during execution.',
      agentAttributable: false,
    };
  if (
    output !== undefined ||
    record.success === true ||
    record.exit_code === 0 ||
    record.exitCode === 0
  )
    return {
      outcome: 'success',
      confidence: 0.96,
      reason: 'The tool returned a successful completion.',
      agentAttributable: false,
    };
  return {
    outcome: 'unknown',
    confidence: 0.35,
    reason: 'No conclusive completion evidence is available.',
    agentAttributable: false,
  };
}

function initialState(): AnalyzerState {
  return { version: TOOL_QUALITY_STATE_VERSION, sources: {} };
}

function readState(statePath: string): AnalyzerState {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as any;
    if (!parsed?.sources || typeof parsed.sources !== 'object')
      return initialState();
    if (parsed.version === TOOL_QUALITY_STATE_VERSION)
      return parsed as AnalyzerState;
    const sources = Object.fromEntries(
      Object.entries(parsed.sources).map(([key, raw]) => {
        const source = (raw || {}) as Partial<SourceState>;
        return [
          key,
          {
            kind: source.kind === 'archive' ? 'archive' : 'live',
            project: source.project,
            dateHint: source.dateHint,
            fingerprint: `state-migration-${parsed.version || 'unknown'}`,
            byteOffset: source.byteOffset || 0,
            lineCount: source.lineCount || 0,
            prefixHash: `state-migration-${parsed.version || 'unknown'}`,
            attemptIds: Array.isArray(source.attemptIds)
              ? source.attemptIds
              : [],
            occurrenceCounts: source.occurrenceCounts || {},
            pending: source.pending || {},
            identity: source.identity || {
              runtimeKind: 'unknown',
              harness: 'unknown',
            },
            currentRunAttemptIds: Array.isArray(source.currentRunAttemptIds)
              ? source.currentRunAttemptIds
              : [],
          } satisfies SourceState,
        ];
      }),
    );
    return { version: TOOL_QUALITY_STATE_VERSION, sources };
  } catch {
    return initialState();
  }
}

export function readAttemptLedger(
  ledgerPath: string,
): Map<string, ToolAttempt> {
  const attempts = new Map<string, ToolAttempt>();
  let content = '';
  try {
    content = fs.readFileSync(ledgerPath, 'utf8');
  } catch {
    return attempts;
  }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as LedgerRecord;
      if (record.op === 'delete') attempts.delete(record.attemptId);
      else if (record.attempt) attempts.set(record.attemptId, record.attempt);
    } catch {
      /* retain the valid append-only prefix */
    }
  }
  return attempts;
}

function appendLedger(ledgerPath: string, records: LedgerRecord[]): void {
  if (!records.length) return;
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const fd = fs.openSync(ledgerPath, 'a+');
  try {
    const size = fs.fstatSync(fd).size;
    const lastByte = Buffer.allocUnsafe(1);
    if (size > 0 && fs.readSync(fd, lastByte, 0, 1, size - 1) !== 1) {
      throw new Error('Could not read ledger tail');
    }
    const separator = size > 0 && lastByte[0] !== 0x0a ? '\n' : '';
    fs.writeFileSync(
      fd,
      separator +
        records.map((record) => JSON.stringify(record)).join('\n') +
        '\n',
    );
  } finally {
    fs.closeSync(fd);
  }
}

function evidenceHasExplicitError(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(evidenceHasExplicitError);
  const record = value as Record<string, unknown>;
  if (
    record.is_error === true ||
    record.isError === true ||
    record.error != null ||
    record.failure != null ||
    record.status === 'error' ||
    record.status === 'failed'
  )
    return true;
  return Object.values(record).some(evidenceHasExplicitError);
}

function isDirectProducerError(output: unknown): boolean {
  return typeof output === 'string' && /^\s*Error:/.test(output);
}

function withCurrentClassification(attempt: ToolAttempt): ToolAttempt {
  if (attempt.classifierVersion === TOOL_QUALITY_CLASSIFIER_VERSION)
    return attempt;
  const explicitError =
    attempt.explicitError === true ||
    (attempt.runtimeKind === 'direct' &&
      isDirectProducerError(attempt.output)) ||
    evidenceHasExplicitError(attempt.evidence);
  return {
    ...attempt,
    explicitError,
    ...classifyToolAttempt(
      attempt.tool,
      attempt.input,
      attempt.output,
      explicitError,
    ),
    classifierVersion: TOOL_QUALITY_CLASSIFIER_VERSION,
  };
}

function reclassifyLedgerAttempts(
  attempts: Map<string, ToolAttempt>,
): LedgerRecord[] {
  const records: LedgerRecord[] = [];
  for (const [attemptId, attempt] of attempts) {
    if (attempt.classifierVersion === TOOL_QUALITY_CLASSIFIER_VERSION) continue;
    const revised = withCurrentClassification(attempt);
    records.push({
      op: 'upsert',
      recordedAt: new Date().toISOString(),
      attemptId,
      attempt: revised,
      reason: 'classifier_version_changed',
    });
    attempts.set(attemptId, revised);
  }
  return records;
}

function discoverTranscriptDirs(
  groupsDir: string,
): Array<{ dir: string; project: string }> {
  const found: Array<{ dir: string; project: string }> = [];
  function walk(dir: string, depth: number): void {
    if (depth > 5) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (path.basename(dir) === 'transcripts') {
      const relative = path.relative(groupsDir, path.dirname(dir));
      const segments = relative.split(path.sep);
      const objectiveIndex = segments.indexOf('objectives');
      const project = (
        objectiveIndex >= 0 ? segments.slice(0, objectiveIndex) : segments
      ).join('/');
      found.push({ dir, project });
      return;
    }
    for (const entry of entries)
      if (
        entry.isDirectory() &&
        !['node_modules', '.git', 'artifacts', 'logs'].includes(entry.name)
      )
        walk(path.join(dir, entry.name), depth + 1);
  }
  walk(groupsDir, 0);
  return found;
}

function archiveMembers(archivePath: string): string[] {
  try {
    return execFileSync('tar', ['-tzf', archivePath], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\n')
      .map((value) => value.trim())
      .filter((value) => value.endsWith('.jsonl'));
  } catch {
    return [];
  }
}

function sourceDateAllowed(
  fileName: string,
  statDate: Date,
  since?: string,
  until?: string,
): boolean {
  const match = fileName.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  const date = match || statDate.toISOString().slice(0, 10);
  return (!since || date >= since) && (!until || date <= until);
}

function fileSha256(filePath: string): string {
  try {
    return execFileSync('sha256sum', [filePath], { encoding: 'utf8' }).split(
      /\s+/,
    )[0];
  } catch {
    return sha256Hex(fs.readFileSync(filePath));
  }
}

function discoverSources(
  options: AnalyzerOptions,
  state: AnalyzerState,
): SourceInput[] {
  const sources: SourceInput[] = [];
  const projects = new Set(options.projects || []);
  for (const item of discoverTranscriptDirs(options.groupsDir)) {
    if (
      projects.size &&
      !projects.has(item.project) &&
      !projects.has(item.project.split('/').at(-1)!)
    )
      continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(item.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const filePath = path.join(item.dir, entry.name);
        const stat = fs.statSync(filePath);
        if (
          !sourceDateAllowed(
            entry.name,
            stat.mtime,
            options.since,
            options.until,
          )
        )
          continue;
        sources.push({
          key: `live:${filePath}`,
          displayPath: filePath,
          project: item.project,
          kind: 'live',
          dateHint:
            entry.name.match(/\d{4}-\d{2}-\d{2}/)?.[0] ||
            stat.mtime.toISOString().slice(0, 10),
          content: fs.readFileSync(filePath),
        });
      }
    }
    if (options.archives === false) continue;
    const archiveDir = path.join(item.dir, 'archive');
    let archives: string[];
    try {
      archives = fs
        .readdirSync(archiveDir)
        .filter((name) => name.endsWith('.tar.gz'))
        .sort();
    } catch {
      continue;
    }
    for (const archiveName of archives) {
      const archivePath = path.join(archiveDir, archiveName);
      // Agent-writable: skip a symlinked bundle (or symlinked archive/) so
      // another project's archive is never read into this project's analysis.
      if (!isRegularFileInside(item.dir, archivePath)) continue;
      const stat = fs.statSync(archivePath);
      if (
        !sourceDateAllowed(
          archiveName,
          stat.mtime,
          options.since,
          options.until,
        )
      )
        continue;
      const fingerprint = fileSha256(archivePath);
      for (const member of archiveMembers(archivePath)) {
        const key = `archive:${archivePath}:${member}`;
        let content: Buffer;
        if (state.sources[key]?.fingerprint === fingerprint) {
          content = Buffer.alloc(0);
        } else {
          try {
            content = execFileSync('tar', ['-xzf', archivePath, '-O', member], {
              maxBuffer: 512 * 1024 * 1024,
            });
          } catch {
            continue;
          }
        }
        sources.push({
          key,
          displayPath: archivePath,
          member,
          project: item.project,
          kind: 'archive',
          fingerprint,
          dateHint:
            member.match(/\d{4}-\d{2}-\d{2}/)?.[0] ||
            archiveName.match(/\d{4}-\d{2}-\d{2}/)?.[0] ||
            stat.mtime.toISOString().slice(0, 10),
          content,
        });
      }
    }
  }
  return sources.sort((a, b) => a.key.localeCompare(b.key));
}

function conversationFromSource(source: SourceInput): string {
  const base = path
    .basename(source.member || source.displayPath)
    .replace(/\.output\.jsonl$|\.jsonl$/g, '');
  return base.replace(/^\d{4}-\d{2}-\d{2}-(?:chat|task)-/, '');
}

function attemptFromCall(
  source: SourceInput,
  identity: Identity,
  call: CallEvent,
  line: number,
  byteOffset: number,
  occurrenceCounts: Record<string, number>,
): ToolAttempt {
  const conversationId = conversationFromSource(source);
  const occurrenceBase = sha256Hex(
    stable([conversationId, identity.harness, call.tool, call.input]),
  );
  const occurrence = call.eventId
    ? 0
    : (occurrenceCounts[occurrenceBase] =
        (occurrenceCounts[occurrenceBase] || 0) + 1);
  const eventIdentity = call.eventId
    ? `${conversationId}:${identity.runId || ''}:${identity.harness}:${call.eventId}`
    : `${occurrenceBase}:${occurrence}`;
  const attemptId = sha256Hex(eventIdentity);
  const classification = classifyToolAttempt(
    call.tool,
    call.input,
    call.completed ? call.output : undefined,
    call.explicitError,
  );
  const sourceLocation = {
    path: source.displayPath,
    member: source.member,
    line,
    byteOffset,
  };
  return {
    attemptId,
    eventIdentity,
    conversationId,
    runId: identity.runId,
    timestamp: call.timestamp || identity.timestamp || source.dateHint,
    timestampSource: call.timestamp
      ? 'event'
      : identity.timestamp
        ? 'run'
        : 'source',
    runtimeKind: identity.runtimeKind,
    harness: identity.harness,
    configuredModel: identity.configuredModel,
    reportedModel: identity.reportedModel,
    tool: call.tool,
    input: call.input,
    output: call.completed ? call.output : undefined,
    explicitError: call.explicitError,
    ...classification,
    classifierVersion: TOOL_QUALITY_CLASSIFIER_VERSION,
    source: sourceLocation,
    sources: [sourceLocation],
    evidence: call.evidence,
  };
}

function sameAttempt(a: ToolAttempt | undefined, b: ToolAttempt): boolean {
  return !!a && stable(a) === stable(b);
}

function locationSourceKey(location: ToolAttempt['source']): string {
  return location.member
    ? `archive:${location.path}:${location.member}`
    : `live:${location.path}`;
}

function attemptSourceLocations(attempt: ToolAttempt): ToolAttempt['source'][] {
  const locations = attempt.sources?.length
    ? attempt.sources
    : [attempt.source];
  return locations.filter(
    (location, index) =>
      locations.findIndex(
        (candidate) =>
          locationSourceKey(candidate) === locationSourceKey(location),
      ) === index,
  );
}

function mergeAttemptSources(
  existing: ToolAttempt | undefined,
  next: ToolAttempt,
): ToolAttempt {
  if (!existing) return next;
  const locations = attemptSourceLocations(existing);
  for (const location of attemptSourceLocations(next)) {
    const existingIndex = locations.findIndex(
      (candidate) =>
        locationSourceKey(candidate) === locationSourceKey(location),
    );
    if (existingIndex === -1) {
      locations.push(location);
    } else {
      locations[existingIndex] = location;
    }
  }
  return { ...next, source: locations[0], sources: locations };
}

function removeAttemptSources(
  attempt: ToolAttempt,
  sourceKeys: Set<string>,
): ToolAttempt | null {
  const locations = attemptSourceLocations(attempt).filter(
    (location) => !sourceKeys.has(locationSourceKey(location)),
  );
  return locations.length
    ? { ...attempt, source: locations[0], sources: locations }
    : null;
}

function isRunBoundary(event: any): boolean {
  if (event?.entry_type === 'run_start') return true;
  if (
    event?.type === 'turn.started' ||
    event?.type === 'step_start' ||
    event?.type === 'agent_start' ||
    event?.type === 'turn_start' ||
    (event?.type === 'system' && event?.subtype === 'init') ||
    event?.type === 'init'
  )
    return true;
  if (event?.type !== 'user') return false;
  const content = event?.message?.content;
  return !(
    Array.isArray(content) &&
    content.some((block: any) => block?.type === 'tool_result')
  );
}

function processSource(
  source: SourceInput,
  prior: SourceState | undefined,
  attempts: Map<string, ToolAttempt>,
  allState: AnalyzerState,
): {
  state: SourceState;
  records: LedgerRecord[];
  lines: number;
  changed: boolean;
} {
  let resume = false;
  if (
    prior &&
    source.kind === 'live' &&
    source.content.length >= prior.byteOffset
  ) {
    resume =
      sha256Hex(source.content.subarray(0, prior.byteOffset)) ===
      prior.prefixHash;
  } else if (prior && source.kind === 'archive') {
    resume = prior.fingerprint === source.fingerprint;
  }
  if (
    resume &&
    (source.kind === 'archive' || source.content.length === prior!.byteOffset)
  )
    return { state: prior!, records: [], lines: 0, changed: false };

  const start = resume ? prior!.byteOffset : 0;
  const lastNewline = source.content.lastIndexOf(10);
  const end = lastNewline < start ? start : lastNewline + 1;
  const chunk = source.content.subarray(start, end).toString('utf8');
  const occurrenceCounts = resume ? { ...prior!.occurrenceCounts } : {};
  const pending: Record<string, PendingCall> = resume
    ? structuredClone(prior!.pending)
    : {};
  const attemptIds = new Set(resume ? prior!.attemptIds : []);
  let currentRunAttemptIds = new Set(resume ? prior!.currentRunAttemptIds : []);
  const seenThisScan = new Set<string>();
  const records: LedgerRecord[] = [];
  let identity: Identity = resume
    ? structuredClone(prior!.identity)
    : { runtimeKind: 'unknown', harness: 'unknown' };
  let offset = start;
  let lineNo = resume ? prior!.lineCount : 0;

  for (const rawLine of chunk.split('\n')) {
    if (!rawLine && offset === end) break;
    lineNo++;
    const lineOffset = offset;
    offset += Buffer.byteLength(rawLine) + 1;
    let event: any;
    try {
      event = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (isRunBoundary(event)) {
      currentRunAttemptIds = new Set();
      identity =
        event?.entry_type === 'run_start'
          ? { runtimeKind: 'unknown', harness: 'unknown' }
          : { ...identity, timestamp: undefined };
    }
    identity = updateIdentity(event, identity);
    for (const attemptId of currentRunAttemptIds) {
      const existing = attempts.get(attemptId);
      if (!existing || existing.harness !== identity.harness) continue;
      const revised: ToolAttempt = {
        ...existing,
        configuredModel: existing.configuredModel || identity.configuredModel,
        reportedModel: existing.reportedModel || identity.reportedModel,
        timestamp:
          existing.timestampSource === 'source' && identity.timestamp
            ? identity.timestamp
            : existing.timestamp,
        timestampSource:
          existing.timestampSource === 'source' && identity.timestamp
            ? 'run'
            : existing.timestampSource,
      };
      if (!sameAttempt(existing, revised)) {
        records.push({
          op: 'upsert',
          recordedAt: new Date().toISOString(),
          attemptId,
          attempt: revised,
        });
        attempts.set(attemptId, revised);
        for (const waiting of Object.values(pending))
          if (waiting.attempt.attemptId === attemptId)
            waiting.attempt = revised;
      }
    }
    const extracted = extractEvents(event);
    if (identity.runtimeKind === 'direct')
      for (const call of extracted.calls)
        if (call.completed && isDirectProducerError(call.output))
          call.explicitError = true;
    for (const call of extracted.calls) {
      const waiting = call.completed ? pending[call.pairKey] : undefined;
      if (waiting) {
        const classification = classifyToolAttempt(
          waiting.attempt.tool,
          waiting.attempt.input,
          call.output,
          call.explicitError,
        );
        const revised: ToolAttempt = {
          ...waiting.attempt,
          output: call.output,
          explicitError: call.explicitError,
          ...classification,
          classifierVersion: TOOL_QUALITY_CLASSIFIER_VERSION,
          evidence: { call: waiting.attempt.evidence, result: call.evidence },
        };
        attemptIds.add(revised.attemptId);
        currentRunAttemptIds.add(revised.attemptId);
        seenThisScan.add(revised.attemptId);
        if (!sameAttempt(attempts.get(revised.attemptId), revised)) {
          records.push({
            op: 'upsert',
            recordedAt: new Date().toISOString(),
            attemptId: revised.attemptId,
            attempt: revised,
          });
          attempts.set(revised.attemptId, revised);
        }
        delete pending[call.pairKey];
        continue;
      }
      let attempt = attemptFromCall(
        source,
        identity,
        call,
        lineNo,
        lineOffset,
        occurrenceCounts,
      );
      attempt = mergeAttemptSources(attempts.get(attempt.attemptId), attempt);
      attemptIds.add(attempt.attemptId);
      currentRunAttemptIds.add(attempt.attemptId);
      seenThisScan.add(attempt.attemptId);
      if (!sameAttempt(attempts.get(attempt.attemptId), attempt)) {
        const record: LedgerRecord = {
          op: 'upsert',
          recordedAt: new Date().toISOString(),
          attemptId: attempt.attemptId,
          attempt,
        };
        records.push(record);
        attempts.set(attempt.attemptId, attempt);
      }
      if (!call.completed)
        pending[call.pairKey] = { attempt, pairKey: call.pairKey };
      else delete pending[call.pairKey];
    }
    for (const result of extracted.results) {
      const waiting = pending[result.pairKey];
      if (!waiting) continue;
      const classification = classifyToolAttempt(
        waiting.attempt.tool,
        waiting.attempt.input,
        result.output,
        result.explicitError,
      );
      const revised: ToolAttempt = {
        ...waiting.attempt,
        output: result.output,
        explicitError: result.explicitError,
        ...classification,
        classifierVersion: TOOL_QUALITY_CLASSIFIER_VERSION,
        evidence: { call: waiting.attempt.evidence, result: result.evidence },
      };
      if (!sameAttempt(attempts.get(revised.attemptId), revised)) {
        records.push({
          op: 'upsert',
          recordedAt: new Date().toISOString(),
          attemptId: revised.attemptId,
          attempt: revised,
        });
        attempts.set(revised.attemptId, revised);
      }
      seenThisScan.add(revised.attemptId);
      currentRunAttemptIds.add(revised.attemptId);
      delete pending[result.pairKey];
    }
  }

  if (!resume && prior) {
    const currentOtherOwners = new Set(
      Object.entries(allState.sources)
        .filter(([key]) => key !== source.key)
        .flatMap(([, value]) => value.attemptIds),
    );
    for (const oldId of prior.attemptIds) {
      if (seenThisScan.has(oldId)) continue;
      const existing = attempts.get(oldId);
      if (currentOtherOwners.has(oldId) && existing) {
        const repaired = removeAttemptSources(existing, new Set([source.key]));
        if (repaired && !sameAttempt(existing, repaired)) {
          records.push({
            op: 'upsert',
            recordedAt: new Date().toISOString(),
            attemptId: oldId,
            attempt: repaired,
            reason: 'source_rewritten_repointed',
          });
          attempts.set(oldId, repaired);
        }
      } else if (existing) {
        records.push({
          op: 'delete',
          recordedAt: new Date().toISOString(),
          attemptId: oldId,
          reason: 'source_rewritten',
        });
        attempts.delete(oldId);
      }
    }
  }
  return {
    state: {
      kind: source.kind,
      project: source.project,
      dateHint: source.dateHint,
      fingerprint: source.fingerprint,
      byteOffset: end,
      lineCount: lineNo,
      prefixHash: sha256Hex(source.content.subarray(0, end)),
      attemptIds: [...attemptIds],
      occurrenceCounts,
      pending,
      identity,
      currentRunAttemptIds: [...currentRunAttemptIds],
    },
    records,
    lines: lineNo - (resume ? prior!.lineCount : 0),
    changed: true,
  };
}

interface Aggregate {
  totalAttempts: number;
  successes: number;
  agentFaults: number;
  codeFailures: number;
  infrastructureFailures: number;
  unknown: number;
  toolExecutionFailures: number;
  successRate: number;
  agentFaultRate: number;
  codeFailureRate: number;
  infrastructureFailureRate: number;
  toolExecutionFailureRate: number;
  unknownRate: number;
  outcomes: Record<ToolOutcome, number>;
}

const TOOL_OUTCOMES = [
  'success',
  'invalid_invocation',
  'harness_error',
  'tool_execution_error',
  'code_failure',
  'transport_failure',
  'unknown',
] satisfies ToolOutcome[];

function aggregate(attempts: ToolAttempt[]): Aggregate {
  const totalAttempts = attempts.length;
  const outcomes = Object.fromEntries(
    TOOL_OUTCOMES.map((outcome) => [outcome, 0]),
  ) as Record<ToolOutcome, number>;
  let agentFaults = 0;
  for (const attempt of attempts) {
    if (Object.hasOwn(outcomes, attempt.outcome)) outcomes[attempt.outcome]++;
    if (attempt.agentAttributable) agentFaults++;
  }
  const successes = outcomes.success;
  const codeFailures = outcomes.code_failure;
  const infrastructureFailures =
    outcomes.transport_failure + outcomes.harness_error;
  const toolExecutionFailures = outcomes.tool_execution_error;
  const unknown = outcomes.unknown;
  const rate = (count: number) => (totalAttempts ? count / totalAttempts : 0);
  return {
    totalAttempts,
    successes,
    agentFaults,
    codeFailures,
    infrastructureFailures,
    toolExecutionFailures,
    unknown,
    successRate: rate(successes),
    agentFaultRate: rate(agentFaults),
    codeFailureRate: rate(codeFailures),
    infrastructureFailureRate: rate(infrastructureFailures),
    toolExecutionFailureRate: rate(toolExecutionFailures),
    unknownRate: rate(unknown),
    outcomes,
  };
}

function grouped(
  attempts: ToolAttempt[],
  key: (attempt: ToolAttempt) => string,
): Record<string, Aggregate> {
  const groups = new Map<string, ToolAttempt[]>();
  for (const attempt of attempts) {
    const name = key(attempt);
    const values = groups.get(name);
    if (values) values.push(attempt);
    else groups.set(name, [attempt]);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, values]) => [name, aggregate(values)]),
  );
}

export function buildToolQualityReport(
  attemptMap: Map<string, ToolAttempt>,
): Record<string, unknown> {
  const attempts = [...attemptMap.values()].map(withCurrentClassification);
  return {
    generatedAt: new Date().toISOString(),
    classifierVersion: TOOL_QUALITY_CLASSIFIER_VERSION,
    overall: aggregate(attempts),
    byHarness: grouped(attempts, (item) => item.harness),
    byModel: grouped(
      attempts,
      (item) =>
        item.configuredModel ||
        item.reportedModel ||
        `${item.harness}:model-unavailable`,
    ),
    byConfiguredModel: grouped(
      attempts,
      (item) =>
        item.configuredModel || `${item.harness}:configured-model-unavailable`,
    ),
    byReportedModel: grouped(
      attempts,
      (item) =>
        item.reportedModel || `${item.harness}:reported-model-unavailable`,
    ),
    byHarnessModel: grouped(
      attempts,
      (item) =>
        `${item.harness}/${item.configuredModel || item.reportedModel || 'model-unavailable'}`,
    ),
    byTool: grouped(attempts, (item) => item.tool),
    byDay: grouped(
      attempts,
      (item) => item.timestamp?.slice(0, 10) || 'date-unavailable',
    ),
  };
}

function writeReports(
  reportDir: string,
  attempts: Map<string, ToolAttempt>,
): void {
  fs.mkdirSync(reportDir, { recursive: true });
  const report = buildToolQualityReport(attempts);
  fs.writeFileSync(
    path.join(reportDir, 'summary.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  const overall = report.overall as Aggregate;
  const markdown = `# Tool-call quality report\n\nGenerated: ${report.generatedAt}\n\n| Attempts | Successes | Agent faults | Code failures | Infrastructure failures | Unknown |\n| ---: | ---: | ---: | ---: | ---: | ---: |\n| ${overall.totalAttempts} | ${overall.successes} | ${overall.agentFaults} | ${overall.codeFailures} | ${overall.infrastructureFailures} | ${overall.unknown} |\n\nThe machine-readable report contains harness, model, harness/model, tool, and daily aggregates. Inspect the append-only ledger for source evidence and classification reasons.\n`;
  fs.writeFileSync(path.join(reportDir, 'summary.md'), markdown);
}

export function runToolQualityAnalyzer(
  options: AnalyzerOptions,
): AnalyzerRunResult {
  const state = readState(options.statePath);
  const attempts = readAttemptLedger(options.ledgerPath);
  const reclassificationRecords = reclassifyLedgerAttempts(attempts);
  appendLedger(options.ledgerPath, reclassificationRecords);
  const previousSourceKeys = new Set(Object.keys(state.sources));
  const sources = discoverSources(options, state);
  const discoveredSourceKeys = new Set(sources.map((source) => source.key));
  let sourcesChanged = 0;
  let linesProcessed = 0;
  let ledgerRecordsAdded = reclassificationRecords.length;
  for (const source of sources) {
    const result = processSource(
      source,
      state.sources[source.key],
      attempts,
      state,
    );
    state.sources[source.key] = result.state;
    if (result.changed) sourcesChanged++;
    linesProcessed += result.lines;
    ledgerRecordsAdded += result.records.length;
    appendLedger(options.ledgerPath, result.records);
  }
  const projectFilter = new Set(options.projects || []);
  const sourceIsInScope = (source: SourceState): boolean => {
    if (source.kind === 'archive' && options.archives === false) return false;
    if (projectFilter.size) {
      if (!source.project) return false;
      if (
        !projectFilter.has(source.project) &&
        !projectFilter.has(source.project.split('/').at(-1)!)
      )
        return false;
    }
    if (options.since || options.until) {
      if (!source.dateHint) return false;
      if (options.since && source.dateHint < options.since) return false;
      if (options.until && source.dateHint > options.until) return false;
    }
    return true;
  };
  const removedSourceKeys = [...previousSourceKeys].filter(
    (key) =>
      !discoveredSourceKeys.has(key) && sourceIsInScope(state.sources[key]),
  );
  if (removedSourceKeys.length) {
    const removed = new Set(removedSourceKeys);
    const survivingOwners = new Set(
      Object.entries(state.sources)
        .filter(([key]) => !removed.has(key))
        .flatMap(([, source]) => source.attemptIds),
    );
    const removalRecords: LedgerRecord[] = [];
    const affectedAttemptIds = new Set(
      removedSourceKeys.flatMap((key) => state.sources[key].attemptIds),
    );
    for (const attemptId of affectedAttemptIds) {
      const existing = attempts.get(attemptId);
      if (!existing) continue;
      if (survivingOwners.has(attemptId)) {
        const repaired = removeAttemptSources(existing, removed);
        if (repaired && !sameAttempt(existing, repaired)) {
          attempts.set(attemptId, repaired);
          removalRecords.push({
            op: 'upsert',
            recordedAt: new Date().toISOString(),
            attemptId,
            attempt: repaired,
            reason: 'source_removed_repointed',
          });
        }
      } else {
        attempts.delete(attemptId);
        removalRecords.push({
          op: 'delete',
          recordedAt: new Date().toISOString(),
          attemptId,
          reason: 'source_removed',
        });
      }
    }
    for (const key of removedSourceKeys) {
      delete state.sources[key];
    }
    appendLedger(options.ledgerPath, removalRecords);
    ledgerRecordsAdded += removalRecords.length;
  }
  fs.mkdirSync(path.dirname(options.statePath), { recursive: true });
  fs.writeFileSync(options.statePath, JSON.stringify(state, null, 2) + '\n');
  writeReports(options.reportDir, attempts);
  return {
    sourcesVisited: sources.length,
    sourcesChanged,
    linesProcessed,
    ledgerRecordsAdded,
    activeAttempts: attempts.size,
  };
}
