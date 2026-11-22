/**
 * Board side of platform/template promotion: builds the payload and has the
 * fixed `scripts/apply-promotion.ts` run in the promotion sandbox through
 * CarapaBox. Board has no write access to the repositories and none is added.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getPromotionConfig } from '../../config.js';
import { getSandboxClient } from '../../lib/mcp-client.js';
import { ipcReplica } from '../../sandbox/ipc-replica.js';
import { effectiveSandboxIpcDir } from '../../sandbox/effective-settings.js';
import { shellQuote } from '../../utils.js';
import { prepareGroupSandbox } from '../fs/sandbox-fs.js';
import {
  ProposalValidationError,
  type ProposalAction,
  type ItemProposalKind,
  type TargetLayer,
} from './actions.js';
import { lineDiff } from './diff.js';
import type { ExecutionOutcome } from './executor.js';
import {
  MAX_PROMOTION_BYTES,
  promotionBaseSchema,
  promotionFilePaths,
  promotionTarget,
  type PromotionBaseFile,
  type PromotionLayer,
  type PromotionPayload,
} from './promotion-targets.js';
import { fileChange, type ActionPreview, type PreviewFile } from './targets.js';

const SCRIPT_TIMEOUT_S = 120;
const MAX_REPORTED_OUTPUT = 2000;

export interface PromotionItem {
  id: string;
  title: string;
  target_layer: TargetLayer;
  kind: ItemProposalKind;
  name: string;
}

type WriteItem = Extract<ProposalAction, { type: 'write_item' }>;

/** Template layers accept a write_item approval and a plain dismissal only. */
export function assertPromotionActions(
  approve: ProposalAction,
  deny: ProposalAction | null,
): asserts approve is WriteItem {
  if (approve.type !== 'write_item') {
    throw new ProposalValidationError(
      'A platform or template proposal must approve with write_item',
    );
  }
  if (deny && deny.type !== 'none') {
    throw new ProposalValidationError(
      'A platform or template proposal can only be dismissed on deny',
    );
  }
}

function repoOf(item: PromotionItem) {
  const layer = item.target_layer as PromotionLayer;
  const target = promotionTarget(layer, item.kind, item.name);
  return { layer, target, kit: getPromotionConfig().kit };
}

function payloadFor(
  item: PromotionItem,
  action: WriteItem,
  baseHash: string | null,
): PromotionPayload {
  const { layer, kit } = repoOf(item);
  return {
    proposalId: item.id,
    title: item.title,
    layer,
    kind: item.kind,
    name: item.name,
    repoDir: kit.dir,
    branch: kit.branch,
    baseHash,
    files: action.files,
  };
}

/** The base files the script wrote in `hash` mode; null when it reported none. */
function readBaseFiles(hostDir: string): PromotionBaseFile[] | null {
  const file = path.join(hostDir, 'base.json');
  try {
    // Fail soft: the base only informs the preview, never the approval.
    if (fs.statSync(file).size > 4 * MAX_PROMOTION_BYTES) return null;
    const parsed = promotionBaseSchema.safeParse(
      JSON.parse(fs.readFileSync(file, 'utf8')),
    );
    return parsed.success ? parsed.data.files : null;
  } catch {
    return null;
  }
}

/** Run the script on a payload file in the sandbox IPC run directory. */
async function runScript(
  mode: 'hash' | 'apply',
  payload: PromotionPayload,
): Promise<{
  output: string;
  isError: boolean;
  baseFiles: PromotionBaseFile[] | null;
}> {
  const config = getPromotionConfig();
  const resolved = await prepareGroupSandbox(config.sandboxProject);
  const runName = `promotion-${randomUUID()}`;
  const hostDir = path.join(
    effectiveSandboxIpcDir(resolved.group, DATA_DIR),
    'runs',
    runName,
  );
  try {
    fs.mkdirSync(hostDir, { recursive: true });
    fs.writeFileSync(
      path.join(hostDir, 'payload.json'),
      JSON.stringify(payload),
    );
    await ipcReplica.flushPath(hostDir, { strict: true });
    // CarapaBox runs only trusted sandbox commands; this one runs
    // scripts/apply-promotion.ts from the given carapa-board checkout
    // (the kit is the repository it writes to).
    const result = await getSandboxClient().sandboxExec(
      resolved.stack,
      resolved.service,
      `carapa-promotion ${shellQuote(config.boardRepoDir)} ${mode} ${shellQuote(`/workspace/ipc/runs/${runName}/payload.json`)}`,
      { instance: resolved.instance, timeout: SCRIPT_TIMEOUT_S },
    );
    let baseFiles: PromotionBaseFile[] | null = null;
    if (mode === 'hash' && !result.isError) {
      // On a remote box the script's files live there: pull the run directory.
      await ipcReplica.flushPath(hostDir);
      baseFiles = readBaseFiles(hostDir);
    }
    return { output: result.stdout.trim(), isError: result.isError, baseFiles };
  } finally {
    fs.rmSync(hostDir, { recursive: true, force: true });
    await ipcReplica.flushPath(hostDir);
  }
}

