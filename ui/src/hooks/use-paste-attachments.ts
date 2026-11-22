import { useState, useCallback } from 'react';

export interface PendingAttachment {
  file: File;
  /** Local blob URL for thumbnail preview */
  previewUrl: string;
  /** Known duration for recorder-created audio, in seconds. */
  durationSeconds?: number;
}

/**
 * Manages paste-to-attach behaviour for dialogs.
 * Files are collected locally; actual upload happens at submit time.
 */
export function usePasteAttachments() {
  const [pending, setPending] = useState<PendingAttachment[]>([]);

  const addFiles = useCallback((files: FileList | File[], durations?: Array<number | undefined>) => {
    const incoming = Array.from(files).map((file, index) => ({
      file,
      previewUrl: URL.createObjectURL(file),
      durationSeconds: durations?.[index],
    }));
    setPending((prev) => [...prev, ...incoming]);
  }, []);

  const removeAt = useCallback((idx: number) => {
    setPending((prev) => {
      const removed = prev[idx];
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((_, i) => i !== idx);
    });
  }, []);

  const clear = useCallback(() => {
    setPending((prev) => {
      prev.forEach((a) => URL.revokeObjectURL(a.previewUrl));
      return [];
    });
  }, []);

  /** Paste event handler — attach to onPaste of textarea / container */
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files = Array.from(e.clipboardData.files);
      if (files.length > 0) {
        e.preventDefault();
        addFiles(files);
      }
    },
    [addFiles],
  );

  return { pending, addFiles, removeAt, clear, handlePaste };
}
