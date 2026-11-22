import { Link } from '@tanstack/react-router';
import {
  Calendar,
  Clock,
  TrendingUp,
  DollarSign,
  Play,
  Timer,
  CheckCircle2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { objectiveStatusConfig } from '@/lib/objective-status';
import { COST_TEXT_CLASS } from '@/lib/cost-display';
import type { Objective } from '@/types';

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

interface ObjectiveCardProps {
  objective: Objective;
  project_id: string;
}

export function ObjectiveCard({ objective, project_id }: ObjectiveCardProps) {
  const status =
    objectiveStatusConfig[objective.status] ?? objectiveStatusConfig.draft;
  const StatusIcon = status.icon;
  const deadlineDate = objective.deadline ? new Date(objective.deadline) : null;
  const isOverdue =
    deadlineDate &&
    deadlineDate < new Date() &&
    objective.status !== 'achieved';
  const updatedDate = new Date(objective.updated_at);

  return (
    <Link
      to="/objective/$projectId/$objectiveId"
      params={{ projectId: project_id, objectiveId: objective.id }}
      className="block group"
    >
      <div className="relative rounded-lg border border-border bg-card/60 backdrop-blur-sm p-4 transition-all hover:border-cyan-600 hover:bg-card/80 hover:shadow-lg hover:shadow-cyan-500/5 dark:hover:border-cyan-500/40">
        {/* Status badge */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border',
                status.bg,
                status.color,
              )}
            >
              <StatusIcon className="size-3" />
              {status.label}
            </span>
            {objective.isAgentRunning && (
              <span className="relative flex size-2.5" title="Agent running">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-600 opacity-75 dark:bg-cyan-400" />
                <span className="relative inline-flex size-2.5 rounded-full bg-cyan-600 dark:bg-cyan-500" />
              </span>
            )}
            {!objective.isAgentRunning &&
              objective.chatStatus === 'working' && (
                <span
                  className="size-2 rounded-full bg-blue-600 dark:bg-blue-500 animate-pulse shrink-0"
                  title="Agent responding"
                />
              )}
            {!objective.isAgentRunning &&
              objective.chatStatus === 'finished' && (
                <span
                  className="size-2 rounded-full bg-green-600 dark:bg-green-500 shrink-0"
                  title="New response"
                />
              )}
            {!objective.isAgentRunning && objective.chatStatus === 'failed' && (
              <span
                className="size-2 rounded-full bg-red-600 dark:bg-red-500 shrink-0"
                title="Oops! Agent response failed"
                data-ui="objective-chat-status-failed"
              />
            )}
            {!objective.isAgentRunning &&
              objective.chatStatus === 'pending' && (
                <span
                  className="size-2 rounded-full bg-blue-600 dark:bg-blue-500 shrink-0"
                  title="Plan pending implementation"
                  data-ui="objective-chat-status-pending"
                />
              )}
          </div>
          {objective.priority > 0 && (
            <span className="text-xs text-muted-foreground">
              #{objective.priority}
            </span>
          )}
        </div>

        {/* Title */}
        <h3 className="text-sm font-semibold text-foreground mb-2 line-clamp-2 group-hover:text-cyan-700 dark:group-hover:text-cyan-300 transition-colors">
          {objective.title}
        </h3>

        {/* Description */}
        {objective.description && (
          <p className="text-xs text-muted-foreground mb-3 line-clamp-2">
            {objective.description}
          </p>
        )}

        {/* Progress bar */}
        <div className="mb-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <TrendingUp className="size-3" />
              Progress
            </span>
            <span className="text-xs font-medium text-foreground">
              {objective.progress}%
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all',
                objective.progress >= 100
                  ? 'bg-green-700 dark:bg-green-500'
                  : objective.progress >= 50
                    ? 'bg-cyan-700 dark:bg-cyan-500'
                    : 'bg-cyan-600 dark:bg-cyan-500/60',
              )}
              style={{ width: `${Math.min(100, objective.progress)}%` }}
            />
          </div>
        </div>

        {/* Footer: deadline + last check-in */}
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          {deadlineDate ? (
            <span
              className={cn(
                'flex items-center gap-1',
                isOverdue && 'text-red-600 dark:text-red-400',
              )}
            >
              <Calendar className="size-3" />
              {deadlineDate.toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
              })}
            </span>
          ) : (
            <span className="flex items-center gap-1 opacity-50">
              <Calendar className="size-3" />
              No deadline
            </span>
          )}
          <span className="flex items-center gap-1">
            <Clock className="size-3" />
            {updatedDate.toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
            })}
          </span>
        </div>

        {/* Run stats */}
        {objective.runStats && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-600 dark:text-zinc-500 mt-3 pt-3 border-t border-border/50">
            <span
              className={cn('flex items-center gap-1', COST_TEXT_CLASS)}
              title="Total cost"
            >
              <DollarSign className="size-3" />$
              {objective.runStats.totalCostUsd.toFixed(2)}
              {objective.cost_limit_usd != null
                ? ` / $${objective.cost_limit_usd.toFixed(2)}`
                : ''}
            </span>
            <span className="flex items-center gap-1" title="Number of runs">
              <Play className="size-3" />
              {objective.runStats.runCount}
            </span>
            {objective.runStats.lastRunAt && (
              <span className="flex items-center gap-1" title="Last run">
                <Clock className="size-3" />
                {formatRelativeTime(objective.runStats.lastRunAt)}
              </span>
            )}
            <span className="flex items-center gap-1" title="Average duration">
              <Timer className="size-3" />
              {formatDuration(objective.runStats.avgDurationMs)}
            </span>
            <span
              className={cn(
                'flex items-center gap-1',
                objective.runStats.successRate < 0.5 &&
                  'text-red-600 dark:text-red-400',
              )}
              title="Success rate"
            >
              <CheckCircle2 className="size-3" />
              {Math.round(objective.runStats.successRate * 100)}%
            </span>
          </div>
        )}
      </div>
    </Link>
  );
}
