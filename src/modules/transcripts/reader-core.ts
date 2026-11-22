/**
 * Dependency-free transcript reader shared by the board's DirectLLM transcript
 * tools (`logic.ts`) and the standalone `transcripts` skill CLI
 * (`transcripts-cli.ts`, bundled to `transcripts.mjs`).
 *
 * Only `node:` built-ins may be imported here: the CLI bundle must run in a
 * sandbox without the board's config, database or logger. All roots are
 * passed in by the caller. Everything in this module is read-only.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  isRealDir,
  readBufferNoFollowSync,
  readNoFollowSync,
} from './transcript-fs-safe.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** `tool_result` only links an output to its call; readers never see it. */
type MessageKind = 'message' | 'tool' | 'tool_result';

export interface ToolResult {
  text: string;
  failed: boolean;
}

export interface TranscriptMessage {
  role: string;
  content: string;
  created_at: string;
  agent_name: string;
  kind: MessageKind;
  /** Tool calls: 1-based position among the transcript's tool calls. */
  toolNo?: number;
  /** Provider id linking a tool call to its result. */
  toolId?: string;
  toolName?: string;
  /** The call's raw input. */
  toolInput?: unknown;
  /** Display form of the input (shortened unless `full`). */
  toolDetail?: string;
  /** A call's output, or the output carried by a `tool_result`. */
  result?: ToolResult;
}

/** A group (project) and the directory holding its `*.jsonl` transcripts. */
export interface GroupSource {
  name: string;
  dir: string;
}

export interface TranscriptFile {
  /** File name without `.jsonl` / `.output.jsonl`. */
  id: string;
  fileName: string;
  /** Best-effort creation time from the file name (epoch or date prefix). */
  nameTime: Date | null;
  mtimeMs: number;
  archived: boolean;
  /** Archive file name for archived members. */
  archiveName?: string;
  readText(): string;
}

export interface ParseOptions {
  includeTools?: boolean;
  /** Keep tool inputs and failure details untruncated. */
  full?: boolean;
  role?: string;
  /** Epoch ms; messages with a parseable timestamp before it are dropped. */
  sinceMs?: number;
  /**
   * Keep only the messages of this task run: from its `run_start` line up to
   * the next `run_start` line. Tool numbering still counts the whole file.
   */
  runId?: string;
}

// ─── Small helpers ───────────────────────────────────────────────────────────

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const TOOL_INPUT_MAX = 160;

export function parseTimestamp(value?: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatTime(dt: Date | null): string {
  if (!dt) return '?';
  return dt.toISOString().replace('T', ' ').slice(0, 16);
}

export function truncate(text: string, maxLen = 200): string {
  if (!text) return '';
  const collapsed = text.split(/\s+/).join(' ').trim();
  if (collapsed.length <= maxLen) return collapsed;
  return collapsed.slice(0, maxLen) + '...';
}

/** Parse `YYYY-MM-DD` to epoch ms (UTC midnight); null when malformed. */
export function parseDateOnly(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isNaN(ms) ? null : ms;
}

function transcriptId(fileName: string): string {
  return fileName.replace(/\.output\.jsonl$/, '').replace(/\.jsonl$/, '');
}

/** Creation time from a 13-digit epoch in the name, else a `YYYY-MM-DD-` prefix. */
function timeFromFileName(fileName: string): Date | null {
  const epoch = fileName.match(/(\d{13})/);
  if (epoch) {
    const d = new Date(parseInt(epoch[1], 10));
    if (!Number.isNaN(d.getTime())) return d;
  }
  const prefix = fileName.match(/^(\d{4}-\d{2}-\d{2})-/);
  if (prefix) {
    const ms = parseDateOnly(prefix[1]);
    if (ms !== null) return new Date(ms);
  }
  return null;
}

/** Newest known activity time of a file (name time vs mtime). */
function fileActivityMs(file: TranscriptFile): number {
  return Math.max(file.nameTime?.getTime() ?? 0, file.mtimeMs);
}

// ─── Context stripping ───────────────────────────────────────────────────────

const BLOCKS: Array<{ open: string; close: string }> = [
  { open: '[CARAPABOT CONTEXT', close: '[/CARAPABOT CONTEXT]' },
  { open: '<system-reminder>', close: '</system-reminder>' },
  { open: '[INHERITED GROUP RULES]', close: '[END INHERITED GROUP RULES]' },
];

/** Strip board-injected context from user messages. */
function cleanUserContent(content: string): string {
  if (typeof content !== 'string') return content;
  const cleaned: string[] = [];
  let closeMarker: string | null = null;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (closeMarker) {
      if (trimmed.includes(closeMarker)) closeMarker = null;
      continue;
    }
    // Appended after the prompt with no terminator: everything after is context.
    if (trimmed.startsWith('[CURRENT HUMAN CONTEXT]')) break;
    if (
      trimmed.startsWith('[AGENT_CONTEXT') ||
      trimmed.startsWith('[INSTRUCTION:') ||
      trimmed.startsWith('[CHANNEL:') ||
      trimmed.startsWith('[Shared browser:')
    ) {
      continue;
    }
    const block = BLOCKS.find((b) => trimmed.includes(b.open));
    if (block) {
      const afterOpen = trimmed.slice(
        trimmed.indexOf(block.open) + block.open.length,
      );
      if (!afterOpen.includes(block.close)) closeMarker = block.close;
      continue;
    }
    cleaned.push(line);
  }
  return cleaned.join('\n').trim();
}

