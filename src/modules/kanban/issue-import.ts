import { ISSUE_IMPORT_POLL_INTERVAL_MS } from '../../config.js';
import { getSandboxClient } from '../../lib/mcp-client.js';
import { logger } from '../../logger.js';
import { resolveEffectiveSandbox } from '../../sandbox/effective-settings.js';
import { getGroupByFolder, registeredGroups } from '../../state-manager.js';
import type { RegisteredGroup } from '../../types.js';
import { broadcast } from '../objectives/ws-events.js';
import { notifyUserSystem } from '../tools/push-tools.js';
import {
  createImportedIssueTask,
  getExternalIssueImportByTaskId,
  getTask,
  updateTask,
  type ExternalIssueIdentity,
  type ExternalIssueImport,
} from './db-kanban.js';
import { appendTaskMessageOnceAsync } from '../transcripts/transcript-store.js';
import type { Task, TaskMessage } from './types.js';
import { getGroupStages } from './stages.js';

const PAGE_SIZE = 20;
const COMMENT_PAGE_SIZE = 100;
const MAX_TASK_TITLE_LENGTH = 500;
const MAX_TASK_DESCRIPTION_LENGTH = 100_000;
const AUTH_BACKOFF_BASE_MS = 60 * 60 * 1000;
const AUTH_BACKOFF_MAX_MS = 6 * AUTH_BACKOFF_BASE_MS;
const authFailures = new Map<
  string,
  { consecutiveAuthFailures: number; nextAttemptAt: number }
>();

type IssueProvider = ExternalIssueIdentity['provider'];
const providerNames: Record<IssueProvider, string> = {
  gitlab: 'GitLab',
  github: 'GitHub',
};

interface ExternalIssue {
  provider: IssueProvider;
  number: number;
  title: string;
  description: string | null;
  url: string;
  labels: string[];
}

interface IssueComment {
  id: number;
  body: string;
  system: boolean;
  createdAt: string;
  updatedAt: string;
  author: string;
  url: string;
}

export interface ImportedIssueSyncResult {
  externalIssue: ExternalIssueImport;
  task: Task;
  comments: TaskMessage[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

const positiveInteger = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) > 0;

/** GitHub lists pull requests among a repository's issues. */
function isPullRequest(value: unknown): boolean {
  return record(value)?.pull_request !== undefined;
}

/** A GitLab issue (`iid`, `web_url`) or a GitHub issue (`number`, `html_url`). */
function parseIssue(value: unknown): ExternalIssue | null {
  const issue = record(value);
  if (!issue || typeof issue.title !== 'string') return null;
  const description = (body: unknown) =>
    typeof body === 'string' ? body : null;
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  if (positiveInteger(issue.iid) && typeof issue.web_url === 'string') {
    return {
      provider: 'gitlab',
      number: issue.iid,
      title: issue.title,
      description: description(issue.description),
      url: issue.web_url,
      labels: labels.filter(
        (label): label is string => typeof label === 'string',
      ),
    };
  }
  if (positiveInteger(issue.number) && typeof issue.html_url === 'string') {
    return {
      provider: 'github',
      number: issue.number,
      title: issue.title,
      description: description(issue.body),
      url: issue.html_url,
      labels: labels
        .map((label) => record(label)?.name)
        .filter((name): name is string => typeof name === 'string'),
    };
  }
  return null;
}

/** A GitLab note or a GitHub issue comment. */
function parseComment(
  value: unknown,
  issue: ExternalIssue,
): IssueComment | null {
  const comment = record(value);
  if (
    !comment ||
    !positiveInteger(comment.id) ||
    typeof comment.body !== 'string'
  ) {
    return null;
  }
  const author =
    record(issue.provider === 'github' ? comment.user : comment.author) ?? {};
  const login = issue.provider === 'github' ? author.login : author.username;
  const createdAt =
    typeof comment.created_at === 'string'
      ? comment.created_at
      : new Date().toISOString();
  return {
    id: comment.id,
    body: comment.body,
    system: comment.system === true,
    createdAt,
    updatedAt:
      typeof comment.updated_at === 'string' ? comment.updated_at : createdAt,
    author:
      typeof login === 'string'
        ? `@${login}`
        : typeof author.name === 'string'
          ? author.name
          : 'unknown user',
    url:
      issue.provider === 'github' && typeof comment.html_url === 'string'
        ? comment.html_url
        : issue.provider === 'github'
          ? `${issue.url}#issuecomment-${comment.id}`
          : `${issue.url}#note_${comment.id}`,
  };
}

/** Canonical project URL used as part of the durable issue identity. */
export function issueRepositoryFromUrl(
  provider: IssueProvider,
  issueUrl: string,
): string {
  const url = new URL(issueUrl);
  const pattern =
    provider === 'github'
      ? /^(\/[^/]+\/[^/]+)\/issues\/\d+\/?$/
      : /^(.*)\/-\/(?:issues|work_items)\/\d+\/?$/;
  const match = url.pathname.match(pattern);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !match?.[1]) {
    throw new Error(
      `Unexpected ${providerNames[provider]} issue URL: ${issueUrl}`,
    );
  }
  return `${url.origin}${match[1].replace(/\/$/, '')}`;
}

