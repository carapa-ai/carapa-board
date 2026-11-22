import { Fragment, useMemo, useState } from 'react';
import { parseDiff, Diff, Hunk } from 'react-diff-view';
import 'react-diff-view/style/index.css';
import './changes-view.css';
import {
  AlertTriangle,
  ChevronRight,
  FileText,
  ImageIcon,
  Link,
  Loader2,
  Package,
} from 'lucide-react';
import { FILE_DRAG_TYPE } from '@/lib/drag-types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { ConversationDiff, ConversationDiffFile } from '@/types';

interface PatchFile {
  name: string;
  body: string;
  changeType: ChangeType;
  linkTarget?: string;
  renderError?: string;
  source: 'task' | 'default-checkout-blocker';
  status?: string;
  previousName?: string;
}

type ChangeType = 'new' | 'modified' | 'deleted' | 'renamed' | 'symlink';

const changeTypeLabels: Record<ChangeType, string> = {
  new: 'New',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
  symlink: 'Symlink',
};

/** Classifies a single unified diff section. Rename metadata takes precedence. */
function classifyPatchChange(body: string): ChangeType {
  if (/^rename (?:from|to) /m.test(body)) return 'renamed';
  if (
    /^(?:new file mode|deleted file mode|new mode|old mode) 120000$/m.test(
      body,
    ) ||
    /^index [0-9a-f]+\.\.[0-9a-f]+ 120000$/m.test(body)
  ) {
    return 'symlink';
  }
  if (
    /^new file mode /m.test(body) ||
    /^--- \/dev\/null(?:\t.*)?$/m.test(body)
  ) {
    return 'new';
  }
  if (
    /^deleted file mode /m.test(body) ||
    /^\+\+\+ \/dev\/null(?:\t.*)?$/m.test(body)
  ) {
    return 'deleted';
  }
  return 'modified';
}

/** Read link text from a symlink patch without touching its filesystem target. */
function linkTargetFromPatch(body: string): string | undefined {
  const deleted = /^deleted file mode 120000$/m.test(body);
  const marker = deleted ? '-' : '+';
  const targetLines: string[] = [];
  let inHunk = false;
  for (const line of body.split('\n')) {
    if (line.startsWith('@@ ')) {
      inHunk = true;
      continue;
    }
    if (inHunk && line.startsWith(marker)) targetLines.push(line.slice(1));
  }
  return targetLines.length > 0 ? targetLines.join('\n') : undefined;
}

function metadataFileToPatchFile(file: ConversationDiffFile): PatchFile {
  const status = file.status ?? '';
  const changeType: ChangeType =
    file.kind === 'symlink'
      ? 'symlink'
      : status.includes('D')
        ? 'deleted'
        : status.includes('R')
          ? 'renamed'
          : status === '??' || status.includes('A')
            ? 'new'
            : 'modified';
  return {
    name: file.path,
    body: '',
    changeType,
    linkTarget: file.linkTarget,
    renderError: file.renderError,
    source: file.source ?? 'task',
    status: file.status,
  };
}

/**
 * Decode a C-style quoted path as printed by git when `core.quotePath` applies.
 * Keep in sync with the copy in src/lib/git-ops.ts (the UI cannot import `src/`).
 */