// ─── Entry normalisation ─────────────────────────────────────────────────────

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toolInput(input: unknown, full: boolean): string {
  let text = '';
  if (typeof input === 'string') {
    text = input;
  } else if (full) {
    // The whole input: picking one field would drop the rest (e.g. a cron's title).
    text = input === undefined ? '' : JSON.stringify(input);
  } else if (input && typeof input === 'object') {
    const rec = input as Record<string, unknown>;
    const key = [
      'command',
      'file_path',
      'path',
      'pattern',
      'query',
      'url',
      'description',
      'prompt',
    ].find((k) => typeof rec[k] === 'string' && rec[k]);
    text = key ? String(rec[key]) : JSON.stringify(input);
  }
  return full ? text.trim() : truncate(text, TOOL_INPUT_MAX);
}

function toolMessage(
  name: string,
  input: unknown,
  full: boolean,
  created_at: string,
  agent_name: string,
  toolId?: string,
): TranscriptMessage {
  const detail = toolInput(input, full);
  return {
    role: 'assistant',
    content: detail ? `TOOL ${name}: ${detail}` : `TOOL ${name}`,
    created_at,
    agent_name,
    kind: 'tool',
    toolId: toolId || undefined,
    toolName: name,
    toolInput: input,
    toolDetail: detail,
  };
}

function toolResult(
  toolId: string,
  name: string,
  output: unknown,
  failed: boolean,
  created_at: string,
  agent_name: string,
): TranscriptMessage {
  return {
    role: 'assistant',
    content: '',
    created_at,
    agent_name,
    kind: 'tool_result',
    toolId: toolId || undefined,
    toolName: name,
    result: { text: outputText(output), failed },
  };
}

/**
 * Tool output as text: strings as-is, content blocks joined, MCP results
 * (`{content: [...], structuredContent?, _meta?}`) by their content blocks,
 * anything else as JSON.
 */
function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined || output === null) return '';
  const content = (output as { content?: unknown }).content;
  if (!Array.isArray(output) && Array.isArray(content)) {
    return outputText(content);
  }
  if (Array.isArray(output)) {
    return output
      .map((b: any) =>
        b?.type === 'text' && typeof b.text === 'string'
          ? b.text
          : b?.type === 'image'
            ? '[image]'
            : JSON.stringify(b),
      )
      .join('\n');
  }
  return JSON.stringify(output);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const resultBytes = (r: ToolResult) => Buffer.byteLength(r.text);

/** `TOOL #n name: input → size`; the result itself is read with `result`. */
function numberedToolLine(msg: TranscriptMessage): string {
  const head = `TOOL #${msg.toolNo} ${msg.toolName}`;
  let line = msg.toolDetail ? `${head}: ${msg.toolDetail}` : head;
  if (msg.result) {
    line += msg.result.failed
      ? ` → failed: ${truncate(msg.result.text, 80)}`
      : ` → ${formatBytes(resultBytes(msg.result))}`;
  }
  return line;
}

