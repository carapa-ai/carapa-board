import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type { fetchConfig } from '@/lib/api';
import type { Project, ProjectSettings } from '@/types';

type SetProjectSettingsForm = Dispatch<SetStateAction<ProjectSettings>>;

/** Shared draft state every tab edits; saved once by the dialog shell. */
export interface FormProps {
  form: ProjectSettings;
  setForm: SetProjectSettingsForm;
}

export type AppConfig = Awaited<ReturnType<typeof fetchConfig>>;

export type ProjectSandbox = Project['effectiveSandbox'];

export const TAB_CONTENT_CLASS = 'min-w-0 px-6 py-4';

/**
 * Heading + optional muted description above a group of related controls.
 * Consecutive sections are separated by a subtle top border.
 */
export function SettingsSection({
  name,
  title,
  description,
  children,
}: {
  name: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      data-ui={`project-settings-section-${name}`}
      className="space-y-4 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-border [&:not(:first-child)]:pt-4"
    >
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && (
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}
