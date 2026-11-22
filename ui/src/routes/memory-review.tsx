import { useEffect, useMemo, useRef, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  AlertCircle,
  Beaker,
  BrainCircuit,
  Check,
  ChevronRight,
  Clock3,
  FileText,
  Loader2,
  MoveRight,
  Pencil,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  WandSparkles,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Select, SelectItem } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { PageHeader } from '@/components/layout/page-header';
import { ProjectPicker } from '@/components/layout/project-picker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { QueryErrorState } from '@/components/layout/query-error-state';
import { Input } from '@/components/ui/input';
import { SearchInput } from '@/components/ui/search-input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RuntimePicker } from '@/components/chat/runtime-picker';
import { useAuth } from '@/lib/auth';
import { useProjects } from '@/hooks/use-projects';
import {
  acceptPartialHistoryReviewBatch,
  approveAndApplyProjectMemoryAudit,
  applyHistoryReviewProject,
  applyProjectMemoryAudit,
  createConversation,
  deleteExistingMemory,
  deleteSkippedProjectMemory,
  fetchExistingMemoriesPage,
  fetchHistoryReviewBatch,
  fetchHistoryReviewBatches,
  fetchRuntimeCatalog,
  fetchProjectMemoryAudit,
  fetchProjectMemoryAuditReport,
  fetchProjectMemoryAudits,
  forceRecheckProjectMemory,
  moveExistingMemory,
  resetHistoryReviewProject,
  resumeProjectMemoryAudit,
  reviewProjectMemoryAuditItem,
  startProjectMemoryAudit,
  startHistoryReviewGeneration,
  updateExistingMemory,
  updateHistoryReviewOperation,
  type ExistingMemory,
  type HistoryMemoryType,
  type HistoryReviewBatchDetail,
  type HistoryReviewEdits,
  type HistoryReviewMemoryOp,
  type HistoryReviewOperation,
  type HistoryReviewProject,
  type MemoryAuditItem,
  type MemoryAuditReviewDecision,
  type MemoryAuditView,
  type RuntimeCatalog,
  type RuntimeSelection,
} from '@/lib/api';
import { buildHistoryReviewVerificationPrompt } from '@/lib/history-review-verification';
import { queryKeys } from '@/lib/query-keys';
import { pollUnlessError, useQueryLoadState } from '@/lib/use-query-load-state';
import { cn } from '@/lib/utils';
import { useStore } from '@/store';
import type { Project } from '@/types';
import { confirmAction } from '@/components/confirm-dialog';

// Colour convention: text uses a light/dark pair; the remaining -500 borders
// and /5-/15 tinted fills are translucent mid-tones that read on both themes.
const MEMORY_TYPES: HistoryMemoryType[] = [
  'identity',
  'project',
  'goal',
  'decision',
  'preference',
  'contact',
  'event',
  'task',
];

type ReviewFilter = 'all' | 'pending' | 'approved' | 'eval' | 'rejected';
type ReviewMode = 'history' | 'existing';
type ExistingEvalFilter = 'all' | 'marked' | 'unmarked';
type MemoryAuditReviewEdits = Parameters<
  typeof reviewProjectMemoryAuditItem
>[3]['edits'];
interface MemoryReviewSearch {
  mode?: ReviewMode;
  batchId?: string;
  projectId?: string;
  auditId?: string;
  itemId?: string;
  action?: 'approve' | 'delete' | 'edit';
}

function MemoryAuditProposalCard({
  item,
  mergeTarget,
  moveTargets,
  busy,
  onDecision,
  onRecheck,
}: {
  item: MemoryAuditItem;
  mergeTarget?: MemoryAuditItem['memory'];
  moveTargets: MemoryAuditView['related_projects'];
  busy: boolean;
  onDecision: (
    decision: MemoryAuditReviewDecision,
    edits?: MemoryAuditReviewEdits,
  ) => void;
  onRecheck: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(
    item.proposed_content ?? item.memory?.content ?? '',
  );
  const [memoryType, setMemoryType] = useState<HistoryMemoryType>(
    item.proposed_memory_type ?? item.memory?.memory_type ?? 'project',
  );
  const [importance, setImportance] = useState(
    String(
      item.proposed_importance ??
        (item.disposition === 'merge' && mergeTarget && item.memory
          ? Math.max(mergeTarget.importance, item.memory.importance)
          : item.memory?.importance) ??
        0.7,
    ),
  );
  const [tags, setTags] = useState(
    (item.proposed_tags ?? item.memory?.tags ?? []).join(', '),
  );
  const initialValidFrom = localDateTime(item.proposed_valid_from ?? null);
  const [validFrom, setValidFrom] = useState(initialValidFrom);
  const [targetProjectId, setTargetProjectId] = useState(
    item.target_project_id ?? '',
  );
  const evidence = item.proposal_evidence?.length
    ? item.proposal_evidence
    : (item.certificate?.files ?? []);
  const proposed = item.proposed_content;
  const importanceBefore =
    item.disposition === 'merge'
      ? mergeTarget?.importance
      : item.disposition === 'create'
        ? undefined
        : item.memory?.importance;
  const importanceAfter =
    item.disposition === 'merge'
      ? item.proposed_content
        ? (item.proposed_importance ??
          (mergeTarget && item.memory
            ? Math.max(mergeTarget.importance, item.memory.importance)
            : importanceBefore))
        : importanceBefore
      : item.disposition === 'rewrite' || item.disposition === 'enhance'
        ? (item.proposed_importance ?? importanceBefore)
        : item.disposition === 'create'
          ? item.proposed_importance
          : undefined;
  return (
    <Card
      className={cn(
        'border-border/70',
        item.review_decision === 'approved' && 'border-emerald-500/30',
        item.review_decision === 'rejected' && 'border-blue-500/30 opacity-80',
        item.review_decision === 'delete_memory' && 'border-red-500/50',
        item.review_decision === 'delete_both' && 'border-red-500/50',
        item.stale && 'border-amber-500/50',
      )}
    >
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline" className="uppercase">
              {item.disposition}
            </Badge>
            <Badge variant="secondary">
              {item.proposed_memory_type ??
                item.memory?.memory_type ??
                'project'}
            </Badge>
            {item.retrieval_value && (
              <Badge variant="outline">{item.retrieval_value}</Badge>
            )}
            <Badge
              variant="outline"
              className={statusColor(item.review_decision)}
            >
              {item.review_decision === 'delete_both'
                ? 'delete both'
                : item.review_decision === 'delete_memory'
                  ? 'delete memory'
                  : item.review_decision}
            </Badge>
            {item.stale && (
              <Badge className="bg-amber-500/15 text-amber-800 dark:text-amber-300">
                Stale
              </Badge>
            )}
            {item.applied_at && (
              <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
                Applied
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-muted-foreground">
            {importanceAfter !== undefined && importanceAfter !== null && (
              <Badge variant="outline">
                importance{' '}
                {importanceBefore !== undefined &&
                importanceBefore !== importanceAfter
                  ? `${importanceBefore.toFixed(2)} → `
                  : ''}
                {importanceAfter.toFixed(2)}
              </Badge>
            )}
            <span>confidence {(item.confidence ?? 0).toFixed(2)}</span>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">{item.reason}</p>
        {item.memory && (
          <div className="rounded-md border border-border/60 p-3 text-sm">
            <div className="mb-1 text-[10px] uppercase text-muted-foreground">
              Current memory
            </div>
            <p className="whitespace-pre-wrap">{item.memory.content}</p>
          </div>
        )}
        {proposed && item.disposition !== 'erase' && (
          <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 p-3 text-sm">
            <div className="mb-1 text-[10px] uppercase text-emerald-700 dark:text-emerald-300">
              Proposed canonical memory
            </div>
            <p className="whitespace-pre-wrap">{proposed}</p>
          </div>
        )}
        {item.disposition === 'merge' && (
          <div className="rounded-md border border-violet-500/20 bg-violet-500/5 p-3 text-sm">
            <div className="mb-1 text-[10px] uppercase text-violet-700 dark:text-violet-300">
              Merge into target memory
            </div>
            {mergeTarget ? (
              <p className="whitespace-pre-wrap">{mergeTarget.content}</p>
            ) : (
              <p className="text-amber-800 dark:text-amber-300">
                Target memory is unavailable
              </p>
            )}
            <div className="mt-2 break-all text-[10px] text-muted-foreground">
              {item.merge_target_id}
            </div>
          </div>
        )}
        {item.disposition === 'move' && (
          <div className="rounded-md border border-sky-500/20 bg-sky-500/5 px-3 py-2 text-sm text-sky-800 dark:text-sky-200">
            Move unchanged memory to{' '}
            <span className="font-medium">
              {moveTargets.find(
                (project) => project.id === item.target_project_id,
              )?.name ?? item.target_project_id}
            </span>
          </div>
        )}
        {evidence.length > 0 && (
          <details className="rounded-md border border-border/60 bg-muted/20">
            <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">
              Verified code evidence ({evidence.length})
            </summary>
            <div className="space-y-3 border-t border-border/60 p-3">
              {evidence.map((file) => (
                <div key={file.id} className="text-xs">
                  <div className="break-all font-mono text-[10px] text-muted-foreground">
                    {file.path}
                    {file.line_start ? `:${file.line_start}` : ''} ·{' '}
                    {file.file_sha256.slice(0, 12)}
                  </div>
                  <pre className="mt-1 overflow-auto whitespace-pre-wrap rounded bg-background p-2">
                    {file.excerpt}
                  </pre>
                </div>
              ))}
            </div>
          </details>
        )}
        {editing && !['erase', 'move'].includes(item.disposition ?? '') && (
          <div className="space-y-3 rounded-md border p-3">
            <Textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              rows={4}
            />
            <div className="grid gap-2 sm:grid-cols-3">
              <Select
                className="w-full"
                value={memoryType}
                onValueChange={(nextValue) =>
                  setMemoryType(nextValue as HistoryMemoryType)
                }
              >
                {MEMORY_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {type}
                  </SelectItem>
                ))}
              </Select>
              <Input
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={importance}
                onChange={(event) => setImportance(event.target.value)}
              />
              <Input
                value={tags}
                onChange={(event) => setTags(event.target.value)}
                placeholder="tags"
              />
            </div>
            {item.proposed_valid_from && (
              <Input
                type="datetime-local"
                value={validFrom}
                onChange={(event) => setValidFrom(event.target.value)}
                aria-label="Memory valid from"
              />
            )}
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={busy || !content.trim()}
                onClick={() => {
                  const parsedImportance = Number(importance);
                  if (
                    !Number.isFinite(parsedImportance) ||
                    parsedImportance < 0 ||
                    parsedImportance > 1
                  ) {
                    toast.error('Importance must be between 0 and 1');
                    return;
                  }
                  onDecision('approved', {
                    proposed_content: content.trim(),
                    proposed_memory_type: memoryType,
                    proposed_importance: parsedImportance,
                    proposed_tags: tags
                      .split(',')
                      .map((tag) => tag.trim())
                      .filter(Boolean),
                    ...(validFrom && validFrom !== initialValidFrom
                      ? {
                          proposed_valid_from: new Date(
                            validFrom,
                          ).toISOString(),
                        }
                      : {}),
                  });
                  setEditing(false);
                }}
              >
                Save and approve
              </Button>
            </div>
          </div>
        )}
        {editing && item.disposition === 'move' && (
          <div className="space-y-3 rounded-md border p-3">
            <label className="block space-y-1 text-xs text-muted-foreground">
              Related destination project
              <Select
                value={targetProjectId}
                onValueChange={(nextValue) => setTargetProjectId(nextValue)}
                className="mt-1 w-full"
              >
                {moveTargets.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name} · {project.relationship}
                  </SelectItem>
                ))}
              </Select>
            </label>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={busy || !targetProjectId}
                onClick={() => {
                  onDecision('approved', {
                    target_project_id: targetProjectId,
                  });
                  setEditing(false);
                }}
              >
                Save destination and approve
              </Button>
            </div>
          </div>
        )}
        {!editing && !item.applied_at && (
          <div className="flex flex-wrap justify-end gap-2">
            {!['create', 'enhance'].includes(item.disposition ?? '') &&
              item.memory && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={onRecheck}
                >
                  <RefreshCw className="mr-1 size-3.5" />
                  Force recheck
                </Button>
              )}
            {item.review_decision !== 'pending' && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => onDecision('pending')}
              >
                <RotateCcw className="mr-1 size-3.5" />
                Undo
              </Button>
            )}
            {!item.stale && item.disposition !== 'erase' && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy || item.stale}
                onClick={() => setEditing(true)}
              >
                <Pencil className="mr-1 size-3.5" />
                Edit
              </Button>
            )}
            {item.stale ? (
              <>
                {item.memory &&
                  ['rewrite', 'merge'].includes(item.disposition ?? '') && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-red-500/30 text-red-700 dark:text-red-300 hover:bg-red-500/10 hover:text-red-800 dark:hover:text-red-200"
                      disabled={busy}
                      onClick={() => onDecision('delete_memory')}
                    >
                      <Trash2 className="mr-1 size-3.5" />
                      Delete current memory
                    </Button>
                  )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => onDecision('dismissed')}
                >
                  Dismiss stale proposal
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => onDecision('rejected')}
                >
                  {['create', 'enhance'].includes(item.disposition ?? '')
                    ? 'Reject proposal'
                    : item.disposition === 'move'
                      ? 'Keep in current project'
                      : 'Keep memory'}
                </Button>
                {item.disposition === 'merge' && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-red-500/30 text-red-700 dark:text-red-300 hover:bg-red-500/10 hover:text-red-800 dark:hover:text-red-200"
                    disabled={busy}
                    onClick={() => onDecision('delete_both')}
                  >
                    <Trash2 className="mr-1 size-3.5" />
                    Delete both
                  </Button>
                )}
                {item.disposition === 'rewrite' && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-red-500/30 text-red-700 dark:text-red-300 hover:bg-red-500/10 hover:text-red-800 dark:hover:text-red-200"
                    disabled={busy}
                    onClick={() => onDecision('delete_memory')}
                  >
                    <Trash2 className="mr-1 size-3.5" />
                    Delete memory
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => onDecision('approved')}
                >
                  <Check className="mr-1 size-3.5" />
                  Approve {item.disposition}
                </Button>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function operationContent(operation: HistoryReviewMemoryOp): string {
  if (operation.op === 'create') return operation.content;
  if (operation.op === 'supersede') return operation.correction_content;
  if (operation.op === 'invalidate') return operation.reason;
  return operation.target;
}

