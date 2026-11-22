/**
 * Opt-in merge risk gate. A project repository may define
 * `.agent/merge-risk.json` on its default branch; a task branch that touches a
 * file covered by one of its rules must not merge without an applied human
 * approval for the exact task head commit.
 *
 * Fail-closed: once the rules file exists on the default branch, an invalid
 * file, a failing git command or an oversized diff gates the merge. The rules
 * are read from the default branch only, never from the task branch, because
 * the coding agent can edit its own branch.
 */
import type { RegisteredGroup } from '../../../types.js';
import type { TaskBranchMergeResult } from '../../../lib/git-ops.js';
import {
  parseGitPathList,
  runGitInRepo,
  validatedInstance,
} from '../../../lib/git-ops.js';
import { hasAppliedMergeApproval } from '../../proposals/db-proposals.js';
import {
  formatMergeFindings,
  MAX_STORED_FINDINGS,
  mergeApprovalLink,
  requestMergeApproval,
} from '../../proposals/merge-approval.js';
import type { MergeFinding } from '../../proposals/actions.js';
import { logger } from '../../../logger.js';
import { isValidGitBranchName } from '../../../lib/git-ref-name.js';
import { shellQuote } from '../../../utils.js';
import type { Task } from '../types.js';
import { isRecord } from '../../../lib/type-guards.js';

const MERGE_RISK_CONFIG_PATH = '.agent/merge-risk.json';
export const MERGE_APPROVAL_REQUIRED_PREFIX =
  '**Review approved, human approval required**';

const MAX_RULES = 100;
const MAX_PATHS_PER_RULE = 50;
const MAX_REASON_CHARS = 200;
const MAX_CHANGED_FILES = 2000;
const MAX_FILE_DIFF_BYTES = 1024 * 1024;
const MAX_LISTED_FINDINGS = 30;
const RULE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

interface MergeRiskFinding {
  ruleId: string;
  file: string;
  reason: string;
}

export type MergeRiskClassification =
  /** `headSha` is the head that was evaluated, set when rules applied. */
  | { gated: false; headSha?: string }
  | { gated: true; headSha: string; findings: MergeRiskFinding[] };

export interface MergeRiskDependencies {
  runGit: (
    group: RegisteredGroup,
    gitArgs: string,
    instance?: string,
  ) => Promise<{ ok: boolean; output: string }>;
  isMergeApproved: (taskId: string, headSha: string) => Promise<boolean>;
}

const defaultDependencies: MergeRiskDependencies = {
  runGit: runGitInRepo,
  isMergeApproved: hasAppliedMergeApproval,
};

interface MergeRiskRule {
  id: string;
  paths: Bun.Glob[];
  addedLinePattern?: RegExp;
  reason: string;
}

type ParsedRules =
  | { ok: true; rules: MergeRiskRule[] }
  | { ok: false; error: string };

const RULE_KEYS = new Set(['id', 'paths', 'added_line_pattern', 'reason']);

function parseRule(raw: unknown, index: number): MergeRiskRule | string {
  const where = `rules[${index}]`;
  if (!isRecord(raw)) {
    return `${where} must be an object`;
  }
  const rule = raw as Record<string, unknown>;
  const unknownKey = Object.keys(rule).find((key) => !RULE_KEYS.has(key));
  if (unknownKey) return `${where} has unknown key "${unknownKey}"`;
  if (typeof rule.id !== 'string' || !RULE_ID_PATTERN.test(rule.id)) {
    return `${where}.id must match ${RULE_ID_PATTERN}`;
  }
  if (
    !Array.isArray(rule.paths) ||
    rule.paths.length < 1 ||
    rule.paths.length > MAX_PATHS_PER_RULE ||
    rule.paths.some((glob) => typeof glob !== 'string' || glob === '')
  ) {
    return `${where}.paths must be 1..${MAX_PATHS_PER_RULE} non-empty globs`;
  }
  if (
    typeof rule.reason !== 'string' ||
    rule.reason.length > MAX_REASON_CHARS
  ) {
    return `${where}.reason must be a string of at most ${MAX_REASON_CHARS} characters`;
  }
  let addedLinePattern: RegExp | undefined;
  if (rule.added_line_pattern !== undefined) {
    if (typeof rule.added_line_pattern !== 'string') {
      return `${where}.added_line_pattern must be a string`;
    }
    try {
      addedLinePattern = new RegExp(rule.added_line_pattern);
    } catch {
      return `${where}.added_line_pattern is not a valid regular expression`;
    }
  }
  try {
    return {
      id: rule.id,
      paths: (rule.paths as string[]).map((glob) => new Bun.Glob(glob)),
      addedLinePattern,
      reason: rule.reason,
    };
  } catch {
    return `${where}.paths contains an invalid glob`;
  }
}

