import { useState, useRef, useCallback } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SandboxInstance } from '@/lib/api';

/** Clickable text that copies full value to clipboard on click */
export function CopyableText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      navigator.clipboard
        .writeText(text)
        .then(() => {
          setCopied(true);
          if (timeoutRef.current) clearTimeout(timeoutRef.current);
          timeoutRef.current = setTimeout(() => setCopied(false), 1500);
        })
        .catch(() => {});
    },
    [text],
  );

  return (
    <button
      onClick={handleClick}
      title={`Click to copy: ${text}`}
      className={cn(
        'inline-flex items-center gap-1 min-w-0 text-left cursor-pointer hover:text-foreground transition-colors group/copy',
        className,
      )}
    >
      <span className="truncate">{text}</span>
      {copied ? (
        <Check className="size-2.5 shrink-0 text-green-700 dark:text-green-400" />
      ) : (
        <Copy className="size-2.5 shrink-0 opacity-0 group-hover/copy:opacity-100 transition-opacity" />
      )}
    </button>
  );
}

/** Extract unique host port numbers from a Docker port strings array.
 * Handles formats like "32801->80/tcp", "0.0.0.0:7080->80/tcp", "7080:80", "7080" */
function parseHostPorts(ports: string[]): number[] {
  const seen = new Set<number>();
  for (const p of ports) {
    // "32801->80/tcp" or "0.0.0.0:32801->80/tcp"
    const arrowMatch = p.match(/(\d+)->/);
    if (arrowMatch) {
      seen.add(parseInt(arrowMatch[1], 10));
      continue;
    }
    // "7080:80" or "7080:80/tcp"
    const colonMatch = p.match(/^(\d+):/);
    if (colonMatch) {
      seen.add(parseInt(colonMatch[1], 10));
      continue;
    }
    // plain "7080"
    const plainMatch = p.match(/^(\d+)/);
    if (plainMatch) seen.add(parseInt(plainMatch[1], 10));
  }
  return [...seen];
}

/** Ingress ports are diagnostic endpoints: only approved clients can use them. */
export function SandboxServicePorts({
  instance,
  service,
}: {
  instance: SandboxInstance;
  service: SandboxInstance['services'][number];
}) {
  const ingress = instance.ingress?.filter(
    (endpoint) => endpoint.service === service.service,
  );
  const httpEndpoints =
    ingress?.filter((endpoint) => endpoint.kind === 'http') ?? [];
  const legacyPorts = ingress?.length
    ? []
    : parseHostPorts(
        (service.ports ?? []).filter(
          (port) =>
            !(
              instance.ssh?.supported &&
              service.service === instance.ssh.service &&
              port.endsWith('->2222/tcp')
            ),
        ),
      );
  if (!httpEndpoints.length && !legacyPorts.length) return null;
  return (
    <div
      data-ui="sandbox-service-ports"
      data-service={service.service}
      className="mt-0.5 flex min-w-0 flex-wrap gap-1 text-xs"
    >
      {httpEndpoints.map((endpoint) => (
        <div
          key={`${endpoint.host}:${endpoint.port}`}
          data-ui="sandbox-ingress-endpoint"
          className="min-w-0 max-w-full"
          title={`HTTP ingress to ${service.service}:${endpoint.targetPort}. Approved clients only; use the website link to open the app.`}
        >
          <div className="flex min-w-0 items-center gap-1">
            <CopyableText
              text={`${endpoint.host}:${endpoint.port}`}
              className="font-mono"
            />
            <span className="shrink-0 text-muted-foreground">
              → {endpoint.targetPort}
            </span>
          </div>
          <span className="text-muted-foreground">
            Proxy · approved clients only
          </span>
        </div>
      ))}
      {legacyPorts.map((port) => (
        <a
          key={port}
          href={`http://localhost:${port}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 text-cyan-700 dark:text-cyan-400 hover:underline"
          title={`Open http://localhost:${port}`}
        >
          <ExternalLink className="size-2.5" />:{port}
        </a>
      ))}
    </div>
  );
}

export function SandboxWorktreePreview({
  worktree,
}: {
  worktree: { slug: string; port: number };
}) {
  return (
    <div
      data-ui="sandbox-worktree-preview"
      data-worktree={worktree.slug}
      className="mt-1 min-w-0 text-xs"
      title={`Worktree: ${worktree.slug}. Open from within this sandbox.`}
    >
      <CopyableText
        text={`http://nginx:${worktree.port}/`}
        className="max-w-full font-mono"
      />
      <span className="ml-1 text-muted-foreground">Sandbox only</span>
    </div>
  );
}
