/**
 * summary / list / show / search over the dependency-free reader core.
 * Each command returns human text plus a JSON-serialisable `data` payload.
 */
import {
  type GroupSource,
  type TranscriptFile,
  type TranscriptMessage,
  formatTime,
  hasArchives,
  listTranscriptFiles,
  normalizeSearchTerms,
  parseDateOnly,
  parseTimestamp,
  parseTranscriptText,
  resultBytes,
  searchTranscriptText,
  truncate,
} from './reader-core.js';

const DEFAULT_SEARCH_LIMIT = 50;

export interface ReaderContext {
  /** Groups to cover when no group is given (already permission-filtered). */
  listGroups(): GroupSource[];
  /** The named group; its `dir` need not exist. */
  resolveGroup(name: string): GroupSource;
}

export interface CommandOptions {
  /** `YYYY-MM-DD`. */
  since?: string;
  role?: 'user' | 'assistant';
  tools?: boolean;
  archive?: boolean;
  full?: boolean;
  limit?: number;
}

export interface CommandResult {
  text: string;
  data: unknown;
}

interface Resolved {
  sinceMs?: number;
  error?: string;
}

function resolveOptions(opts: CommandOptions): Resolved {
  if (opts.since === undefined) return {};
  const sinceMs = parseDateOnly(opts.since);
  return sinceMs === null
    ? { error: `Invalid --since '${opts.since}'; expected YYYY-MM-DD.` }
    : { sinceMs };
}

function invalid(error: string): CommandResult {
  return { text: error, data: { error } };
}

function filesFor(
  source: GroupSource,
  opts: CommandOptions,
  sinceMs?: number,
): TranscriptFile[] {
  return listTranscriptFiles(source.dir, {
    archive: opts.archive ? true : 'auto',
    sinceMs,
  });
}

function readFile(
  file: TranscriptFile,
  opts: CommandOptions,
  sinceMs?: number,
  runId?: string,
): TranscriptMessage[] {
  return parseTranscriptText(file.readText(), {
    includeTools: opts.tools,
    full: opts.full,
    role: opts.role,
    sinceMs,
    runId,
  });
}

function formatMessage(
  msg: TranscriptMessage,
  full: boolean,
  fallback: Date | null,
): string {
  const ts = parseTimestamp(msg.created_at) || fallback;
  const role = msg.role.toUpperCase();
  const who = msg.agent_name ? `${role} (${msg.agent_name})` : role;
  return `[${formatTime(ts)}] ${who}: ${displayContent(msg, full)}`;
}

/** Tool lines are already bounded; cutting them again drops the `→ size`. */
function displayContent(msg: TranscriptMessage, full: boolean): string {
  return full || msg.kind === 'tool' ? msg.content : truncate(msg.content);
}

function messageData(msg: TranscriptMessage, full: boolean) {
  const { role, created_at, agent_name, kind, toolNo } = msg;
  return {
    role,
    content: displayContent(msg, full),
    created_at,
    agent_name,
    kind,
    // Results stay out of listings; `result` returns one on demand.
    ...(toolNo === undefined ? {} : { toolNo }),
  };
}

const fileTime = (f: TranscriptFile) => f.nameTime ?? new Date(f.mtimeMs);

// ─── summary ─────────────────────────────────────────────────────────────────