function parseRules(text: string): ParsedRules {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: 'not valid JSON' };
  }
  if (!isRecord(json)) {
    return { ok: false, error: 'top level must be an object' };
  }
  const config = json as Record<string, unknown>;
  if (Object.keys(config).some((key) => key !== 'rules')) {
    return { ok: false, error: 'only the "rules" key is allowed' };
  }
  if (!Array.isArray(config.rules) || config.rules.length > MAX_RULES) {
    return {
      ok: false,
      error: `"rules" must be an array of at most ${MAX_RULES}`,
    };
  }
  const rules: MergeRiskRule[] = [];
  for (const [index, raw] of config.rules.entries()) {
    const rule = parseRule(raw, index);
    if (typeof rule === 'string') return { ok: false, error: rule };
    if (rules.some((existing) => existing.id === rule.id)) {
      return { ok: false, error: `duplicate rule id "${rule.id}"` };
    }
    rules.push(rule);
  }
  return { ok: true, rules };
}

/** A patch git could not render as text (added lines carry a `+` prefix). */
const OPAQUE_PATCH_PATTERN = /^(Binary files .* differ|GIT binary patch)$/m;

/**
 * Added lines of a single-file `git diff -U0` patch. File headers (including
 * their `+++` line) precede the first hunk; inside hunks every `+` line is an
 * addition, even one whose content itself starts with `++`.
 */
function addedLines(patch: string): string[] {
  const added: string[] = [];
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (!inHunk) {
      inHunk = line.startsWith('@@');
    } else if (line.startsWith('+')) {
      added.push(line.slice(1));
    }
  }
  return added;
}

/**
 * Classify the task branch against the rules on the default branch. Never
 * throws: every failure while the rules file exists becomes a finding.
 */
export async function classifyMergeRisk(
  task: Task,
  group: RegisteredGroup,
  dependencies: MergeRiskDependencies = defaultDependencies,
): Promise<MergeRiskClassification> {
  const mode = group.settings?.taskCheckoutMode;
  if (!task.branch_name || (mode !== 'worktree' && mode !== 'branch')) {
    return { gated: false };
  }
  const branch = task.branch_name;
  const defaultBranch = group.settings?.defaultBranch || 'develop';
  const instance = validatedInstance(task, group);
  const git = (args: string) => dependencies.runGit(group, args, instance);
  let headSha = '';
  const gate = (findings: MergeRiskFinding[]): MergeRiskClassification => ({
    gated: true,
    headSha,
    findings,
  });
  const configFinding = (ruleId: string, reason: string): MergeRiskFinding => ({
    ruleId,
    file: MERGE_RISK_CONFIG_PATH,
    reason,
  });
  const failure = (what: string) =>
    gate([configFinding('merge-risk-error', `${what}; treated as risky`)]);

  if (!isValidGitBranchName(defaultBranch) || !isValidGitBranchName(branch)) {
    return failure('Invalid branch name');
  }

  // `ls-tree` exits 0 with empty output for an absent path, which separates
  // "the project has no rules" from a git error.
  const listed = await git(
    `ls-tree --name-only ${shellQuote(defaultBranch)} -- ${shellQuote(MERGE_RISK_CONFIG_PATH)}`,
  );
  if (!listed.ok) return failure('Could not read the default branch');
  if (listed.output.trim() === '') return { gated: false };

  const head = await git(
    `rev-parse --verify ${shellQuote(`refs/heads/${branch}`)}`,
  );
  headSha = head.output.trim();
  if (!head.ok || !/^[0-9a-f]{7,64}$/.test(headSha)) {
    headSha = '';
    return failure('Could not resolve the task branch head');
  }

  const shown = await git(
    `show ${shellQuote(`${defaultBranch}:${MERGE_RISK_CONFIG_PATH}`)}`,
  );
  if (!shown.ok) return failure('Could not read the rules file');
  const parsed = parseRules(shown.output);
  if (!parsed.ok) {
    return gate([
      configFinding(
        'merge-risk-invalid-config',
        `${MERGE_RISK_CONFIG_PATH} on ${defaultBranch} is invalid (${parsed.error})`,
      ),
    ]);
  }

  const base = await git(`merge-base ${shellQuote(defaultBranch)} ${headSha}`);
  const baseSha = base.output.trim();
  if (!base.ok || !/^[0-9a-f]{7,64}$/.test(baseSha)) {
    return failure('Could not find the merge base');
  }
  const names = await git(
    `diff --name-only --no-renames -z ${baseSha} ${headSha}`,
  );
  if (!names.ok) return failure('Could not list the changed files');
  const files = parseGitPathList(names.output);

  const findings: MergeRiskFinding[] = [];
  if (files.includes(MERGE_RISK_CONFIG_PATH)) {
    findings.push(
      configFinding('merge-risk-config', 'Task changes the merge risk rules'),
    );
  }
  if (files.length > MAX_CHANGED_FILES) {
    findings.push(
      configFinding(
        'merge-risk-too-large',
        `More than ${MAX_CHANGED_FILES} changed files`,
      ),
    );
    return gate(findings);
  }

  // `--text` ignores `-diff`/binary attributes and heuristics, and the other
  // flags skip configured drivers, so patches are raw text.
  const diffArgs = `diff -U0 --text --no-ext-diff --no-textconv --no-color --no-renames ${baseSha} ${headSha}`;
  const patches = new Map<string, Promise<{ ok: boolean; output: string }>>();
  const patchOf = (file: string) => {
    let patch = patches.get(file);
    if (!patch) {
      patch = git(`${diffArgs} -- ${shellQuote(file)}`);
      patches.set(file, patch);
    }
    return patch;
  };

  // The size limit applies to every changed file, matched by a rule or not.
  // One diff of the whole range screens it: when that is within the limit, no
  // single file can exceed it; otherwise measure each file on its own.
  const tooLarge = new Set<string>();
  const screen = await git(diffArgs);
  if (!screen.ok) return failure('Could not read the diff');
  if (Buffer.byteLength(screen.output) > MAX_FILE_DIFF_BYTES) {
    for (const file of files) {
      const patch = await patchOf(file);
      if (!patch.ok) {
        findings.push({
          ruleId: 'merge-risk-error',
          file,
          reason: 'Could not read the file diff; treated as risky',
        });
      } else if (Buffer.byteLength(patch.output) > MAX_FILE_DIFF_BYTES) {
        tooLarge.add(file);
        findings.push({
          ruleId: 'merge-risk-too-large',
          file,
          reason: 'File diff is larger than 1 MB',
        });
      }
    }
  }

  for (const file of files) {
    const matching = parsed.rules.filter((rule) =>
      rule.paths.some((glob) => glob.match(file)),
    );
    let added: string[] | undefined;
    for (const rule of matching) {
      if (rule.addedLinePattern) {
        // An oversize file is already gated; its patch is not parsed.
        if (tooLarge.has(file)) continue;
        if (!added) {
          const patch = await patchOf(file);
          if (!patch.ok || OPAQUE_PATCH_PATTERN.test(patch.output)) {
            findings.push({
              ruleId: 'merge-risk-error',
              file,
              reason: patch.ok
                ? 'File diff is not textual; treated as risky'
                : 'Could not read the file diff; treated as risky',
            });
            break;
          }
          added = addedLines(patch.output);
        }
        const pattern = rule.addedLinePattern;
        if (!added.some((line) => pattern.test(line))) continue;
      }
      findings.push({ ruleId: rule.id, file, reason: rule.reason });
    }
  }
  return findings.length > 0 ? gate(findings) : { gated: false, headSha };
}