function lastLine(output: string, prefix: string): string | null {
  const line = output
    .split('\n')
    .reverse()
    .find((l) => l.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : null;
}

/**
 * Hash and files of the target in the repository now, for a new proposal.
 * `files` is null when the script could not report them.
 */
export async function promotionBase(
  item: PromotionItem,
  action: WriteItem,
): Promise<{ hash: string; files: PromotionBaseFile[] | null }> {
  // Validates the name and file mapping before any call.
  const { layer, target } = repoOf(item);
  promotionFilePaths(target, item.kind, action.files);
  let result: Awaited<ReturnType<typeof runScript>>;
  try {
    result = await runScript('hash', payloadFor(item, action, null));
  } catch (err) {
    throw new ProposalValidationError(
      `The ${layer} target cannot be read through the promotion sandbox: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const hash = result.isError ? null : lastLine(result.output, 'HASH ');
  if (!hash) {
    throw new ProposalValidationError(
      `The ${layer} target cannot be checked: ${result.output.slice(0, MAX_REPORTED_OUTPUT) || 'no output'}`,
    );
  }
  return { hash, files: result.baseFiles };
}

/** Commit the proposal; null when the target changed since it was proposed. */
export async function applyPromotionProposal(
  item: PromotionItem & { base_hash: string },
  action: ProposalAction,
): Promise<ExecutionOutcome | null> {
  assertPromotionActions(action, null);
  const { target } = repoOf(item);
  const { output, isError } = await runScript(
    'apply',
    payloadFor(item, action, item.base_hash),
  );
  const sha = isError ? null : lastLine(output, 'COMMIT ');
  if (sha) {
    return {
      message: `Committed ${sha} to ${target.repo}. Agents see it after the next update_skill.sh.`,
      needsRefresh: false,
    };
  }
  if (lastLine(output, 'STALE:') !== null) return null;
  throw new Error(
    output.slice(0, MAX_REPORTED_OUTPUT) ||
      'The promotion script failed without output',
  );
}

/** The stored base of a proposal; null for one made before it was kept. */
export function parseBaseFiles(raw: unknown): PromotionBaseFile[] | null {
  const parsed = promotionBaseSchema.safeParse({ files: raw });
  return raw == null || !parsed.success ? null : parsed.data.files;
}

/**
 * How a proposed file differs from its stored base. Binary files and symbolic
 * links are not diffed: Approve removes or replaces them as a whole.
 */
function changeFromBase(
  base: PromotionBaseFile | undefined,
  after: string | undefined,
): Pick<PreviewFile, 'change' | 'diff'> {
  const afterBuffer =
    after === undefined ? undefined : Buffer.from(after, 'utf8');
  if (base?.encoding !== 'base64' && base?.encoding !== 'symlink') {
    return fileChange(
      base ? Buffer.from(base.content, 'utf8') : undefined,
      afterBuffer,
    );
  }
  const symlink = base.encoding === 'symlink';
  const before = Buffer.from(base.content, symlink ? 'utf8' : 'base64');
  if (!symlink && afterBuffer?.equals(before)) {
    return { change: 'unchanged', diff: '' };
  }
  return {
    change: afterBuffer ? 'modified' : 'removed',
    diff: [
      symlink ? `-[symlink to ${base.content}]` : '-[binary file]',
      ...(after === undefined ? [] : [lineDiff('', after)]),
    ].join('\n'),
  };
}

/**
 * What Approve will write and where, without contacting the sandbox. Files are
 * diffed against the target as it was when the proposal was made (the version
 * the base hash protects). Without a stored base the files are labelled
 * `unknown` rather than shown as added.
 */
export function previewPromotion(
  action: ProposalAction,
  item: PromotionItem,
  baseFiles: PromotionBaseFile[] | null,
): ActionPreview {
  const { target, kit } = repoOf(item);
  const proposed = action.type === 'write_item' ? action.files : [];
  const paths = promotionFilePaths(target, item.kind, proposed);
  const baseByPath = new Map(
    (baseFiles ?? []).map((file) => [file.path, file]),
  );
  const files: PreviewFile[] = proposed.map((file, index) =>
    baseFiles
      ? {
          path: paths[index],
          ...changeFromBase(
            // A rule is one file whatever its proposed path is called.
            item.kind === 'rule' ? baseFiles[0] : baseByPath.get(file.path),
            file.content,
          ),
        }
      : {
          path: paths[index],
          change: 'unknown',
          diff: lineDiff('', file.content),
        },
  );
  if (baseFiles && item.kind === 'skill') {
    // write_item replaces the whole item, so unlisted base files are deleted.
    const kept = new Set(proposed.map((file) => file.path));
    for (const base of baseFiles) {
      if (kept.has(base.path)) continue;
      files.push({
        path: `${target.itemPath}/${base.path}`,
        ...changeFromBase(base, undefined),
      });
    }
  }
  return {
    actionType: action.type,
    targetPath: '',
    exists: baseFiles ? baseFiles.length > 0 : false,
    replacesSymlink: false,
    symlinkTarget: null,
    contentHidden: false,
    files,
    problem: null,
    promotion: {
      repository: target.repo,
      branch: kit.branch,
      paths,
      previousContentAvailable: baseFiles !== null,
    },
  };
}