export function summaryCommand(
  ctx: ReaderContext,
  group: string | undefined,
  opts: CommandOptions = {},
): CommandResult {
  const { sinceMs, error } = resolveOptions(opts);
  if (error) return invalid(error);
  const groups = group ? [ctx.resolveGroup(group)] : ctx.listGroups();
  if (groups.length === 0) {
    return { text: 'No groups found.', data: { groups: [] } };
  }

  let text = '=== Transcript Summary ===\n\n';
  const data: unknown[] = [];
  for (const source of groups) {
    const files = filesFor(source, opts, sinceMs);
    if (files.length === 0) {
      text += `  ${source.name}: (no transcripts)\n`;
      data.push({ group: source.name, transcripts: 0 });
      continue;
    }

    let totalMessages = 0;
    const agents = new Set<string>();
    let latest: Date | null = null;
    const recentTasks: string[] = [];
    let archived = 0;

    for (const f of files) {
      if (f.archived) archived++;
      const messages = readFile(f, opts, sinceMs);
      totalMessages += messages.length;
      for (const msg of messages) {
        if (msg.agent_name) agents.add(msg.agent_name);
        const ts = parseTimestamp(msg.created_at) || fileTime(f);
        if (!latest || ts > latest) latest = ts;
      }
      const firstUser = messages.find((m) => m.role === 'user');
      if (firstUser && recentTasks.length < 3) {
        recentTasks.push(truncate(firstUser.content, 60));
      }
    }

    const agentList = [...agents].sort();
    text += `  ${source.name}:\n`;
    text += `    Transcripts: ${files.length}${archived ? ` (${archived} archived)` : ''}  |  Messages: ${totalMessages}\n`;
    text += `    Last activity: ${formatTime(latest)}\n`;
    text += `    Agents: ${agentList.join(', ') || 'none'}\n`;
    if (recentTasks.length > 0) {
      text += '    Recent tasks:\n';
      for (const t of recentTasks) text += `      • ${t}\n`;
    }
    text += '\n';
    data.push({
      group: source.name,
      transcripts: files.length,
      archived,
      messages: totalMessages,
      lastActivity: latest ? latest.toISOString() : null,
      agents: agentList,
      recentTasks,
    });
  }
  return { text, data: { groups: data } };
}

// ─── list ────────────────────────────────────────────────────────────────────

export function listCommand(
  ctx: ReaderContext,
  group: string,
  opts: CommandOptions = {},
): CommandResult {
  const { sinceMs, error } = resolveOptions(opts);
  if (error) return invalid(error);
  const source = ctx.resolveGroup(group);
  const all = filesFor(source, opts, sinceMs);
  if (all.length === 0) {
    return {
      text: `No transcripts found for group '${group}'.`,
      data: { group, transcripts: [] },
    };
  }
  const files = opts.limit && opts.limit > 0 ? all.slice(0, opts.limit) : all;

  let text = `=== Transcripts for '${group}' (${all.length} files${files.length < all.length ? `, showing ${files.length}` : ''}) ===\n\n`;
  const data: unknown[] = [];
  for (const f of files) {
    const messages = readFile(f, opts, sinceMs);
    let first: Date | null = null;
    let title = '';
    const agents = new Set<string>();
    for (const msg of messages) {
      if (msg.role === 'user' && !title) title = truncate(msg.content, 80);
      const ts = parseTimestamp(msg.created_at) || fileTime(f);
      if (!first || ts < first) first = ts;
      if (msg.agent_name) agents.add(msg.agent_name);
    }
    const agentList = [...agents];
    text += `  ${f.id}${f.archived ? ' (archived)' : ''}\n`;
    text += `    Date: ${formatTime(first)}  |  Messages: ${messages.length}${agentList.length ? ` [${agentList.join(', ')}]` : ''}\n`;
    if (title) text += `    Task: ${title}\n`;
    text += '\n';
    data.push({
      id: f.id,
      archived: f.archived,
      date: first ? first.toISOString() : null,
      messages: messages.length,
      agents: agentList,
      task: title,
    });
  }
  return { text, data: { group, total: all.length, transcripts: data } };
}

// ─── show ────────────────────────────────────────────────────────────────────

type Located =
  | {
      group: string;
      target: TranscriptFile;
      /** A task's raw run output, which holds its tool calls. */
      rawOutput?: TranscriptFile;
      /** Set when `id` was a run ID: `target` is the transcript holding it. */
      runId?: string;
      error?: undefined;
    }
  | { error: CommandResult };

/** Points from a task's message log to the raw output holding its tool calls. */
const rawOutputHint = (raw: TranscriptFile, command: string) =>
  `[Tool calls are logged in '${raw.id}': ${command}]`;

