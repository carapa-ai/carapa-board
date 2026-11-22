/**
 * Empty state shown when the URL names a project that is not in the loaded
 * project list (deleted project, renamed folder slug, mistyped bookmark).
 */

import { Link } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function ProjectNotFound({ projectId }: { projectId: string }) {
  return (
    <div
      data-ui="project-not-found"
      data-project-id={projectId}
      className="flex-1 flex items-center justify-center p-6 text-muted-foreground"
    >
      <div className="max-w-md text-center space-y-3">
        <AlertTriangle className="size-10 mx-auto opacity-60" />
        <h2 className="text-lg font-semibold text-foreground">
          Project not found
        </h2>
        <p className="text-sm">
          There is no project named{' '}
          <code className="font-mono text-xs bg-muted px-1 rounded break-all">
            {projectId}
          </code>
          . It may have been deleted or renamed.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link to="/">Back to projects</Link>
        </Button>
      </div>
    </div>
  );
}
