import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render as rtlRender, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import type * as ReactQueryModule from '@tanstack/react-query';
import type * as ReactRouterModule from '@tanstack/react-router';
import type * as ProjectHooksModule from '@/hooks/use-projects';
import type { Project } from '@/types';

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactRouterModule>()),
  Link: ({
    children,
    to,
    params,
    ...props
  }: {
    children: ReactNode;
    to: string;
    params: Record<string, string>;
  } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      {...props}
      href={to
        .replace('$projectId', params.projectId)
        .replace('$objectiveId', params.objectiveId ?? '')}
    >
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
  useRouterState: () => ({ location: { pathname: '/board/current' } }),
}));

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactQueryModule>()),
  useQuery: () => ({
    data: { enableKanban: true, enableChat: true, enableObjectives: true },
  }),
}));

vi.mock('@/hooks/use-projects', async (importOriginal) => ({
  ...(await importOriginal<typeof ProjectHooksModule>()),
  useUpdateProjectMode: () => ({ mutate: vi.fn() }),
}));

import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { SortableProjectItem } from './sidebar';
import type { ReactElement } from 'react';

// The row menu uses the real mutation hook, which needs a query client.
const render = (ui: ReactElement) =>
  rtlRender(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );
import { rovingKeyDown } from './roving-list';

const project: Project = {
  id: 'project-alpha',
  name: 'Alpha Project',
  folder: 'alpha-project',
};

function renderProjectRow() {
  return render(
    <DndContext onDragEnd={() => {}}>
      <SortableContext items={[project.id]}>
        <SortableProjectItem project={project} />
      </SortableContext>
    </DndContext>,
  );
}

afterEach(cleanup);

describe('sidebar project drag handle', () => {
  it('is named after the project, sits beside the row link and is revealed with the row actions', () => {
    renderProjectRow();

    const handle = screen.getByRole('button', {
      name: 'Reorder Alpha Project',
    });

    // dnd-kit keeps the roledescription; the list is a single roving tab
    // stop, so the handle itself is reached with ArrowRight (tabindex -1).
    expect(handle.getAttribute('aria-roledescription')).toBe('sortable');
    expect(handle.getAttribute('tabindex')).toBe('-1');
    expect(handle.tagName).toBe('BUTTON');

    // The handle must not be nested inside the row's link.
    expect(handle.closest('a')).toBeNull();
    expect(screen.getByRole('link', { name: /Alpha Project/ })).toBeTruthy();

    // It is only revealed with its row's actions, on hover and on focus
    // within the row, so keyboard focus makes it appear too.
    const actions = handle.closest('[data-ui="project-row-actions"]');
    expect(actions?.className).toContain('group-focus-within:opacity-100');
    expect(handle.className).toContain('focus-visible:ring-2');
    expect(handle.className).toContain('focus-visible:ring-ring');
  });
});

const second: Project = {
  id: 'project-beta',
  name: 'Beta Project',
  folder: 'beta-project',
};

describe('sidebar project list roving focus', () => {
  function renderList(reorderMode = false) {
    return render(
      <DndContext onDragEnd={() => {}}>
        <SortableContext items={[project.id, second.id]}>
          <nav
            aria-label="Projects"
            data-roving-root
            onKeyDown={(e) => rovingKeyDown(e)}
          >
            <SortableProjectItem
              project={project}
              rovingTabStop
              reorderMode={reorderMode}
            />
            <SortableProjectItem
              project={second}
              rovingTabStop={false}
              reorderMode={reorderMode}
            />
          </nav>
        </SortableContext>
      </DndContext>,
    );
  }

  it('is one Tab stop and moves with the arrow keys', async () => {
    const user = userEvent.setup();
    renderList();
    const nav = screen.getByRole('navigation', { name: 'Projects' });
    const tabbable = Array.from(
      nav.querySelectorAll<HTMLElement>('a, button'),
    ).filter((el) => el.tabIndex >= 0);
    expect(tabbable.map((el) => el.textContent)).toEqual(['Alpha Project']);

    screen.getByRole('link', { name: /Alpha Project/ }).focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(
      screen.getByRole('link', { name: /Beta Project/ }),
    );
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(
      screen.getByRole('link', { name: /Alpha Project/ }),
    );
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(
      screen.getByRole('link', { name: /Beta Project/ }),
    );
  });

  it('reaches the row actions with ArrowRight and comes back with ArrowLeft', async () => {
    const user = userEvent.setup();
    renderList();
    const link = screen.getByRole('link', { name: /Alpha Project/ });
    link.focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Actions for Alpha Project' }),
    );
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Reorder Alpha Project' }),
    );
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(document.activeElement).toBe(link);
  });

  it('moves between rows with Up/Down on the "…" trigger instead of opening its menu', async () => {
    const user = userEvent.setup();
    renderList();
    const trigger = screen.getByRole('button', {
      name: 'Actions for Alpha Project',
    });
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('link', { name: /Beta Project/ }),
    );
    // Enter still opens the menu.
    screen.getByRole('button', { name: 'Actions for Beta Project' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('only offers the handle on touch layouts while in Reorder mode', () => {
    const { unmount } = renderList(false);
    expect(
      screen.getByRole('button', {
        name: 'Reorder Alpha Project',
        hidden: true,
      }).className,
    ).toContain('max-md:hidden');
    unmount();
    renderList(true);
    expect(
      screen.getByRole('button', {
        name: 'Reorder Alpha Project',
        hidden: true,
      }).className,
    ).not.toContain('max-md:hidden');
  });
});
