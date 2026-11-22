import { memo, useEffect, useRef } from 'react';
import {
  Square,
  Loader2,
  X,
  FileText,
  Sparkles,
  ListChecks,
  Mic,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { buildMeetingPrompt } from '@/lib/meeting-prompts';
import {
  meetingLanguageLabel,
  type MeetingLanguageOption,
} from '@/lib/meeting-languages';
import { cn } from '@/lib/utils';
import type { MeetingRecordingState } from '@/types';

interface MeetingRecordingOverlayProps {
  state: MeetingRecordingState;
  languages: MeetingLanguageOption[];
  visible: boolean;
  onStop: () => void;
  onDismiss: () => void;
  onResume: () => void;
  resumeDisabled?: boolean;
  /** Pre-fill the chat input with an agent prompt and focus it. */
  onPromptAgent: (prompt: string) => void;
  /** The chat's model hears audio, so prompts also name the recording. */
  hearsAudio?: boolean;
  /** Open a saved meeting file (group-relative path) in the workspace pane. */
  onOpenFile: (relPath: string, mimetype?: string) => void;
}

/** A recorder's `.webm` is audio; by extension alone it would open as video. */
function audioMimetype(relPath: string): string | undefined {
  const ext = relPath.split('.').pop()?.toLowerCase();
  return ext === 'webm'
    ? 'audio/webm'
    : ext === 'ogg'
      ? 'audio/ogg'
      : ext === 'm4a'
        ? 'audio/mp4'
        : undefined;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const MeetingRecordingOverlay = memo(function MeetingRecordingOverlay({
  state,
  languages,
  visible,
  onStop,
  onDismiss,
  onResume,
  resumeDisabled,
  onPromptAgent,
  hearsAudio,
  onOpenFile,
}: MeetingRecordingOverlayProps) {
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [state.partialTranscript]);

  if (!visible) return null;

  const transcriptPath =
    state.artifactRelPath && state.partialTranscript?.trim()
      ? state.artifactRelPath
      : null;

  const canPrompt = !state.isRecording && !!state.partialTranscript;
  const languageLabel = meetingLanguageLabel(languages, state.language);

  const handlePrompt = (kind: 'summarize' | 'action_items' | 'custom') => {
    onPromptAgent(
      buildMeetingPrompt(
        kind,
        state.artifactRelPath,
        state.artifactFilename,
        hearsAudio
          ? state.audioRecordings.map((recording) => recording.relPath)
          : [],
      ),
    );
  };

  return (
    <div
      className={cn(
        // The shadow stays black-based in both themes: a soft dark drop shadow reads on light and dark surfaces alike.
        'absolute inset-x-0 bottom-full z-30 mb-1.5 flex flex-col overflow-hidden rounded-2xl border border-black/10 dark:border-white/10 bg-background shadow-lg shadow-black/20 animate-in fade-in slide-in-from-bottom-2 duration-200',
        state.isRecording ? 'h-[min(50vh,22rem)]' : 'h-[min(58vh,26rem)]',
      )}
    >
      {state.isRecording && (
        <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <div className="relative flex size-2.5 shrink-0 items-center justify-center">
              <div className="absolute size-2.5 rounded-full bg-red-600 dark:bg-red-500 animate-ping" />
              <div className="relative size-2.5 rounded-full bg-red-600 dark:bg-red-500" />
            </div>
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium tabular-nums">
                Recording… {formatDuration(state.duration)}
              </span>
              {state.language && (
                <span className="truncate text-[10px] text-muted-foreground">
                  {languageLabel}
                </span>
              )}
            </div>
          </div>
          <Button
            size="sm"
            variant="default"
            onClick={onStop}
            disabled={state.isStopping}
            // text-white on the filled bg-red-600 keeps >= 4.5:1 in both themes.
            className="h-7 shrink-0 bg-red-600 px-2.5 text-xs text-white hover:bg-red-700 dark:hover:bg-red-500"
          >
            {state.isStopping ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <>
                <Square className="mr-1 size-3 fill-current" />
                Stop
              </>
            )}
          </Button>
        </div>
      )}

      {state.error && (
        <p
          data-ui="meeting-recording-error"
          role="alert"
          className="shrink-0 px-3 pb-1 text-xs text-destructive break-words"
        >
          {state.error}
        </p>
      )}

      <div
        ref={transcriptRef}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-2"
      >
        {state.partialTranscript ? (
          <p className="text-sm leading-relaxed text-foreground/85 whitespace-pre-wrap break-words">
            {state.partialTranscript}
            {state.isRecording && (
              <span className="ml-1.5 text-xs italic opacity-60">
                transcribing…
              </span>
            )}
          </p>
        ) : state.isRecording ? (
          <div className="flex items-center gap-2 py-1">
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            <span className="text-sm italic text-muted-foreground">
              Awaiting transcript…
            </span>
          </div>
        ) : (
          <p className="py-1 text-sm text-muted-foreground">
            No transcript captured.
          </p>
        )}
      </div>

      {!state.isRecording && (
        <div className="shrink-0 space-y-2 border-t border-black/5 px-3 py-2 dark:border-white/5">
          {state.language && (
            <p className="text-[10px] text-muted-foreground">
              Language: {languageLabel}
            </p>
          )}
          <div className="flex items-center gap-1.5">
            <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="default"
                className="h-7 gap-1 bg-red-600 px-2 text-xs text-white hover:bg-red-700 dark:hover:bg-red-500"
                onClick={onResume}
                disabled={resumeDisabled}
              >
                {state.isStarting || state.isStopping ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Mic className="size-3" />
                )}
                Resume
              </Button>
              {canPrompt && (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-7 gap-1 px-2 text-xs"
                    onClick={() => handlePrompt('summarize')}
                  >
                    <Sparkles className="size-3" />
                    Summarize
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-7 gap-1 px-2 text-xs"
                    onClick={() => handlePrompt('action_items')}
                  >
                    <ListChecks className="size-3" />
                    Action items
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    onClick={() => handlePrompt('custom')}
                  >
                    Ask agent…
                  </Button>
                </>
              )}
            </div>
            <Button
              size="icon"
              variant="ghost"
              onClick={onDismiss}
              title="Dismiss"
              className="ml-auto size-7 shrink-0 text-muted-foreground hover:text-foreground"
            >
              <X className="size-4" />
            </Button>
          </div>
          {transcriptPath && (
            <button
              type="button"
              data-ui="meeting-recording-transcript-link"
              onClick={() => onOpenFile(transcriptPath)}
              className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
            >
              <FileText className="size-3 shrink-0" />
              <span>Open transcript file</span>
            </button>
          )}
          {state.audioRecordings.map((recording, index) => (
            <button
              key={recording.relPath}
              type="button"
              data-ui="meeting-recording-audio-link"
              onClick={() =>
                onOpenFile(recording.relPath, audioMimetype(recording.relPath))
              }
              className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
            >
              <Mic className="size-3 shrink-0" />
              <span>
                {state.audioRecordings.length > 1
                  ? `Open recording ${index + 1}`
                  : 'Open recording'}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

export default MeetingRecordingOverlay;