/**
 * Numbers tool calls, drops repeated announcements of the same call, and
 * attaches each result to its call. Returns the message to keep, or null.
 */
class ToolPairing {
  private count = 0;
  private byId = new Map<string, TranscriptMessage>();

  accept(msg: TranscriptMessage): TranscriptMessage | null {
    if (msg.kind === 'message') return msg;
    const call = msg.toolId ? this.byId.get(msg.toolId) : undefined;
    if (msg.kind === 'tool_result') {
      if (call) {
        call.result = msg.result;
        return null;
      }
      // A result whose call was never logged stands in for the call.
      msg = { ...msg, kind: 'tool', content: `TOOL ${msg.toolName}` };
    } else if (call) {
      return null;
    }
    msg.toolNo = ++this.count;
    if (msg.toolId) this.byId.set(msg.toolId, msg);
    return msg;
  }
}

/** Normalise one parsed JSONL entry from any supported dialect. */
function normalizeEntry(entry: unknown, full = false): TranscriptMessage[] {
  if (!entry || typeof entry !== 'object') return [];
  const e = entry as Record<string, any>;
  const type = asString(e.type);
  const created_at = asString(e.timestamp) || asString(e.created_at);
  const agent_name = asString(e.agent_name);

  // Task transcripts (no `type`) and current chat messages.
  if (type === '' || type === 'message') {
    const role = asString(e.role);
    if (!role || typeof e.content !== 'string' || !e.content) return [];
    const content =
      role === 'user' ? cleanUserContent(e.content) : e.content.trim();
    if (!content) return [];
    return [{ role, content, created_at, agent_name, kind: 'message' }];
  }

  // Legacy provider output: {type:"assistant", message:{role, content[]}}.
  if (type === 'assistant') {
    const msg = e.message;
    if (!msg || typeof msg !== 'object' || !Array.isArray(msg.content)) {
      return [];
    }
    const model = asString(msg.model) || asString(e.model) || agent_name;
    const out: TranscriptMessage[] = [];
    const text = msg.content
      .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
      .map((p: any) => p.text)
      .join('\n')
      .trim();
    if (text) {
      out.push({
        role: 'assistant',
        content: text,
        created_at,
        agent_name: model,
        kind: 'message',
      });
    }
    for (const p of msg.content) {
      if (p?.type === 'tool_use') {
        out.push(
          toolMessage(
            asString(p.name) || 'unknown',
            p.input,
            full,
            created_at,
            model,
            asString(p.id),
          ),
        );
      }
    }
    return out;
  }

  // Legacy provider output: results come back as user tool_result blocks.
  if (type === 'user') {
    const content = e.message?.content;
    if (!Array.isArray(content)) return [];
    return content
      .filter((p: any) => p?.type === 'tool_result')
      .map((p: any) =>
        toolResult(
          asString(p.tool_use_id),
          'unknown',
          p.content,
          p.is_error === true,
          created_at,
          agent_name,
        ),
      );
  }

  if (type === 'text') {
    const content = asString(e.text) || asString(e.content);
    return content
      ? [
          {
            role: 'assistant',
            content,
            created_at,
            agent_name: asString(e.model) || agent_name,
            kind: 'message',
          },
        ]
      : [];
  }

  // Current provider-neutral tool events: "started" carries the input; the
  // completed/failed event with the same id carries the output.
  if (type === 'tool_call') {
    const name = asString(e.name) || 'unknown';
    const id = asString(e.id);
    if (e.input !== undefined) {
      return [toolMessage(name, e.input, full, created_at, agent_name, id)];
    }
    if (e.status === 'failed') {
      const detail = asString(e.error?.message) || 'failed';
      return [toolResult(id, name, detail, true, created_at, agent_name)];
    }
    if (e.status === 'completed') {
      return [toolResult(id, name, e.output, false, created_at, agent_name)];
    }
    return [];
  }

  // opencode parts: the same part id is logged while running and when done.
  if (type === 'tool_use') {
    const name = asString(e.part?.tool) || asString(e.tool) || 'unknown';
    const id = asString(e.part?.id);
    const state = e.part?.state;
    const out = [
      toolMessage(
        name,
        state?.input ?? e.input,
        full,
        created_at,
        agent_name,
        id,
      ),
    ];
    if (state?.status === 'completed' || state?.status === 'error') {
      out.push(
        toolResult(
          id,
          name,
          state.output,
          state.status === 'error',
          created_at,
          agent_name,
        ),
      );
    }
    return out;
  }

  if (type === 'compaction_marker') {
    return [
      {
        role: 'system',
        content: `[CONTEXT COMPACTED: ${asString(e.content)}]`,
        created_at,
        agent_name: '',
        kind: 'message',
      },
    ];
  }

  // turn_outcome, telemetry, turn_instruction_state, tool_result, result, ...
  return [];
}

