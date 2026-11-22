import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { chooseOption, selectedLabel } from '@/test-utils/select';
import { Tabs } from '@/components/ui/tabs';
import { privacyModePatch } from '@/lib/privacy-mode';
import type { Project, ProjectSettings } from '@/types';
import { GeneralTab } from './general-tab';

type GeneralTabConfig = React.ComponentProps<typeof GeneralTab>['config'];

afterEach(cleanup);

function Harness({
  saved,
  canEdit,
  error = null,
  onPatch,
  enabledModes,
}: {
  enabledModes?: string[];
  saved: ProjectSettings['privacyMode'];
  canEdit: boolean;
  error?: string | null;
  onPatch?: (patch: Pick<ProjectSettings, 'privacyMode'>) => void;
}) {
  const [form, setForm] = useState<ProjectSettings>({
    privacyMode: saved,
    ...(enabledModes ? { enabledModes } : {}),
  });
  return (
    <Tabs defaultValue="general">
      <GeneralTab
        form={form}
        setForm={setForm}
        project={
          { id: 'p', isMain: false, settings: form } as unknown as Project
        }
        projects={[]}
        project_id="p"
        config={
          enabledModes
            ? ({
                enableKanban: true,
                enableChat: true,
                enableObjectives: true,
              } as unknown as GeneralTabConfig)
            : undefined
        }
        projectName="P"
        setProjectName={() => {}}
        group_folder="p"
        setProjectFolder={() => {}}
        parentId={null}
        setParentId={() => {}}
        inheritedEffectiveSandbox={undefined as never}
        canEditPrivacyMode={canEdit}
        privacyModeError={error}
        clearPrivacyModeError={() => {}}
      />
      <button
        onClick={() =>
          onPatch?.(privacyModePatch(form.privacyMode, saved, canEdit))
        }
      >
        patch
      </button>
    </Tabs>
  );
}

describe('GeneralTab privacy mode', () => {
  it('lets an admin change the mode and sends it in the PATCH payload', async () => {
    const patches: Pick<ProjectSettings, 'privacyMode'>[] = [];
    render(
      <Harness saved={null} canEdit onPatch={(patch) => patches.push(patch)} />,
    );
    const select = screen.getByLabelText('Privacy mode') as HTMLButtonElement;
    expect(select.disabled).toBe(false);
    expect(selectedLabel(select)).toBe('Off');

    await chooseOption(select, 'Local memory pipeline');
    fireEvent.click(screen.getByText('patch'));
    await chooseOption(select, 'Off');
    fireEvent.click(screen.getByText('patch'));

    expect(patches).toEqual([{ privacyMode: 'local_memory' }, {}]);
  });

  it('shows a read-only label for non-admins and never sends the mode', () => {
    const patches: Pick<ProjectSettings, 'privacyMode'>[] = [];
    render(
      <Harness
        saved="strict"
        canEdit={false}
        onPatch={(patch) => patches.push(patch)}
      />,
    );
    expect(document.querySelector('select#settings-privacy-mode')).toBeNull();
    expect(
      document.querySelector(
        '[data-ui="project-settings-privacy-mode-readonly"]',
      )?.textContent,
    ).toBe('Strict');
    fireEvent.click(screen.getByText('patch'));
    expect(patches).toEqual([{}]);
  });

  it('displays an absent mode as Off', () => {
    render(<Harness saved={undefined} canEdit={false} />);
    expect(
      document.querySelector(
        '[data-ui="project-settings-privacy-mode-readonly"]',
      )?.textContent,
    ).toBe('Off');
  });

  it('shows the server error for a rejected downgrade', () => {
    render(<Harness saved="strict" canEdit error="Fresh signature required" />);
    expect(screen.getByRole('alert').textContent).toBe(
      'Fresh signature required',
    );
  });
});

describe('GeneralTab enabled modes', () => {
  it('locks the last remaining mode so zero modes cannot be selected', () => {
    render(<Harness saved={null} canEdit enabledModes={['kanban', 'chat']} />);
    const kanban = screen.getByRole('checkbox', { name: 'Kanban' });
    const chat = screen.getByRole('checkbox', { name: 'Chat' });
    expect(kanban.hasAttribute('disabled')).toBe(false);

    fireEvent.click(kanban);
    expect(kanban.getAttribute('aria-checked')).toBe('false');
    expect(chat.hasAttribute('disabled')).toBe(true);
    expect(
      document.querySelector('[data-ui="project-modes-minimum-hint"]')
        ?.textContent,
    ).toBe('At least one mode must stay enabled.');
  });

  it('asks for a mode when the project already has none', () => {
    render(<Harness saved={null} canEdit enabledModes={[]} />);
    expect(
      document.querySelector('[data-ui="project-modes-minimum-hint"]')
        ?.textContent,
    ).toBe('Select at least one mode to save.');
  });
});