function unquoteGitPath(path: string): string {
  if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"'))
    return path;
  const simple: Record<string, number> = {
    a: 7,
    b: 8,
    f: 12,
    n: 10,
    r: 13,
    t: 9,
    v: 11,
  };
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  const body = Array.from(path.slice(1, -1));
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\' || i === body.length - 1) {
      bytes.push(...encoder.encode(ch));
      continue;
    }
    const next = body[++i];
    const octal = /^[0-3][0-7]{2}$/.exec(body.slice(i, i + 3).join(''));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 2;
    } else if (next in simple) {
      bytes.push(simple[next]);
    } else {
      bytes.push(...encoder.encode(next));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Strip git's `a/` or `b/` side prefix from a possibly quoted diff path. */
function diffSidePath(raw: string, side: 'a' | 'b'): string {
  const path = unquoteGitPath(raw.replace(/\t.*$/, '').trim());
  return path.startsWith(`${side}/`) ? path.slice(2) : path;
}

function renameFrom(body: string): string | undefined {
  const raw = /^rename from (.+)$/m.exec(body)?.[1];
  return raw === undefined ? undefined : unquoteGitPath(raw);
}

/**
 * Split a unified diff into per-file sections and pull each filename directly
 * from the raw text. We do the naming ourselves (rather than trusting
 * react-diff-view's parser, which yields '/dev/null' or empty paths for some
 * entries) and only hand the per-file body to react-diff-view for rendering.
 */
export function splitPatch(patch: string): PatchFile[] {
  const lines = patch.replace(/\r/g, '').split('\n');
  const files: PatchFile[] = [];
  let cur: { name: string; lockedName: boolean; lines: string[] } | null = null;
  const push = () => {
    if (cur) {
      const body = cur.lines.join('\n');
      const changeType = classifyPatchChange(body);
      files.push({
        name: cur.name,
        body,
        changeType,
        ...(changeType === 'renamed' ? { previousName: renameFrom(body) } : {}),
        ...(changeType === 'symlink'
          ? { linkTarget: linkTargetFromPatch(body) }
          : {}),
        source: 'task',
      });
    }
  };
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      push();
      cur = { name: '', lockedName: false, lines: [line] };
      // "diff --git a/<old> b/<new>" — take the b-side as the name.
      const m = line.match(/ "?b\/.+$/);
      if (m) cur.name = diffSidePath(m[0].trim(), 'b');
    } else if (cur) {
      cur.lines.push(line);
      // The "+++ b/<path>" / "--- a/<path>" lines are authoritative when present.
      if (line.startsWith('+++ ')) {
        const p = diffSidePath(line.slice(4), 'b');
        if (p && p !== '/dev/null') {
          cur.name = p;
          cur.lockedName = true;
        }
      } else if (line.startsWith('--- ') && !cur.lockedName) {
        const p = diffSidePath(line.slice(4), 'a');
        if (p && p !== '/dev/null') cur.name = p;
      } else if (line.startsWith('rename to ') && !cur.lockedName) {
        cur.name = unquoteGitPath(line.slice('rename to '.length));
      }
    }
  }
  push();
  return files;
}

/**
 * Renders a git diff (worktree or working-tree scope). Files are collapsed by
 * default — click a filename to expand its diff. Shared by the conversation
 * Files & changes panel and the task detail dialog.
 */