const RUN_ID = /^run-(\d{13})-[a-z0-9]{6}$/;
/** Archive member mtimes are whole seconds; allow for that and clock skew. */
const RUN_MTIME_SLACK_MS = 60_000;

const isRawOutput = (f: TranscriptFile) => f.fileName.endsWith('.output.jsonl');

/** A task's raw run output file, when `target` is its message log. */
const rawOutputOf = (files: TranscriptFile[], target: TranscriptFile) =>
  target.id.endsWith('.output')
    ? undefined
    : files.find((f) => f.id === `${target.id}.output`);

/**
 * The task transcript holding run `runId`. Only files modified since the run
 * started can contain it (the run's epoch is in its ID); the file-name date
 * is not usable because a re-run appends to the task's original file.
 */
function locateRun(
  ctx: ReaderContext,
  group: string | undefined,
  runId: string,
  opts: CommandOptions,
  sinceMs?: number,
): Located {
  const needle = `"run_id":"${runId}"`;
  const minMtimeMs = Number(RUN_ID.exec(runId)![1]) - RUN_MTIME_SLACK_MS;
  const sources =
    group === undefined ? ctx.listGroups() : [ctx.resolveGroup(group)];
  for (const source of sources) {
    const files = filesFor(source, opts, sinceMs);
    const target = files
      .filter((f) => f.mtimeMs >= minMtimeMs)
      .sort((a, b) => Number(isRawOutput(a)) - Number(isRawOutput(b)))
      .find((f) => f.readText().includes(needle));
    if (target) {
      return {
        group: source.name,
        target,
        rawOutput: rawOutputOf(files, target),
        runId,
      };
    }
  }
  const hint =
    !opts.archive && (group === undefined || hasArchives(sources[0].dir))
      ? ' Archives were not searched; pass --archive.'
      : '';
  const text = `Run '${runId}' not found in any task transcript${
    group === undefined ? '' : ` in group '${group}'`
  }.${hint} Run IDs resolve only for task runs.`;
  return {
    error: {
      text,
      data: { group: group ?? null, id: null, error: text, messages: [] },
    },
  };
}

/** The transcript `id` names in `group`, or in whichever group has it. */
function locate(
  ctx: ReaderContext,
  group: string | undefined,
  id: string | undefined,
  opts: CommandOptions,
  sinceMs?: number,
): Located {
  if (id && RUN_ID.test(id)) return locateRun(ctx, group, id, opts, sinceMs);
  if (group === undefined) {
    // No group: the id alone locates the transcript in whichever group has it.
    const found = ctx
      .listGroups()
      .find((g) =>
        filesFor(g, opts, sinceMs).some((f) => f.id.includes(id ?? '')),
      );
    if (!found) {
      const text = `Transcript '${id}' not found in any group.${
        opts.archive ? '' : ' Archives were not searched; pass --archive.'
      }`;
      return {
        error: {
          text,
          data: { group: null, id: null, error: text, messages: [] },
        },
      };
    }
    group = found.name;
  }
  const source = ctx.resolveGroup(group);
  const files = filesFor(source, opts, sinceMs);
  if (files.length === 0) {
    return {
      error: {
        text: `No transcripts found for group '${group}'.`,
        data: { group, id: null, messages: [] },
      },
    };
  }

  // A partial task id matches both a task's `.jsonl` and its raw `.output`
  // file; prefer the former, the latter stays reachable via `<id>.output`.
  const matches = id ? files.filter((f) => f.id.includes(id)) : files;
  const target = matches.find((f) => !f.id.endsWith('.output')) ?? matches[0];
  if (!target) {
    const hint =
      !opts.archive && hasArchives(source.dir)
        ? ' Archives were not searched; pass --archive.'
        : '';
    const text = `Task '${id}' not found in group '${group}'.${hint}`;
    return {
      error: { text, data: { group, id: null, error: text, messages: [] } },
    };
  }
  return { group, target, rawOutput: rawOutputOf(files, target) };
}