function operationTargetId(operation: HistoryReviewMemoryOp): string | null {
  if (operation.op === 'supersede') return operation.supersedes_id;
  if (operation.op === 'invalidate' || operation.op === 'forget') {
    return operation.memory_id;
  }
  return null;
}

function operationDate(operation: HistoryReviewMemoryOp): string | null {
  if (operation.op === 'create' || operation.op === 'supersede') {
    return operation.valid_from;
  }
  if (operation.op === 'invalidate') return operation.effective_at;
  return null;
}

function operationType(operation: HistoryReviewMemoryOp): string | null {
  return operation.op === 'create' || operation.op === 'supersede'
    ? operation.memory_type
    : null;
}

function localDateTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function isoDateTime(value: string): string {
  return new Date(value).toISOString();
}

function batchLabel(id: string): string {
  return id
    .replace(/^project-history-batch-/, '')
    .replace(/\.json$/, '')
    .replaceAll('-', ' ');
}

function statusColor(status: string): string {
  if (status === 'applied' || status === 'approved') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  }
  if (
    status === 'error' ||
    status === 'rejected' ||
    status === 'delete_memory' ||
    status === 'delete_both'
  ) {
    return 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300';
  }
  if (status === 'previewing' || status === 'pending') {
    return 'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300';
  }
  return 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300';
}

function EditOperationForm({
  item,
  sourceProjectId,
  projects,
  busy,
  onCancel,
  onSave,
}: {
  item: HistoryReviewOperation;
  sourceProjectId: string;
  projects: Project[];
  busy: boolean;
  onCancel: () => void;
  onSave: (
    edits: HistoryReviewEdits,
    markForEval: boolean,
    targetProjectId?: string,
  ) => void;
}) {
  const operation = item.operation;
  const [content, setContent] = useState(operationContent(operation));
  const [memoryType, setMemoryType] = useState(
    operationType(operation) ?? 'project',
  );
  const [importance, setImportance] = useState(
    operation.op === 'create' || operation.op === 'supersede'
      ? String(operation.importance)
      : '0.7',
  );
  const [tags, setTags] = useState(
    operation.op === 'create' || operation.op === 'supersede'
      ? operation.tags.join(', ')
      : '',
  );
  const initialEffectiveAt = localDateTime(operationDate(operation));
  const [effectiveAt, setEffectiveAt] = useState(initialEffectiveAt);
  const [markForEval, setMarkForEval] = useState(item.mark_for_eval);
  const [targetProjectId, setTargetProjectId] = useState(
    item.target_project_id || sourceProjectId,
  );

  const save = () => {
    if (!content.trim()) {
      toast.error('Content is required');
      return;
    }
    if (!effectiveAt || Number.isNaN(new Date(effectiveAt).getTime())) {
      toast.error(
        operation.op === 'invalidate'
          ? 'Effective at is required'
          : 'Valid from is required',
      );
      return;
    }
    // The server replaces saved edits. Send the date only when the user changed
    // it, or to carry forward an override saved earlier (at full precision).
    const savedDate =
      operation.op === 'invalidate'
        ? item.edits?.effective_at
        : item.edits?.valid_from;
    const dateIso =
      effectiveAt !== initialEffectiveAt ? isoDateTime(effectiveAt) : savedDate;
    if (operation.op === 'invalidate') {
      onSave(
        {
          reason: content.trim(),
          ...(dateIso ? { effective_at: dateIso } : {}),
        },
        markForEval,
      );
      return;
    }
    const parsedImportance = Number(importance);
    if (
      !Number.isFinite(parsedImportance) ||
      parsedImportance < 0.7 ||
      parsedImportance > 1
    ) {
      toast.error('Importance must be between 0.7 and 1');
      return;
    }
    onSave(
      {
        content: content.trim(),
        memory_type: memoryType,
        importance: parsedImportance,
        tags: tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
        ...(dateIso ? { valid_from: dateIso } : {}),
      },
      markForEval,
      operation.op === 'create' ? targetProjectId : undefined,
    );
  };

  return (
    <div className="mt-4 space-y-3 rounded-md border border-border bg-muted/20 p-3">
      <label className="block space-y-1 text-xs text-muted-foreground">
        {operation.op === 'invalidate' ? 'Reason' : 'Memory content'}
        <Textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          rows={4}
          className="mt-1 text-foreground"
        />
      </label>
      {operation.op !== 'invalidate' && (
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1 text-xs text-muted-foreground">
            Type
            <Select
              value={memoryType}
              onValueChange={(nextValue) => setMemoryType(nextValue)}
              className="mt-1 w-full"
            >
              {MEMORY_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {type}
                </SelectItem>
              ))}
            </Select>
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            Importance
            <Input
              type="number"
              min="0.7"
              max="1"
              step="0.01"
              value={importance}
              onChange={(event) => setImportance(event.target.value)}
              className="mt-1"
            />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            Valid from
            <Input
              type="datetime-local"
              value={effectiveAt}
              onChange={(event) => setEffectiveAt(event.target.value)}
              className="mt-1"
            />
          </label>
        </div>
      )}
      {operation.op === 'create' && (
        <div className="block space-y-1 text-xs text-muted-foreground">
          <span>Destination project</span>
          <ProjectPicker
            projects={projects}
            value={targetProjectId}
            onValueChange={setTargetProjectId}
            disabled={!!operation.precedes_id}
            className="mt-1 w-full"
            aria-label="Destination project"
            data-ui="memory-review-destination-project-picker"
          />
          {operation.precedes_id && (
            <span className="block text-[11px]">
              This memory is linked to the current project timeline and cannot
              be moved.
            </span>
          )}
        </div>
      )}
      {operation.op === 'invalidate' && (
        <label className="block space-y-1 text-xs text-muted-foreground">
          Effective at
          <Input
            type="datetime-local"
            value={effectiveAt}
            onChange={(event) => setEffectiveAt(event.target.value)}
            className="mt-1 max-w-xs"
          />
        </label>
      )}
      {operation.op !== 'invalidate' && (
        <label className="block space-y-1 text-xs text-muted-foreground">
          Tags
          <Input
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="architecture, preference"
            className="mt-1"
          />
        </label>
      )}
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={markForEval}
          onCheckedChange={(checked) => setMarkForEval(checked === true)}
        />
        Mark the approved operation for a future memory eval
      </label>
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" onClick={save} disabled={busy}>
          {busy && <Loader2 className="mr-1 size-3.5 animate-spin" />}
          Save and approve
        </Button>
      </div>
    </div>
  );
}

