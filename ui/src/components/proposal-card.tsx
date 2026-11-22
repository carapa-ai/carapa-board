import { useEffect, useState, type ReactNode } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import {
  decideProposal,
  getProposal,
  type MergeApproval,
  type Proposal,
  type ProposalActionPreview,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** How often a card re-reads a proposal that another request is applying. */
const APPLYING_POLL_MS = 1500;

const ACTION_LABELS: Record<
  ProposalActionPreview['actionType'],
  (
    kind: Proposal['kind'],
    preview: ProposalActionPreview,
    prompt: Proposal['prompt'],
  ) => string
> = {
  write_item: (kind) =>
    kind === 'skill'
      ? 'Replace the whole skill folder'
      : 'Replace the rule file',
  delete_item: (kind) =>
    kind === 'skill' ? 'Delete the skill folder' : 'Delete the rule file',
  mark_local: () => 'Add local: true to the frontmatter',
  none: () => 'Change nothing',
  merge_task: () => 'Merge the task branch',
  set_prompt: (_kind, preview, prompt) =>
    preview.files[0]?.change === 'removed'
      ? 'Remove the prompt'
      : `Replace the ${prompt?.promptType} prompt`,
};

function promptFilename(prompt: NonNullable<Proposal['prompt']>): string {
  return prompt.promptType === 'stage'
    ? `stage-${prompt.stageId}.md`
    : `${prompt.promptType}.md`;
}

const STATUS_LABELS: Record<Proposal['status'], string> = {
  pending: 'Waiting for you',
  applying: 'Applying…',
  applied: 'Approved and applied',
  denied: 'Denied',
  failed: 'Failed',
  stale: 'Stale — nothing written',
};

function statusLabel(proposal: Proposal): string {
  return proposal.kind === 'merge' && proposal.status === 'applied'
    ? 'Approved'
    : STATUS_LABELS[proposal.status];
}

/** Rule, file and reason of each finding that held a merge. */
export function MergeFindingsList({
  findings,
  omitted = 0,
}: {
  findings: MergeApproval['findings'];
  omitted?: number;
}) {
  return (
    <ul data-ui="merge-approval-findings" className="mt-1.5 space-y-1">
      {findings.map((finding, index) => (
        <li
          key={index}
          data-ui="merge-approval-finding"
          className="text-xs text-muted-foreground"
        >
          <code>{finding.ruleId}</code> · <code>{finding.file}</code>
          <span className="block">{finding.reason}</span>
        </li>
      ))}
      {omitted > 0 && (
        <li className="text-xs text-muted-foreground">… and {omitted} more</li>
      )}
    </ul>
  );
}

/** Task, exact commit and the rules that held the merge; no file diff. */
function MergeSummary({
  projectId,
  merge,
}: {
  projectId: string;
  merge: MergeApproval;
}) {
  return (
    <section data-ui="merge-approval" data-task-id={merge.taskId}>
      <p className="text-sm">
        Task{' '}
        <a
          data-ui="merge-approval-task"
          className="underline underline-offset-2"
          href={`/board/${encodeURIComponent(projectId)}?taskId=${encodeURIComponent(merge.taskId)}`}
        >
          {merge.taskTitle ?? merge.taskId}
        </a>
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Commit{' '}
        <code data-ui="merge-approval-head" title={merge.headSha}>
          {merge.headSha.slice(0, 12)}
        </code>
      </p>
      <MergeFindingsList findings={merge.findings} omitted={merge.omitted} />
    </section>
  );
}

function DiffLines({ diff }: { diff: string }) {
  return (
    <pre
      data-ui="proposal-diff"
      className="max-h-96 overflow-auto rounded border border-border/60 bg-background/60 p-2 text-[11px] leading-snug"
    >
      {diff.split('\n').map((line, index) => (
        <div
          key={index}
          className={cn(
            'whitespace-pre-wrap break-all',
            line.startsWith('+') &&
              'bg-green-500/10 text-green-700 dark:text-green-400',
            line.startsWith('-') &&
              'bg-red-500/10 text-red-700 dark:text-red-400',
            line.startsWith('…') && 'text-muted-foreground',
          )}
        >
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}

function ActionSummary({
  heading,
  kind,
  preview,
  prompt,
}: {
  heading: string;
  kind: Proposal['kind'];
  preview: ProposalActionPreview;
  prompt?: Proposal['prompt'];
}) {
  const changed = preview.files.filter((file) => file.change !== 'unchanged');
  return (
    <section data-ui="proposal-action" data-action-type={preview.actionType}>
      <h4 className="text-xs font-medium text-muted-foreground">{heading}</h4>
      <p className="mt-0.5 text-sm">
        {ACTION_LABELS[preview.actionType](kind, preview, prompt)}
      </p>
      {preview.targetPath && (
        <code className="mt-0.5 block break-all text-[11px] text-muted-foreground">
          {preview.targetPath}
        </code>
      )}
      {preview.promotion && (
        <div
          data-ui="proposal-promotion"
          className="mt-1 text-xs text-muted-foreground"
        >
          <p>
            Commits to <code>{preview.promotion.repository}</code> on branch{' '}
            <code>{preview.promotion.branch}</code>, replacing any existing copy
            at:
          </p>
          <ul className="mt-0.5 space-y-0.5">
            {preview.promotion.paths.map((target) => (
              <li key={target}>
                <code className="break-all">{target}</code>
              </li>
            ))}
          </ul>
          {!preview.promotion.previousContentAvailable && (
            <p className="mt-1">
              Previous content unavailable: the files below are the full
              proposed content, not a diff.
            </p>
          )}
        </div>
      )}
      {preview.replacesSymlink && (
        <p className="mt-1 text-xs text-muted-foreground">
          The current entry is a generated link
          {preview.symlinkTarget ? ` to ${preview.symlinkTarget}` : ''}; it is
          replaced by a real copy and the shared file is left untouched.
        </p>
      )}
      {preview.problem && (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">
          {preview.problem}
        </p>
      )}
      {changed.map((file) => (
        <details key={file.path} className="mt-1.5" open={changed.length === 1}>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            {file.path} ·{' '}
            {file.change === 'unknown'
              ? 'previous content unavailable'
              : file.change}
          </summary>
          {file.diff && <DiffLines diff={file.diff} />}
        </details>
      ))}
    </section>
  );
}

type FenceState =
  | { phase: 'loading' }
  | { phase: 'missing' }
  | { phase: 'ready'; proposal: Proposal };

/**
 * Card for a ```carapaproposal {"id": "..."}``` fence. The fence only names a
 * proposal; everything shown and every action comes from the server's record,
 * so an unknown or foreign id renders `fallback` (the plain code block).
 */
export function ProposalFence({
  projectId,
  proposalId,
  fallback,
}: {
  projectId: string;
  proposalId: string;
  fallback: ReactNode;
}) {
  const [state, setState] = useState<FenceState>({ phase: 'loading' });
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ phase: 'loading' });
    getProposal(projectId, proposalId)
      .then((proposal) => {
        if (!cancelled) setState({ phase: 'ready', proposal });
      })
      .catch(() => {
        if (!cancelled) setState({ phase: 'missing' });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, proposalId]);

  // Another request (a second click, another viewer, or the page opened
  // mid-apply) may be applying this proposal: keep reading it until it
  // reaches a terminal status so the final result is shown without a reload.
  const status = state.phase === 'ready' ? state.proposal.status : null;
  const [pollRound, setPollRound] = useState(0);
  useEffect(() => {
    if (status !== 'applying') return;
    let cancelled = false;
    const timer = setTimeout(() => {
      getProposal(projectId, proposalId)
        .then((proposal) => {
          if (!cancelled) setState({ phase: 'ready', proposal });
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setPollRound((round) => round + 1);
        });
    }, APPLYING_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [status, pollRound, projectId, proposalId]);

  // A pending card may have been decided in another tab or by another user.
  // Re-read it when the page regains focus. The effect is torn down while a
  // decision is in flight (busy), which also drops any re-read started before
  // the decision response, so the decision result always wins.
  useEffect(() => {
    if (status !== 'pending' || busy !== null) return;
    let cancelled = false;
    let inFlight = false;
    const reread = () => {
      if (inFlight) return;
      inFlight = true;
      getProposal(projectId, proposalId)
        .then((proposal) => {
          if (!cancelled) setState({ phase: 'ready', proposal });
        })
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') reread();
    };
    window.addEventListener('focus', reread);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', reread);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [status, busy, projectId, proposalId]);

  if (state.phase !== 'ready') return <>{fallback}</>;
  const { proposal } = state;
  const pending = proposal.status === 'pending';
  const canApprove =
    pending &&
    proposal.supported &&
    !proposal.targetChanged &&
    !proposal.approve.problem;

  const decide = async (decision: 'approve' | 'deny') => {
    setBusy(decision);
    setError(null);
    try {
      const next = await decideProposal(projectId, proposalId, decision);
      setState({ phase: 'ready', proposal: next });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      data-ui="proposal-card"
      data-proposal-id={proposal.id}
      data-status={proposal.status}
      className="my-3 space-y-3 rounded-lg border border-border bg-muted/30 p-3"
    >
      <header>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h3 className="min-w-0 break-words text-sm font-medium">
            {proposal.title}
          </h3>
          <code
            data-ui="proposal-id"
            className="select-text break-all text-xs text-muted-foreground"
          >
            {proposal.id}
          </code>
        </div>
        {proposal.merge ? (
          <p className="text-xs text-muted-foreground">
            Merge approval · held by the project's merge risk rules
          </p>
        ) : proposal.prompt ? (
          <p
            data-ui="proposal-prompt-target"
            className="text-xs text-muted-foreground"
          >
            prompt <code>{promptFilename(proposal.prompt)}</code> · project{' '}
            <code>{proposal.prompt.targetProject}</code>
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {proposal.kind} <code>{proposal.name}</code> ·{' '}
            {proposal.targetLayer.replace(/_/g, ' ')} layer
          </p>
        )}
        {!proposal.merge && (
          <p className="mt-1 text-sm text-muted-foreground">
            {proposal.rationale}
          </p>
        )}
      </header>

      {proposal.merge ? (
        <MergeSummary projectId={projectId} merge={proposal.merge} />
      ) : (
        <>
          <ActionSummary
            heading="If you approve"
            kind={proposal.kind}
            preview={proposal.approve}
            prompt={proposal.prompt}
          />
          {proposal.deny ? (
            <ActionSummary
              heading="If you deny"
              kind={proposal.kind}
              preview={proposal.deny}
            />
          ) : (
            <section data-ui="proposal-action" data-action-type="dismiss">
              <h4 className="text-xs font-medium text-muted-foreground">
                If you deny
              </h4>
              <p className="mt-0.5 text-sm">
                Closes the proposal without changes
              </p>
            </section>
          )}
        </>
      )}

      {pending && proposal.targetChanged && (
        <p className="text-xs text-red-600 dark:text-red-400">
          The target changed after this was proposed, so it can no longer be
          approved. Ask the agent for a new proposal.
        </p>
      )}
      {pending && !proposal.supported && (
        <p className="text-xs text-muted-foreground">
          This layer cannot be applied yet.
        </p>
      )}

      {pending ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            data-ui="proposal-approve"
            disabled={!canApprove || busy !== null}
            onClick={() => void decide('approve')}
          >
            {busy === 'approve' ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Check />
            )}
            Approve
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-ui="proposal-deny"
            disabled={busy !== null}
            onClick={() => void decide('deny')}
          >
            {busy === 'deny' ? <Loader2 className="animate-spin" /> : <X />}
            {proposal.deny || proposal.merge ? 'Deny' : 'Dismiss'}
          </Button>
        </div>
      ) : (
        <p
          data-ui="proposal-decision"
          className="text-xs text-muted-foreground"
        >
          <span className="font-medium text-foreground">
            {statusLabel(proposal)}
          </span>
          {proposal.decidedBy && ` by ${proposal.decidedBy}`}
          {proposal.decidedAt &&
            ` · ${new Date(proposal.decidedAt).toLocaleString()}`}
          {proposal.result && <span className="block">{proposal.result}</span>}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