export function ChangesView({
  diff,
  isLoading,
  isRefreshing = false,
  enableFileDrag = false,
  onProjectSetup,
  onIndexAction,
  onStageAll,
  pendingIndexPath,
  indexBusy = false,
  sectionView = false,
  indexAction,
}: {
  diff: ConversationDiff | undefined;
  isLoading: boolean;
  isRefreshing?: boolean;
  /** Lets the conversation Changes tab reference a diff file in the composer. */
  enableFileDrag?: boolean;
  onProjectSetup?: () => void;
  onIndexAction?: (
    path: string,
    action: 'stage' | 'unstage',
    previousPath?: string,
  ) => void;
  onStageAll?: () => void;
  pendingIndexPath?: string;
  indexBusy?: boolean;
  sectionView?: boolean;
  indexAction?: 'stage' | 'unstage';
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const patchFiles = useMemo(
    () => (diff?.available && diff.patch ? splitPatch(diff.patch) : []),
    [diff?.available, diff?.patch],
  );
  const renderedFiles = useMemo(() => {
    const taskMetadata = new Map(
      (diff?.files ?? []).map((file) => [file.path, file]),
    );
    const patched = patchFiles.map((file) => {
      const metadata = taskMetadata.get(file.name);
      return {
        ...file,
        changeType:
          metadata?.kind === 'symlink' ? ('symlink' as const) : file.changeType,
        linkTarget: metadata?.linkTarget ?? file.linkTarget,
        renderError: metadata?.renderError,
        status: metadata?.status,
      };
    });
    const patchedTaskPaths = new Set(patched.map((file) => file.name));
    const metadataOnly = (diff?.files ?? [])
      .filter(
        (file) =>
          !patchedTaskPaths.has(file.path) &&
          (file.kind === 'symlink' || !!file.renderError),
      )
      .map(metadataFileToPatchFile);
    const blockers = (diff?.blockers ?? []).map((file) =>
      metadataFileToPatchFile({ ...file, source: 'default-checkout-blocker' }),
    );
    return [...patched, ...metadataOnly, ...blockers];
  }, [diff?.blockers, diff?.files, patchFiles]);

  const taskStatByPath = new Map(
    (diff?.files ?? []).map((file) => [file.path, file] as const),
  );
  const blockerStatByPath = new Map(
    (diff?.blockers ?? []).map((file) => [file.path, file] as const),
  );
  const repositoryByPath = new Map(
    (diff?.repositories ?? []).flatMap((repository) =>
      repository.files.map((file) => [file.path, repository] as const),
    ),
  );

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
        <Loader2 className="size-4 animate-spin" /> Loading diff…
      </div>
    );
  }
  if (!diff?.available) {
    if (diff?.reason === 'not-initialized') {
      return (
        <div
          className="py-8 px-3 text-center space-y-2"
          data-ui="repository-not-initialized"
        >
          <p className="text-sm font-medium">Git is not initialized</p>
          <p className="text-sm text-muted-foreground">
            Ask the agent to initialize Git in this project's configured
            repository on the <code>{diff.defaultBranch || 'develop'}</code>{' '}
            branch, then refresh Changes. You can review the files here and
            create the first commit.
          </p>
          {onProjectSetup && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-ui="repository-initialize-setup"
              onClick={onProjectSetup}
            >
              Set up this project
            </Button>
          )}
        </div>
      );
    }
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        {diff?.reason === 'no-repo'
          ? 'Connect a repository in Project Settings → Repository → Repository Location, then recreate the sandbox to apply its mount.'
          : diff?.reason === 'no-worktree'
            ? "No code changes — this task isn't running in a git worktree."
            : "Couldn't read the git diff."}
      </p>
    );
  }
  if (
    renderedFiles.length === 0 &&
    !diff.changeSections?.some((section) => section.files.length > 0)
  ) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        {diff.repositoryState === 'unborn' ? (
          <>
            No commits yet on <code>{diff.branch}</code>. Add your app files and
            refresh Changes to create the first commit.
          </>
        ) : diff.scope === 'working-tree' ? (
          'No uncommitted changes in the repository.'
        ) : diff.scope === 'merged' ? (
          'No changes in the merge commit.'
        ) : (
          <>
            No changes against <code>{diff.base}</code>.
          </>
        )}
      </p>
    );
  }

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  return (
    <div
      className={cn(
        'cb-diff py-2 space-y-3 relative',
        isRefreshing && 'opacity-70',
      )}
    >
      {isRefreshing && (
        <div className="absolute top-0 right-0 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          Refreshing…
        </div>
      )}
      {!sectionView && diff.scope === 'working-tree' && (
        <p className="text-[11px] text-muted-foreground bg-muted/50 rounded px-2 py-1.5">
          {diff.repositoryState === 'unborn' ? (
            <>
              No commits yet on <code>{diff.branch}</code>. Review these files,
              stage the files to include, then create the first commit to enable
              worktrees.
            </>
          ) : (
            <>
              Uncommitted changes in the repo's working tree (shared across
              conversations — not isolated to this chat).
            </>
          )}
        </p>
      )}
      {!sectionView && (diff.blockers?.length ?? 0) > 0 && (
        <div
          data-ui="default-checkout-blockers"
          // Translucent amber fill reads on both themes; only the border tone is theme-swapped.
          className="flex items-start gap-2 rounded border border-amber-600/40 bg-amber-500/10 px-2.5 py-2 text-xs dark:border-amber-500/40"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-700 dark:text-amber-600" />
          <span>
            These entries are in the shared default checkout. They are not
            changes attributed to this task and do not prevent non-deploy
            completion, but integration remains pending until the checkout is
            clean.
          </span>
        </div>
      )}
      {!sectionView && (
        <div className="text-xs text-muted-foreground">
          {diff.scope === 'branch' || diff.scope === 'worktree' ? (
            <>
              <span className="font-mono">{diff.branch}</span> vs{' '}
              <span className="font-mono">{diff.base}</span>
              {diff.uncommitted && (
                <span className="ml-2 text-amber-700 dark:text-amber-500">
                  (uncommitted)
                </span>
              )}
            </>
          ) : diff.scope === 'merged' ? (
            <>
              merged commit{' '}
              <span className="text-foreground">
                {diff.branch?.slice(0, 8)}
              </span>
            </>
          ) : (
            <>
              {diff.repositoryState === 'unborn' ? (
                'Files for the first commit'
              ) : (
                <>working tree vs {diff.base}</>
              )}
            </>
          )}
        </div>
      )}

      {!sectionView && diff.changeSections ? (
        diff.changeSections.map((section) => (
          <section
            key={section.kind}
            data-ui={`${section.kind}-changes`}
            className="space-y-1"
          >
            <div className="flex items-center justify-between gap-2 px-1">
              <h3 className="text-xs font-medium text-foreground capitalize">
                {section.kind} changes ({section.files.length})
              </h3>
              {section.kind === 'unstaged' &&
                section.files.length > 0 &&
                onStageAll && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    data-ui="stage-all-changes"
                    disabled={indexBusy}
                    onClick={onStageAll}
                  >
                    Stage all
                  </Button>
                )}
            </div>
            {section.files.length ? (
              <ChangesView
                diff={{
                  ...diff,
                  files: section.files,
                  patch: section.patch,
                  changeSections: undefined,
                  blockers: undefined,
                }}
                isLoading={false}
                enableFileDrag={enableFileDrag}
                onIndexAction={
                  section.kind === 'committed' ? undefined : onIndexAction
                }
                indexAction={
                  section.kind === 'staged'
                    ? 'unstage'
                    : section.kind === 'unstaged'
                      ? 'stage'
                      : undefined
                }
                pendingIndexPath={pendingIndexPath}
                indexBusy={indexBusy}
                sectionView
              />
            ) : (
              <p className="text-[11px] text-muted-foreground px-1">
                No {section.kind} changes.
              </p>
            )}
          </section>
        ))
      ) : (
        <div className="space-y-2">
          {renderedFiles.map((file, i) => {
            const name = file.name || `file ${i + 1}`;
            const canDrag =
              enableFileDrag && !!file.name && file.source === 'task';
            const key = `${file.source}-${name}-${i}`;
            const isOpen = expanded.has(key);
            const changeTypeLabel = changeTypeLabels[file.changeType];
            const stat =
              file.source === 'default-checkout-blocker'
                ? blockerStatByPath.get(name)
                : taskStatByPath.get(name);
            const repository =
              file.source === 'task' ? repositoryByPath.get(name) : undefined;
            const previousRepository =
              i > 0 && renderedFiles[i - 1].source === 'task'
                ? repositoryByPath.get(renderedFiles[i - 1].name)?.name
                : undefined;
            const showRepositoryHeading =
              file.source === 'task' &&
              (diff.repositories?.length ?? 0) > 0 &&
              (i === 0 || repository?.name !== previousRepository);
            const isImg = /\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(name);
            const parsed =
              isOpen && file.body ? parseDiff(file.body)[0] : undefined;
            return (
              <Fragment key={key}>
                {showRepositoryHeading && (
                  <div className="flex items-center gap-1.5 px-1 pt-2 text-[11px] text-muted-foreground">
                    <Package className="size-3" />
                    <span className="font-medium text-foreground">
                      {repository?.name ?? 'Main repository'}
                    </span>
                    {repository && (
                      <span className="font-mono opacity-70">
                        {repository.branch} vs {repository.base}
                      </span>
                    )}
                  </div>
                )}
                <div
                  className="rounded-lg border border-border overflow-hidden"
                  data-ui="changed-file-row"
                  data-file-path={name}
                >
                  <div className="flex items-center bg-muted/50">
                    <button
                      data-ui="changed-file"
                      data-file-path={name}
                      data-change-type={file.changeType}
                      data-change-source={file.source}
                      data-link-target={file.linkTarget}
                      data-git-status={file.status}
                      draggable={canDrag}
                      onClick={() => toggle(key)}
                      onDragStart={(event) => {
                        if (!canDrag) return;
                        event.dataTransfer.setData(FILE_DRAG_TYPE, file.name);
                        event.dataTransfer.setData(
                          'text/plain',
                          `@${file.name}`,
                        );
                        event.dataTransfer.effectAllowed = 'copy';
                      }}
                      className={cn(
                        'min-w-0 flex-1 flex items-center gap-1.5 px-3 py-1.5 hover:bg-muted text-xs font-mono text-left',
                        canDrag && 'cursor-grab active:cursor-grabbing',
                      )}
                      title={
                        canDrag
                          ? 'Drag into chat to reference this file'
                          : undefined
                      }
                    >
                      <ChevronRight
                        className={`size-3 shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                      />
                      {file.changeType === 'symlink' ? (
                        <Link className="size-3 shrink-0" />
                      ) : isImg ? (
                        <ImageIcon className="size-3 shrink-0" />
                      ) : (
                        <FileText className="size-3 shrink-0" />
                      )}
                      <span className="truncate flex-1">{name}</span>
                      {file.linkTarget !== undefined && (
                        <span
                          className="truncate text-muted-foreground"
                          title={file.linkTarget}
                        >
                          → {file.linkTarget}
                        </span>
                      )}
                      {file.source === 'default-checkout-blocker' && (
                        // Translucent amber fill reads on both themes; only the text tone is theme-swapped.
                        <span className="shrink-0 rounded bg-amber-500/15 px-1 font-sans text-[10px] text-amber-700 dark:text-amber-400">
                          Default checkout
                        </span>
                      )}
                      <span
                        className={`cb-change-type cb-change-type-${file.changeType}`}
                      >
                        {changeTypeLabel}
                      </span>
                      {stat && (
                        <span className="shrink-0 flex items-center gap-1.5">
                          <span className="text-green-700 dark:text-green-400">
                            +{stat.additions}
                          </span>
                          <span className="text-red-600 dark:text-red-400">
                            -{stat.deletions}
                          </span>
                        </span>
                      )}
                    </button>
                    {onIndexAction && indexAction && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="shrink-0 mr-1"
                        data-ui="git-index-action"
                        data-file-path={name}
                        disabled={indexBusy}
                        onClick={() =>
                          onIndexAction(name, indexAction, file.previousName)
                        }
                      >
                        {pendingIndexPath === name ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : indexAction === 'unstage' ? (
                          'Unstage'
                        ) : (
                          'Stage'
                        )}
                      </Button>
                    )}
                  </div>
                  {isOpen && (
                    <div className="overflow-x-auto">
                      {parsed && parsed.hunks?.length ? (
                        <Diff
                          viewType="unified"
                          diffType={parsed.type}
                          hunks={parsed.hunks}
                        >
                          {(hunks: any[]) =>
                            hunks.map((hunk) => (
                              <Hunk key={hunk.content} hunk={hunk} />
                            ))
                          }
                        </Diff>
                      ) : (
                        <pre className="text-[11px] leading-relaxed px-3 py-2 whitespace-pre-wrap break-all text-muted-foreground">
                          {file.renderError ||
                            file.body ||
                            'No visual patch is available for this entry.'}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
