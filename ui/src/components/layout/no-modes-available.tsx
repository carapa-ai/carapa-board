/**
 * Empty state shown when a project has no view to render.
 *
 * - Server flags (ENABLE_KANBAN, ENABLE_CHAT, ENABLE_OBJECTIVES) all `false`:
 *   there is nothing the project can enable, so ask the operator to re-enable
 *   at least one mode.
 * - Server offers a mode but the project has none selected (its own
 *   `enabledModes` setting): offer a way back to Project settings (the dialog
 *   itself is mounted once at the app root), since the normal header and its
 *   project menu are not rendered on this page.
 */

import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useStore } from '@/store';
import { useAppConfig } from '@/hooks/use-app-config';

export function NoModesAvailable({ projectId }: { projectId?: string }) {
  const { data: config } = useAppConfig();
  const setSettingsProjectId = useStore((s) => s.setSettingsProjectId);
  const serverOffersMode =
    config?.enableKanban || config?.enableChat || config?.enableObjectives;

  return (
    <div
      data-ui="no-modes-available"
      className="flex-1 flex items-center justify-center p-6 text-muted-foreground"
    >
      <div className="max-w-md text-center space-y-3">
        <AlertTriangle className="size-10 mx-auto opacity-60" />
        <h2 className="text-lg font-semibold text-foreground">
          No modes are enabled
        </h2>
        {serverOffersMode && projectId ? (
          <>
            <p className="text-sm">
              This project has no mode enabled. Enable Kanban, Chat, or
              Objectives in the project settings.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSettingsProjectId(projectId)}
            >
              Open project settings
            </Button>
          </>
        ) : (
          <p className="text-sm">
            Kanban, Chat, and Objectives are all disabled at the server. Ask the
            administrator to enable at least one of{' '}
            <code className="font-mono text-xs bg-muted px-1 rounded">
              ENABLE_KANBAN
            </code>
            ,{' '}
            <code className="font-mono text-xs bg-muted px-1 rounded">
              ENABLE_CHAT
            </code>
            , or{' '}
            <code className="font-mono text-xs bg-muted px-1 rounded">
              ENABLE_OBJECTIVES
            </code>
            .
          </p>
        )}
      </div>
    </div>
  );
}
