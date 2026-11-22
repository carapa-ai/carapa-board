import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import type * as DndSortableModule from '@dnd-kit/sortable';
import type * as ReactQueryModule from '@tanstack/react-query';
import type * as ReactRouterModule from '@tanstack/react-router';
import type * as ProjectHooksModule from '@/hooks/use-projects';
import type { Project, ProjectModeStatuses } from '@/types';

const sidebarHarness = vi.hoisted(() => ({
  navigate: vi.fn(),
  mutateMode: vi.fn(),
}));

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
  useNavigate: () => sidebarHarness.navigate,
  useParams: () => ({}),
  useRouterState: () => ({ location: { pathname: '/board/current' } }),
}));

vi.mock('@dnd-kit/sortable', async (importOriginal) => ({
  ...(await importOriginal<typeof DndSortableModule>()),
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactQueryModule>()),
  useQuery: () => ({
    data: { enableKanban: true, enableChat: true, enableObjectives: true },
  }),
}));

vi.mock('@/hooks/use-projects', async (importOriginal) => ({
  ...(await importOriginal<typeof ProjectHooksModule>()),
  useUpdateProjectMode: () => ({ mutate: sidebarHarness.mutateMode }),
}));

import { ProjectModeSwitcher } from './header';
import { ActiveProjectItem } from './sidebar';
import { ProjectTitleMenu } from './project-title-menu';
import { useStore } from '@/store';

const project: Project = {
  id: 'shortcut-project',
  name: 'Shortcut Project',
  folder: 'shortcut-project',
  accessLevel: 'owner',
  settings: { enabledModes: ['kanban', 'chat'] },
};

const statuses: ProjectModeStatuses = {
  kanban: 'working',
  chat: 'finished',
  objectives: 'idle',
};

afterEach(() => {
  cleanup();
  sidebarHarness.navigate.mockReset();
  sidebarHarness.mutateMode.mockReset();
});

function renderRow() {
  return render(
    <ActiveProjectItem project={project} modeStatuses={statuses} />,
  );
}

describe('sidebar project status indicator', () => {
  it('is a labelled image, not a control, and spells out every enabled mode', () => {
    renderRow();

    const indicator = screen.getByRole('img', {
      name: 'Chat finished, Kanban working',
    });
    expect(indicator.getAttribute('title')).toBeNull();
    expect(indicator.tagName).toBe('SPAN');
    expect(indicator.getAttribute('tabindex')).toBeNull();
    expect(indicator.closest('button')).toBeNull();
    // The mode shortcuts moved into the overflow menu.
    expect(screen.queryByRole('button', { name: 'Kanban working' })).toBeNull();
  });
});

describe('sidebar project row overflow menu', () => {
  it('lists the enabled modes with their status and switches mode by mouse', async () => {
    const user = userEvent.setup();
    renderRow();

    await user.click(
      screen.getByRole('button', { name: 'Actions for Shortcut Project' }),
    );
    expect(screen.getByRole('menuitem', { name: /Open Kanban/ })).toBeTruthy();
    expect(
      screen.getByRole('menuitem', { name: /Open Chat/ }).textContent,
    ).toContain('finished');
    expect(screen.queryByRole('menuitem', { name: /Objectives/ })).toBeNull();

    const newTab = screen.getByRole('menuitem', { name: 'Open in new tab' });
    expect(newTab.getAttribute('href')).toBe('/board/shortcut-project');
    expect(newTab.getAttribute('target')).toBe('_blank');
    expect(newTab.getAttribute('rel')).toContain('noopener');
    expect(screen.getByRole('menuitem', { name: 'Copy link' })).toBeTruthy();

    await user.click(screen.getByRole('menuitem', { name: /Open Chat/ }));
    expect(sidebarHarness.mutateMode).toHaveBeenCalledWith('chat');
    expect(sidebarHarness.navigate).toHaveBeenCalledWith({
      to: '/chat/$projectId',
      params: { projectId: 'shortcut-project' },
    });
  });

  it('opens by keyboard (Enter on the trigger) and by right-click on the row, and Escape returns focus', async () => {
    const user = userEvent.setup();
    renderRow();
    const trigger = screen.getByRole('button', {
      name: 'Actions for Shortcut Project',
    });

    trigger.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('menu')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.contextMenu(
      screen.getByRole('link', { name: /Shortcut Project/ }),
    );
    expect(await screen.findByRole('menu')).toBeTruthy();
  });
});

describe('project title menu', () => {
  afterEach(() => {
    useStore.getState().setShareProjectId(null);
    useStore.getState().setSettingsProjectId(null);
  });

  it('is a menu button for the current project that offers the same entries as the row menu', async () => {
    const user = userEvent.setup();
    render(
      <ProjectTitleMenu
        project={project}
        fallbackName="x"
        statuses={statuses}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Shortcut Project' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    await user.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const titleEntries = screen
      .getAllByRole('menuitem')
      .map((i) => i.textContent);
    expect(titleEntries.some((t) => t?.startsWith('Share'))).toBe(true);
    expect(titleEntries.some((t) => t?.includes('Project settings'))).toBe(
      true,
    );
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(trigger);

    cleanup();
    renderRow();
    await user.click(
      screen.getByRole('button', { name: 'Actions for Shortcut Project' }),
    );
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(
      titleEntries,
    );
  });

  it('opens Share and Project settings for its own project through the store', async () => {
    const user = userEvent.setup();
    renderRow();
    for (const [name, key] of [
      [/^Share/, 'shareProjectId'],
      [/Project settings/, 'settingsProjectId'],
    ] as const) {
      await user.click(
        screen.getByRole('button', { name: 'Actions for Shortcut Project' }),
      );
      await user.click(screen.getByRole('menuitem', { name }));
      expect(useStore.getState()[key]).toBe('shortcut-project');
    }
  });
});

describe('navbar project mode activity badges', () => {
  it('does not render disabled mode buttons or idle badges in compact mode', () => {
    render(
      <ProjectModeSwitcher
        currentMode="kanban"
        compact
        enabledModes={{ kanban: true, chat: false, objectives: false }}
        statuses={{ kanban: 'idle', chat: 'working', objectives: 'finished' }}
        onSwitch={vi.fn()}
      />,
    );

    const kanbanButton = screen.getByRole('button', { name: 'Kanban mode' });
    expect(
      kanbanButton.querySelector('[data-ui="project-mode-status"]'),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: /Chat mode/ })).toBeNull();
    expect(
      screen.queryByRole('button', { name: /Objectives mode/ }),
    ).toBeNull();
  });
});
