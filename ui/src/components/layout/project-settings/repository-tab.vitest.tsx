import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Tabs } from '@/components/ui/tabs';
import type { ProjectSettings } from '@/types';
import { RepositoryTab } from './repository-tab';

afterEach(cleanup);

function Harness() {
  const [form, setForm] = useState<ProjectSettings>({
    taskCheckoutMode: 'worktree',
    maxParallelWorktrees: 2,
  });
  return (
    <Tabs defaultValue="repository">
      <RepositoryTab
        {...({
          form,
          setForm,
          project_id: 'p',
          config: undefined,
          gitNexusRepos: undefined,
          savedProjectSettings: undefined,
          pushSettingsChanged: false,
          isPushing: false,
          setIsPushing: () => {},
          worktreeFilesText: '',
          setWorktreeFilesText: () => {},
        } as unknown as React.ComponentProps<typeof RepositoryTab>)}
      />
      <output data-testid="form">{JSON.stringify(form)}</output>
    </Tabs>
  );
}

describe('RepositoryTab max parallel worktrees', () => {
  it('sends null when cleared and the number when entered', () => {
    render(<Harness />);
    const input = document.getElementById('settings-parallel')!;
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByTestId('form').textContent).toContain(
      '"maxParallelWorktrees":null',
    );
    fireEvent.change(input, { target: { value: '3' } });
    expect(screen.getByTestId('form').textContent).toContain(
      '"maxParallelWorktrees":3',
    );
  });
});