/** Notice body shared by every caller that parks a card on this failure. */
function buildApprovalRequiredNotice(
  mergeOutput: string,
  parkedStageId?: string,
): string {
  return (
    `${MERGE_APPROVAL_REQUIRED_PREFIX} — the branch changes files covered by the project's merge risk rules, so it was not merged. ` +
    `A person must approve this exact commit before it can merge.` +
    (parkedStageId
      ? ` The task was paused in \`${parkedStageId}\` so no reviewer or conflict resolver is started.`
      : ' No reviewer or conflict resolver is started.') +
    `\n\n${mergeOutput}`
  );
}

/** The approval a human can decide for a held merge. */
export interface MergeApprovalDetails {
  proposalId: string;
  headSha: string;
  findings: MergeFinding[];
}

/**
 * {@link buildApprovalRequiredNotice} plus the link to the approval card,
 * creating the approval for the held head if it does not exist yet. Parking the
 * card must never depend on the approval store, so a failure only drops the
 * link (and the approval details). `resume` says the human's approval
 * continues the merge by itself (a review-parked card); otherwise the card has
 * to be moved again.
 */
export async function requestApprovalForHeldMerge(
  task: Task,
  group: RegisteredGroup,
  result: TaskBranchMergeResult,
  options: { parkedStageId?: string; resume: boolean },
  dependencies: MergeRiskDependencies = defaultDependencies,
): Promise<{ notice: string; approval?: MergeApprovalDetails }> {
  const notice = buildApprovalRequiredNotice(
    result.output,
    options.parkedStageId,
  );
  try {
    // The final head check refuses a branch that moved after classification
    // without findings; classify the current head (outside the merge
    // transaction) so that head gets its own approval.
    let approval = result.approval;
    if (!approval) {
      const current = await classifyMergeRisk(task, group, dependencies);
      if (!current.gated || !current.headSha) return { notice };
      approval = { headSha: current.headSha, findings: current.findings };
    }
    const request = await requestMergeApproval(
      task,
      approval.headSha,
      approval.findings,
      { resume: options.resume },
    );
    const link = mergeApprovalLink(task.project_id, request.conversationId);
    return {
      notice:
        `${notice}\n\n[Review and decide the merge approval](${link}). ` +
        (options.resume
          ? 'Approving it resumes the merge.'
          : 'After approving it, move the card again; the merge then passes the gate.'),
      approval: {
        proposalId: request.proposalId,
        headSha: approval.headSha,
        findings: approval.findings.slice(0, MAX_STORED_FINDINGS),
      },
    };
  } catch (err) {
    logger.warn(
      { task_id: task.id, error: String(err) },
      '[merge] Could not request merge approval',
    );
    return { notice };
  }
}