function taskTitle(issue: ExternalIssue): string {
  return (
    issue.title.trim().slice(0, MAX_TASK_TITLE_LENGTH) ||
    `${providerNames[issue.provider]} issue #${issue.number}`
  );
}

function taskDescription(issue: ExternalIssue): string {
  const metadata = [
    issue.labels.length > 0 ? `Labels: ${issue.labels.join(', ')}` : '',
    `Imported from [${providerNames[issue.provider]} issue #${issue.number}](${issue.url}).`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const footer = `\n\n---\n${metadata}`;
  const body = issue.description?.trim() ?? '';
  return `${body.slice(0, Math.max(0, MAX_TASK_DESCRIPTION_LENGTH - footer.length))}${footer}`;
}

function repositoryUrl(group: RegisteredGroup): string {
  const value = group.settings?.repositoryUrl?.trim();
  if (!value) throw new Error('Issue import requires a repository URL');
  return value;
}

async function callIssueTool(
  group: RegisteredGroup,
  input: Record<string, unknown>,
): Promise<unknown> {
  const sandbox = resolveEffectiveSandbox(group);
  const result = await getSandboxClient().callTool('sandbox_issues', {
    name: sandbox.stack,
    instance: sandbox.instance,
    // CarapaBox uses the GitLab or GitHub account its relay serves to this
    // container for the repository's server.
    service: sandbox.service,
    git_repo: repositoryUrl(group),
    ...input,
  });
  if (result.isError) {
    throw new Error(result.stdout || 'CarapaBox issue request failed');
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error('CarapaBox returned invalid JSON for issues');
  }
}

async function loadIssuePage(
  group: RegisteredGroup,
  page: number,
): Promise<{ issues: ExternalIssue[]; resultCount: number }> {
  const values = await callIssueTool(group, {
    action: 'list',
    state: 'open',
    page,
    per_page: PAGE_SIZE,
  });
  if (!Array.isArray(values)) {
    throw new Error('CarapaBox returned a non-list issue response');
  }
  const candidates = values.filter((value) => !isPullRequest(value));
  const issues = candidates.map(parseIssue).filter((issue) => issue !== null);
  if (issues.length !== candidates.length) {
    logger.warn(
      {
        project: group.folder,
        page,
        skipped: candidates.length - issues.length,
      },
      'Skipped malformed issues',
    );
  }
  return { issues, resultCount: values.length };
}

async function loadIssue(
  group: RegisteredGroup,
  issueNumber: number,
): Promise<ExternalIssue> {
  const value = await callIssueTool(group, {
    action: 'get',
    issue_number: issueNumber,
  });
  const issue = parseIssue(value);
  if (!issue) throw new Error('CarapaBox returned a malformed issue');
  return issue;
}

async function loadIssueComments(
  group: RegisteredGroup,
  issue: ExternalIssue,
): Promise<IssueComment[]> {
  const comments: IssueComment[] = [];
  for (let page = 1; ; page += 1) {
    const values = await callIssueTool(group, {
      action: 'list_comments',
      issue_number: issue.number,
      page,
      per_page: COMMENT_PAGE_SIZE,
    });
    if (!Array.isArray(values)) {
      throw new Error('CarapaBox returned a non-list comment response');
    }
    comments.push(
      ...values
        .map((value) => parseComment(value, issue))
        .filter((comment): comment is IssueComment => comment !== null),
    );
    if (values.length < COMMENT_PAGE_SIZE) break;
  }
  return comments;
}

/** Stable per comment revision; GitLab keeps the IDs it had before GitHub support. */
function commentMessageId(
  provider: IssueProvider,
  comment: IssueComment,
): string {
  const revision = Date.parse(comment.updatedAt);
  const kind = provider === 'github' ? 'github-comment' : 'gitlab-note';
  return `${kind}-${comment.id}-${Number.isFinite(revision) ? revision : 'original'}`;
}

/**
 * Fetch comments from the issue's source project and store them in the
 * transcript of the folder that currently holds the task.
 */
async function importIssueComments(
  sourceGroup: RegisteredGroup,
  transcriptFolder: string,
  taskId: string,
  issue: ExternalIssue,
): Promise<TaskMessage[]> {
  const appended: TaskMessage[] = [];
  const name = providerNames[issue.provider];
  for (const comment of await loadIssueComments(sourceGroup, issue)) {
    if (comment.system || !comment.body.trim()) continue;
    const message: TaskMessage = {
      id: commentMessageId(issue.provider, comment),
      task_id: taskId,
      role: 'user',
      entry_type: 'external_comment',
      content: `**${name} comment by ${comment.author}** ([open in ${name}](${comment.url}))\n\n${comment.body.trim()}`,
      created_at: comment.updatedAt,
    };
    if (await appendTaskMessageOnceAsync(transcriptFolder, message)) {
      appended.push(message);
    }
  }
  return appended;
}

/**
 * Refresh a task from its durable issue import identity. `group` is the
 * project that holds the task now; the issue is fetched through the project
 * that imported it, which keeps syncing after the task moves.
 */
export async function syncImportedIssue(
  group: RegisteredGroup,
  taskId: string,
): Promise<ImportedIssueSyncResult | undefined> {
  const externalIssue = await getExternalIssueImportByTaskId(taskId);
  if (!externalIssue) return undefined;
  const sourceGroup =
    externalIssue.projectId === group.folder
      ? group
      : getGroupByFolder(externalIssue.projectId);
  if (!sourceGroup) {
    throw new Error(
      `Source project ${externalIssue.projectId} of imported task ${taskId} is not registered`,
    );
  }
  const issue = await loadIssue(sourceGroup, externalIssue.issueNumber);
  await updateTask(taskId, {
    title: taskTitle(issue),
    description: taskDescription(issue),
  });
  const [task, comments] = await Promise.all([
    getTask(taskId),
    importIssueComments(sourceGroup, group.folder, taskId, issue),
  ]);
  if (!task) throw new Error(`Imported task ${taskId} no longer exists`);
  return { externalIssue, task, comments };
}

export async function importIssuesForProject(
  group: RegisteredGroup,
): Promise<number> {
  if (!group.settings?.issueImportEnabled) return 0;
  const enabledModes = group.settings.enabledModes ?? ['kanban', 'chat'];
  if (!enabledModes.includes('kanban')) return 0;
  const stages = getGroupStages(group).filter((stage) => !stage.inactive);
  // An active `requests` stage holds imported issues until the owner drags
  // them onward (approval); without it they land in the backlog as before.
  const requests = stages.some((stage) => stage.id === 'requests');
  if (!requests && !stages.some((stage) => stage.id === 'backlog')) {
    throw new Error(
      'Issue import requires an active requests or backlog stage',
    );
  }

  let imported = 0;
  let seen = 0;
  for (let page = 1; ; page += 1) {
    const { issues, resultCount } = await loadIssuePage(group, page);
    seen += issues.length;
    for (const issue of issues) {
      let repository: string;
      try {
        repository = issueRepositoryFromUrl(issue.provider, issue.url);
      } catch (error) {
        logger.warn(
          { project: group.folder, issue: issue.number, error },
          'Skipped issue with unparseable URL',
        );
        continue;
      }
      const task = await createImportedIssueTask(
        {
          project_id: group.folder,
          title: taskTitle(issue),
          description: taskDescription(issue),
          status: requests ? 'requests' : 'backlog',
          author: issue.provider,
          ownerUserId: group.user_id ?? null,
          lastTriggerSource: 'system',
          lastTriggeredAt: new Date().toISOString(),
        },
        {
          provider: issue.provider,
          repository,
          issueNumber: issue.number,
          issueUrl: issue.url,
        },
      );
      if (!task) continue;
      imported += 1;
      broadcast({ type: 'task_created', payload: task });
      if (requests && group.user_id) {
        void notifyUserSystem(group.user_id, group.folder, {
          summary: `New change request: ${task.title}`,
          content: `${task.title}\n\n${issue.url}`,
          source_id: `${issue.provider}-issue:${repository}#${issue.number}`,
          action_url: `/board/${encodeURIComponent(group.folder)}?taskId=${encodeURIComponent(task.id)}`,
        });
      }
      try {
        const comments = await importIssueComments(
          group,
          group.folder,
          task.id,
          issue,
        );
        for (const message of comments) {
          broadcast({
            type: 'task_message',
            payload: {
              task_id: task.id,
              project_id: group.folder,
              message,
            },
          });
        }
      } catch (error) {
        logger.warn(
          { project: group.folder, issue: issue.number, error },
          'Issue imported without comments',
        );
      }
    }
    if (resultCount < PAGE_SIZE) break;
  }

  logger.info(
    { project: group.folder, seen, imported },
    'Issue import poll completed',
  );
  return imported;
}

async function runIssueImportPoll(
  groups: readonly RegisteredGroup[] = Object.values(registeredGroups),
): Promise<void> {
  for (const group of groups) {
    if (!group.settings?.issueImportEnabled) continue;
    const previous = authFailures.get(group.folder);
    if (previous && Date.now() < previous.nextAttemptAt) continue;
    try {
      await importIssuesForProject(group);
      authFailures.delete(group.folder);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/API error \(HTTP (401|403)\)/.test(message)) {
        const consecutiveAuthFailures =
          (previous?.consecutiveAuthFailures ?? 0) + 1;
        const delay = Math.min(
          AUTH_BACKOFF_BASE_MS * 2 ** Math.min(consecutiveAuthFailures - 1, 3),
          AUTH_BACKOFF_MAX_MS,
        );
        authFailures.set(group.folder, {
          consecutiveAuthFailures,
          nextAttemptAt: Date.now() + delay,
        });
        if (!previous && group.user_id) {
          void notifyUserSystem(group.user_id, group.folder, {
            summary: `Issue import stopped: token rejected for ${group.folder}`,
            content: `The repository server rejected the token used to import issues for project ${group.folder}. Save a new token for the account named below in Provider accounts (account menu) → Code hosting; imports resume on the next attempt.\n\n${message.slice(0, 500)}`,
            // Persistent source ID deduplication would suppress later revocations
            // with a fixed ID, so each failure streak needs its own ID.
            source_id: `issue-import-auth:${group.folder}:${crypto.randomUUID()}`,
          });
        }
      }
      logger.error({ project: group.folder, error }, 'Issue import failed');
    }
  }
}

export function startIssueImportPoller(
  intervalMs = ISSUE_IMPORT_POLL_INTERVAL_MS,
): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runIssueImportPoll();
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
