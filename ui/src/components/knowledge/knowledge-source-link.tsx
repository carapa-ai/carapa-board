import { ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';

/** External "Source" link; renders nothing unless the URL is http(s). */
export function KnowledgeSourceLink({
  sourceUrl,
  className,
}: {
  sourceUrl: string | null;
  className?: string;
}) {
  let host: string | null = null;
  try {
    const url = new URL(sourceUrl ?? '');
    if (url.protocol === 'http:' || url.protocol === 'https:')
      host = url.hostname;
  } catch {
    // Not a valid URL: render no link.
  }
  if (!sourceUrl || !host) return null;
  return (
    <a
      data-ui="knowledge-source-link"
      href={sourceUrl}
      title={sourceUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'inline-flex max-w-full items-center gap-1 text-xs text-primary hover:underline',
        className,
      )}
    >
      <ExternalLink className="size-3 shrink-0" />
      <span className="truncate">Source: {host}</span>
    </a>
  );
}
