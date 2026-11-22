import { useLayoutEffect, useRef, useState } from 'react';
import type { TaskRecording } from '@/lib/api';

// The recording URL carries a short-lived ticket, so the player streams it
// directly (with Range requests for seeking) even on native clients that
// cannot attach auth headers to a media element.
//
// Loaded lazily by the task dialog to keep it out of the dialog's bundle.
export default function TaskRecordingPlayer({
  recording,
}: {
  recording: TaskRecording;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // Every list refetch mints a new ticket. Keep the URL this player mounted
  // with so a refetch (window focus, task update) does not restart playback.
  const [src] = useState(recording.url);

  // The source is attached here rather than via a `src` prop so the cleanup
  // below can release the media buffers without leaving the element empty:
  // React re-runs mount effects after a simulated unmount (StrictMode, and
  // any remount that reuses the element), and a prop would not be re-applied.
  useLayoutEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.src = src;
    return () => {
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [src]);

  return (
    <video
      ref={videoRef}
      data-ui="task-recording-player"
      data-recording-filename={recording.filename}
      controls
      preload="metadata"
      // bg-black stays in both themes: the video surface is deliberately dark
      // (letterboxed media), so it is not a dark-only patch.
      className="w-full max-h-[60vh] rounded border border-border bg-black"
    />
  );
}
