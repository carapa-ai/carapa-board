import { toast } from 'sonner';
import type { PendingAttachment } from '@/hooks/use-paste-attachments';

export type FailedUpload = { name: string; message: string | undefined };

const MAX_LISTED_FAILED_UPLOADS = 3;

export function describeFailedUploads(
  failures: FailedUpload[],
  totalCount: number,
): string {
  if (!failures.some((failure) => failure.message)) {
    return `${failures.length} of ${totalCount} uploads failed`;
  }
  const listed = failures
    .slice(0, MAX_LISTED_FAILED_UPLOADS)
    .map(({ name, message }) => (message ? `${name}: ${message}` : name));
  const hidden = failures.length - listed.length;
  if (hidden > 0) listed.push(`and ${hidden} more`);
  return listed.join('; ');
}

/**
 * Upload pending attachments and append an [Attached files] block to `text`.
 * Resolves to `null` when any upload was rejected: the user is told which
 * files failed and the caller must not send, create or clear anything.
 */
export async function appendUploadedAttachments(
  pending: PendingAttachment[],
  text: string,
  upload: (file: File) => Promise<{ containerPath: string }>,
): Promise<string | null> {
  if (pending.length === 0) return text;
  const results = await Promise.allSettled(
    pending.map((a) =>
      upload(a.file).then((r) => ({
        name: a.file.name,
        containerPath: r.containerPath,
      })),
    ),
  );
  const failures: FailedUpload[] = [];
  results.forEach((result, i) => {
    if (result.status !== 'rejected') return;
    const reason: unknown = result.reason;
    const message =
      reason instanceof Error
        ? reason.message.trim()
        : typeof reason === 'string'
          ? reason.trim()
          : undefined;
    failures.push({
      name: pending[i].file.name,
      message: message || undefined,
    });
  });
  if (failures.length > 0) {
    const description = failures.some((failure) => failure.message)
      ? describeFailedUploads(failures, pending.length)
      : failures.map((failure) => failure.name).join(', ');
    toast.error(`Could not upload: ${description}. Nothing was sent.`);
    return null;
  }
  const attachSection =
    '[Attached files]\n' +
    results
      .map((r) => {
        const { name, containerPath } = (
          r as PromiseFulfilledResult<{ name: string; containerPath: string }>
        ).value;
        return `- ${name}: ${containerPath}`;
      })
      .join('\n');
  return text ? `${text}\n\n${attachSection}` : attachSection;
}
