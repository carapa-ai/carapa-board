import { useEffect, useRef, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import type { SortingStrategy } from '@dnd-kit/sortable';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { SELECT_CHECKBOX_CLASS } from './select-checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

// While the dragged card is previewed in a column, its slot is already part of
// the column's layout, so sortable must not displace any card on top of it.
const previewSortingStrategy: SortingStrategy = () => null;

interface KanbanColumnProps {
  id: string;
  project_id: string;
  title: string;
  color: string;
  count: number;
  taskIds: string[];
  hasMore: boolean;
  onLoadMore: () => void;
  selectedIds: Set<string>;
  onSelectAll: (select: boolean) => void;
  emptyMessage?: string;
  /** A dragged card is previewed inside this column (drag-time override). */
  isDropTarget?: boolean;
  children: ReactNode;
}

export function KanbanColumn({
  id,
  project_id,
  title,
  color,
  count,
  taskIds,
  hasMore,
  onLoadMore,
  selectedIds,
  onSelectAll,
  emptyMessage,
  isDropTarget = false,
  children,
}: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const sentinelRef = useRef<HTMLDivElement>(null);
  const hasMoreRef = useRef(hasMore);
  const onLoadMoreRef = useRef(onLoadMore);
  const storageKey = `kanban-collapsed:${project_id}:${id}`;
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(storageKey) === 'true',
  );

  useEffect(() => {
    hasMoreRef.current = hasMore;
  }, [hasMore]);
  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    if (collapsed) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    // The Radix ScrollArea viewport clips overflow, so we must use it as the
    // IntersectionObserver root; otherwise the sentinel is never "visible"
    // relative to the browser viewport and the observer never fires.
    const scrollViewport = sentinel.closest(
      '[data-slot="scroll-area-viewport"]',
    ) as HTMLElement | null;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMoreRef.current) {
          onLoadMoreRef.current();
        }
      },
      { root: scrollViewport, threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [collapsed]);

  const selectedInColumn = taskIds.filter((fid) => selectedIds.has(fid)).length;
  const allSelected = taskIds.length > 0 && selectedInColumn === taskIds.length;
  const someSelected = selectedInColumn > 0 && !allSelected;

  return (
    <div
      ref={setNodeRef}
      data-ui="kanban-column"
      data-stage-id={id}
      data-collapsed={collapsed}
      className={cn(
        'min-h-0 flex flex-col rounded-lg bg-kanban-column border border-kanban-column-border transition-all duration-200',
        collapsed
          ? 'w-10 flex-none'
          : 'flex-none w-[calc(var(--kanban-region-width,100vw)-4rem)] min-w-0 max-w-none sm:w-[calc((var(--kanban-region-width,100vw)-3.75rem)/3.5)] sm:min-w-[240px] sm:max-w-[360px]',
        (isOver || isDropTarget) && 'border-primary/50 bg-primary/5',
      )}
    >
      {/* Column header */}
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-2.5 border-b border-kanban-column-divider cursor-pointer select-none',
          collapsed &&
            'flex-col px-0 py-2 border-b-0 h-full justify-start gap-3',
        )}
        onClick={() =>
          setCollapsed((v) => {
            const next = !v;
            localStorage.setItem(storageKey, String(next));
            return next;
          })
        }
        title={collapsed ? `Expand ${title}` : `Collapse ${title}`}
      >
        {collapsed ? (
          <>
            <ChevronRight className="size-3.5 text-muted-foreground shrink-0 mx-auto" />
            <div
              className="size-2.5 rounded-full shrink-0 mx-auto"
              style={{ backgroundColor: color }}
            />
            <span
              data-ui="kanban-collapsed-stage-title"
              className="min-h-0 flex-1 overflow-hidden text-center text-xs font-medium text-foreground"
              style={{ writingMode: 'vertical-rl' }}
              title={title}
            >
              {title}
            </span>
            <Badge variant="secondary" className="text-xs h-5 px-1 mx-auto">
              {count}
            </Badge>
          </>
        ) : (
          <>
            {/* Check-all checkbox */}
            <div
              onClick={(e) => e.stopPropagation()}
              className="flex items-center"
            >
              <Checkbox
                checked={
                  allSelected ? true : someSelected ? 'indeterminate' : false
                }
                onCheckedChange={(checked) => onSelectAll(!!checked)}
                className={SELECT_CHECKBOX_CLASS}
                aria-label={`Select all in ${title}`}
                disabled={taskIds.length === 0}
              />
            </div>
            <div
              className="size-2.5 rounded-full"
              style={{ backgroundColor: color }}
            />
            <h3
              className="text-sm font-medium text-foreground min-w-0 flex-1 truncate"
              title={title}
            >
              {title}
            </h3>
            <ChevronDown className="size-3.5 text-muted-foreground ml-auto shrink-0" />
            <Badge variant="secondary" className="text-xs h-5 px-1.5">
              {count}
            </Badge>
          </>
        )}
      </div>

      {/* Card list */}
      {!collapsed && (
        <div
          data-ui="kanban-card-list-region"
          data-stage-id={id}
          className="flex-1 min-h-0 overflow-hidden"
        >
          <ScrollArea
            data-ui="kanban-card-list"
            data-stage-id={id}
            className="h-full min-w-0 max-w-full p-2 [&_[data-slot=scroll-area-viewport]]:!overflow-x-hidden [&_[data-slot=scroll-area-viewport]]:!overflow-y-auto [&_[data-slot=scroll-area-viewport]>div]:!block [&_[data-slot=scroll-area-viewport]>div]:!w-full [&_[data-slot=scroll-area-viewport]>div]:min-w-0"
          >
            <SortableContext
              items={taskIds}
              strategy={
                isDropTarget
                  ? previewSortingStrategy
                  : verticalListSortingStrategy
              }
            >
              <div className="space-y-2 min-w-0 w-full">
                {children}
                {taskIds.length === 0 && (
                  <div className="py-8 text-center text-sm text-muted-foreground italic px-4">
                    {emptyMessage || 'No tasks'}
                  </div>
                )}
              </div>
            </SortableContext>
            {/* Infinite scroll sentinel */}
            <div ref={sentinelRef} className="h-1" />
          </ScrollArea>
        </div>
      )}
    </div>
  );
}