export function showCommand(
  ctx: ReaderContext,
  group: string | undefined,
  id: string | undefined,
  last: number | undefined,
  opts: CommandOptions = {},
): CommandResult {
  const { sinceMs, error } = resolveOptions(opts);
  if (error) return invalid(error);
  const located = locate(ctx, group, id, opts, sinceMs);
  if (located.error) return located.error;
  const { target, runId } = located;
  group = located.group;

  // Tool calls are always read so hidden ones can be counted in place.
  let messages = readFile(target, { ...opts, tools: true }, sinceMs, runId);
  const isShown = (m: TranscriptMessage) => !!opts.tools || m.kind !== 'tool';
  if (last && last > 0) {
    const shownAt = messages.flatMap((m, i) => (isShown(m) ? [i] : []));
    if (shownAt.length > last) {
      messages = messages.slice(shownAt[shownAt.length - last]);
    }
  }
  const shown = messages.filter(isShown);
  // The final agent reply is the outcome of the transcript: never truncated.
  const lastReply = [...shown]
    .reverse()
    .find((m) => m.role === 'assistant' && m.kind === 'message');
  const fullFor = (m: TranscriptMessage) => !!opts.full || m === lastReply;

  const title = runId ? `${target.id} · run ${runId}` : target.id;
  let text = `=== ${title} (${shown.length} messages) ===\n\n`;
  let hiddenRun = 0;
  const flushHidden = () => {
    if (hiddenRun === 0) return;
    text += `  [${hiddenRun} tool call${hiddenRun === 1 ? '' : 's'}; --tools shows them]\n\n`;
    hiddenRun = 0;
  };
  for (const msg of messages) {
    if (!isShown(msg)) {
      hiddenRun++;
      continue;
    }
    flushHidden();
    text += formatMessage(msg, fullFor(msg), fileTime(target)) + '\n\n';
  }
  flushHidden();
  const pointRaw =
    opts.tools && located.rawOutput && !messages.some((m) => m.kind === 'tool');
  if (pointRaw)
    text += `  ${rawOutputHint(located.rawOutput!, `show ${located.rawOutput!.id} --tools`)}\n\n`;
  return {
    text,
    data: {
      group,
      id: target.id,
      ...(runId ? { runId } : {}),
      archived: target.archived,
      ...(pointRaw ? { toolCallsIn: located.rawOutput!.id } : {}),
      ...(opts.tools
        ? {}
        : { hiddenToolCalls: messages.length - shown.length }),
      messages: shown.map((m) => messageData(m, fullFor(m))),
    },
  };
}

// ─── result ──────────────────────────────────────────────────────────────────

/**
 * At most `max` bytes of `text`, never splitting a character. Ends at the last
 * whitespace when that keeps at least half, so words stay whole without one
 * long token (a JSON line, base64) shrinking the output to almost nothing.
 */
function cutAtBytes(text: string, max: number): string {
  const buf = Buffer.from(text);
  let end = max;
  // Step back over UTF-8 continuation bytes to the start of a character.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  const prefix = buf.subarray(0, end).toString('utf8');
  const space = prefix.search(/\s\S*$/);
  return space >= prefix.length / 2 ? prefix.slice(0, space) : prefix;
}

