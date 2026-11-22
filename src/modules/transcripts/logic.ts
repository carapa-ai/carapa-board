import path from 'path';
import { GROUPS_DIR } from '../../config.js';
import { getGroupDir } from '../../group-dir.js';
import {
  type ReaderContext,
  searchCommand,
  showCommand,
  summaryCommand,
  listCommand,
} from './reader-commands.js';
import { discoverGroups } from './reader-core.js';

const SHARED_GROUP = '(group)';

/** List available groups (including nested child groups under parents). */
export function getGroups(): string[] {
  return discoverGroups(GROUPS_DIR, { sharedName: SHARED_GROUP }).map(
    (g) => g.name,
  );
}

/** Resolve group name to its transcripts directory (hierarchy-aware). */
function resolveTranscriptDir(group: string): string {
  if (group === SHARED_GROUP) return path.join(GROUPS_DIR, 'transcripts');
  if (group.startsWith('obj-'))
    return path.join(GROUPS_DIR, 'objectives', group, 'transcripts');
  // Use getGroupDir() which respects parent/child nesting
  return path.join(getGroupDir(group), 'transcripts');
}

function contextFor(allowedGroups?: string[]): ReaderContext {
  const resolveGroup = (name: string) => ({
    name,
    dir: resolveTranscriptDir(name),
  });
  return {
    resolveGroup,
    listGroups: () =>
      getGroups()
        .filter((g) => !allowedGroups || allowedGroups.includes(g))
        .map(resolveGroup),
  };
}

export function getTranscriptSummary(
  filterGroup?: string,
  allowedGroups?: string[],
): string {
  return summaryCommand(contextFor(allowedGroups), filterGroup).text;
}

export function listTranscripts(group: string): string {
  return listCommand(contextFor(), group).text;
}

export function showTranscript(
  group: string,
  task_id?: string,
  lastN?: number,
  full = false,
): string {
  return showCommand(contextFor(), group, task_id, lastN, { full }).text;
}

export function searchTranscripts(
  query: string,
  filterGroup?: string,
  full = false,
  allowedGroups?: string[],
): string {
  return searchCommand(contextFor(allowedGroups), query, filterGroup, { full })
    .text;
}