function keep(msg: TranscriptMessage, opts: ParseOptions): boolean {
  if (msg.kind === 'tool' && !opts.includeTools) return false;
  if (opts.role && msg.role !== opts.role) return false;
  if (opts.sinceMs !== undefined) {
    const ts = parseTimestamp(msg.created_at);
    if (ts && ts.getTime() < opts.sinceMs) return false;
  }
  return true;
}

function* lines(text: string): Generator<string> {
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    const line = text.slice(start, end).trim();
    start = end + 1;
    if (line) yield line;
  }
}

/** The `run_id` of a `run_start` line; undefined for every other line. */
function runStartId(line: string): string | undefined {
  if (!line.includes('"run_start"')) return undefined;
  try {
    const entry = JSON.parse(line);
    return entry?.entry_type === 'run_start'
      ? asString(entry.run_id)
      : undefined;
  } catch {
    return undefined;
  }
}

interface ParsedLine {
  ts: string;
  messages: TranscriptMessage[];
}

function parseLine(line: string, full = false): ParsedLine {
  try {
    const entry = JSON.parse(line);
    const ts =
      entry && typeof entry === 'object'
        ? asString(entry.timestamp) || asString(entry.created_at)
        : '';
    return { ts, messages: normalizeEntry(entry, full) };
  } catch {
    return { ts: '', messages: [] };
  }
}

/**
 * Current chat transcripts stamp only user messages and turn-state rows, not
 * assistant messages. Untimed messages inherit the latest preceding timestamp
 * so later replies are not dated by the file name.
 */
class TimestampCarry {
  private last = '';
  see(ts: string): void {
    if (ts) this.last = ts;
  }
  fill(msg: TranscriptMessage): TranscriptMessage {
    return msg.created_at || !this.last
      ? msg
      : { ...msg, created_at: this.last };
  }
}

export function parseTranscriptText(
  text: string,
  opts: ParseOptions = {},
): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  const carry = new TimestampCarry();
  const tools = new ToolPairing();
  let inRun = opts.runId === undefined;
  for (const line of lines(text)) {
    if (opts.runId !== undefined) {
      const startedRun = runStartId(line);
      if (startedRun !== undefined) inRun = startedRun === opts.runId;
    }
    const parsed = parseLine(line, opts.full);
    carry.see(parsed.ts);
    for (const raw of parsed.messages) {
      const msg = tools.accept(carry.fill(raw));
      if (msg && inRun && keep(msg, opts)) out.push(msg);
    }
  }
  // Results arrive after their calls, so tool lines are rendered last.
  for (const msg of out) {
    if (msg.kind === 'tool') msg.content = numberedToolLine(msg);
  }
  return out;
}

/** A search hit: the matched message plus the terms its content contains. */
export interface TranscriptSearchHit {
  msg: TranscriptMessage;
  /** The search terms (as given) whose lowercase form the content contains. */
  matchedTerms: string[];
}

