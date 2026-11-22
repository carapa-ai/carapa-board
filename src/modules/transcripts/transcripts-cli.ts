/**
 * Command line for the shared `transcripts` skill. Bundled by
 * `bun run build:transcripts-skill` into the skill's `scripts/transcripts.mjs`;
 * keep imports limited to the dependency-free reader modules.
 */
import path from 'node:path';
import {
  type CommandOptions,
  type CommandResult,
  type ReaderContext,
  listCommand,
  resultCommand,
  searchCommand,
  showCommand,
  summaryCommand,
} from './reader-commands.js';
import {
  type GroupSource,
  discoverGroups,
  normalizeSearchTerms,
} from './reader-core.js';

const USAGE = `Usage:
  transcripts.mjs summary [--group G]
  transcripts.mjs list <group>
  transcripts.mjs show <task_or_conv_or_run_id> [--last N] [--full]
  transcripts.mjs show <group> [task_or_conv_id] [--last N] [--full]
  transcripts.mjs search <term> [<term>...] [--group G] [--full]
  transcripts.mjs result [group] <task_or_conv_id> <n> [--max-bytes N]

Options: --since YYYY-MM-DD  --role user|assistant  --tools  --archive
         --json  --limit N (search default 50)
         -- ends options, so a term may start with '-' (search -- -1);
         short flags accept -n=5 as well as -n 5
show --tools numbers tool calls (#n); result prints call #n with its output.
A run ID (run-<13 digits>-<6 chars>, from Run History) opens its task transcript;
show limits it to that run, result numbers tools across the whole transcript.
search with several terms ORs them in one pass and reports per-term counts.
Environment: TRANSCRIPTS_GROUP_ROOT, TRANSCRIPTS_DIR, TRANSCRIPTS_PROJECT`;

export interface CliResult {
  stdout: string;
  code: number;
}

class UsageError extends Error {}

interface Parsed {
  positional: string[];
  group?: string;
  last?: number;
  maxBytes?: number;
  json: boolean;
  options: CommandOptions;
}

const VALUE_FLAGS = new Set([
  '--group',
  '-g',
  '--last',
  '-n',
  '--since',
  '--role',
  '--limit',
  '--max-bytes',
]);

function positiveInt(flag: string, value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new UsageError(`${flag} expects a positive integer, got '${value}'.`);
  }
  return Number(value);
}

function parseArgs(args: string[]): Parsed {
  const parsed: Parsed = { positional: [], json: false, options: {} };
  let endOfOptions = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!endOfOptions && arg === '--') {
      endOfOptions = true;
      continue;
    }
    if (endOfOptions || !arg.startsWith('-') || arg === '-') {
      parsed.positional.push(arg);
      continue;
    }
    let flag = arg;
    let value: string | undefined;
    const eq = arg.indexOf('=');
    if (
      eq !== -1 &&
      (arg.startsWith('--') || VALUE_FLAGS.has(arg.slice(0, eq)))
    ) {
      flag = arg.slice(0, eq);
      value = arg.slice(eq + 1);
    }
    if (VALUE_FLAGS.has(flag)) {
      if (value === undefined) {
        value = args[++i];
        if (value === undefined) throw new UsageError(`${flag} needs a value.`);
      }
    }
    switch (flag) {
      case '--group':
      case '-g':
        parsed.group = value;
        break;
      case '--last':
      case '-n':
        parsed.last = positiveInt(flag, value!);
        break;
      case '--limit':
        parsed.options.limit = positiveInt(flag, value!);
        break;
      case '--max-bytes':
        parsed.maxBytes = positiveInt(flag, value!);
        break;
      case '--since':
        parsed.options.since = value;
        break;
      case '--role':
        if (value !== 'user' && value !== 'assistant') {
          throw new UsageError(`--role expects user or assistant.`);
        }
        parsed.options.role = value;
        break;
      case '--full':
      case '-f':
        parsed.options.full = true;
        break;
      case '--tools':
        parsed.options.tools = true;
        break;
      case '--archive':
        parsed.options.archive = true;
        break;
      case '--json':
        parsed.json = true;
        break;
      default:
        throw new UsageError(`Unknown option '${arg}'.`);
    }
  }
  return parsed;
}

function contextFromEnv(
  env: Record<string, string | undefined>,
): ReaderContext {
  const root = env.TRANSCRIPTS_GROUP_ROOT || '/workspace/group';
  const sharedDir = env.TRANSCRIPTS_DIR || path.join(root, 'transcripts');
  const sharedName = env.TRANSCRIPTS_PROJECT || 'shared';
  const groups = () => discoverGroups(root, { sharedName, sharedDir });
  return {
    listGroups: groups,
    resolveGroup: (name): GroupSource =>
      groups().find((g) => g.name === name) ?? {
        name,
        dir: path.join(root, name, 'transcripts'),
      },
  };
}

/** Run the CLI; never touches process state so it can be tested directly. */
export function runCli(
  argv: string[],
  env: Record<string, string | undefined> = {},
): CliResult {
  try {
    const [command, ...rest] = argv;
    if (!command || command === '--help' || command === '-h') {
      return { stdout: USAGE + '\n', code: command ? 0 : 1 };
    }
    const p = parseArgs(rest);
    const ctx = contextFromEnv(env);
    let result: CommandResult;
    switch (command) {
      case 'summary':
        result = summaryCommand(ctx, p.group, p.options);
        break;
      case 'list':
        if (!p.positional[0]) throw new UsageError('list needs <group>.');
        result = listCommand(ctx, p.positional[0], p.options);
        break;
      case 'show': {
        const [first, second] = p.positional;
        if (!first) throw new UsageError('show needs <id> or <group>.');
        // `show <id>` searches every group; `show <group> [id]` stays scoped.
        const isGroup =
          second !== undefined ||
          ctx.listGroups().some((g) => g.name === first);
        result = isGroup
          ? showCommand(ctx, first, second, p.last, p.options)
          : showCommand(ctx, undefined, first, p.last, p.options);
        break;
      }
      case 'result': {
        const args = p.positional;
        if (args.length < 2 || args.length > 3) {
          throw new UsageError('result needs [group] <id> <n>.');
        }
        const n = positiveInt('result <n>', args[args.length - 1]);
        const [group, id] = args.length === 3 ? args : [undefined, args[0]];
        result = resultCommand(ctx, group, id, n, {
          ...p.options,
          maxBytes: p.maxBytes,
        });
        break;
      }
      case 'search': {
        const terms = normalizeSearchTerms(p.positional);
        if (terms.length === 0) throw new UsageError('search needs <keyword>.');
        result = searchCommand(ctx, terms, p.group, p.options);
        break;
      }
      default:
        throw new UsageError(`Unknown command '${command}'.`);
    }
    const out = p.json ? JSON.stringify(result.data, null, 2) : result.text;
    return { stdout: out.endsWith('\n') ? out : out + '\n', code: 0 };
  } catch (err) {
    if (err instanceof UsageError) {
      return { stdout: `${err.message}\n\n${USAGE}\n`, code: 1 };
    }
    throw err;
  }
}
