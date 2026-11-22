import { afterEach, describe, expect, it } from 'vitest';
import { useStore } from './store';

const storageKey = 'carapa-ui-state';

function persistedState() {
  return JSON.parse(localStorage.getItem(storageKey) ?? '{}').state as Record<
    string,
    unknown
  >;
}

afterEach(() => {
  localStorage.removeItem(storageKey);
  useStore.setState({
    desktopSidebarCollapsed: false,
    desktopChatSidebarCollapsed: false,
    sidebarOpen: false,
    chatSidebarOpen: false,
  });
});

describe('desktop sidebar preferences', () => {
  it('persists desktop collapse preferences without persisting mobile drawer state', () => {
    useStore.setState({
      desktopSidebarCollapsed: true,
      desktopChatSidebarCollapsed: true,
      sidebarOpen: true,
      chatSidebarOpen: true,
    });

    expect(persistedState()).toMatchObject({
      desktopSidebarCollapsed: true,
      desktopChatSidebarCollapsed: true,
    });
    expect(persistedState()).not.toHaveProperty('sidebarOpen');
    expect(persistedState()).not.toHaveProperty('chatSidebarOpen');
  });

  it('retains device layout preferences when resetting user state on logout', () => {
    useStore.setState({
      desktopSidebarCollapsed: true,
      desktopChatSidebarCollapsed: true,
      sidebarOpen: true,
      chatSidebarOpen: true,
    });

    useStore.getState().resetForLogout();

    expect(useStore.getState().desktopSidebarCollapsed).toBe(true);
    expect(useStore.getState().desktopChatSidebarCollapsed).toBe(true);
    expect(useStore.getState().sidebarOpen).toBe(false);
    expect(useStore.getState().chatSidebarOpen).toBe(false);
  });
});