const SAFE_TERM = /^[a-z0-9 _.:/@#-]+$/;

/**
 * Search terms as a list: empty/whitespace-only terms are dropped and
 * duplicates are removed case-insensitively (the first form wins).
 */
export function normalizeSearchTerms(terms: string | string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of Array.isArray(terms) ? terms : [terms]) {
    if (!term.trim()) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

/**
 * Messages whose content contains any of `terms` (OR), each paired with the
 * terms it contains. Every line is read and parsed once regardless of the term
 * count. Lines that cannot contain any term are never JSON-parsed; the
 * raw-line prefilter is only applied when every term passes the
 * safe-character check (terms JSON encoding leaves untouched).
 */
export function searchTranscriptText(
  text: string,
  terms: string | string[],
  opts: ParseOptions = {},
): TranscriptSearchHit[] {
  const normalized = normalizeSearchTerms(terms);
  const needles = normalized.map((t) => t.toLowerCase());
  // Tool numbers count every call, so with tools no line may be skipped.
  const prefilter =
    !opts.includeTools && needles.every((n) => SAFE_TERM.test(n));
  const out: TranscriptSearchHit[] = [];
  const carry = new TimestampCarry();
  const tools = new ToolPairing();
  for (const line of lines(text)) {
    if (prefilter) {
      const lower = line.toLowerCase();
      if (!needles.some((n) => lower.includes(n))) {
        // Skipped lines still advance the timestamp for later matches.
        if (line.includes('"timestamp"') || line.includes('"created_at"')) {
          carry.see(parseLine(line).ts);
        }
        continue;
      }
    }
    const parsed = parseLine(line, opts.full);
    carry.see(parsed.ts);
    for (const raw of parsed.messages) {
      // Results attach to their calls; they are not searchable themselves.
      const msg = tools.accept(carry.fill(raw));
      if (msg && keep(msg, opts)) {
        const content = msg.content.toLowerCase();
        const matchedTerms = normalized.filter((_, i) =>
          content.includes(needles[i]),
        );
        if (matchedTerms.length > 0) out.push({ msg, matchedTerms });
      }
    }
  }
  // Matched on input text; rendered numbered once results have arrived.
  for (const hit of out) {
    if (hit.msg.kind === 'tool') hit.msg.content = numberedToolLine(hit.msg);
  }
  return out;
}

// ─── Group discovery ─────────────────────────────────────────────────────────

const SKIP_CHILD_DIRS = new Set(['objectives', 'transcripts', 'logs']);

/**
 * Board's list of project folders in the groups root:
 * `{ "version": 1, "projects": { "<folder>": "<dir relative to root>" } }`.
 * Written by `project-dirs-file.ts` whenever projects load or change.
 */
export const PROJECT_DIRS_FILE = 'project-dirs.json';

/** Project name → absolute project dir from {@link PROJECT_DIRS_FILE}, or null. */
function readProjectDirs(root: string): Map<string, string> | null {
  const text = readNoFollowSync(root, path.join(root, PROJECT_DIRS_FILE));
  if (!text) return null;
  let projects: unknown;
  try {
    projects = (JSON.parse(text.content) as { projects?: unknown })?.projects;
  } catch {
    return null;
  }
  if (!projects || typeof projects !== 'object' || Array.isArray(projects))
    return null;
  const dirs = new Map<string, string>();
  for (const [name, rel] of Object.entries(projects)) {
    if (typeof rel !== 'string') continue;
    const parts = rel.split('/');
    if (parts.some((p) => p === '' || p === '.' || p === '..')) continue;
    dirs.set(name, path.join(root, ...parts));
  }
  return dirs.size > 0 ? dirs : null;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function subdirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name)
      .filter((name) => isDir(path.join(dir, name)));
  } catch {
    return [];
  }
}

export interface DiscoverOptions {
  /** Name for `<root>/transcripts` (the shared layout). Omit to not list it. */
  sharedName?: string;
  /** Override for the shared directory (default `<root>/transcripts`). */
  sharedDir?: string;
}

/**
 * Groups under `root`: `<root>/<group>/transcripts`, nested
 * `<root>/<parent>/<child>/transcripts`, `<root>/objectives/<id>/transcripts`
 * and the shared `<root>/transcripts`. First occurrence of a name wins, so a
 * nested group shadows a shared mount of the same name.
 *
 * When the root holds Board's {@link PROJECT_DIRS_FILE}, projects come only
 * from it: a leftover folder (an old location after a parent change, or a
 * flat copy written without the parent) is never read. Without the file (a
 * sandbox mount of one group) the folders are scanned.
 */
