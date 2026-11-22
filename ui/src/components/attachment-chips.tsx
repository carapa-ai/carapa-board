import { X, Mic } from 'lucide-react';
import { ImageHoverPreview } from '@/components/image-hover-preview';
import type { PendingAttachment } from '@/hooks/use-paste-attachments';

interface AttachmentChipsProps {
  attachments: PendingAttachment[];
  onRemove: (index: number) => void;
}

export function AttachmentChips({
  attachments,
  onRemove,
}: AttachmentChipsProps) {
  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {attachments.map((a, i) => {
        const isImage = a.file.type.startsWith('image/');
        const isAudio = a.file.type.startsWith('audio/');
        return (
          <div
            key={i}
            className="relative group flex items-center gap-1 bg-muted rounded px-1.5 py-1 text-xs max-w-[120px]"
          >
            {isImage ? (
              <ImageHoverPreview src={a.previewUrl} alt={a.file.name}>
                <img
                  src={a.previewUrl}
                  alt={a.file.name}
                  className="size-8 object-cover rounded"
                />
              </ImageHoverPreview>
            ) : isAudio ? (
              <div className="size-8 bg-blue-500/10 rounded flex items-center justify-center text-blue-600 dark:text-blue-500 shrink-0">
                <Mic className="size-4" />
              </div>
            ) : (
              <span className="truncate text-foreground" title={a.file.name}>
                {a.file.name}
              </span>
            )}
            {isAudio && (
              <span className="truncate text-foreground italic">
                Audio recording
              </span>
            )}
            <button
              type="button"
              onClick={() => onRemove(i)}
              // text-white on the filled bg-red-600 keeps >= 4.5:1 in both themes.
              className="absolute -top-1.5 -right-1.5 inline-flex min-h-6 min-w-6 items-center justify-center bg-red-600 dark:bg-red-500 text-white rounded-full opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 md:focus-visible:opacity-100 transition-opacity shadow-sm z-10"
              title="Remove"
              aria-label={`Remove ${a.file.name || (isAudio ? 'audio recording' : 'attachment')}`}
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