function OperationCard({
  item,
  sourceProjectId,
  projects,
  enabled,
  busy,
  editing,
  onEdit,
  onCancelEdit,
  onVerify,
  verifying,
  onDecision,
}: {
  item: HistoryReviewOperation;
  sourceProjectId: string;
  projects: Project[];
  enabled: boolean;
  busy: boolean;
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onVerify: () => void;
  verifying: boolean;
  onDecision: (
    decision: 'pending' | 'approved' | 'rejected',
    markForEval?: boolean,
    edits?: HistoryReviewEdits,
    targetProjectId?: string,
  ) => void;
}) {
  const operation = item.operation;
  const content = operationContent(operation);
  const date = operationDate(operation);
  const type = operationType(operation);
  const tags =
    operation.op === 'create' || operation.op === 'supersede'
      ? operation.tags
      : [];
  const targetId = operationTargetId(operation);
  const targetMemory = item.target_memory;
  return (
    <Card
      id={`memory-review-operation-${item.id}`}
      data-ui="memory-review-operation"
      data-memory-id={item.id}
      className={cn(
        'border-border/70',
        item.decision === 'approved' && 'border-emerald-500/30',
        item.decision === 'rejected' && 'opacity-70 border-red-500/30',
      )}
    >
      <CardContent className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="uppercase">
              {operation.op}
            </Badge>
            {type && <Badge variant="secondary">{type}</Badge>}
            <Badge variant="outline" className={statusColor(item.decision)}>
              {item.decision}
            </Badge>
            {item.mark_for_eval && (
              <Badge className="border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300">
                <Beaker className="mr-1 size-3" />
                Eval
              </Badge>
            )}
            {item.target_project_id &&
              item.target_project_id !== sourceProjectId && (
                <Badge className="border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300">
                  → {item.target_project_id}
                </Badge>
              )}
          </div>
          <div className="text-right text-xs text-muted-foreground">
            {date && <div>{new Date(date).toLocaleString()}</div>}
            {(operation.op === 'create' || operation.op === 'supersede') && (
              <div>importance {operation.importance.toFixed(2)}</div>
            )}
          </div>
        </div>

        {targetId && (
          <div
            data-ui="memory-review-target"
            data-memory-id={targetId}
            className="mt-3 rounded-md border border-border/60 bg-muted/20 p-3"
          >
            <div className="text-xs text-muted-foreground">Current memory</div>
            <code className="mt-1 block break-all font-mono text-[11px] text-muted-foreground">
              {targetId}
            </code>
            {targetMemory === null && (
              <p className="mt-2 text-xs text-muted-foreground">
                Target memory not found or no longer current.
              </p>
            )}
            {targetMemory && (
              <>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6">
                  {targetMemory.content}
                </p>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {targetMemory.memory_type} · valid from{' '}
                  {new Date(targetMemory.valid_from).toLocaleString()}
                </div>
              </>
            )}
          </div>
        )}

        <p className="mt-3 whitespace-pre-wrap text-sm leading-6">{content}</p>
        {tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1">
            {tags.map((tag) => (
              <Badge key={tag} variant="outline" className="text-[10px]">
                {tag}
              </Badge>
            ))}
          </div>
        )}

        <details className="mt-3 rounded-md border border-border/60 bg-muted/20">
          <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">
            Evidence ({item.evidence.length}) and candidate rationale
          </summary>
          <div className="space-y-3 border-t border-border/60 p-3">
            {item.candidates.map((candidate) => (
              <div key={candidate.id}>
                <div className="text-xs font-medium">{candidate.claim}</div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  confidence {candidate.confidence.toFixed(2)} ·{' '}
                  {candidate.change_kind}
                </div>
              </div>
            ))}
            {item.evidence.map((evidence) => (
              <blockquote
                key={`${evidence.conversation_id}:${evidence.message_id}`}
                className="border-l-2 border-primary/40 pl-3 text-xs"
              >
                <p className="whitespace-pre-wrap text-foreground/90">
                  {evidence.excerpt}
                </p>
                <footer className="mt-1 break-all text-[10px] text-muted-foreground">
                  {evidence.source_kind} · {evidence.conversation_id}#
                  {evidence.message_id} ·{' '}
                  {new Date(evidence.created_at).toLocaleString()}
                </footer>
              </blockquote>
            ))}
          </div>
        </details>

        {editing && (
          <EditOperationForm
            item={item}
            sourceProjectId={sourceProjectId}
            projects={projects}
            busy={busy}
            onCancel={onCancelEdit}
            onSave={(edits, markForEval, targetProjectId) =>
              onDecision('approved', markForEval, edits, targetProjectId)
            }
          />
        )}

        {!editing && (
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            {item.decision !== 'pending' && (
              <Button
                variant="ghost"
                size="sm"
                disabled={!enabled || busy}
                onClick={() => onDecision('pending')}
              >
                <RotateCcw className="mr-1 size-3.5" />
                Undo
              </Button>
            )}
            {item.decision === 'pending' && (
              <Button
                variant="outline"
                size="sm"
                disabled={!enabled || busy || verifying}
                onClick={onVerify}
                title="Open a fresh project chat with a code-verification prompt"
              >
                {verifying ? (
                  <Loader2 className="mr-1 size-3.5 animate-spin" />
                ) : (
                  <Search className="mr-1 size-3.5" />
                )}
                Verify in project chat
              </Button>
            )}
            {operation.op !== 'forget' && (
              <Button
                variant="outline"
                size="sm"
                disabled={!enabled || busy}
                onClick={onEdit}
              >
                <Pencil className="mr-1 size-3.5" />
                Edit
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className={
                operation.op === 'forget'
                  ? 'border-emerald-500/30 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10'
                  : 'border-red-500/30 text-red-700 dark:text-red-300 hover:bg-red-500/10'
              }
              disabled={!enabled || busy}
              onClick={() => onDecision('rejected')}
            >
              {operation.op === 'forget' ? (
                <RotateCcw className="mr-1 size-3.5" />
              ) : (
                <X className="mr-1 size-3.5" />
              )}
              {operation.op === 'forget' ? 'Keep memory' : 'Reject'}
            </Button>
            {operation.op !== 'forget' && (
              <Button
                variant="outline"
                size="sm"
                disabled={!enabled || busy}
                onClick={() => onDecision('approved', true)}
              >
                <Beaker className="mr-1 size-3.5" />
                Approve + eval
              </Button>
            )}
            <Button
              size="sm"
              disabled={!enabled || busy}
              onClick={() => onDecision('approved', false)}
            >
              <Check className="mr-1 size-3.5" />
              {operation.op === 'forget' ? 'Approve erase' : 'Approve'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MemoryAuditProposalList({
  items,
  allItems,
  moveTargets,
  busy,
  onDecision,
  onRecheck,
}: {
  items: MemoryAuditItem[];
  allItems: MemoryAuditItem[];
  moveTargets: MemoryAuditView['related_projects'];
  busy: boolean;
  onDecision: (
    item: MemoryAuditItem,
    decision: MemoryAuditReviewDecision,
    edits?: MemoryAuditReviewEdits,
  ) => void;
  onRecheck: (item: MemoryAuditItem) => void;
}) {
  return items.map((item) => (
    <MemoryAuditProposalCard
      key={item.id}
      item={item}
      mergeTarget={
        item.disposition === 'merge'
          ? allItems.find(
              (candidate) => candidate.memory_id === item.merge_target_id,
            )?.memory
          : undefined
      }
      moveTargets={moveTargets}
      busy={busy}
      onDecision={(decision, edits) => onDecision(item, decision, edits)}
      onRecheck={() => onRecheck(item)}
    />
  ));
}

function MemoryAuditProposalAccordion({
  label,
  items,
  allItems,
  moveTargets,
  busy,
  onDecision,
  onRecheck,
}: {
  label: string;
  items: MemoryAuditItem[];
  allItems: MemoryAuditItem[];
  moveTargets: MemoryAuditView['related_projects'];
  busy: boolean;
  onDecision: (
    item: MemoryAuditItem,
    decision: MemoryAuditReviewDecision,
    edits?: MemoryAuditReviewEdits,
  ) => void;
  onRecheck: (item: MemoryAuditItem) => void;
}) {
  if (items.length === 0) return null;
  return (
    <details className="group rounded-md border border-border/70 bg-muted/10">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2">
          <ChevronRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
          {label}
        </span>
        <Badge variant="outline">{items.length}</Badge>
      </summary>
      <div className="space-y-3 border-t border-border/60 p-3">
        <MemoryAuditProposalList
          items={items}
          allItems={allItems}
          moveTargets={moveTargets}
          busy={busy}
          onDecision={onDecision}
          onRecheck={onRecheck}
        />
      </div>
    </details>
  );
}

function ExistingMemoryEditForm({
  memory,
  busy,
  onCancel,
  onSave,
}: {
  memory: ExistingMemory;
  busy: boolean;
  onCancel: () => void;
  onSave: (updates: {
    content: string;
    memory_type: HistoryMemoryType;
    importance: number;
    tags: string;
  }) => void;
}) {
  const [content, setContent] = useState(memory.content);
  const [memoryType, setMemoryType] = useState(memory.memory_type);
  const [importance, setImportance] = useState(String(memory.importance));
  const [tags, setTags] = useState(memory.tags.join(', '));

  return (
    <div className="mt-4 space-y-3 rounded-md border border-border bg-muted/20 p-3">
      <label className="block space-y-1 text-xs text-muted-foreground">
        Memory content
        <Textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          rows={5}
          className="mt-1 text-foreground"
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1 text-xs text-muted-foreground">
          Memory type
          <Select
            value={memoryType}
            onValueChange={(nextValue) =>
              setMemoryType(nextValue as HistoryMemoryType)
            }
            className="mt-1 w-full"
          >
            {MEMORY_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {type}
              </SelectItem>
            ))}
          </Select>
        </label>
        <label className="block space-y-1 text-xs text-muted-foreground">
          Importance
          <Input
            type="number"
            min="0"
            max="1"
            step="0.05"
            value={importance}
            onChange={(event) => setImportance(event.target.value)}
            className="mt-1 text-foreground"
          />
        </label>
      </div>
      <label className="block space-y-1 text-xs text-muted-foreground">
        Tags (comma separated)
        <Input
          value={tags}
          onChange={(event) => setTags(event.target.value)}
          className="mt-1 text-foreground"
        />
      </label>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={
            busy ||
            !content.trim() ||
            !Number.isFinite(Number(importance)) ||
            Number(importance) < 0 ||
            Number(importance) > 1
          }
          onClick={() =>
            onSave({
              content: content.trim(),
              memory_type: memoryType,
              importance: Number(importance),
              tags,
            })
          }
        >
          {busy && <Loader2 className="mr-1 size-3.5 animate-spin" />}
          Save
        </Button>
      </div>
    </div>
  );
}

function ExistingMemoryCard({
  memory,
  projectId,
  projects,
  editing,
  busy,
  onEdit,
  onCancelEdit,
  onSave,
  onDelete,
  onMove,
  onToggleEval,
}: {
  memory: ExistingMemory;
  projectId: string;
  projects: Project[];
  editing: boolean;
  busy: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: Parameters<typeof ExistingMemoryEditForm>[0]['onSave'];
  onDelete: () => void;
  onMove: (targetProjectId: string) => void;
  onToggleEval: () => void;
}) {
  const [moving, setMoving] = useState(false);
  const [deleteConfirming, setDeleteConfirming] = useState(false);
  const [targetProjectId, setTargetProjectId] = useState(
    projects.find((project) => project.id !== projectId)?.id ?? '',
  );

  return (
    <Card
      data-ui="existing-memory-card"
      data-memory-id={memory.id}
      className="border-border/70"
    >
      <CardContent className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{memory.memory_type}</Badge>
            {memory.marked_for_eval && (
              <Badge className="border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300">
                <Beaker className="mr-1 size-3" />
                Eval
              </Badge>
            )}
            <Badge variant="outline">{memory.source}</Badge>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <div>importance {memory.importance.toFixed(2)}</div>
            <div>{new Date(memory.updated_at).toLocaleString()}</div>
          </div>
        </div>
        <p className="mt-3 whitespace-pre-wrap text-sm leading-6">
          {memory.content}
        </p>
        {memory.tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1">
            {memory.tags.map((tag) => (
              <Badge key={tag} variant="outline" className="text-[10px]">
                {tag}
              </Badge>
            ))}
          </div>
        )}
        <div className="mt-3 break-all text-[10px] text-muted-foreground">
          {memory.id} · valid from{' '}
          {new Date(memory.valid_from ?? memory.created_at).toLocaleString()}
        </div>

        {editing ? (
          <ExistingMemoryEditForm
            key={memory.updated_at}
            memory={memory}
            busy={busy}
            onCancel={onCancelEdit}
            onSave={onSave}
          />
        ) : (
          <div className="mt-4 space-y-2">
            {moving && (
              <div
                data-ui="existing-memory-move-confirmation"
                className="flex flex-wrap items-center justify-end gap-2 rounded-md border border-border bg-muted/20 p-2"
              >
                <span className="mr-auto text-xs text-muted-foreground">
                  Move to project
                </span>
                <ProjectPicker
                  projects={projects}
                  value={targetProjectId}
                  onValueChange={setTargetProjectId}
                  excludedProjectIds={new Set([projectId])}
                  size="sm"
                  className="min-w-56 max-sm:w-full"
                  aria-label="Move memory to project"
                  data-ui="existing-memory-move-project-picker"
                />
                <Button
                  size="sm"
                  disabled={busy || !targetProjectId}
                  onClick={() => onMove(targetProjectId)}
                >
                  {busy && <Loader2 className="mr-1 size-3.5 animate-spin" />}
                  Move
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setMoving(false)}
                >
                  Cancel
                </Button>
              </div>
            )}
            {deleteConfirming && (
              <div
                data-ui="existing-memory-delete-confirmation"
                className="flex flex-wrap items-center justify-end gap-2 rounded-md border border-red-500/30 bg-red-500/5 p-2"
              >
                <span className="mr-auto text-xs text-red-700 dark:text-red-300">
                  Permanently delete this memory and its graph data?
                </span>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy}
                  onClick={onDelete}
                >
                  {busy && <Loader2 className="mr-1 size-3.5 animate-spin" />}
                  Confirm delete
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setDeleteConfirming(false)}
                >
                  Cancel
                </Button>
              </div>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={onToggleEval}
              >
                <Beaker className="mr-1 size-3.5" />
                {memory.marked_for_eval ? 'Unmark eval' : 'Mark for eval'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={onEdit}
              >
                <Pencil className="mr-1 size-3.5" />
                Edit
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || projects.length < 2}
                onClick={() => {
                  setDeleteConfirming(false);
                  setMoving(true);
                }}
              >
                <MoveRight className="mr-1 size-3.5" />
                Move
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="border-red-500/30 text-red-700 dark:text-red-300 hover:bg-red-500/10"
                disabled={busy}
                onClick={() => {
                  setMoving(false);
                  setDeleteConfirming(true);
                }}
              >
                <Trash2 className="mr-1 size-3.5" />
                Delete
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function replaceProject(
  detail: HistoryReviewBatchDetail | undefined,
  project: HistoryReviewProject,
): HistoryReviewBatchDetail | undefined {
  if (!detail) return detail;
  return {
    ...detail,
    projects: detail.projects.map((existing) =>
      existing.project_id === project.project_id ? project : existing,
    ),
  };
}

export function MemoryReviewPage({
  search = {},
}: {
  search?: MemoryReviewSearch;
}) {
  const isAdmin = useAuth((state) => state.user?.role === 'admin');
  const { data: projects = [] } = useProjects();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [mode, setMode] = useState<ReviewMode>(search.mode ?? 'history');
  const [batchId, setBatchId] = useState(search.batchId ?? '');
  const [projectId, setProjectId] = useState(search.projectId ?? '');
  const [existingProjectId, setExistingProjectId] = useState(
    search.projectId ?? '',
  );
  const [auditId, setAuditId] = useState(search.auditId ?? '');
  // Audit just started by this page; keep it selected until its project's list
  // shows it.
  const currentExistingProjectIdRef = useRef(existingProjectId);
  useEffect(() => {
    currentExistingProjectIdRef.current = existingProjectId;
  }, [existingProjectId]);
  const startedAuditRef = useRef<{
    projectId: string;
    auditId: string;
  } | null>(null);
  const [existingSearch, setExistingSearch] = useState('');
  const [existingTypeFilter, setExistingTypeFilter] = useState('all');
  const [existingEvalFilter, setExistingEvalFilter] =
    useState<ExistingEvalFilter>('all');
  const [existingEditingId, setExistingEditingId] = useState<string | null>(
    null,
  );
  const [filter, setFilter] = useState<ReviewFilter>('all');
  const [operationFilter, setOperationFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [verificationItemId, setVerificationItemId] = useState<string | null>(
    null,
  );
  const [generateOpen, setGenerateOpen] = useState(false);
  const [generateProjectId, setGenerateProjectId] = useState('');
  const [generateSince, setGenerateSince] = useState('');
  const [generateUntil, setGenerateUntil] = useState('');
  const [generateSinceEdited, setGenerateSinceEdited] = useState(false);
  const [generateUntilEdited, setGenerateUntilEdited] = useState(false);
  const [generateRuntime, setGenerateRuntime] =
    useState<RuntimeSelection | null>(null);
  const handledDeepLinkRef = useRef<string | null>(null);
  const existingMemoryLoadMoreRef = useRef<HTMLDivElement | null>(null);

  const batchesQuery = useQuery({
    queryKey: queryKeys.historyReview.batches,
    queryFn: fetchHistoryReviewBatches,
    enabled: isAdmin && mode === 'history',
    refetchInterval: pollUnlessError(5_000),
  });
  const runtimeCatalogQuery = useQuery({
    queryKey: queryKeys.runtimeCatalog,
    queryFn: fetchRuntimeCatalog,
    enabled: isAdmin && mode === 'history',
  });
  const directRuntimeCatalog = useMemo<RuntimeCatalog | undefined>(() => {
    const catalog = runtimeCatalogQuery.data;
    if (!catalog) return undefined;
    const directHarnessIds = new Set(
      catalog.harnesses
        .filter((harness) => harness.kind === 'direct')
        .map((harness) => harness.id),
    );
    return {
      ...catalog,
      harnesses: catalog.harnesses.filter((harness) =>
        directHarnessIds.has(harness.id),
      ),
      models: catalog.models.flatMap((model) => {
        const bindings = model.bindings.filter((binding) =>
          directHarnessIds.has(binding.harnessId),
        );
        return bindings.length > 0 ? [{ ...model, bindings }] : [];
      }),
      presets: catalog.presets.filter((preset) =>
        directHarnessIds.has(preset.selection.harnessId),
      ),
    };
  }, [runtimeCatalogQuery.data]);
  const configuredReflector = runtimeCatalogQuery.data?.defaults.reflector;
  const configuredReflectorIsDirect = !!directRuntimeCatalog?.models
    .find((model) => model.id === configuredReflector?.modelId)
    ?.bindings.some(
      (binding) => binding.harnessId === configuredReflector?.harnessId,
    );
  const fallbackDirectBinding = directRuntimeCatalog?.models[0]?.bindings[0];
  const defaultGenerateRuntime = configuredReflectorIsDirect
    ? configuredReflector
    : fallbackDirectBinding && directRuntimeCatalog?.models[0]
      ? {
          harnessId: fallbackDirectBinding.harnessId,
          modelId: directRuntimeCatalog.models[0].id,
        }
      : undefined;
  const configuredReflectorLabel = configuredReflector
    ? (runtimeCatalogQuery.data?.models.find(
        (model) => model.id === configuredReflector.modelId,
      )?.label ?? configuredReflector.modelId)
    : 'Not configured';

  function openGenerateDialog() {
    const now = new Date();
    setGenerateSinceEdited(false);
    setGenerateUntilEdited(false);
    setGenerateUntil(localDateTime(now.toISOString()));
    setGenerateSince(
      localDateTime(
        new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString(),
      ),
    );
    setGenerateProjectId(
      projects.find((project) => project.name.toLowerCase() === 'carapaboard')
        ?.id ??
        projects.find((project) => project.id === 'main')?.id ??
        projects[0]?.id ??
        '',
    );
    setGenerateRuntime(defaultGenerateRuntime ?? null);
    setGenerateOpen(true);
  }
  useEffect(() => {
    if (
      projects.length > 0 &&
      !projects.some((candidate) => candidate.id === existingProjectId)
    ) {
      setExistingProjectId(projects[0]!.id);
    }
  }, [existingProjectId, projects]);

  const existingMemoriesQuery = useInfiniteQuery({
    queryKey: queryKeys.memories.existing(existingProjectId, '', 'all'),
    queryFn: ({ pageParam }) =>
      fetchExistingMemoriesPage(existingProjectId, {
        offset: pageParam,
        limit: 100,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => {
      const next = lastPage.offset + lastPage.items.length;
      return next < lastPage.total ? next : undefined;
    },
    enabled: isAdmin && mode === 'existing' && !!existingProjectId,
  });
  const existingMemories = useMemo(
    () => existingMemoriesQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [existingMemoriesQuery.data],
  );
  const existingMemoryTotal = existingMemoriesQuery.data?.pages[0]?.total ?? 0;
  useEffect(() => {
    const sentinel = existingMemoryLoadMoreRef.current;
    if (
      !sentinel ||
      !existingMemoriesQuery.hasNextPage ||
      existingMemoriesQuery.isFetchingNextPage ||
      existingMemoriesQuery.isFetchNextPageError ||
      typeof IntersectionObserver === 'undefined'
    ) {
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          void existingMemoriesQuery.fetchNextPage();
        }
      },
      { rootMargin: '600px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [
    existingMemoriesQuery.fetchNextPage,
    existingMemoriesQuery.hasNextPage,
    existingMemoriesQuery.isFetchingNextPage,
    existingMemoriesQuery.isFetchNextPageError,
  ]);
  const memoryAuditsQuery = useQuery({
    queryKey: queryKeys.memoryAudits.all(existingProjectId),
    queryFn: () => fetchProjectMemoryAudits(existingProjectId),
    enabled: isAdmin && mode === 'existing' && !!existingProjectId,
    refetchInterval: 5_000,
  });
  const memoryAuditReportQuery = useQuery({
    queryKey: queryKeys.memoryAudits.report(existingProjectId),
    queryFn: () => fetchProjectMemoryAuditReport(existingProjectId),
    enabled: isAdmin && mode === 'existing' && !!existingProjectId,
    refetchInterval: 30_000,
  });
  useEffect(() => {
    // Keep the URL/selected id until the list has loaded.
    const audits = memoryAuditsQuery.data?.audits;
    if (!audits) return;
    if (audits.some((audit) => audit.id === auditId)) {
      if (startedAuditRef.current?.auditId === auditId)
        startedAuditRef.current = null;
      return;
    }
    const started = startedAuditRef.current;
    if (
      auditId &&
      started?.auditId === auditId &&
      started.projectId === existingProjectId
    )
      return;
    setAuditId(audits[0]?.id ?? '');
  }, [auditId, existingProjectId, memoryAuditsQuery.data]);
  const memoryAuditQuery = useQuery({
    queryKey: queryKeys.memoryAudits.detail(existingProjectId, auditId),
    queryFn: () => fetchProjectMemoryAudit(existingProjectId, auditId),
    enabled: isAdmin && mode === 'existing' && !!existingProjectId && !!auditId,
    refetchInterval: (query) =>
      ['queued', 'running', 'applying'].includes(query.state.data?.status ?? '')
        ? 2_000
        : 15_000,
  });
  useEffect(() => {
    const batches = batchesQuery.data?.batches ?? [];
    if (!batchId && batches[0]) {
      const newestActive = batches.find(
        (batch) => batch.status === 'previewing' || batch.status === 'applying',
      );
      setBatchId((newestActive ?? batches[0]).id);
    }
  }, [batchId, batchesQuery.data]);

  const batchQuery = useQuery({
    queryKey: queryKeys.historyReview.batch(batchId),
    queryFn: () => fetchHistoryReviewBatch(batchId),
    enabled: isAdmin && mode === 'history' && !!batchId,
    refetchInterval: (query) =>
      pollUnlessError(
        query.state.data?.batch.status === 'previewing' ? 5_000 : 30_000,
      )(query),
  });
  const historyLoad = useQueryLoadState([batchesQuery, batchQuery], {
    isEmpty: () => !batchesQuery.data?.batches.length,
  });
  useEffect(() => {
    // Keep the URL project until the batch has loaded.
    if (!batchQuery.data) return;
    const projects = batchQuery.data.projects ?? [];
    if (!projects.length) {
      setProjectId('');
      return;
    }
    if (!projects.some((project) => project.project_id === projectId)) {
      setProjectId(
        projects.find((project) => project.project_status === 'preview')
          ?.project_id ?? projects[0]!.project_id,
      );
    }
  }, [batchQuery.data, projectId]);

  const project = batchQuery.data?.projects?.find(
    (item) => item.project_id === projectId,
  );
  const reviewProjectIds = useMemo(
    () =>
      new Set((batchQuery.data?.projects ?? []).map((item) => item.project_id)),
    [batchQuery.data?.projects],
  );
  // The mobile picker replaces the sidebar below md, where the pending badge
  // would otherwise be hidden. Mirror the sidebar badge as item badges, only
  // for projects in the current batch that still have pending audits.
  const pendingAuditBadges = useMemo(
    () =>
      Object.fromEntries(
        (batchQuery.data?.projects ?? [])
          .filter((item) => item.counts.pending > 0)
          .map((item) => [item.project_id, `${item.counts.pending} pending`]),
      ),
    [batchQuery.data?.projects],
  );
  const selectedProjectName =
    projects.find((candidate) => candidate.id === projectId)?.name ?? projectId;

  const generateMutation = useMutation({
    mutationFn: () => {
      if (!generateRuntime) throw new Error('Select a reflector model');
      const submittedAt = new Date();
      const since = generateSinceEdited
        ? isoDateTime(generateSince)
        : new Date(submittedAt.getTime() - 48 * 60 * 60 * 1000).toISOString();
      const until = generateUntilEdited
        ? isoDateTime(generateUntil)
        : submittedAt.toISOString();
      return startHistoryReviewGeneration({
        projectId: generateProjectId,
        since,
        until,
        reflectorRuntime: generateRuntime,
      });
    },
    onSuccess: ({ batchId: generatedBatchId }) => {
      setGenerateOpen(false);
      setBatchId(generatedBatchId);
      setProjectId(generateProjectId);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.historyReview.batches,
      });
      toast.success('History proposal generation started');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const reviewMutation = useMutation({
    mutationFn: (input: {
      item: HistoryReviewOperation;
      decision: 'pending' | 'approved' | 'rejected';
      markForEval?: boolean;
      edits?: HistoryReviewEdits;
      targetProjectId?: string;
    }) =>
      updateHistoryReviewOperation(batchId, projectId, input.item.id, {
        revision: project?.review_revision ?? 0,
        decision: input.decision,
        mark_for_eval: input.markForEval,
        target_project_id: input.targetProjectId,
        edits: input.edits,
      }),
    onSuccess: (updated, input) => {
      queryClient.setQueryData<HistoryReviewBatchDetail>(
        queryKeys.historyReview.batch(batchId),
        (detail) => replaceProject(detail, updated),
      );
      setEditingId((current) => (current === input.item.id ? null : current));
    },
    onError: (error: Error) => toast.error(error.message),
  });

  useEffect(() => {
    if (!search.itemId || !project || !batchQuery.data) return;
    const item = project.operations.find(
      (candidate) => candidate.id === search.itemId,
    );
    if (!item) return;

    const deepLinkKey = `${batchId}:${projectId}:${item.id}:${search.action ?? 'view'}`;
    if (handledDeepLinkRef.current === deepLinkKey) return;
    handledDeepLinkRef.current = deepLinkKey;
    setFilter('all');
    setOperationFilter('all');
    setTypeFilter('all');

    if (search.action === 'edit') {
      if (item.operation.op !== 'forget') setEditingId(item.id);
    } else if (
      (search.action === 'approve' || search.action === 'delete') &&
      project.review_enabled &&
      !reviewMutation.isPending
    ) {
      void navigate({
        to: '/memory-review',
        search: (previous) => ({ ...previous, action: undefined }),
        replace: true,
      });
      reviewMutation.mutate({
        item,
        decision: search.action === 'approve' ? 'approved' : 'rejected',
        markForEval: false,
      });
    }

    window.requestAnimationFrame(() => {
      document
        .getElementById(`memory-review-operation-${item.id}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, [
    batchId,
    batchQuery.data,
    navigate,
    project,
    projectId,
    reviewMutation,
    search.action,
    search.itemId,
  ]);

  const resetMutation = useMutation({
    mutationFn: () => resetHistoryReviewProject(batchId, projectId),
    onSuccess: (updated) => {
      queryClient.setQueryData<HistoryReviewBatchDetail>(
        queryKeys.historyReview.batch(batchId),
        (detail) => replaceProject(detail, updated),
      );
      toast.success('Review reset');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const acceptPartialMutation = useMutation({
    mutationFn: () => acceptPartialHistoryReviewBatch(batchId),
    onSuccess: (detail) => {
      queryClient.setQueryData<HistoryReviewBatchDetail>(
        queryKeys.historyReview.batch(batchId),
        detail,
      );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.historyReview.batches,
      });
      const failed = detail.projects.filter(
        (project) => project.project_status === 'error',
      );
      if (failed.length > 0) {
        toast.error(
          `Some proposals could not be recovered: ${failed
            .map(
              (project) =>
                `${project.project_id}: ${project.errors.join('; ')}`,
            )
            .join(' · ')}`,
        );
        return;
      }
      toast.success(
        'Partial results recovered; valid proposals are ready for review',
      );
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const applyMutation = useMutation({
    mutationFn: () => applyHistoryReviewProject(batchId, projectId),
    onSuccess: (result) => {
      queryClient.setQueryData<HistoryReviewBatchDetail>(
        queryKeys.historyReview.batch(batchId),
        (detail) => replaceProject(detail, result.project),
      );
      queryClient.invalidateQueries({
        queryKey: queryKeys.historyReview.batches,
      });
      toast.success(
        `Applied ${Object.values(result.applied.applied).reduce((a, b) => a + b, 0)} memory operations${result.applied.baselineRebased ? ' after safely rebasing them onto the current memory timeline' : ''}`,
      );
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const existingUpdateMutation = useMutation({
    mutationFn: (input: {
      projectId: string;
      memory: ExistingMemory;
      updates: Parameters<typeof updateExistingMemory>[2];
    }) => updateExistingMemory(input.projectId, input.memory.id, input.updates),
    onSuccess: (updated, input) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.memories.existing(input.projectId, '', 'all'),
      });
      setExistingEditingId((current) =>
        current === input.memory.id ? null : current,
      );
      toast.success('Memory updated');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const existingDeleteMutation = useMutation({
    mutationFn: (input: { projectId: string; memory: ExistingMemory }) =>
      deleteExistingMemory(input.projectId, input.memory.id).then(
        () => input.memory.id,
      ),
    onSuccess: (deletedId, input) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.memories.existing(input.projectId, '', 'all'),
      });
      toast.success('Memory permanently deleted');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const existingMoveMutation = useMutation({
    mutationFn: (input: {
      projectId: string;
      targetProjectId: string;
      memory: ExistingMemory;
    }) =>
      moveExistingMemory(
        input.projectId,
        input.memory.id,
        input.targetProjectId,
      ),
    onSuccess: (moved, input) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.memories.existing(input.projectId, '', 'all'),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.memories.existing(input.targetProjectId, '', 'all'),
      });
      toast.success(`Memory moved to ${input.targetProjectId}`);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const startAuditMutation = useMutation({
    mutationFn: (input: {
      projectId: string;
      jobMode: 'cleanup' | 'index' | 'reorganize';
    }) => startProjectMemoryAudit(input.projectId, input.jobMode),
    onSuccess: ({ audit, created }, input) => {
      // The user may have switched projects while the request was in flight;
      // only select the new audit when its project is still the one shown.
      if (input.projectId === currentExistingProjectIdRef.current) {
        startedAuditRef.current = {
          projectId: input.projectId,
          auditId: audit.id,
        };
        setAuditId(audit.id);
      }
      void queryClient.invalidateQueries({
        queryKey: queryKeys.memoryAudits.all(input.projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.memoryAudits.report(input.projectId),
      });
      toast.success(
        created
          ? audit.mode === 'index'
            ? 'Project knowledge indexing started'
            : audit.mode === 'reorganize'
              ? 'Memory reorganization started'
              : 'Memory audit started'
          : 'Opened the active memory-maintenance job',
      );
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const resumeAuditMutation = useMutation({
    mutationFn: () => resumeProjectMemoryAudit(existingProjectId, auditId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.memoryAudits.all(existingProjectId),
      });
      toast.success('Memory audit resumed');
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const auditReviewMutation = useMutation({
    mutationFn: (input: {
      item: MemoryAuditItem;
      decision: MemoryAuditReviewDecision;
      edits?: Parameters<typeof reviewProjectMemoryAuditItem>[3]['edits'];
    }) =>
      reviewProjectMemoryAuditItem(existingProjectId, auditId, input.item.id, {
        revision: input.item.revision,
        decision: input.decision,
        edits: input.edits,
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData<MemoryAuditView>(
        queryKeys.memoryAudits.detail(existingProjectId, auditId),
        updated,
      );
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const deleteSkippedMemoryMutation = useMutation({
    mutationFn: (item: MemoryAuditItem) =>
      deleteSkippedProjectMemory(existingProjectId, auditId, item.id),
    onSuccess: (updated) => {
      queryClient.setQueryData<MemoryAuditView>(
        queryKeys.memoryAudits.detail(existingProjectId, auditId),
        updated,
      );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.memories.existing(existingProjectId, '', 'all'),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.memoryAudits.report(existingProjectId),
      });
      toast.success('Skipped memory permanently deleted');
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const auditRecheckMutation = useMutation({
    mutationFn: (memoryId: string) =>
      forceRecheckProjectMemory(existingProjectId, auditId, memoryId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.memoryAudits.all(existingProjectId),
      });
      toast.success('Memory queued for a fresh check');
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const applyAuditMutation = useMutation({
    mutationFn: () => applyProjectMemoryAudit(existingProjectId, auditId),
    onSuccess: (updated) => {
      queryClient.setQueryData<MemoryAuditView>(
        queryKeys.memoryAudits.detail(existingProjectId, auditId),
        updated,
      );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.memoryAudits.all(existingProjectId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.memoryAudits.report(existingProjectId),
      });
      void queryClient.invalidateQueries({
        queryKey: ['memories', 'existing'],
      });
      void existingMemoriesQuery.refetch();
      toast.success(
        updated.status === 'applied'
          ? 'Memory audit fully applied'
          : 'Reviewed decisions applied; the remaining audit is unchanged',
      );
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const approveAndApplyAuditMutation = useMutation({
    mutationFn: () =>
      approveAndApplyProjectMemoryAudit(existingProjectId, auditId),
    onSuccess: (updated) => {
      queryClient.setQueryData<MemoryAuditView>(
        queryKeys.memoryAudits.detail(existingProjectId, auditId),
        updated,
      );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.memoryAudits.all(existingProjectId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.memoryAudits.report(existingProjectId),
      });
      void queryClient.invalidateQueries({
        queryKey: ['memories', 'existing'],
      });
      void existingMemoriesQuery.refetch();
      toast.success(
        updated.status === 'applied'
          ? 'All current proposals approved and applied'
          : 'Current non-stale proposals approved and applied',
      );
    },
    onError: (error: Error) => toast.error(error.message),
  });

  async function verifyInProjectChat(item: HistoryReviewOperation) {
    if (!project || verificationItemId) return;
    const targetProjectId = project.project_id;
    setVerificationItemId(item.id);
    try {
      const conversation = await createConversation(targetProjectId);
      const store = useStore.getState();
      store.setActiveConvForProject(targetProjectId, conversation.id);
      store.saveDraftByKey(
        `${targetProjectId}:${conversation.id}`,
        buildHistoryReviewVerificationPrompt({
          batchId,
          projectId: targetProjectId,
          item,
        }),
      );
      const linkSearch = new URLSearchParams({
        batchId,
        projectId: targetProjectId,
        itemId: item.id,
      });
      store.setDraftDeepLinksByKey(`${targetProjectId}:${conversation.id}`, [
        {
          label: 'Approve',
          href: `/memory-review?${linkSearch.toString()}&action=approve`,
          variant: 'default',
        },
        {
          label: 'Delete',
          href: `/memory-review?${linkSearch.toString()}&action=delete`,
          variant: 'destructive',
        },
        {
          label: 'Edit',
          href: `/memory-review?${linkSearch.toString()}&action=edit`,
          variant: 'outline',
        },
      ]);
      // Debug mode asks the normal project agent to prioritize evidence. If a
      // project has custom modes without "debug", ChatPage safely falls back
      // to its normal mode while preserving the drafted request.
      store.setChatModeForComposer(
        `${targetProjectId}:${conversation.id}`,
        'debug',
      );
      await queryClient.invalidateQueries({
        queryKey: queryKeys.conversations.all(targetProjectId),
      });
      await navigate({
        to: '/chat/$projectId',
        params: { projectId: targetProjectId },
      });
      toast.success('Verification request drafted in a fresh project chat');
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Could not open a project verification chat',
      );
    } finally {
      setVerificationItemId(null);
    }
  }

  const visibleOperations = useMemo(() => {
    if (!project) return [];
    return project.operations.filter((item) => {
      if (
        filter !== 'all' &&
        (filter === 'eval' ? !item.mark_for_eval : item.decision !== filter)
      ) {
        return false;
      }
      if (operationFilter !== 'all' && item.operation.op !== operationFilter) {
        return false;
      }
      return (
        typeFilter === 'all' || operationType(item.operation) === typeFilter
      );
    });
  }, [filter, operationFilter, project, typeFilter]);

  const visibleExistingMemories = useMemo(() => {
    const query = existingSearch.trim().toLowerCase();
    return existingMemories.filter((memory) => {
      if (
        existingTypeFilter !== 'all' &&
        memory.memory_type !== existingTypeFilter
      ) {
        return false;
      }
      if (existingEvalFilter === 'marked' && !memory.marked_for_eval) {
        return false;
      }
      if (existingEvalFilter === 'unmarked' && memory.marked_for_eval) {
        return false;
      }
      return (
        !query ||
        memory.content.toLowerCase().includes(query) ||
        memory.id.toLowerCase().includes(query) ||
        memory.tags.some((tag) => tag.toLowerCase().includes(query))
      );
    });
  }, [
    existingEvalFilter,
    existingMemories,
    existingSearch,
    existingTypeFilter,
  ]);

  const memoryAuditProposalGroups = useMemo(() => {
    const proposals = (memoryAuditQuery.data?.items ?? [])
      .filter((item) =>
        ['rewrite', 'merge', 'erase', 'create', 'enhance', 'move'].includes(
          item.disposition ?? '',
        ),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    const stale = proposals.filter(
      (item) =>
        !item.applied_at &&
        item.stale &&
        !['dismissed', 'delete_memory'].includes(item.review_decision),
    );
    const staleIds = new Set(stale.map((item) => item.id));
    return {
      stale,
      pending: proposals.filter(
        (item) =>
          !item.applied_at &&
          !staleIds.has(item.id) &&
          item.review_decision === 'pending',
      ),
      reviewed: proposals.filter(
        (item) =>
          !item.applied_at &&
          !staleIds.has(item.id) &&
          item.review_decision !== 'pending',
      ),
      applied: proposals.filter((item) => !!item.applied_at),
    };
  }, [memoryAuditQuery.data?.items]);

  const auditProposalBusy =
    auditReviewMutation.isPending ||
    auditRecheckMutation.isPending ||
    applyAuditMutation.isPending ||
    approveAndApplyAuditMutation.isPending;

  const pendingApplicableAuditCount =
    memoryAuditQuery.data?.items.filter(
      (item) =>
        !item.applied_at &&
        !item.stale &&
        item.review_decision === 'pending' &&
        ['rewrite', 'merge', 'erase', 'create', 'enhance', 'move'].includes(
          item.disposition ?? '',
        ),
    ).length ?? 0;

  const selectedExistingProject = projects.find(
    (project) => project.id === existingProjectId,
  );
  const hasRelatedMemoryProject =
    !!selectedExistingProject?.parentId ||
    projects.some((project) => project.parentId === existingProjectId) ||
    (selectedExistingProject?.settings?.memorySourceProjects ?? []).some(
      (sourceId) => projects.some((project) => project.id === sourceId),
    );
  const hasActiveMemoryJob = (memoryAuditsQuery.data?.audits ?? []).some(
    (audit) =>
      ['queued', 'running', 'ready', 'applying', 'paused'].includes(
        audit.status,
      ) &&
      !(
        audit.status === 'ready' &&
        audit.processed_items >= audit.total_items &&
        audit.proposal_items === 0
      ),
  );

  if (!isAdmin) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="Memory Review" />
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          Administrator access is required.
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Memory Review"
        subtitle="Review historical proposals or maintain existing project memories."
      />
      <Dialog open={generateOpen} onOpenChange={setGenerateOpen}>
        <DialogContent data-ui="history-proposal-generation-dialog">
          <DialogHeader>
            <DialogTitle>Generate history proposals</DialogTitle>
            <DialogDescription>
              Preview conversation evidence as staged memory changes. Nothing is
              written to live memory until you review and apply it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5 text-sm">
              <span className="font-medium">Project</span>
              <ProjectPicker
                projects={projects}
                value={generateProjectId}
                onValueChange={setGenerateProjectId}
                className="w-full"
                aria-label="History proposal project"
                data-ui="history-proposal-project-picker"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1.5 text-sm">
                <span className="font-medium">From</span>
                <Input
                  data-ui="history-proposal-since"
                  type="datetime-local"
                  value={generateSince}
                  onChange={(event) => {
                    setGenerateSince(event.target.value);
                    setGenerateSinceEdited(true);
                  }}
                />
              </label>
              <label className="space-y-1.5 text-sm">
                <span className="font-medium">Until</span>
                <Input
                  data-ui="history-proposal-until"
                  type="datetime-local"
                  value={generateUntil}
                  onChange={(event) => {
                    setGenerateUntil(event.target.value);
                    setGenerateUntilEdited(true);
                  }}
                />
              </label>
            </div>
            <div
              className="space-y-2"
              data-ui="history-proposal-runtime-picker"
            >
              <div>
                <div className="text-sm font-medium">Reflector model</div>
                <p className="text-xs text-muted-foreground">
                  Configured default: {configuredReflectorLabel}. Select any
                  configured direct runtime to override it for this preview.
                </p>
              </div>
              <RuntimePicker
                catalog={directRuntimeCatalog}
                value={generateRuntime}
                onChange={setGenerateRuntime}
                allowClear={false}
                presets={directRuntimeCatalog?.presets}
                reasoningEmptyLabel="Default reasoning"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setGenerateOpen(false)}
              disabled={generateMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              data-ui="history-proposal-submit"
              disabled={
                generateMutation.isPending ||
                !generateProjectId ||
                !generateSince ||
                !generateUntil ||
                !generateRuntime
              }
              onClick={() => generateMutation.mutate()}
            >
              {generateMutation.isPending ? (
                <Loader2 className="mr-1 size-4 animate-spin" />
              ) : (
                <WandSparkles className="mr-1 size-4" />
              )}
              Generate proposals
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 sm:gap-3 sm:px-4 sm:py-3">
          <BrainCircuit className="hidden size-5 text-primary sm:block" />
          <Select
            compact
            aria-label="Review mode"
            value={mode}
            onValueChange={(nextValue) => setMode(nextValue as ReviewMode)}
          >
            <SelectItem value="history">History proposals</SelectItem>
            <SelectItem value="existing">Existing memories</SelectItem>
          </Select>
          {mode === 'history' ? (
            <>
              <Button
                data-ui="history-proposal-generate"
                size="sm"
                onClick={openGenerateDialog}
                disabled={
                  projects.length === 0 || runtimeCatalogQuery.isLoading
                }
              >
                <WandSparkles className="mr-1 size-3.5" />
                Generate proposals
              </Button>
              <Select
                compact
                aria-label="Proposal batch"
                data-ui="memory-review-batch-selector"
                value={batchId}
                onValueChange={(nextValue) => {
                  setBatchId(nextValue);
                  setProjectId('');
                }}
                className="min-w-0 flex-1 sm:min-w-72 sm:flex-none"
              >
                {!batchId && (
                  <SelectItem value="" disabled>
                    {batchesQuery.isLoading
                      ? 'Loading history reviews…'
                      : batchesQuery.isError && !batchesQuery.data
                        ? 'Could not load history reviews'
                        : 'No history-review batches found'}
                  </SelectItem>
                )}
                {(batchesQuery.data?.batches ?? []).map((batch) => (
                  <SelectItem key={batch.id} value={batch.id}>
                    {batchLabel(batch.id)} · {batch.status}
                  </SelectItem>
                ))}
              </Select>
              {batchQuery.data?.batch && (
                <>
                  <Badge
                    variant="outline"
                    className={statusColor(batchQuery.data.batch.status)}
                  >
                    {batchQuery.data.batch.status}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {batchQuery.data.batch.ready}/
                    {batchQuery.data.batch.projects} ready ·{' '}
                    {batchQuery.data.batch.applied} applied
                  </span>
                  <span
                    data-ui="history-proposal-batch-metadata"
                    className="basis-full text-xs text-muted-foreground sm:basis-auto"
                  >
                    {batchQuery.data.batch.reflectorModel ??
                      'Configured reflector'}{' '}
                    ·{' '}
                    {batchQuery.data.batch.since
                      ? new Date(batchQuery.data.batch.since).toLocaleString()
                      : 'All history'}{' '}
                    →{' '}
                    {new Date(
                      batchQuery.data.batch.until ??
                        batchQuery.data.batch.cutoff_at,
                    ).toLocaleString()}
                  </span>
                  {batchQuery.data.batch.status === 'error' && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-amber-500/40 text-amber-800 dark:text-amber-200 hover:bg-amber-500/10"
                      disabled={acceptPartialMutation.isPending}
                      onClick={async () => {
                        const confirmed = await confirmAction(
                          'Keep every successfully collected proposal, ignore the remaining failures, and mark unfinished candidates as skipped?',
                          {
                            title: 'Accept partial results?',
                            confirmLabel: 'Accept partial',
                          },
                        );
                        if (confirmed) acceptPartialMutation.mutate();
                      }}
                    >
                      {acceptPartialMutation.isPending && (
                        <Loader2 className="mr-1 size-3.5 animate-spin" />
                      )}
                      Ignore errors & continue
                    </Button>
                  )}
                </>
              )}
            </>
          ) : (
            <>
              <ProjectPicker
                projects={projects}
                value={existingProjectId}
                onValueChange={(value) => {
                  setExistingProjectId(value);
                  startedAuditRef.current = null;
                  setAuditId('');
                  setExistingEditingId(null);
                }}
                className="min-w-0 flex-1 sm:min-w-64 sm:flex-none"
                aria-label="Existing memories project"
                data-ui="existing-memory-project-picker"
              />
              <span
                className="text-xs text-muted-foreground"
                data-ui="existing-memory-count"
              >
                {existingMemoriesQuery.isError && !existingMemoriesQuery.data
                  ? 'Could not load memories'
                  : `${existingMemoryTotal} active memories in database`}
              </span>
              <Button
                size="sm"
                disabled={
                  !existingProjectId ||
                  startAuditMutation.isPending ||
                  hasActiveMemoryJob
                }
                onClick={() =>
                  startAuditMutation.mutate({
                    projectId: existingProjectId,
                    jobMode: 'cleanup',
                  })
                }
              >
                {startAuditMutation.isPending ? (
                  <Loader2 className="mr-1 size-3.5 animate-spin" />
                ) : (
                  <BrainCircuit className="mr-1 size-3.5" />
                )}
                Audit memories
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={
                  !existingProjectId ||
                  startAuditMutation.isPending ||
                  hasActiveMemoryJob
                }
                onClick={() =>
                  startAuditMutation.mutate({
                    projectId: existingProjectId,
                    jobMode: 'index',
                  })
                }
              >
                {startAuditMutation.isPending ? (
                  <Loader2 className="mr-1 size-3.5 animate-spin" />
                ) : (
                  <Sparkles className="mr-1 size-3.5" />
                )}
                Index project knowledge
              </Button>
              <Button
                size="sm"
                variant="outline"
                title={
                  hasRelatedMemoryProject
                    ? 'Propose moves only between this project and related parent, child, or configured memory-source projects'
                    : 'Configure a parent, child, or memory source first'
                }
                disabled={
                  !existingProjectId ||
                  !hasRelatedMemoryProject ||
                  startAuditMutation.isPending ||
                  hasActiveMemoryJob
                }
                onClick={() =>
                  startAuditMutation.mutate({
                    projectId: existingProjectId,
                    jobMode: 'reorganize',
                  })
                }
              >
                {startAuditMutation.isPending ? (
                  <Loader2 className="mr-1 size-3.5 animate-spin" />
                ) : (
                  <MoveRight className="mr-1 size-3.5" />
                )}
                Reorganize memories
              </Button>
            </>
          )}
          <Button
            data-ui="memory-review-refresh"
            variant="ghost"
            size="sm"
            className="ml-auto shrink-0"
            onClick={() => {
              if (mode === 'existing') {
                void existingMemoriesQuery.refetch();
              } else {
                void batchesQuery.refetch();
                if (batchId) void batchQuery.refetch();
              }
            }}
            disabled={
              mode === 'existing'
                ? existingMemoriesQuery.isFetching
                : batchesQuery.isFetching || batchQuery.isFetching
            }
          >
            <RefreshCw
              className={cn(
                'mr-1 size-3.5',
                (mode === 'existing'
                  ? existingMemoriesQuery.isFetching
                  : batchesQuery.isFetching || batchQuery.isFetching) &&
                  'animate-spin',
              )}
            />
            Refresh
          </Button>
        </div>

        {mode === 'history' && historyLoad.staleError && (
          <div
            role="alert"
            data-ui="memory-review-history-stale-error"
            className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2 text-sm text-destructive"
          >
            <AlertCircle className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              Could not refresh history reviews:{' '}
              {historyLoad.staleError.message}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={historyLoad.retry}
              disabled={historyLoad.isRetrying}
            >
              {historyLoad.isRetrying && (
                <Loader2 className="animate-spin" aria-hidden />
              )}
              Retry
            </Button>
          </div>
        )}
        {mode === 'existing' ? (
          <div className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
            <div className="mx-auto max-w-5xl space-y-4">
              {memoryAuditReportQuery.data && (
                <details className="group rounded-lg border border-border/70 bg-card">
                  <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-4 py-3 text-sm [&::-webkit-details-marker]:hidden">
                    <ChevronRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
                    <span className="font-medium">
                      Memory maintenance report
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {memoryAuditReportQuery.data.total_audits} jobs
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Last applied:{' '}
                      {memoryAuditReportQuery.data.last_applied_at
                        ? new Date(
                            memoryAuditReportQuery.data.last_applied_at,
                          ).toLocaleString()
                        : 'never'}
                    </span>
                    <span className="ml-auto flex flex-wrap gap-2">
                      <Badge variant="outline">
                        {memoryAuditReportQuery.data.totals.erased} erased
                      </Badge>
                      <Badge variant="outline">
                        {memoryAuditReportQuery.data.totals.merged} merged
                      </Badge>
                      <Badge variant="outline">
                        {memoryAuditReportQuery.data.totals.created} created
                      </Badge>
                      <Badge variant="outline">
                        {memoryAuditReportQuery.data.totals.moved} moved
                      </Badge>
                    </span>
                  </summary>
                  <div className="space-y-3 border-t border-border/60 p-4">
                    <p className="text-xs text-muted-foreground">
                      Counts include only human-approved operations that were
                      successfully applied by automated memory maintenance.
                    </p>
                    <div className="space-y-2">
                      {memoryAuditReportQuery.data.audits
                        .filter(
                          (audit) =>
                            audit.counts.erased +
                              audit.counts.merged +
                              audit.counts.created +
                              audit.counts.moved >
                            0,
                        )
                        .map((audit) => (
                          <div
                            key={audit.id}
                            className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-xs"
                          >
                            <Badge variant="secondary">{audit.mode}</Badge>
                            <span className="text-muted-foreground">
                              {new Date(audit.created_at).toLocaleString()}
                            </span>
                            <span className="ml-auto flex flex-wrap gap-2">
                              {audit.counts.erased > 0 && (
                                <span>{audit.counts.erased} erased</span>
                              )}
                              {audit.counts.merged > 0 && (
                                <span>{audit.counts.merged} merged</span>
                              )}
                              {audit.counts.created > 0 && (
                                <span>{audit.counts.created} created</span>
                              )}
                              {audit.counts.moved > 0 && (
                                <span>{audit.counts.moved} moved</span>
                              )}
                            </span>
                          </div>
                        ))}
                      {memoryAuditReportQuery.data.audits.every(
                        (audit) =>
                          audit.counts.erased +
                            audit.counts.merged +
                            audit.counts.created +
                            audit.counts.moved ===
                          0,
                      ) && (
                        <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                          No memory-maintenance changes have been applied yet.
                        </div>
                      )}
                    </div>
                  </div>
                </details>
              )}
              {memoryAuditQuery.data && (
                <Card className="border-primary/20">
                  <CardContent className="space-y-4 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">
                            {memoryAuditQuery.data.mode === 'index'
                              ? 'Project knowledge indexing'
                              : memoryAuditQuery.data.mode === 'reorganize'
                                ? 'Memory reorganization'
                                : 'Automated memory audit'}
                          </span>
                          <Badge
                            variant="outline"
                            className={statusColor(
                              memoryAuditQuery.data.status,
                            )}
                          >
                            {memoryAuditQuery.data.status}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {memoryAuditQuery.data.runtime_id}
                          </span>
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {memoryAuditQuery.data.processed_items}/
                          {memoryAuditQuery.data.total_items} checked ·{' '}
                          {memoryAuditQuery.data.proposal_items} proposals
                        </div>
                        {memoryAuditQuery.data.index_summary && (
                          <div className="mt-1 text-xs text-muted-foreground">
                            {memoryAuditQuery.data.index_summary.discovered}{' '}
                            discovered ·{' '}
                            {memoryAuditQuery.data.index_summary.created +
                              memoryAuditQuery.data.index_summary.enhanced}{' '}
                            proposed ·{' '}
                            {memoryAuditQuery.data.index_summary.covered}{' '}
                            covered ·{' '}
                            {memoryAuditQuery.data.index_summary.skipped}{' '}
                            skipped
                          </div>
                        )}
                      </div>
                      <div className="flex gap-2">
                        {['paused', 'failed'].includes(
                          memoryAuditQuery.data.status,
                        ) && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={resumeAuditMutation.isPending}
                            onClick={() => resumeAuditMutation.mutate()}
                          >
                            {resumeAuditMutation.isPending && (
                              <Loader2 className="mr-1 size-3.5 animate-spin" />
                            )}
                            Resume
                          </Button>
                        )}
                        {memoryAuditQuery.data.counts.applicable > 0 && (
                          <Button
                            size="sm"
                            disabled={
                              !memoryAuditQuery.data.apply_enabled ||
                              applyAuditMutation.isPending
                            }
                            title={
                              !memoryAuditQuery.data.apply_enabled
                                ? `Resolve the ${memoryAuditProposalGroups.stale.length} stale proposal(s) in Needs attention first (dismiss or delete them)`
                                : undefined
                            }
                            onClick={async () => {
                              if (
                                await confirmAction(
                                  memoryAuditQuery.data.mode === 'index'
                                    ? `Apply ${memoryAuditQuery.data.counts.applicable} reviewed indexing proposals now?`
                                    : memoryAuditQuery.data.mode ===
                                        'reorganize'
                                      ? `Move ${memoryAuditQuery.data.counts.approved} approved memories to their related projects and keep ${memoryAuditQuery.data.counts.rejected} rejected proposals in this project?`
                                      : `Apply ${memoryAuditQuery.data.counts.applicable} reviewed decisions now? Approved erasures are permanent${memoryAuditQuery.data.counts.delete_memory ? `; ${memoryAuditQuery.data.counts.delete_memory} rewrite decision(s) will erase their memory` : ''}${memoryAuditQuery.data.counts.delete_both ? `; ${memoryAuditQuery.data.counts.delete_both} merge decision(s) will erase both involved memories` : ''}. Unfinished audit items will continue later.`,
                                  {
                                    title: 'Apply reviewed decisions?',
                                    confirmLabel: 'Apply',
                                    destructive:
                                      memoryAuditQuery.data.mode === 'cleanup',
                                  },
                                )
                              ) {
                                applyAuditMutation.mutate();
                              }
                            }}
                          >
                            {applyAuditMutation.isPending && (
                              <Loader2 className="mr-1 size-3.5 animate-spin" />
                            )}
                            Apply reviewed (
                            {memoryAuditQuery.data.counts.applicable})
                          </Button>
                        )}
                        {pendingApplicableAuditCount > 0 && (
                          <Button
                            data-ui="memory-audit-approve-and-apply-all"
                            size="sm"
                            variant="secondary"
                            disabled={auditProposalBusy}
                            onClick={async () => {
                              if (
                                await confirmAction(
                                  `Approve ${pendingApplicableAuditCount} pending non-stale proposal(s) and apply all reviewed decisions now? This bypasses individual review. Approved cleanup proposals may rewrite, merge, or permanently erase memories.`,
                                  {
                                    title: 'Approve and apply all?',
                                    confirmLabel: 'Approve and apply',
                                    destructive: true,
                                  },
                                )
                              ) {
                                approveAndApplyAuditMutation.mutate();
                              }
                            }}
                          >
                            {approveAndApplyAuditMutation.isPending && (
                              <Loader2 className="mr-1 size-3.5 animate-spin" />
                            )}
                            Approve pending & apply all (
                            {pendingApplicableAuditCount})
                          </Button>
                        )}
                      </div>
                    </div>
                    {memoryAuditQuery.data.error && (
                      <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-700 dark:text-red-300">
                        {memoryAuditQuery.data.error}
                      </div>
                    )}
                    {['queued', 'running', 'applying'].includes(
                      memoryAuditQuery.data.status,
                    ) && (
                      <div className="h-2 overflow-hidden rounded bg-muted">
                        <div
                          className="h-full bg-primary transition-all"
                          style={{
                            width: `${memoryAuditQuery.data.total_items ? Math.round((memoryAuditQuery.data.processed_items / memoryAuditQuery.data.total_items) * 100) : 100}%`,
                          }}
                        />
                      </div>
                    )}
                    {memoryAuditQuery.data.counts.pending > 0 && (
                      <p className="text-xs text-muted-foreground">
                        {memoryAuditQuery.data.counts.pending} proposal(s) can
                        remain pending while reviewed decisions are applied.
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2 text-xs">
                      <Badge variant="outline">
                        {memoryAuditQuery.data.counts.pending} pending
                      </Badge>
                      <Badge variant="outline">
                        {memoryAuditQuery.data.counts.approved} approved
                      </Badge>
                      <Badge variant="outline">
                        {memoryAuditQuery.data.counts.rejected}{' '}
                        {memoryAuditQuery.data.mode === 'index'
                          ? 'rejected'
                          : memoryAuditQuery.data.mode === 'reorganize'
                            ? 'staying'
                            : 'kept'}
                      </Badge>
                      <Badge variant="outline">
                        {memoryAuditQuery.data.counts.applied} applied
                      </Badge>
                      {memoryAuditQuery.data.counts.delete_both > 0 && (
                        <Badge className="border-red-500/30 bg-red-500/10 text-red-800 dark:text-red-200">
                          {memoryAuditQuery.data.counts.delete_both} delete both
                        </Badge>
                      )}
                      {memoryAuditQuery.data.counts.delete_memory > 0 && (
                        <Badge className="border-red-500/30 bg-red-500/10 text-red-800 dark:text-red-200">
                          {memoryAuditQuery.data.counts.delete_memory} delete
                          memory
                        </Badge>
                      )}
                      {memoryAuditQuery.data.counts.dismissed > 0 && (
                        <Badge variant="outline">
                          {memoryAuditQuery.data.counts.dismissed} dismissed
                        </Badge>
                      )}
                      {memoryAuditQuery.data.counts.skipped > 0 && (
                        <Badge className="border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200">
                          {memoryAuditQuery.data.counts.skipped} skipped
                        </Badge>
                      )}
                    </div>
                    {memoryAuditQuery.data.counts.skipped > 0 && (
                      <details className="rounded-md border border-amber-500/20 bg-amber-500/5">
                        <summary className="cursor-pointer px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                          Show memories skipped because their evidence could not
                          be verified
                        </summary>
                        <div className="space-y-2 border-t border-amber-500/20 p-3">
                          {memoryAuditQuery.data.items
                            .filter(
                              (item) =>
                                item.processing_state === 'error' &&
                                !item.applied_at,
                            )
                            .map((item) => (
                              <div
                                key={item.id}
                                data-ui="skipped-memory"
                                data-memory-id={item.memory_id}
                                className="flex flex-col items-start gap-3 rounded-md border border-amber-500/15 p-3 text-xs sm:flex-row"
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="font-medium text-foreground">
                                    {item.memory?.content ?? item.memory_id}
                                  </div>
                                  <div className="mt-1 text-muted-foreground">
                                    {item.reason}
                                  </div>
                                </div>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="shrink-0 border-red-500/30 text-red-700 dark:text-red-300 hover:bg-red-500/10 hover:text-red-800 dark:hover:text-red-200"
                                  disabled={
                                    deleteSkippedMemoryMutation.isPending ||
                                    !item.memory
                                  }
                                  onClick={async () => {
                                    const confirmed = await confirmAction(
                                      'This cannot be undone.',
                                      {
                                        title:
                                          'Permanently delete this skipped memory?',
                                        confirmLabel: 'Delete memory',
                                        destructive: true,
                                      },
                                    );
                                    if (confirmed) {
                                      deleteSkippedMemoryMutation.mutate(item);
                                    }
                                  }}
                                >
                                  <Trash2 className="mr-1 size-3.5" />
                                  Delete memory
                                </Button>
                              </div>
                            ))}
                        </div>
                      </details>
                    )}
                    <div className="space-y-3">
                      {memoryAuditProposalGroups.stale.length > 0 && (
                        <section className="space-y-3">
                          <div className="flex items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
                            <span className="flex items-center gap-2 font-medium">
                              <AlertCircle className="size-4" />
                              Needs attention
                            </span>
                            <Badge className="border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200">
                              {memoryAuditProposalGroups.stale.length}
                            </Badge>
                          </div>
                          <MemoryAuditProposalList
                            items={memoryAuditProposalGroups.stale}
                            allItems={memoryAuditQuery.data.items}
                            moveTargets={memoryAuditQuery.data.related_projects}
                            busy={auditProposalBusy}
                            onDecision={(item, decision, edits) =>
                              auditReviewMutation.mutate({
                                item,
                                decision,
                                edits,
                              })
                            }
                            onRecheck={(item) =>
                              auditRecheckMutation.mutate(item.memory_id)
                            }
                          />
                        </section>
                      )}
                      <MemoryAuditProposalList
                        items={memoryAuditProposalGroups.pending}
                        allItems={memoryAuditQuery.data.items}
                        moveTargets={memoryAuditQuery.data.related_projects}
                        busy={auditProposalBusy}
                        onDecision={(item, decision, edits) =>
                          auditReviewMutation.mutate({
                            item,
                            decision,
                            edits,
                          })
                        }
                        onRecheck={(item) =>
                          auditRecheckMutation.mutate(item.memory_id)
                        }
                      />
                      <MemoryAuditProposalAccordion
                        label="Reviewed proposals"
                        items={memoryAuditProposalGroups.reviewed}
                        allItems={memoryAuditQuery.data.items}
                        moveTargets={memoryAuditQuery.data.related_projects}
                        busy={auditProposalBusy}
                        onDecision={(item, decision, edits) =>
                          auditReviewMutation.mutate({
                            item,
                            decision,
                            edits,
                          })
                        }
                        onRecheck={(item) =>
                          auditRecheckMutation.mutate(item.memory_id)
                        }
                      />
                      <MemoryAuditProposalAccordion
                        label="Applied changes"
                        items={memoryAuditProposalGroups.applied}
                        allItems={memoryAuditQuery.data.items}
                        moveTargets={memoryAuditQuery.data.related_projects}
                        busy={auditProposalBusy}
                        onDecision={(item, decision, edits) =>
                          auditReviewMutation.mutate({
                            item,
                            decision,
                            edits,
                          })
                        }
                        onRecheck={(item) =>
                          auditRecheckMutation.mutate(item.memory_id)
                        }
                      />
                      {['ready', 'applied'].includes(
                        memoryAuditQuery.data.status,
                      ) &&
                        memoryAuditQuery.data.proposal_items === 0 && (
                          <div className="rounded-md border border-dashed p-5 text-center text-sm text-muted-foreground">
                            {memoryAuditQuery.data.mode === 'index'
                              ? memoryAuditQuery.data.index_summary
                                ? `${memoryAuditQuery.data.index_summary.discovered} candidate(s) discovered; ${memoryAuditQuery.data.index_summary.covered} already covered and ${memoryAuditQuery.data.index_summary.skipped} skipped.${memoryAuditQuery.data.index_summary.summary ? ` ${memoryAuditQuery.data.index_summary.summary}` : ''}`
                                : 'No missing or incomplete high-value project knowledge was found.'
                              : memoryAuditQuery.data.mode === 'reorganize'
                                ? 'All memories already belong in this project.'
                                : 'No cleanup changes were proposed. Unchanged certificates will skip redundant future checks.'}
                          </div>
                        )}
                    </div>
                  </CardContent>
                </Card>
              )}
              <div className="flex flex-wrap items-end gap-2">
                <label className="min-w-64 flex-1 space-y-1 text-xs text-muted-foreground">
                  Search loaded memories
                  <SearchInput
                    value={existingSearch}
                    onChange={(event) => setExistingSearch(event.target.value)}
                    placeholder="Content, tag, or memory ID"
                    wrapperClassName="mt-1"
                    className="text-foreground"
                  />
                </label>
                <Select
                  aria-label="Filter existing memories by type"
                  value={existingTypeFilter}
                  onValueChange={(nextValue) =>
                    setExistingTypeFilter(nextValue)
                  }
                >
                  <SelectItem value="all">All memory types</SelectItem>
                  {MEMORY_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {type}
                    </SelectItem>
                  ))}
                </Select>
                <Select
                  aria-label="Filter existing memories by evaluation state"
                  value={existingEvalFilter}
                  onValueChange={(nextValue) =>
                    setExistingEvalFilter(nextValue as ExistingEvalFilter)
                  }
                >
                  <SelectItem value="all">All eval states</SelectItem>
                  <SelectItem value="marked">Marked for eval</SelectItem>
                  <SelectItem value="unmarked">Not marked for eval</SelectItem>
                </Select>
              </div>

              {existingMemoriesQuery.isLoading ? (
                <div className="flex justify-center gap-2 py-16 text-muted-foreground">
                  <Loader2 className="size-5 animate-spin" />
                  Loading existing memories…
                </div>
              ) : existingMemoriesQuery.isError &&
                !existingMemoriesQuery.data ? (
                <Card>
                  <CardContent className="flex flex-wrap items-center gap-3 p-6 text-sm text-destructive">
                    <AlertCircle className="size-5 shrink-0" />
                    <span className="min-w-0 flex-1">
                      {(existingMemoriesQuery.error as Error).message}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void existingMemoriesQuery.refetch()}
                      disabled={existingMemoriesQuery.isFetching}
                    >
                      Retry
                    </Button>
                  </CardContent>
                </Card>
              ) : (
                <>
                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline">
                      {visibleExistingMemories.length} shown
                    </Badge>
                    <Badge variant="outline">
                      {
                        existingMemories.filter(
                          (memory) => memory.marked_for_eval,
                        ).length
                      }{' '}
                      marked for eval
                    </Badge>
                    {existingMemories.length < existingMemoryTotal && (
                      <span>
                        Loaded {existingMemories.length} of{' '}
                        {existingMemoryTotal}. The audit covers all{' '}
                        {existingMemoryTotal}.
                      </span>
                    )}
                  </div>
                  <div className="space-y-3">
                    {visibleExistingMemories.map((memory) => (
                      <ExistingMemoryCard
                        key={memory.id}
                        memory={memory}
                        projectId={existingProjectId}
                        projects={projects}
                        editing={existingEditingId === memory.id}
                        busy={
                          existingUpdateMutation.isPending ||
                          existingDeleteMutation.isPending ||
                          existingMoveMutation.isPending
                        }
                        onEdit={() => setExistingEditingId(memory.id)}
                        onCancelEdit={() => setExistingEditingId(null)}
                        onSave={(updates) =>
                          existingUpdateMutation.mutate({
                            projectId: existingProjectId,
                            memory,
                            updates,
                          })
                        }
                        onToggleEval={() =>
                          existingUpdateMutation.mutate({
                            projectId: existingProjectId,
                            memory,
                            updates: {
                              mark_for_eval: !memory.marked_for_eval,
                            },
                          })
                        }
                        onMove={(targetProjectId) =>
                          existingMoveMutation.mutate({
                            projectId: existingProjectId,
                            targetProjectId,
                            memory,
                          })
                        }
                        onDelete={() =>
                          existingDeleteMutation.mutate({
                            projectId: existingProjectId,
                            memory,
                          })
                        }
                      />
                    ))}
                    {visibleExistingMemories.length === 0 && (
                      <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
                        No existing memories match the current filters.
                      </div>
                    )}
                    {existingMemoriesQuery.isError && (
                      <div
                        className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/30 p-3 text-sm"
                        data-ui="existing-memory-load-more-error"
                      >
                        <AlertCircle className="size-4 shrink-0 text-destructive" />
                        <div className="min-w-0 flex-1">
                          <p role="alert" className="text-destructive">
                            {existingMemoriesQuery.error?.message ||
                              (existingMemoriesQuery.isFetchNextPageError
                                ? 'Failed to load more memories'
                                : 'Failed to refresh memories')}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Showing {existingMemories.length} of{' '}
                            {existingMemoryTotal} memories
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            void (existingMemoriesQuery.isFetchNextPageError
                              ? existingMemoriesQuery.fetchNextPage()
                              : existingMemoriesQuery.refetch())
                          }
                          disabled={existingMemoriesQuery.isFetching}
                        >
                          {existingMemoriesQuery.isFetchNextPageError
                            ? 'Retry loading more'
                            : 'Retry'}
                        </Button>
                      </div>
                    )}
                    {existingMemoriesQuery.hasNextPage &&
                      !existingMemoriesQuery.isFetchNextPageError && (
                        <div
                          ref={existingMemoryLoadMoreRef}
                          className="flex h-10 items-center justify-center text-xs text-muted-foreground"
                          aria-live="polite"
                        >
                          {existingMemoriesQuery.isFetchingNextPage && (
                            <>
                              <Loader2 className="mr-1 size-3.5 animate-spin" />
                              Loading 100 more…
                            </>
                          )}
                        </div>
                      )}
                  </div>
                </>
              )}
            </div>
          </div>
        ) : historyLoad.phase === 'loading' ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
            Loading history reviews…
          </div>
        ) : historyLoad.phase === 'error' ? (
          <QueryErrorState
            title="Could not load history reviews"
            error={historyLoad.error}
            onRetry={historyLoad.retry}
            isRetrying={historyLoad.isRetrying}
          />
        ) : historyLoad.phase === 'empty' ? (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            No history-reflection batches found.
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 md:grid-cols-[280px_minmax(0,1fr)]">
            <aside
              data-ui="memory-review-project-sidebar"
              className="hidden min-h-0 overflow-auto border-r border-border bg-sidebar/40 p-2 md:block"
            >
              {(batchQuery.data?.projects ?? []).map((item) => (
                <button
                  key={item.project_id}
                  type="button"
                  onClick={() => setProjectId(item.project_id)}
                  className={cn(
                    'mb-1 w-full rounded-md px-3 py-2 text-left transition-colors',
                    projectId === item.project_id
                      ? 'bg-accent text-accent-foreground'
                      : 'hover:bg-accent/50',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">
                      {item.project_id}
                    </span>
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                    <span>
                      {item.progress.conversations_processed}/
                      {item.progress.conversations_total} conversations loaded
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <span>{item.project_status}</span>
                      {item.counts.pending > 0 && (
                        <Badge className="border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300">
                          {item.counts.pending} pending
                        </Badge>
                      )}
                    </span>
                  </div>
                  {/* The badge above already surfaces the pending count, so
                      this line only reports reviewed outcomes and renders
                      only when an operation has been approved or rejected. */}
                  {item.counts.approved + item.counts.rejected > 0 && (
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {item.counts.approved} approved · {item.counts.rejected}{' '}
                      rejected
                    </div>
                  )}
                </button>
              ))}
            </aside>

            <div className="min-h-0 overflow-auto p-3 sm:p-4 md:p-6">
              {project && (
                <div className="mx-auto max-w-5xl space-y-4">
                  <div className="md:hidden">
                    {/* Below md the sidebar is hidden, so the picker
                        re-surfaces the pending-audit count as item badges. */}
                    <ProjectPicker
                      projects={projects}
                      value={projectId}
                      onValueChange={setProjectId}
                      allowedProjectIds={reviewProjectIds}
                      badges={pendingAuditBadges}
                      className="w-full"
                      aria-label="Review project"
                      data-ui="memory-review-mobile-project-picker"
                    />
                  </div>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <h1 className="text-xl font-semibold">
                          {selectedProjectName}
                        </h1>
                        <Badge
                          variant="outline"
                          className={statusColor(project.project_status)}
                        >
                          {project.project_status}
                        </Badge>
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {project.progress.memory_files_processed}/
                        {project.progress.memory_files_total} native memory
                        files · {project.progress.conversations_processed}/
                        {project.progress.conversations_total} conversations
                        loaded
                      </p>
                      {project.progress.reflection && (
                        <p
                          className="mt-1 text-sm text-muted-foreground"
                          data-ui="history-reflection-progress"
                          data-project-id={project.project_id}
                          role="status"
                        >
                          {project.project_status === 'pending' &&
                          project.progress.reflection.activeChunk !== null
                            ? `Reflecting chunk ${project.progress.reflection.activeChunk}/${project.progress.reflection.totalChunks} · `
                            : ''}
                          {project.progress.reflection.completedChunks}/
                          {project.progress.reflection.totalChunks} chunks
                          completed
                          {' · '}
                          {project.progress.reflection.failedChunks} failed
                          {' · '}Updated{' '}
                          {new Date(
                            project.progress.reflection.updatedAt,
                          ).toLocaleTimeString()}
                        </p>
                      )}
                    </div>
                    <div className="flex gap-2">
                      {project.review_stale && (
                        <Button
                          variant="outline"
                          onClick={() => resetMutation.mutate()}
                          disabled={resetMutation.isPending}
                        >
                          Reset stale review
                        </Button>
                      )}
                      <Button
                        disabled={
                          !project.apply_enabled || applyMutation.isPending
                        }
                        onClick={async () => {
                          const confirmed = await confirmAction(
                            `Apply ${project.counts.approved} approved operations for ${project.project_id}? This writes long-term memory.`,
                            {
                              title: 'Apply approved operations?',
                              confirmLabel: 'Apply',
                            },
                          );
                          if (confirmed) applyMutation.mutate();
                        }}
                      >
                        {applyMutation.isPending && (
                          <Loader2 className="mr-1 size-4 animate-spin" />
                        )}
                        Apply approved
                      </Button>
                    </div>
                  </div>

                  {project.batch_status === 'previewing' && (
                    <div className="flex gap-2 rounded-md border border-blue-500/30 bg-blue-500/10 p-3 text-sm text-blue-800 dark:text-blue-200">
                      <Clock3 className="mt-0.5 size-4 shrink-0" />
                      The batch is still processing. Completed proposals can be
                      reviewed now; applying is enabled after the writer exits.
                    </div>
                  )}
                  {project.errors.length > 0 && (
                    <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-800 dark:text-red-200">
                      <div className="mb-1 flex items-center gap-2 font-medium">
                        <AlertCircle className="size-4" />
                        Preview errors
                      </div>
                      {project.errors.map((error) => (
                        <div key={error} className="break-words text-xs">
                          {error}
                        </div>
                      ))}
                    </div>
                  )}
                  {project.ignored_errors.length > 0 && (
                    <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-100">
                      <div className="mb-1 flex items-center gap-2 font-medium">
                        <AlertCircle className="size-4" />
                        Partial preview — ignored failures
                      </div>
                      <p className="mb-2 text-xs text-amber-800/80 dark:text-amber-100/80">
                        Successfully checkpointed operations were retained and
                        unfinished candidates were explicitly skipped
                        {project.partial_finalized_at
                          ? ` on ${new Date(project.partial_finalized_at).toLocaleString()}`
                          : ''}
                        .
                      </p>
                      {project.ignored_errors.map((error) => (
                        <div key={error} className="break-words text-xs">
                          {error}
                        </div>
                      ))}
                    </div>
                  )}
                  {!project.review_enabled &&
                    project.project_status === 'pending' && (
                      <div className="rounded-md border border-border bg-muted/20 p-4 text-sm text-muted-foreground">
                        This project is still extracting or reflecting. The page
                        will refresh automatically.
                      </div>
                    )}

                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                    {(
                      [
                        ['pending', project.counts.pending],
                        ['approved', project.counts.approved],
                        ['eval', project.counts.eval],
                        ['rejected', project.counts.rejected],
                        ['all', project.counts.operations],
                      ] as const
                    ).map(([name, count]) => (
                      <button
                        type="button"
                        key={name}
                        data-ui="memory-review-status-filter"
                        data-review-filter={name}
                        aria-pressed={filter === name}
                        onClick={() => setFilter(name)}
                        className={cn(
                          'rounded-md border px-3 py-2 text-left',
                          filter === name
                            ? 'border-primary bg-primary/10'
                            : 'border-border bg-card',
                        )}
                      >
                        <div className="text-lg font-semibold">{count}</div>
                        <div className="text-[11px] capitalize text-muted-foreground">
                          {name}
                        </div>
                      </button>
                    ))}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Select
                      compact
                      aria-label="Filter proposals by operation"
                      value={operationFilter}
                      onValueChange={(nextValue) =>
                        setOperationFilter(nextValue)
                      }
                    >
                      <SelectItem value="all">All operations</SelectItem>
                      <SelectItem value="create">Create</SelectItem>
                      <SelectItem value="supersede">Supersede</SelectItem>
                      <SelectItem value="invalidate">Invalidate</SelectItem>
                      <SelectItem value="forget">Forget</SelectItem>
                    </Select>
                    <Select
                      compact
                      aria-label="Filter proposals by memory type"
                      value={typeFilter}
                      onValueChange={(nextValue) => setTypeFilter(nextValue)}
                    >
                      <SelectItem value="all">All memory types</SelectItem>
                      {MEMORY_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {type}
                        </SelectItem>
                      ))}
                    </Select>
                  </div>

                  <div className="space-y-3">
                    {visibleOperations.map((item) => (
                      <OperationCard
                        key={item.id}
                        item={item}
                        sourceProjectId={project.project_id}
                        projects={projects}
                        enabled={project.review_enabled}
                        busy={reviewMutation.isPending}
                        editing={editingId === item.id}
                        onEdit={() => setEditingId(item.id)}
                        onCancelEdit={() => setEditingId(null)}
                        onVerify={() => void verifyInProjectChat(item)}
                        verifying={verificationItemId === item.id}
                        onDecision={(
                          decision,
                          markForEval,
                          edits,
                          targetProjectId,
                        ) =>
                          reviewMutation.mutate({
                            item,
                            decision,
                            markForEval,
                            edits,
                            targetProjectId,
                          })
                        }
                      />
                    ))}
                    {project.review_enabled &&
                      visibleOperations.length === 0 && (
                        <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
                          No operations match the current filters.
                        </div>
                      )}
                  </div>

                  {project.skipped_candidates.length > 0 && (
                    <details className="rounded-md border border-border bg-card">
                      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
                        Reflector-skipped candidates (
                        {project.skipped_candidates.length})
                      </summary>
                      <div className="space-y-3 border-t border-border p-4">
                        {project.skipped_candidates.map((group, index) => (
                          <div
                            key={`${group.reason}-${index}`}
                            className="rounded-md border border-border/60 p-3"
                          >
                            <Badge variant="outline">{group.reason}</Badge>
                            {group.candidates.map((candidate) => (
                              <div key={candidate.id} className="mt-2 text-sm">
                                <FileText className="mr-1 inline size-3.5 text-muted-foreground" />
                                {candidate.claim}
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MemoryReviewRoute() {
  const search = Route.useSearch();
  return <MemoryReviewPage search={search} />;
}

export const Route = createFileRoute('/memory-review')({
  validateSearch: (search: Record<string, unknown>): MemoryReviewSearch => ({
    mode:
      search.mode === 'history' || search.mode === 'existing'
        ? search.mode
        : undefined,
    batchId: typeof search.batchId === 'string' ? search.batchId : undefined,
    projectId:
      typeof search.projectId === 'string' ? search.projectId : undefined,
    auditId: typeof search.auditId === 'string' ? search.auditId : undefined,
    itemId: typeof search.itemId === 'string' ? search.itemId : undefined,
    action:
      search.action === 'approve' ||
      search.action === 'delete' ||
      search.action === 'edit'
        ? search.action
        : undefined,
  }),
  component: MemoryReviewRoute,
});
