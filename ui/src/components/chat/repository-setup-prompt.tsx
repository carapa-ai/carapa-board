import { Button } from '@/components/ui/button';

const SETUP_RUNTIME_GUIDANCE =
  'If the project-setup skill is not available in this runtime (for example, a direct-LLM agent running in Board), provide setup guidance using only the tools actually available to you. Start with get_project_setup. Do not search project knowledge as a substitute for the installed skill or assume you have a sandbox shell. Use authorized sandbox-backed tools when available; otherwise explain what remains and how to continue with a sandbox agent.';

export const REPOSITORY_SETUP_PROMPT =
  'Use the project-setup skill to help me set up this code project. No code repository is connected yet. Check where my existing files are, preserve them, and guide me through what is missing in plain language. Do the steps you are already allowed to do and explain any choice I need to make. Do not assume I know Git or how to use a computer.' +
  ' ' +
  SETUP_RUNTIME_GUIDANCE;

export const GIT_INITIALIZATION_SETUP_PROMPT =
  'Use the project-setup skill to help me finish setting up this code project. A repository folder is already configured, but Git is not initialized there. Inspect the selected folder, preserve my existing files, and initialize the missing Git metadata using the project’s configured default branch. Do the steps you are already allowed to do and explain any remaining choices in plain language. Before creating the first saved version (commit), review the files and ask for my permission. Do not choose a different repository or replace existing files.' +
  ' ' +
  SETUP_RUNTIME_GUIDANCE;

export function RepositorySetupPrompt({
  reason = 'no-repo',
  onSetup,
  onSettings,
}: {
  reason?: 'no-repo' | 'not-initialized';
  onSetup: () => void;
  onSettings: () => void;
}) {
  return (
    <div
      className="mx-auto mb-4 max-w-lg rounded-lg border border-border bg-muted/30 p-3 text-sm space-y-2"
      data-ui="repository-setup-prompt"
    >
      <p className="font-medium">Set up a home for your app</p>
      <p className="text-xs text-muted-foreground">
        {reason === 'not-initialized'
          ? 'Your code folder is connected, but Git is not initialized yet. Ask the agent to help you prepare it for saving versions and separate working copies.'
          : 'This code project has no connected folder for its code and saved versions. Ask the agent to help you set it up.'}
      </p>
      <Button type="button" size="sm" variant="outline" onClick={onSetup}>
        Set up this project
      </Button>
      <p className="text-xs text-muted-foreground">
        Only chatting and saving files?{' '}
        <button
          type="button"
          className="underline underline-offset-2 hover:text-foreground"
          onClick={onSettings}
        >
          Open Project Settings
        </button>{' '}
        and turn off Code project. No code repository is needed.
      </p>
    </div>
  );
}
