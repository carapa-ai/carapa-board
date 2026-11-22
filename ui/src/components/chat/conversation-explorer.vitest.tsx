import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConversationExplorer } from './conversation-explorer';

const state = vi.hoisted(() => ({
  project: { id: 'p1', accessLevel: null as string | null },
  user: { id: 'u1', role: 'user' },
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' },
}));
vi.mock('@/hooks/use-projects', () => ({
  useProject: () => ({ data: state.project }),
}));
vi.mock('@/lib/auth', () => ({
  useAuth: (select: (s: { user: unknown }) => unknown) =>
    select({ user: state.user }),
}));
vi.mock('./bash-tab', () => ({ BashTab: () => null }));
vi.mock('./browser-tab', () => ({ BrowserTab: () => null }));
vi.mock('./changes-tab', () => ({ ChangesTab: () => null }));
vi.mock('./files-tab', () => ({ FilesTab: () => null }));
vi.mock('./mail-tab', () => ({ MailTab: () => null }));

function bashTab() {
  const view = render(
    <ConversationExplorer project_id="p1" conversation_id={null} />,
  );
  const tab = screen.queryByRole('tab', { name: 'Bash' });
  view.unmount();
  return tab;
}

describe('ConversationExplorer Bash tab', () => {
  it('hides Bash for chat-only users and viewers and shows it for editors and admins', () => {
    expect(bashTab()).toBeNull();
    state.project.accessLevel = 'viewer';
    expect(bashTab()).toBeNull();
    state.project.accessLevel = 'editor';
    expect(bashTab()).not.toBeNull();
    state.project.accessLevel = null;
    state.user.role = 'admin';
    expect(bashTab()).not.toBeNull();
  });
});