export function discoverGroups(
  root: string,
  opts: DiscoverOptions = {},
): GroupSource[] {
  const found = new Map<string, string>();
  const add = (name: string, dir: string) => {
    if (!found.has(name) && isDir(dir)) found.set(name, dir);
  };

  const projectDirs = readProjectDirs(root);
  if (projectDirs) {
    for (const [name, dir] of projectDirs)
      add(name, path.join(dir, 'transcripts'));
  } else {
    for (const top of subdirs(root)) {
      if (top === 'objectives' || top === 'transcripts') continue;
      const topPath = path.join(root, top);
      add(top, path.join(topPath, 'transcripts'));
      for (const child of subdirs(topPath)) {
        if (child.startsWith('.') || SKIP_CHILD_DIRS.has(child)) continue;
        add(child, path.join(topPath, child, 'transcripts'));
      }
    }
  }

  const objectivesDir = path.join(root, 'objectives');
  for (const obj of subdirs(objectivesDir)) {
    add(obj, path.join(objectivesDir, obj, 'transcripts'));
  }

  if (opts.sharedName) {
    const shared = opts.sharedDir ?? path.join(root, 'transcripts');
    add(opts.sharedName, shared);
  }

  return [...found.entries()]
    .map(([name, dir]) => ({ name, dir }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Archives (read-only, in-process) ────────────────────────────────────────

interface ArchiveMember {
  name: string;
  mtimeMs: number;
  offset: number;
  size: number;
}

interface LoadedArchive {
  path: string;
  data: Buffer;
  members: ArchiveMember[];
}

let lastArchive: LoadedArchive | null = null;

function cString(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf8');
}

function octal(buf: Buffer, start: number, length: number): number | null {
  // Base-256 (high bit set) sizes are far beyond MAX_ARCHIVE_BYTES.
  if (buf[start] & 0x80) return null;
  const text = cString(buf, start, length).trim();
  if (!/^[0-7]*$/.test(text)) return null;
  return text === '' ? 0 : parseInt(text, 8);
}

/** Minimal ustar/GNU/pax reader: regular `.jsonl` members only. Names are data. */
function parseTar(data: Buffer): ArchiveMember[] {
  const members: ArchiveMember[] = [];
  let pos = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;

  while (pos + 512 <= data.length) {
    if (data.subarray(pos, pos + 512).every((b) => b === 0)) break;
    const size = octal(data, pos + 124, 12);
    if (size === null || pos + 512 + size > data.length) break;
    const mtime = octal(data, pos + 136, 12) ?? 0;
    const type = String.fromCharCode(data[pos + 156] || 0x30);
    const prefix = cString(data, pos + 345, 155);
    const base = cString(data, pos, 100);
    const body = pos + 512;

    if (type === 'L') {
      longName = cString(data, body, size);
    } else if (type === 'x') {
      const m = data
        .subarray(body, body + size)
        .toString('utf8')
        .match(/\d+ path=([^\n]*)\n/);
      paxPath = m ? m[1] : null;
    } else if (type === 'g') {
      // Global pax header: ignored.
    } else {
      if (type === '0' || type === '\0') {
        const name =
          paxPath ?? longName ?? (prefix ? `${prefix}/${base}` : base);
        if (isTranscriptName(name)) {
          members.push({ name, mtimeMs: mtime * 1000, offset: body, size });
        }
      }
      longName = null;
      paxPath = null;
    }
    pos = body + Math.ceil(size / 512) * 512;
  }
  return members;
}

function loadArchive(archivePath: string): LoadedArchive | null {
  if (lastArchive?.path === archivePath) return lastArchive;
  try {
    // A symlink or FIFO planted as an archive is never followed or opened.
    const raw = readBufferNoFollowSync(path.dirname(archivePath), archivePath);
    if (!raw) return null;
    const data = zlib.gunzipSync(raw.buffer, {
      maxOutputLength: MAX_ARCHIVE_BYTES,
    });
    lastArchive = { path: archivePath, data, members: parseTar(data) };
    return lastArchive;
  } catch {
    return null;
  }
}

/** Display-safe member id: member names are data and may contain anything. */
function safeMemberName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f]/g, '?');
}

