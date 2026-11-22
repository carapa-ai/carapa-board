// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPreviewTabLeaveGuard, useStore } from '@/store';
import { useProjectWorkspacePane } from './use-project-workspace-pane';

let android = false;
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => android,
    getPlatform: () => (android ? 'android' : 'web'),
  },
}));

describe('useProjectWorkspacePane', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: class {
        observe() {}
        disconnect() {}
      },
    });
  });

  afterEach(() => {
    android = false;
    useStore.setState({ previewTabsByProject: {} });
  });

  it('shares the project open preference and width across mounts', async () => {
    localStorage.setItem(
      'artifactsPanelOpenByProject',
      JSON.stringify({ project: true }),
    );
    localStorage.setItem('artifactsPanelWidth', '512');
    const first = renderHook(() => useProjectWorkspacePane('project'));
    expect(first.result.current.open).toBe(true);
    expect(first.result.current.width).toBe(512);

    await act(async () => first.result.current.setOpen(false));
    first.unmount();
    const second = renderHook(() => useProjectWorkspacePane('project'));
    expect(second.result.current.open).toBe(false);
  });

  it('supports an independently persisted default-open pane scope', async () => {
    const first = renderHook(() =>
      useProjectWorkspacePane('project', {
        openStateKey: 'objective:one',
        defaultOpen: true,
      }),
    );
    expect(first.result.current.open).toBe(true);

    await act(async () => first.result.current.setOpen(false));
    first.unmount();

    const second = renderHook(() =>
      useProjectWorkspacePane('project', {
        openStateKey: 'objective:one',
        defaultOpen: true,
      }),
    );
    expect(second.result.current.open).toBe(false);
    expect(
      JSON.parse(localStorage.getItem('artifactsPanelOpenByProject') ?? '{}')
        .project,
    ).toBeUndefined();
  });

  it('opens Android panes for the session without changing persisted state', () => {
    android = true;
    localStorage.setItem(
      'artifactsPanelOpenByProject',
      JSON.stringify({ project: true }),
    );
    const hook = renderHook(() => useProjectWorkspacePane('project'));
    expect(hook.result.current.open).toBe(false);

    act(() => hook.result.current.setOpen(true));
    expect(hook.result.current.open).toBe(true);
    expect(localStorage.getItem('artifactsPanelOpenByProject')).toBe(
      JSON.stringify({ project: true }),
    );
    hook.unmount();
    android = false;
  });

  it('keeps the pane open when the active preview is dirty', async () => {
    const unregister = registerPreviewTabLeaveGuard(
      'project',
      'file',
      () => false,
    );
    useStore.setState({
      previewTabsByProject: {
        project: {
          tabs: [{ id: 'file', title: 'file', kind: 'file' }],
          activeTabId: 'file',
          activationSequence: 0,
        },
      },
    });
    const hook = renderHook(() => useProjectWorkspacePane('project'));
    act(() => hook.result.current.setOpen(true));
    await act(async () => hook.result.current.setOpen(false));
    expect(hook.result.current.open).toBe(true);
    unregister();
  });

  it('does not hide a dirty pane during responsive restore changes', () => {
    const unregister = registerPreviewTabLeaveGuard(
      'project',
      'file',
      () => false,
    );
    useStore.setState({
      previewTabsByProject: {
        project: {
          tabs: [{ id: 'file', title: 'file', kind: 'file' }],
          activeTabId: 'file',
          activationSequence: 0,
        },
      },
    });
    const hook = renderHook(
      ({ restoreOpen }) =>
        useProjectWorkspacePane('project', { restoreOpen, persistOpen: false }),
      { initialProps: { restoreOpen: true } },
    );
    act(() => hook.result.current.setOpen(true));
    hook.rerender({ restoreOpen: false });
    expect(hook.result.current.open).toBe(true);
    unregister();
  });

  it('allows an already-authorized close without asking the leave guard again', () => {
    const unregister = registerPreviewTabLeaveGuard(
      'project',
      'file',
      () => false,
    );
    useStore.setState({
      previewTabsByProject: {
        project: {
          tabs: [{ id: 'file', title: 'file', kind: 'file' }],
          activeTabId: 'file',
          activationSequence: 0,
        },
      },
    });
    const hook = renderHook(() => useProjectWorkspacePane('project'));
    act(() => hook.result.current.setOpen(true));
    act(() => hook.result.current.setOpenAfterLeaveCheck(false));
    expect(hook.result.current.open).toBe(false);
    unregister();
  });
});
