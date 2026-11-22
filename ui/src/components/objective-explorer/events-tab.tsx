import { useState, useEffect } from 'react';
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  keepPreviousData,
  type InfiniteData,
} from '@tanstack/react-query';
import {
  fetchObjectiveEvents,
  fetchObjectiveEventTypes,
  type ObjectiveEventGroup,
  type ObjectiveEventRunStatus,
} from '@/lib/api';
import { Select, SelectItem } from '@/components/ui/select';
import { SearchInput } from '@/components/ui/search-input';
import {
  WorkspaceToolbar,
  WorkspaceToolbarRow,
} from '@/components/chat/workspace-toolbar';
import {
  countLoadedObjectiveRows,
  mergeObjectivePages,
  nextObjectiveOffset,
} from './pagination';

interface Props {
  project_id: string;
  objective_id: string;
}

export function EventsTab({ project_id, objective_id }: Props) {
  const [typeFilter, setTypeFilter] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const limit = 50;

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const queryClient = useQueryClient();
  const filterKey = [
    'objective-events',
    project_id,
    objective_id,
    typeFilter,
    debouncedSearch,
  ];
  const fetchPage = (offset: number) =>
    fetchObjectiveEvents(project_id, objective_id, {
      limit,
      offset,
      type: typeFilter || undefined,
      search: debouncedSearch || undefined,
    });

  const {
    data,
    isLoading,
    isError,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isPlaceholderData,
  } = useInfiniteQuery({
    queryKey: filterKey,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      nextObjectiveOffset(
        countLoadedObjectiveRows(allPages.map((page) => page.groups)),
        lastPage.total,
      ),
    placeholderData: keepPreviousData,
  });

  // Brain runs can take several minutes and new events arrive meanwhile. Only
  // the first page polls (first tick after one interval, so loading a filter
  // costs one request); loaded pages are refreshed when it changed.
  const pollable = !!data && !isPlaceholderData;
  useEffect(() => {
    if (!pollable) return;
    let inFlight = false;
    const poll = async () => {
      if (inFlight || document.hidden) return;
      const busy = () =>
        queryClient.isFetching({ queryKey: filterKey, exact: true }) > 0;
      if (busy()) return;
      inFlight = true;
      try {
        const head = await fetchPage(0);
        // A next-page fetch started meanwhile would overwrite the update.
        if (busy()) return;
        const current =
          queryClient.getQueryData<InfiniteData<typeof head, number>>(
            filterKey,
          );
        if (
          !current ||
          JSON.stringify(head) === JSON.stringify(current.pages[0])
        ) {
          return;
        }
        if (current.pages.length === 1) {
          queryClient.setQueryData(filterKey, { ...current, pages: [head] });
        } else {
          await queryClient.refetchQueries({
            queryKey: filterKey,
            exact: true,
          });
        }
      } catch {
        // Transient failure: the next tick retries.
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(() => void poll(), 3_000);
    return () => clearInterval(timer);
    // filterKey and fetchPage derive from the listed dependencies.
  }, [pollable, project_id, objective_id, typeFilter, debouncedSearch]);

  const { data: typesData } = useQuery({
    queryKey: ['objective-event-types', project_id, objective_id],
    queryFn: () => fetchObjectiveEventTypes(project_id, objective_id),
  });
  const distinctTypes = typesData?.types ?? [];
  const groups = data
    ? mergeObjectivePages(
        data.pages.map((page) => page.groups),
        (group) => group.id,
      )
    : [];
  const remaining = data
    ? data.pages[data.pages.length - 1]!.total -
      countLoadedObjectiveRows(data.pages.map((page) => page.groups))
    : 0;

  const formatTime = (ts: string) => {
    const d = new Date(ts);
    return d.toLocaleString('en-GB', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const eventIcon = (type: string) => {
    if (type.includes('run')) return '🏃';
    if (type.includes('score') || type.includes('eval')) return '📊';
    if (type.includes('task')) return '✅';
    if (type.includes('error') || type.includes('fail')) return '❌';
    if (type.includes('report')) return '📝';
    if (type.includes('reflect')) return '🧠';
    return '📌';
  };

  const runBadge = (event: {
    runStatus: ObjectiveEventRunStatus;
    linkedRunId?: string;
    runRationale?: string;
    delivery?: ObjectiveEventGroup['delivery'];
  }) => {
    if (event.delivery?.status === 'failed') {
      return (
        <span
          data-ui="objective-event-delivery-failed"
          className="rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-500/15 dark:text-red-400"
          title="Brain could not resolve or persist delivery for this event"
        >
          Delivery failed
        </span>
      );
    }
    if (event.runStatus === 'unmatched') {
      return (
        <span
          data-ui="objective-event-delivery-unmatched"
          className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
          title="No active objective subscribes to this event"
        >
          No subscribers
        </span>
      );
    }
    if (event.runStatus === 'delivered') {
      const targetCount = event.delivery?.targetObjectiveIds.length ?? 0;
      return (
        <span
          data-ui="objective-event-delivery-enqueued"
          className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:bg-blue-500/15 dark:text-blue-400"
          title={
            event.delivery?.targetObjectiveIds.length
              ? `Enqueued for ${event.delivery.targetObjectiveIds.join(', ')}`
              : 'Enqueued for subscribing objectives'
          }
        >
          Delivered{targetCount > 1 ? ` · ${targetCount}` : ''}
        </span>
      );
    }
    if (event.runStatus === 'unknown') {
      return (
        <span
          data-ui="objective-event-delivery-unknown"
          className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
          title="This legacy source event has no persisted routing outcome"
        >
          Unknown
        </span>
      );
    }
    if (event.runStatus === 'queued') {
      return (
        <span
          data-ui="objective-event-queued"
          className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-600 dark:bg-violet-500/15 dark:text-violet-400"
          title={
            event.runRationale ??
            'In the brain queue; runs when the objective is free'
          }
        >
          Queued
        </span>
      );
    }
    if (event.runStatus === 'run') {
      return (
        <span
          className="rounded bg-green-500/10 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-500/15 dark:text-green-400"
          title={
            event.linkedRunId
              ? `Produced run ${event.linkedRunId}`
              : 'Produced an agent run'
          }
        >
          Run
        </span>
      );
    }
    if (event.runStatus === 'skipped') {
      return (
        <span
          className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-400"
          title={event.runRationale ?? 'No agent run was produced'}
        >
          No run
        </span>
      );
    }
    if (event.runStatus === 'failed') {
      return (
        <span
          className="rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-500/15 dark:text-red-400"
          title={event.runRationale ?? 'Agent invocation did not complete'}
        >
          Failed
        </span>
      );
    }
    if (event.runStatus === 'pending' && event.linkedRunId) {
      return (
        <span
          className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:bg-blue-500/15 dark:text-blue-400"
          title={`Run ${event.linkedRunId} is still in progress`}
        >
          Running
        </span>
      );
    }
    return (
      <span
        className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
        title="Waiting for an agent invocation outcome"
      >
        Waiting
      </span>
    );
  };

  const groupLabel = (group: ObjectiveEventGroup) => {
    const triggers = group.events.filter(
      (event) => event.type !== 'agent_invoked',
    );
    const invocation = group.events.find(
      (event) => event.type === 'agent_invoked',
    );
    if (!invocation) {
      if (triggers.length === 1) return triggers[0]!.type;
      const types = new Set(triggers.map((event) => event.type));
      return types.size === 1
        ? `${triggers.length} ${triggers[0]!.type}`
        : `${triggers.length} events`;
    }
    if (triggers.length === 0) return 'agent_invoked';
    if (triggers.length === 1) return `${triggers[0]!.type} → agent_invoked`;
    const types = new Set(triggers.map((event) => event.type));
    const triggerLabel =
      types.size === 1
        ? `${triggers.length} ${triggers[0]!.type}`
        : `${triggers.length} events`;
    return `${triggerLabel} → agent_invoked`;
  };

  return (
    <div className="text-sm flex flex-col gap-2">
      {/* Filters */}
      <WorkspaceToolbar data-ui="events-toolbar">
        <WorkspaceToolbarRow className="flex-nowrap">
          <SearchInput
            compact
            aria-label="Search events"
            wrapperClassName="flex-1"
            placeholder="Search events…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setExpandedGroup(null);
            }}
          />
          <Select
            compact
            value={typeFilter}
            onValueChange={(nextValue) => {
              setTypeFilter(nextValue);
              setExpandedGroup(null);
            }}
          >
            <SelectItem value="">All types</SelectItem>
            {distinctTypes.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </Select>
        </WorkspaceToolbarRow>
      </WorkspaceToolbar>

      {isLoading && (
        <div className="text-muted-foreground text-sm py-2">
          Loading events...
        </div>
      )}

      {isError && (
        <div className="text-destructive text-sm py-2">
          Error loading events: {(error as Error)?.message || 'Unknown error'}
        </div>
      )}

      {!isLoading && !isError && !groups.length && (
        <div className="text-muted-foreground text-sm py-2">
          No events found
        </div>
      )}

      <div className="space-y-0.5">
        {groups.map((group) => {
          const groupKey = group.id;
          const firstTrigger = group.events.find(
            (event) => event.type !== 'agent_invoked',
          );
          return (
            <div
              key={groupKey}
              data-ui="objective-event-group"
              {...(group.linkedRunId
                ? { 'data-run-id': group.linkedRunId }
                : {})}
            >
              <div
                className="flex items-start gap-2 py-1.5 px-1 rounded hover:bg-muted/50 cursor-pointer border-b border-border/30"
                onClick={() =>
                  setExpandedGroup(expandedGroup === groupKey ? null : groupKey)
                }
              >
                <span className="text-base leading-none mt-0.5 flex-shrink-0">
                  {eventIcon(firstTrigger?.type ?? 'agent_invoked')}
                </span>
                <div className="flex-1 min-w-0">
                  <span className="font-medium text-xs">
                    {groupLabel(group)}
                  </span>
                  {group.linkedRunId ? (
                    <span className="ml-2 text-xs text-muted-foreground font-mono break-all">
                      {group.linkedRunId}
                    </span>
                  ) : null}
                </div>
                {runBadge(group)}
                {(group.runStatus === 'skipped' ||
                  group.runStatus === 'failed') &&
                group.runRationale ? (
                  <span
                    data-ui="objective-event-run-rationale"
                    className="min-w-0 max-w-[40%] truncate text-xs text-muted-foreground"
                    title={group.runRationale}
                  >
                    {group.runRationale}
                  </span>
                ) : null}
                <span className="text-xs text-muted-foreground font-mono flex-shrink-0">
                  {formatTime(group.timestamp)}
                </span>
              </div>
              {expandedGroup === groupKey && (
                <div className="bg-muted/30 rounded p-2 mb-1 font-mono text-xs whitespace-pre-wrap max-h-64 overflow-auto">
                  {group.events.map((event, eventIdx) => (
                    <div
                      key={`${event.timestamp}-${event.type}-${eventIdx}`}
                      className={
                        eventIdx > 0
                          ? 'mt-3 border-t border-border/50 pt-3'
                          : ''
                      }
                      data-ui="objective-event-group-member"
                    >
                      <div className="mb-1 text-muted-foreground">
                        {formatTime(event.timestamp)} · {event.type}
                      </div>
                      {JSON.stringify(event.payload, null, 2)}
                    </div>
                  ))}
                  {group.runRationale
                    ? `\n\nOutcome: ${group.runRationale}`
                    : ''}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {hasNextPage && (
        <button
          className="w-full text-center text-xs text-muted-foreground hover:text-foreground py-2"
          disabled={isFetchingNextPage}
          onClick={() => void fetchNextPage()}
        >
          Load more ({remaining} remaining)
        </button>
      )}
    </div>
  );
}