function archiveFiles(archivePath: string): TranscriptFile[] {
  const archive = loadArchive(archivePath);
  if (!archive) return [];
  const archiveName = path.basename(archivePath);
  return archive.members.map((m) => {
    const fileName = safeMemberName(m.name);
    return {
      id: transcriptId(fileName),
      fileName,
      nameTime: timeFromFileName(path.basename(fileName)),
      mtimeMs: m.mtimeMs,
      archived: true,
      archiveName,
      readText: () => {
        const a = loadArchive(archivePath);
        const member = a?.members.find(
          (x) => x.offset === m.offset && x.name === m.name,
        );
        return member
          ? a!.data.toString('utf8', member.offset, member.offset + member.size)
          : '';
      },
    };
  });
}

// ─── File listing ────────────────────────────────────────────────────────────

/** `*.stream.jsonl` holds raw streaming deltas, not transcript messages. */
const isTranscriptName = (name: string): boolean =>
  name.endsWith('.jsonl') && !name.endsWith('.stream.jsonl');

function listLiveFiles(dir: string): TranscriptFile[] {
  // The tree is agent-writable: a symlinked directory or entry must not
  // expose another project's transcripts, and a FIFO must not block a read.
  if (!isRealDir(dir)) return [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const files: TranscriptFile[] = [];
  for (const fileName of names) {
    if (!isTranscriptName(fileName)) continue;
    const filePath = path.join(dir, fileName);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(filePath);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    files.push({
      id: transcriptId(fileName),
      fileName,
      nameTime: timeFromFileName(fileName),
      mtimeMs: st.mtimeMs,
      archived: false,
      readText: () => readNoFollowSync(dir, filePath)?.content ?? '',
    });
  }
  return files;
}

export function hasArchives(dir: string): boolean {
  return archiveNames(dir).length > 0;
}

function archiveNames(dir: string): string[] {
  if (!isRealDir(dir) || !isRealDir(path.join(dir, 'archive'))) return [];
  try {
    return fs
      .readdirSync(path.join(dir, 'archive'))
      .filter((n) => n.endsWith('.tar.gz'))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export interface ListFilesOptions {
  /** `true`/`false` to force; `'auto'` includes archives when `sinceMs` predates the oldest live file. */
  archive?: boolean | 'auto';
  sinceMs?: number;
}

/**
 * Transcript files of a group, newest first. Live files shadow archived
 * members of the same name; files not active since `sinceMs` are dropped.
 */
export function listTranscriptFiles(
  dir: string,
  opts: ListFilesOptions = {},
): TranscriptFile[] {
  const live = listLiveFiles(dir);
  let files = live;

  let withArchive = opts.archive === true;
  if (opts.archive === 'auto' && opts.sinceMs !== undefined) {
    const oldest = live.length
      ? Math.min(...live.map((f) => f.nameTime?.getTime() ?? f.mtimeMs))
      : Infinity;
    withArchive = opts.sinceMs < oldest;
  }

  if (withArchive) {
    const seen = new Set(live.map((f) => f.fileName));
    files = [...live];
    for (const name of archiveNames(dir)) {
      for (const f of archiveFiles(path.join(dir, 'archive', name))) {
        if (seen.has(f.fileName)) continue;
        seen.add(f.fileName);
        files.push(f);
      }
    }
  }

  // A task writes `<id>.jsonl` (prompts/results) and `<id>.output.jsonl` (raw
  // run output). Keep them selectable: the raw-output id keeps an `.output` suffix.
  const plainIds = new Set(
    files.filter((f) => !f.fileName.endsWith('.output.jsonl')).map((f) => f.id),
  );
  for (const f of files) {
    if (f.fileName.endsWith('.output.jsonl') && plainIds.has(f.id)) {
      f.id = `${f.id}.output`;
    }
  }

  if (opts.sinceMs !== undefined) {
    const since = opts.sinceMs;
    files = files.filter((f) => fileActivityMs(f) >= since);
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