/** The notice text of {@link requestApprovalForHeldMerge}. */
export async function approvalRequiredNotice(
  ...args: Parameters<typeof requestApprovalForHeldMerge>
): Promise<string> {
  return (await requestApprovalForHeldMerge(...args)).notice;
}

export interface MergeRiskVerdict {
  /** Set when the merge must not proceed. */
  blocked?: TaskBranchMergeResult;
  /**
   * The head sha that was classified (and approved, if it was gated). Pass it
   * to {@link ensureBranchAtPinnedHead} at merge execution.
   */
  pinnedHead?: string;
}

function approvalRequired(
  output: string,
  approval?: TaskBranchMergeResult['approval'],
): TaskBranchMergeResult {
  return {
    mergeOk: false,
    failureKind: 'approval_required',
    output,
    ...(approval ? { approval } : {}),
  };
}

/**
 * Gate one merge attempt: classify, then look up the approval for the exact
 * head. Touches the database, so never call it inside a database transaction.
 */
export async function evaluateMergeRisk(
  task: Task,
  group: RegisteredGroup,
  source: string,
  dependencies: MergeRiskDependencies = defaultDependencies,
): Promise<MergeRiskVerdict> {
  const classification = await classifyMergeRisk(task, group, dependencies);
  if (!classification.gated) return { pinnedHead: classification.headSha };
  const { headSha, findings } = classification;
  const approved = await dependencies.isMergeApproved(task.id, headSha);
  // Rule ids and paths only; never diff content.
  logger.info(
    {
      task_id: task.id,
      project: task.project_id,
      source,
      headSha,
      approved,
      ruleIds: [...new Set(findings.map((finding) => finding.ruleId))],
    },
    '[merge] Merge risk gate decision',
  );
  if (approved) return { pinnedHead: headSha };
  return {
    blocked: approvalRequired(
      formatMergeFindings(
        headSha,
        findings.slice(0, MAX_LISTED_FINDINGS),
        Math.max(0, findings.length - MAX_LISTED_FINDINGS),
      ),
      { headSha, findings },
    ),
  };
}

/**
 * Enforce the classified head at merge execution: git only (it runs inside the
 * merge's database transaction), and the last check before the sandbox merge.
 * A branch that moved since classification is refused, because neither the
 * classification nor the approval covers the new head.
 */
export async function ensureBranchAtPinnedHead(
  task: Task,
  group: RegisteredGroup,
  pinnedHead: string | undefined,
  dependencies: MergeRiskDependencies = defaultDependencies,
): Promise<TaskBranchMergeResult | undefined> {
  if (!pinnedHead || !task.branch_name) return undefined;
  const head = await dependencies.runGit(
    group,
    `rev-parse --verify ${shellQuote(`refs/heads/${task.branch_name}`)}`,
    validatedInstance(task, group),
  );
  const current = head.output.trim();
  if (head.ok && current === pinnedHead) return undefined;
  logger.info(
    { task_id: task.id, project: task.project_id, pinnedHead, current },
    '[merge] Task branch moved after merge risk classification',
  );
  if (head.ok) {
    // Only a gated head needs a person. A head that no rule covers is just a
    // race: fail retryably so the next attempt classifies and pins it, rather
    // than parking the card on an approval that does not exist.
    const reclassified = await classifyMergeRisk(task, group, dependencies);
    if (!reclassified.gated) {
      return {
        mergeOk: false,
        failureKind: 'environment',
        output: `[env] The task branch moved from \`${pinnedHead}\` to \`${current}\` after the merge risk check; retry to classify the new head.`,
      };
    }
  }
  return approvalRequired(
    head.ok
      ? `The task branch moved from \`${pinnedHead}\` to \`${current}\` after the merge risk check; the new head needs its own check.`
      : `The task branch head could not be re-read after the merge risk check (was \`${pinnedHead}\`).`,
  );
}
