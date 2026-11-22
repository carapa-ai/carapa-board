import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { type PinnedDir, readGroupFileSync } from '../../lib/group-fs.js';
import {
  existsIpcEntrySync,
  ipcRoot,
  openIpcDirOrNullSync,
  readIpcTextSync,
} from '../../lib/ipc-fs.js';
import { isPathInside } from '../../lib/path-containment.js';
import { isRecord } from '../../lib/type-guards.js';
import { logger } from '../../logger.js';
import type { ChunkData } from '../../stream/parsers.js';
import { formatToolResult, formatToolUse } from '../../stream/agent-display.js';
import { ingestTranscriptSpoolSync } from './transcript-append-service.js';

const TERMINAL_RUN_STATUSES = ['completed', 'interrupted', 'failed'] as const;

const errorSchema = z
  .object({
    message: z.string(),
    code: z.string().optional(),
    details: z.unknown().optional(),
  })
  .strict();

const eventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('session'),
      id: z.string().min(1),
      status: z.enum(['started', 'resumed']),
    })
    .strict(),
  z
    .object({
      type: z.literal('run'),
      status: z.enum(['started', 'in_progress', ...TERMINAL_RUN_STATUSES]),
      model: z.string().optional(),
      reasoningEffort: z.string().optional(),
      mode: z.string().optional(),
      stopReason: z.string().optional(),
      error: errorSchema.optional(),
      metrics: z
        .object({
          durationMs: z.number().optional(),
          timeToFirstOutputMs: z.number().optional(),
          costUsd: z.number().optional(),
          contextSize: z.number().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('message_delta'),
      id: z.string().min(1),
      role: z.enum(['assistant', 'system']),
      delta: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('message'),
      id: z.string().min(1),
      role: z.enum(['user', 'assistant', 'system']),
      content: z.string(),
      format: z.enum(['markdown', 'text']).optional(),
      status: z.enum(['completed', 'interrupted']),
    })
    .strict(),
  z
    .object({
      type: z.literal('thought_delta'),
      id: z.string().min(1),
      delta: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('thought'),
      id: z.string().min(1),
      content: z.string(),
      format: z.enum(['markdown', 'text']).optional(),
      status: z.enum(['completed', 'interrupted']),
    })
    .strict(),
  z
    .object({
      type: z.literal('tool_call'),
      id: z.string().min(1),
      status: z.enum(['started', 'in_progress', 'completed', 'failed']),
      name: z.string().optional(),
      category: z
        .enum(['execute', 'read', 'edit', 'search', 'mcp', 'other'])
        .optional(),
      input: z.unknown().optional(),
      outputDelta: z.unknown().optional(),
      output: z.unknown().optional(),
      exitCode: z.number().nullable().optional(),
      error: errorSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('interaction'),
      id: z.string().min(1),
      status: z.enum(['requested', 'answered', 'cancelled']),
      questions: z
        .array(
          z
            .object({
              id: z.string(),
              header: z.string(),
              question: z.string(),
              options: z
                .array(
                  z
                    .object({
                      label: z.string(),
                      description: z.string(),
                      preview: z.string().optional(),
                    })
                    .strict(),
                )
                .optional(),
              allowOther: z.boolean().optional(),
              secret: z.boolean().optional(),
              multiSelect: z.boolean().optional(),
            })
            .strict(),
        )
        .optional(),
      answers: z.record(z.string(), z.array(z.string())).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('plan'),
      id: z.string().min(1),
      entries: z.array(
        z
          .object({
            id: z.string(),
            content: z.string(),
            status: z.enum(['pending', 'in_progress', 'completed']),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      type: z.literal('usage'),
      scope: z.enum(['incremental', 'cumulative']),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      cachedInputTokens: z.number().int().nonnegative().optional(),
      cacheWriteInputTokens: z.number().int().nonnegative().optional(),
      reasoningOutputTokens: z.number().int().nonnegative().optional(),
      cacheTtlSeconds: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('background_tasks'),
      tasks: z.array(
        z
          .object({
            id: z.string().min(1),
            description: z.string(),
            startedAt: z.number().optional(),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      type: z.literal('error'),
      message: z.string(),
      fatal: z.boolean(),
      code: z.string().optional(),
      details: z.unknown().optional(),
    })
    .strict(),
]);

const manifestSchema = z
  .object({
    format: z.literal('carapa-run'),
    version: z.literal(1),
    harness: z.string().min(1),
    requestedModel: z.string().nullable(),
  })
  .strict();

export type CarapaRunV1Event = z.infer<typeof eventSchema>;
export type CarapaRunV1Manifest = z.infer<typeof manifestSchema>;
type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

function isTerminalRunStatus(status: string): status is TerminalRunStatus {
  return TERMINAL_RUN_STATUSES.some((candidate) => candidate === status);
}

export interface CarapaRunV1Document {
  manifest: CarapaRunV1Manifest;
  events: CarapaRunV1Event[];
}

export interface CarapaRunV1Summary {
  result: string | null;
  hasAssistantText: boolean;
  agentSuccess?: boolean;
  agentTerminalFailure?: boolean;
  session_id?: string;
  uuid?: string;
  total_tokens?: number;
  tok_output?: number;
  tok_input?: number;
  tok_cache_write?: number;
  tok_cache_read?: number;
  tok_context_last?: number;
  tok_reasoning?: number;
  model_name?: string;
  usageSource?: 'reported';
  rawUsage?: Record<string, number>;
  /** Prompt-cache lifetime the provider applied to this run's last cache write. */
  cache_ttl_s?: number;
  tool_usage_count?: number;
}

export interface CarapaRunV1StreamState {
  accumulatedMessages: Map<string, string>;
  identityPrefix: string;
  terminal: boolean;
  sessionEmitted: boolean;
  toolNames: Map<string, string>;
}

export function createCarapaRunV1StreamState(
  identityPrefix = '',
): CarapaRunV1StreamState {
  return {
    accumulatedMessages: new Map(),
    identityPrefix,
    terminal: false,
    sessionEmitted: false,
    toolNames: new Map(),
  };
}

export function carapaRunV1Paths(runDir: string): {
  events: string;
  manifest: string;
} {
  return {
    events: path.join(runDir, 'output.v1.jsonl'),
    manifest: path.join(runDir, 'output.v1.meta.json'),
  };
}

export function archivedCarapaRunV1Paths(
  transcriptDir: string,
  runId: string,
): { events: string; manifest: string } {
  return {
    events: path.join(transcriptDir, `${runId}.v1.jsonl`),
    manifest: path.join(transcriptDir, `${runId}.v1.meta.json`),
  };
}

export function parseCarapaRunV1Manifest(
  content: string,
  expectedHarness?: string,
): CarapaRunV1Manifest {
  const parsed = manifestSchema.parse(JSON.parse(content));
  if (expectedHarness && parsed.harness !== expectedHarness) {
    throw new Error(
      `V1 transcript harness is ${parsed.harness}; expected ${expectedHarness}`,
    );
  }
  return parsed;
}

export function parseCarapaRunV1Event(line: string): CarapaRunV1Event {
  return eventSchema.parse(JSON.parse(line));
}

/**
 * Valid events of a Run V1 event text. The text may be the tail of a larger
 * spool, so a partial first line and any invalid line are skipped, not thrown.
 */
export function parseCarapaRunV1EventText(text: string): CarapaRunV1Event[] {
  const events: CarapaRunV1Event[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(parseCarapaRunV1Event(line));
    } catch {
      // Truncated tail line or an event outside the schema.
    }
  }
  return events;
}

/** The last terminal `run` event, or undefined when there is none. */
export function lastCarapaRunV1TerminalEvent(
  events: readonly CarapaRunV1Event[],
): Extract<CarapaRunV1Event, { type: 'run' }> | undefined {
  return events
    .filter(
      (event): event is Extract<CarapaRunV1Event, { type: 'run' }> =>
        event.type === 'run' && isTerminalRunStatus(event.status),
    )
    .at(-1);
}

function validateLifecycle(
  events: readonly CarapaRunV1Event[],
  requireTerminal: boolean,
): void {
  let started = false;
  let terminal = false;
  for (const [index, event] of events.entries()) {
    if (terminal) {
      throw new Error(
        `V1 transcript has an event after terminal event at line ${index + 1}`,
      );
    }
    if (event.type !== 'run') continue;
    if (event.status === 'started') {
      if (started)
        throw new Error('V1 transcript contains multiple run start events');
      started = true;
    }
    if (isTerminalRunStatus(event.status)) {
      terminal = true;
    }
  }
  if (!started) throw new Error('V1 transcript is missing its run start event');
  if (requireTerminal && !terminal) {
    throw new Error('V1 transcript is missing its terminal run event');
  }
}

/** Largest V1 events/manifest file served from an agent-writable tree. */
const MAX_CONTAINED_BYTES = 64 * 1024 * 1024;

/**
 * Append flags that never follow a leaf link and fail on a FIFO without a
 * reader instead of blocking.
 */
const APPEND_FLAGS =
  fs.constants.O_WRONLY |
  fs.constants.O_APPEND |
  fs.constants.O_CREAT |
  fs.constants.O_NOFOLLOW |
  fs.constants.O_NONBLOCK;

/**
 * Text of `file` inside `groupDir`; null when missing. The file is read through
 * a pinned, O_NOFOLLOW | O_NONBLOCK descriptor and must be a regular file, so
 * a planted link, directory swap or FIFO is refused (GroupFsError) instead of
 * followed or blocked on.
 */
function readContainedFileOrNull(
  groupDir: string,
  file: string,
): string | null {
  if (!isPathInside(groupDir, file)) {
    throw new Error('Path escapes base directory');
  }
  const read = readGroupFileSync(file, { maxBytes: MAX_CONTAINED_BYTES });
  return read ? read.data.toString('utf8') : null;
}

function readOptionalText(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

/**
 * The sandbox IPC run directory holding both files of `paths`; null for any
 * other location. The agent writes that directory, so its files are only used
 * through a pinned descriptor.
 */
function ipcRunDirOf(paths: { events: string; manifest: string }) {
  const dir = path.dirname(paths.events);
  return path.dirname(paths.manifest) === dir &&
    isPathInside(ipcRoot(), dir, { allowRoot: false })
    ? dir
    : null;
}

/**
 * The pair read through the pinned `dir`. A file that exists but cannot be read
 * (link, FIFO, hard link, oversized) makes the whole pair unreadable (null);
 * ipc-fs logs it.
 */
function readPinnedPair(
  dir: PinnedDir,
  paths: { events: string; manifest: string },
  options: { expectedHarness?: string; requireTerminal?: boolean },
): CarapaRunV1Document | null {
  let refused = false;
  const read = (file: string) => {
    const name = path.basename(file);
    const text = readIpcTextSync(dir, name, MAX_CONTAINED_BYTES, {
      rejectHardLinks: true,
    });
    if (text === null && existsIpcEntrySync(dir, name)) refused = true;
    return text;
  };
  const texts = { events: read(paths.events), manifest: read(paths.manifest) };
  return refused
    ? null
    : parsePair(texts, options.expectedHarness, options.requireTerminal);
}

/**
 * `containedIn` (a group directory) confines both files to that directory
 * without following links; use it for agent-writable trees served to viewers.
 * A pair in a sandbox IPC run dir is always read pinned, and reads as null
 * when a file there is not a plain regular file.
 */
export function readCarapaRunV1Pair(
  paths: { events: string; manifest: string },
  options: {
    expectedHarness?: string;
    requireTerminal?: boolean;
    containedIn?: string;
  } = {},
): CarapaRunV1Document | null {
  const { containedIn } = options;
  const ipcDir = containedIn ? null : ipcRunDirOf(paths);
  if (ipcDir) {
    const dir = openIpcDirOrNullSync(ipcDir);
    if (!dir) return null;
    try {
      return readPinnedPair(dir, paths, options);
    } finally {
      dir.closeSync();
    }
  }
  const read = (file: string) =>
    containedIn
      ? readContainedFileOrNull(containedIn, file)
      : readOptionalText(file);
  return parsePair(
    { events: read(paths.events), manifest: read(paths.manifest) },
    options.expectedHarness,
    options.requireTerminal,
  );
}

/**
 * Build a document for {@link summarizeCarapaRunV1} from event lines fed one at
 * a time, so a spool of any size is validated with bounded memory. The
 * document keeps only what the summary reads: stream deltas, tool
 * input/output, plans, question text and every assistant message but the last
 * are dropped. It must not be used to project or replay the transcript.
 * `finish` throws on a malformed or non-terminal pair, like `parsePair`.
 */
export function createCarapaRunV1SummaryCollector(
  manifestText: string,
  options: { expectedHarness?: string; requireTerminal?: boolean } = {},
): { push(line: string): void; finish(): CarapaRunV1Document } {
  const events: CarapaRunV1Event[] = [];
  let lastAssistant: CarapaRunV1Event | undefined;
  let lines = 0;
  let seen = 0;
  let started = false;
  let terminal = false;
  return {
    push(line) {
      if (!line.trim()) return;
      lines++;
      let event: CarapaRunV1Event;
      try {
        event = parseCarapaRunV1Event(line);
      } catch (error) {
        throw new Error(
          `Invalid V1 transcript event at line ${lines}: ${String(error)}`,
        );
      }
      seen++;
      if (terminal) {
        throw new Error(
          `V1 transcript has an event after terminal event at line ${seen}`,
        );
      }
      if (event.type === 'run') {
        if (event.status === 'started') {
          if (started)
            throw new Error('V1 transcript contains multiple run start events');
          started = true;
        }
        if (isTerminalRunStatus(event.status)) terminal = true;
      }
      if (event.type === 'message') {
        if (event.role === 'assistant') lastAssistant = event;
      } else if (event.type === 'tool_call') {
        events.push({ type: 'tool_call', id: event.id, status: event.status });
      } else if (event.type === 'interaction') {
        events.push({
          type: 'interaction',
          id: event.id,
          status: event.status,
        });
      } else if (event.type !== 'message_delta' && event.type !== 'plan') {
        events.push(event);
      }
    },
    finish() {
      const manifest = parseCarapaRunV1Manifest(
        manifestText,
        options.expectedHarness,
      );
      if (!started)
        throw new Error('V1 transcript is missing its run start event');
      if ((options.requireTerminal ?? true) && !terminal) {
        throw new Error('V1 transcript is missing its terminal run event');
      }
      return {
        manifest,
        events: lastAssistant ? [...events, lastAssistant] : events,
      };
    },
  };
}

function parsePair(
  texts: { events: string | null; manifest: string | null },
  expectedHarness: string | undefined,
  requireTerminal: boolean | undefined,
): CarapaRunV1Document | null {
  const hasEvents = texts.events !== null;
  const hasManifest = texts.manifest !== null;
  if (!hasEvents && !hasManifest) return null;
  if (texts.events === null || texts.manifest === null) {
    throw new Error(
      `Incomplete V1 transcript pair: events=${hasEvents}, manifest=${hasManifest}`,
    );
  }
  const manifest = parseCarapaRunV1Manifest(texts.manifest, expectedHarness);
  const events = texts.events
    .split('\n')
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return parseCarapaRunV1Event(line);
      } catch (error) {
        throw new Error(
          `Invalid V1 transcript event at line ${index + 1}: ${String(error)}`,
        );
      }
    });
  validateLifecycle(events, requireTerminal ?? true);
  return { manifest, events };
}

/**
 * A sandbox stop can terminate the provider after it has written assistant
 * deltas but before it writes its terminal run event. Make that partial run
 * replayable instead of discarding the already-streamed response.
 */
export function ensureCarapaRunV1Terminal(
  paths: { events: string; manifest: string },
  status: 'interrupted' | 'failed' = 'interrupted',
): boolean {
  // A pair in an IPC run dir is used through its pinned descriptor: a FIFO,
  // link or swapped directory there is refused, never opened or blocked on.
  const ipcDir = ipcRunDirOf(paths);
  const dir = ipcDir ? openIpcDirOrNullSync(ipcDir) : null;
  if (ipcDir && !dir) return false;
  try {
    const eventsFile = dir
      ? dir.entry(path.basename(paths.events))
      : paths.events;
    const manifestFile = dir
      ? dir.entry(path.basename(paths.manifest))
      : paths.manifest;
    // The runtime writes the manifest before it creates the event spool. A stop
    // inside that window leaves a manifest only: give it an empty interrupted
    // run so the pair is valid instead of a rejected incomplete transcript.
    if (fs.existsSync(manifestFile) && !fs.existsSync(eventsFile)) {
      try {
        fs.writeFileSync(
          eventsFile,
          `${JSON.stringify({ type: 'run', status: 'started' })}\n${JSON.stringify({ type: 'run', status })}\n`,
          { flag: 'wx' },
        );
      } catch (error) {
        // The runtime created the spool concurrently: use it as written.
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const document = dir
      ? readPinnedPair(dir, paths, { requireTerminal: false })
      : readCarapaRunV1Pair(paths, { requireTerminal: false });
    if (!document) return false;
    if (
      document.events.some(
        (event) => event.type === 'run' && isTerminalRunStatus(event.status),
      )
    ) {
      return true;
    }
    const completedMessageIds = new Set(
      document.events
        .filter((event) => event.type === 'message')
        .map((event) => event.id),
    );
    const partialMessages = new Map<string, string>();
    for (const event of document.events) {
      if (event.type !== 'message_delta' || event.role !== 'assistant') {
        continue;
      }
      partialMessages.set(
        event.id,
        `${partialMessages.get(event.id) ?? ''}${event.delta}`,
      );
    }
    const append = (event: unknown) => {
      const fd = fs.openSync(eventsFile, APPEND_FLAGS);
      try {
        fs.writeFileSync(fd, `${JSON.stringify(event)}\n`);
      } finally {
        fs.closeSync(fd);
      }
    };
    for (const [id, content] of partialMessages) {
      if (completedMessageIds.has(id) || !content) continue;
      append({
        type: 'message',
        id,
        role: 'assistant',
        content,
        status: 'interrupted',
      });
    }
    append({ type: 'run', status });
    return true;
  } finally {
    dir?.closeSync();
  }
}

function asToolInput(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function displayToolOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function planMarkdown(
  event: Extract<CarapaRunV1Event, { type: 'plan' }>,
): string {
  const lines = event.entries.map((entry) => {
    const marker = entry.status === 'completed' ? 'x' : ' ';
    return `- [${marker}] ${entry.content}`;
  });
  return lines.length ? `\n\n${lines.join('\n')}\n\n` : '';
}

function displayToolId(identityPrefix: string, providerToolId: string): string {
  return identityPrefix
    ? `${identityPrefix}-v1-tool-${providerToolId}`
    : providerToolId;
}

function eventDisplayText(
  event: CarapaRunV1Event,
  toolNames: Map<string, string>,
  identityPrefix = '',
): string {
  if (event.type === 'tool_call') {
    if (event.name) toolNames.set(event.id, event.name);
    const name = event.name ?? toolNames.get(event.id) ?? 'tool';
    const toolId = displayToolId(identityPrefix, event.id);
    if (event.status === 'started') {
      return formatToolUse(
        name,
        asToolInput(event.input),
        undefined,
        undefined,
        toolId,
      );
    }
    if (event.status === 'completed' || event.status === 'failed') {
      return formatToolResult(
        displayToolOutput(event.output ?? event.error?.message),
        event.status === 'failed',
        toolId,
      );
    }
  }
  if (event.type === 'plan') return planMarkdown(event);
  if (event.type === 'interaction' && event.status === 'requested') {
    return `\n\n\`\`\`askuserquestion\n${JSON.stringify({
      questions: (event.questions ?? []).map((question) => ({
        id: question.id,
        header: question.header,
        question: question.question,
        options: question.options ?? [],
        isOther: question.allowOther ?? false,
        isSecret: question.secret ?? false,
        multiSelect: question.multiSelect ?? false,
      })),
      codexRequestId: event.id,
    })}\n\`\`\`\n\n`;
  }
  if (event.type === 'error') return `\n\n> ⚠️ ${event.message}\n\n`;
  return '';
}

export function emitCarapaRunV1Lines(
  content: string,
  onChunk: (data: ChunkData) => void,
  state: CarapaRunV1StreamState,
  onToolUse?: (
    name: string,
    input: Record<string, unknown>,
    toolId?: string,
  ) => void,
  onInteractionRequest?: (
    event: Extract<CarapaRunV1Event, { type: 'interaction' }>,
  ) => void,
): void {
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    if (state.terminal)
      throw new Error('V1 transcript emitted an event after terminal');
    const event = parseCarapaRunV1Event(line);
    if (event.type === 'session' && !state.sessionEmitted) {
      state.sessionEmitted = true;
      onChunk({ type: 'session', session_id: event.id });
      continue;
    }
    if (event.type === 'message_delta') {
      state.accumulatedMessages.set(
        event.id,
        (state.accumulatedMessages.get(event.id) ?? '') + event.delta,
      );
      if (event.role === 'assistant' && event.delta) {
        onChunk({
          type: 'text',
          content: event.delta,
          entryId: `message:${event.id}`,
          entryComplete: false,
        });
      }
      continue;
    }
    if (event.type === 'message' && event.role === 'assistant') {
      let streamId = event.id;
      let accumulated = state.accumulatedMessages.get(streamId) ?? '';
      if (!accumulated) {
        // A harness may only learn the provider message id at the end, after
        // its deltas went out under a provisional one. Close the latest open
        // entry whose text the terminal message starts with, so one answer is
        // not shown as both the streamed entry and the canonical result.
        for (const [id, text] of [...state.accumulatedMessages].reverse()) {
          if (text && event.content.startsWith(text)) {
            streamId = id;
            accumulated = text;
            break;
          }
        }
      }
      if (accumulated && !event.content.startsWith(accumulated)) {
        throw new Error(
          `V1 message ${event.id} does not match its streamed deltas`,
        );
      }
      // Complete the same provider-owned entry rather than emitting a second
      // message. Usually this is an empty control fragment; when the terminal
      // message extends the delivered deltas, only its missing suffix is sent.
      // `canonicalEntry` lets persisted projection replace this provider entry
      // with the run_result identity without comparing unrelated tool text.
      onChunk({
        type: 'text',
        content: accumulated ? event.content.slice(accumulated.length) : '',
        entryId: `message:${streamId}`,
        entryComplete: true,
        canonicalEntry: true,
      });
      state.accumulatedMessages.delete(streamId);
      continue;
    }
    if (event.type === 'background_tasks') {
      onChunk({ type: 'background_tasks', tasks: event.tasks });
      continue;
    }
    if (event.type === 'tool_call' && event.status === 'started') {
      const name = event.name ?? 'tool';
      onToolUse?.(name, asToolInput(event.input), event.id);
    }
    if (event.type === 'interaction' && event.status === 'requested') {
      onInteractionRequest?.(event);
    }
    const display = eventDisplayText(
      event,
      state.toolNames,
      state.identityPrefix,
    );
    if (display)
      onChunk({
        type: 'text',
        content: display,
        entryId: `${event.type}:${
          event.type === 'tool_call'
            ? displayToolId(state.identityPrefix, event.id)
            : 'id' in event
              ? event.id
              : 'current'
        }`,
        entryComplete:
          event.type !== 'tool_call' ||
          event.status === 'completed' ||
          event.status === 'failed',
      });
    if (event.type === 'run' && isTerminalRunStatus(event.status)) {
      state.terminal = true;
    }
  }
}

export function projectCarapaRunV1Entries(
  document: CarapaRunV1Document,
  metadata: Record<string, unknown> = {},
  identityPrefix = '',
  options: { includeUserMessages?: boolean } = {},
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const toolNames = new Map<string, string>();
  for (const [index, event] of document.events.entries()) {
    if (event.type === 'tool_call') {
      const toolId = displayToolId(identityPrefix, event.id);
      rows.push({
        ...event,
        id: toolId,
        ...metadata,
      });
      continue;
    }
    if (
      event.type === 'message' &&
      (event.role !== 'user' || options.includeUserMessages) &&
      event.content.trim()
    ) {
      rows.push({
        id: `${identityPrefix ? `${identityPrefix}-` : ''}v1-${index}-${event.id}`,
        type: 'message',
        role: event.role,
        content: event.content,
        ...(event.status === 'interrupted' ? { interrupted: true } : {}),
        ...metadata,
      });
      continue;
    }
    const display = eventDisplayText(event, toolNames, identityPrefix);
    if (display) {
      rows.push({
        id: `${identityPrefix ? `${identityPrefix}-` : ''}v1-${index}-${'id' in event ? event.id : event.type}`,
        type: 'message',
        role: 'assistant',
        content: display,
        ...metadata,
      });
    }
  }
  return rows;
}

export function summarizeCarapaRunV1(
  document: CarapaRunV1Document,
): CarapaRunV1Summary {
  let sessionId: string | undefined;
  let model = document.manifest.requestedModel ?? undefined;
  let terminalStatus: 'completed' | 'interrupted' | 'failed' | undefined;
  let lastAssistant: Extract<CarapaRunV1Event, { type: 'message' }> | undefined;
  let lastError: string | undefined;
  let totals = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 0,
  };
  let lastUsage: typeof totals | undefined;
  let cacheTtlSeconds: number | undefined;
  const tools = new Set<string>();
  for (const event of document.events) {
    if (event.type === 'session') sessionId = event.id;
    if (event.type === 'run') {
      if (event.model) model = event.model;
      if (isTerminalRunStatus(event.status)) {
        terminalStatus = event.status;
      }
    }
    if (event.type === 'message' && event.role === 'assistant')
      lastAssistant = event;
    if (event.type === 'error') lastError = event.message;
    if (event.type === 'tool_call') tools.add(event.id);
    if (event.type === 'usage') {
      cacheTtlSeconds = event.cacheTtlSeconds ?? cacheTtlSeconds;
      const usage = {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cachedInputTokens: event.cachedInputTokens ?? 0,
        cacheWriteInputTokens: event.cacheWriteInputTokens ?? 0,
        reasoningOutputTokens: event.reasoningOutputTokens ?? 0,
      };
      // Claude emits request snapshots followed by an authoritative turn total.
      // Keep the last request for context occupancy; totals still replace below.
      if (
        event.scope !== 'cumulative' ||
        document.manifest.harness !== 'claude' ||
        !lastUsage
      )
        lastUsage = usage;
      totals =
        event.scope === 'cumulative'
          ? usage
          : {
              inputTokens: totals.inputTokens + usage.inputTokens,
              outputTokens: totals.outputTokens + usage.outputTokens,
              cachedInputTokens:
                totals.cachedInputTokens + usage.cachedInputTokens,
              cacheWriteInputTokens:
                totals.cacheWriteInputTokens + usage.cacheWriteInputTokens,
              reasoningOutputTokens:
                totals.reasoningOutputTokens + usage.reasoningOutputTokens,
            };
    }
  }
  const hasUsage = lastUsage !== undefined;
  return {
    // A failed provider can produce no assistant message at all. Preserve its
    // canonical error as the result so chat persistence has something durable
    // to display after the transient live error fragment disappears.
    result: lastAssistant?.content ?? lastError ?? null,
    hasAssistantText: !!lastAssistant?.content.trim(),
    agentSuccess: terminalStatus === 'completed',
    agentTerminalFailure: terminalStatus === 'failed',
    session_id: sessionId,
    uuid: lastAssistant?.id,
    model_name: model,
    ...(hasUsage
      ? {
          total_tokens: totals.inputTokens + totals.outputTokens,
          tok_input: totals.inputTokens,
          inputTokenSemantics: 'fresh' as const,
          tok_output: totals.outputTokens,
          tok_cache_read: totals.cachedInputTokens,
          tok_cache_write: totals.cacheWriteInputTokens,
          tok_reasoning: totals.reasoningOutputTokens,
          tok_context_last:
            lastUsage!.inputTokens +
            lastUsage!.cachedInputTokens +
            lastUsage!.cacheWriteInputTokens,
          usageSource: 'reported' as const,
          rawUsage: { ...totals },
        }
      : {}),
    cache_ttl_s: cacheTtlSeconds,
    tool_usage_count: tools.size || undefined,
  };
}

export function appendCarapaRunV1ToTranscript(
  targetPath: string,
  paths: { events: string; manifest: string },
  expectedHarness: string,
  metadata: Record<string, unknown> = {},
): boolean {
  try {
    const document = readCarapaRunV1Pair(paths, {
      expectedHarness,
      requireTerminal: true,
    });
    if (!document) return false;
    ingestTranscriptSpoolSync(
      targetPath,
      paths.events,
      (_source, context) =>
        projectCarapaRunV1Entries(document, metadata, context.sourceArtifactId),
      {
        checkpointNamespace: 'carapa-run-v1',
      },
    );
    return true;
  } catch (error) {
    logger.warn(
      { error, targetPath, eventPath: paths.events },
      'Failed to append canonical V1 run transcript',
    );
    return false;
  }
}
