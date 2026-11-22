export interface PlanKanbanTaskInput {
  artifactPath: string;
  planText: string;
  planTitle?: string;
}

function filenameTitle(artifactPath: string): string {
  const filename = artifactPath.split('/').at(-1) || 'implementation-plan';
  return filename
    .replace(/\.md$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function planKanbanTask({
  artifactPath,
  planText,
  planTitle,
}: PlanKanbanTaskInput): { title: string; description: string } {
  const heading = planText.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const title = planTitle?.trim() || heading || filenameTitle(artifactPath);
  const source = `Plan source: @${artifactPath}`;

  return {
    title: title.slice(0, 500),
    description: `${source}\n\n${planText.trim()}`,
  };
}