/** One tool call (numbered as in `show --tools`) with its complete result. */
export function resultCommand(
  ctx: ReaderContext,
  group: string | undefined,
  id: string,
  n: number,
  opts: CommandOptions & { maxBytes?: number } = {},
): CommandResult {
  const located = locate(ctx, group, id, opts);
  if (located.error) return located.error;
  const { target } = located;
  // Unfiltered parse, so the numbering matches `show --tools`.
  const call = parseTranscriptText(target.readText(), {
    includeTools: true,
    full: true,
  }).find((m) => m.toolNo === n);
  if (!call) {
    const hint = located.rawOutput
      ? ` ${rawOutputHint(located.rawOutput, `result ${located.rawOutput.id} ${n}`)}`
      : '';
    return invalid(`Tool call #${n} not found in '${target.id}'.${hint}`);
  }

  const result = call.result;
  const bytes = result ? resultBytes(result) : 0;
  let text = result?.text ?? '';
  const truncated =
    opts.maxBytes !== undefined && opts.maxBytes > 0 && bytes > opts.maxBytes;
  if (truncated) text = cutAtBytes(text, opts.maxBytes!);
  const input =
    typeof call.toolInput === 'string'
      ? call.toolInput
      : JSON.stringify(call.toolInput ?? null, null, 2);
  const status = !result ? 'no result logged' : result.failed ? 'failed' : 'ok';

  let out = `=== ${target.id} tool call #${n} ===\n\n`;
  out += `${formatMessage({ ...call, content: `TOOL ${call.toolName}` }, true, fileTime(target))}\n\n`;
  out += `Input:\n${input}\n\n`;
  out += `Result (${status}, ${bytes} bytes):\n${text}\n`;
  if (truncated) {
    out += `\n[truncated: first ${Buffer.byteLength(text)} of ${bytes} bytes; raise --max-bytes to see more]\n`;
  }
  return {
    text: out,
    data: {
      group: located.group,
      id: target.id,
      n,
      name: call.toolName,
      created_at: call.created_at,
      agent_name: call.agent_name,
      input: call.toolInput ?? null,
      result: result ? { failed: result.failed, bytes, truncated, text } : null,
    },
  };
}

// ─── search ──────────────────────────────────────────────────────────────────

export function searchCommand(
  ctx: ReaderContext,
  query: string | string[],
  group: string | undefined,
  opts: CommandOptions = {},
): CommandResult {
  const { sinceMs, error } = resolveOptions(opts);
  if (error) return invalid(error);
  const terms = normalizeSearchTerms(query);
  const label = terms.join(' | ');
  const quoted = terms.map((t) => `'${t}'`).join(' | ');
  const multi = terms.length > 1;
  const groups = group ? [ctx.resolveGroup(group)] : ctx.listGroups();
  const limit =
    opts.limit && opts.limit > 0 ? opts.limit : DEFAULT_SEARCH_LIMIT;

  let total = 0;
  const termTotals: Record<string, number> = {};
  for (const term of terms) termTotals[term] = 0;
  const shown: Array<{
    group: string;
    id: string;
    archived: boolean;
    msg: TranscriptMessage;
    fallback: Date;
  }> = [];

  for (const source of groups) {
    for (const f of filesFor(source, opts, sinceMs)) {
      const hits = searchTranscriptText(f.readText(), terms, {
        includeTools: opts.tools,
        role: opts.role,
        sinceMs,
      });
      for (const hit of hits) {
        total++;
        for (const term of hit.matchedTerms) termTotals[term]++;
        if (shown.length < limit) {
          shown.push({
            group: source.name,
            id: f.id,
            archived: f.archived,
            msg: hit.msg,
            fallback: fileTime(f),
          });
        }
      }
    }
  }

  if (total === 0) {
    return {
      text: `No results found for ${quoted}.`,
      data: {
        query: label,
        ...(multi ? { terms, termTotals } : {}),
        total: 0,
        shown: 0,
        results: [],
      },
    };
  }

  let text = `=== Search results for ${quoted} (${total} matches) ===\n`;
  if (multi) {
    text += `Per term: ${terms.map((t) => `${t} ${termTotals[t]}`).join(', ')}\n`;
  }
  text += '\n';
  for (const r of shown) {
    text += `  [${r.group}] ${r.id}${r.archived ? ' (archived)' : ''}\n`;
    text += `    ${formatMessage(r.msg, !!opts.full, r.fallback)}\n\n`;
  }
  if (shown.length < total) {
    text += `Showing the first ${shown.length} of ${total} matches; use --limit N to show more.\n`;
  }
  return {
    text,
    data: {
      query: label,
      ...(multi ? { terms, termTotals } : {}),
      total,
      shown: shown.length,
      results: shown.map((r) => ({
        group: r.group,
        id: r.id,
        archived: r.archived,
        message: messageData(r.msg, !!opts.full),
      })),
    },
  };
}
