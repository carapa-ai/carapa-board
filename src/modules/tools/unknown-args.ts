import { logger } from '../../logger.js';
import { isRecord } from '../../lib/type-guards.js';

const MAX_KEY_LENGTH = 64;
const MAX_LISTED_KEYS = 10;

/** Wrong names agents commonly use for the project parameter. */
const PROJECT_PARAM_ALIASES: Record<string, string> = {
  project_id: 'target_project',
  group_folder: 'target_project',
  project: 'target_project',
  projectId: 'target_project',
};
const TARGET_PROJECT_ALIASES: Record<string, string> = {
  target_project: 'project_id',
  project: 'project_id',
};

/** Keys in `args` that the tool's input shape does not declare. */
export function findUnknownArgKeys(
  shape: Record<string, unknown>,
  args: unknown,
): string[] {
  if (!isRecord(args)) return [];
  return Object.keys(args).filter((key) => !Object.hasOwn(shape, key));
}

function clip(key: string): string {
  return key.length > MAX_KEY_LENGTH ? `${key.slice(0, MAX_KEY_LENGTH)}…` : key;
}

/** Key names safe to log: capped in number and length. */
export function loggableKeys(keys: readonly string[]): string[] {
  return keys.slice(0, MAX_LISTED_KEYS).map(clip);
}

function suggestionFor(
  key: string,
  shape: Record<string, unknown>,
): string | undefined {
  const aliases =
    'target_project' in shape
      ? PROJECT_PARAM_ALIASES
      : 'project_id' in shape
        ? TARGET_PROJECT_ALIASES
        : undefined;
  return aliases && Object.hasOwn(aliases, key) ? aliases[key] : undefined;
}

/** Error text naming keys only, never argument values. */
export function formatUnknownArgsError(
  toolName: string,
  keys: readonly string[],
  shape: Record<string, unknown>,
): string {
  const listed = loggableKeys(keys);
  const extra =
    keys.length > MAX_LISTED_KEYS
      ? ` (+${keys.length - MAX_LISTED_KEYS} more)`
      : '';
  const accepted = Object.keys(shape).map(clip).join(', ') || '(none)';
  const suggestions = [
    ...new Set(keys.flatMap((key) => suggestionFor(key, shape) ?? [])),
  ];
  const hint = suggestions.length
    ? ` Did you mean ${suggestions.join(' or ')}?`
    : '';
  return `Unknown parameter(s) ${listed.join(', ')}${extra} for ${toolName}. Accepted: ${accepted}.${hint}`;
}

/**
 * MCP error result for a call carrying undeclared keys, or undefined when all
 * keys are declared. Logs key names only.
 */
export function rejectUnknownArgs(
  toolName: string,
  shape: Record<string, unknown>,
  args: unknown,
  groupFolder?: string,
) {
  const keys = findUnknownArgKeys(shape, args);
  if (keys.length === 0) return undefined;
  logger.warn(
    {
      tool: toolName,
      unknownKeys: loggableKeys(keys),
      group_folder: groupFolder,
    },
    'MCP tool call rejected: unknown arguments',
  );
  return {
    isError: true as const,
    content: [
      {
        type: 'text' as const,
        text: formatUnknownArgsError(toolName, keys, shape),
      },
    ],
  };
}
