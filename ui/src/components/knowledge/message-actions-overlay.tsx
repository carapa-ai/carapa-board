import { useState, useEffect, useId, useRef } from 'react';
import { Notebook, Check, Loader2, Copy, GitFork, X } from 'lucide-react';
import { copyToClipboard } from '@/lib/utils';
import {
  useSharedKnowledgeBases,
  useSaveMessageToKnowledge,
} from '@/hooks/use-knowledge';
import { toast } from 'sonner';
import { useStore } from '@/store';

interface MessageActionsOverlayProps {
  id: string;
  content: string;
  project_id: string;
  onClose: () => void;
  anchorY: number;
  hasFork: boolean;
}

export function MessageActionsOverlay({
  content,
  project_id,
  onClose,
  anchorY,
  hasFork,
}: MessageActionsOverlayProps) {
  const { data: kbs = [], isLoading } = useSharedKnowledgeBases(project_id);
  const overlayRef = useRef<HTMLDivElement>(null);
  const { mutate: saveMessage, isPending: isSaving } =
    useSaveMessageToKnowledge();
  const [copied, setCopied] = useState(false);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    overlayRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = overlayRef.current;
      if (!panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        'button:not([disabled])',
      );
      const first = focusable[0] ?? panel;
      const last = focusable[focusable.length - 1] ?? panel;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (!panel.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, []);

  const handleCopy = async () => {
    const success = await copyToClipboard(content);
    if (success) {
      setCopied(true);
      toast.success('Copied to clipboard');
      setTimeout(() => {
        setCopied(false);
        onClose();
      }, 500);
    } else {
      toast.error('Could not copy to clipboard');
    }
  };

  const handleSaveToKb = (kb_id: string, kbName: string) => {
    // Backend derives the filename and attaches cached page transcripts of any links.
    saveMessage(
      { id: kb_id, content, group_folder: project_id, kbName },
      { onSuccess: onClose },
    );
  };

  return (
    <div
      // bg-black/60 is a modal scrim, dark in both themes.
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-md animate-in fade-in duration-300"
      onClick={onClose}
    >
      <div
        ref={overlayRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="bg-popover text-popover-foreground dark:bg-zinc-900 border border-black/10 dark:border-white/10 rounded-3xl shadow-2xl overflow-hidden w-[320px] max-w-[95vw] outline-none animate-in zoom-in-95 slide-in-from-bottom-10 duration-300"
        style={{
          marginTop: Math.max(
            -100,
            Math.min(100, anchorY - window.innerHeight / 2),
          ),
        }}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-black/5 dark:border-white/5 flex items-center justify-between bg-black/5 dark:bg-white/5">
          <div className="flex items-center gap-2">
            <Zap className="size-4 text-yellow-600 dark:text-yellow-400" />
            <span
              id={titleId}
              className="text-sm font-bold text-foreground dark:text-white uppercase tracking-widest"
            >
              Message Actions
            </span>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="p-1 hover:bg-black/10 dark:hover:bg-white/10 rounded-full transition-colors"
          >
            <X className="size-5 text-muted-foreground dark:text-white/50" />
          </button>
        </div>

        <div className="p-3 flex flex-col gap-2">
          {/* Section: Quick Actions */}
          <div className="grid grid-cols-2 gap-2 mb-2">
            <button
              onClick={handleCopy}
              className="flex flex-col items-center justify-center gap-2 p-4 bg-black/5 dark:bg-white/5 hover:bg-blue-600 dark:hover:bg-blue-600 rounded-2xl transition-all group"
            >
              <div className="size-10 rounded-full bg-black/10 dark:bg-white/10 flex items-center justify-center group-hover:bg-white/20 dark:group-hover:bg-white/20">
                {copied ? (
                  <Check className="size-5 text-green-700 dark:text-green-400 group-hover:text-green-400" />
                ) : (
                  <Copy className="size-5 text-foreground dark:text-white group-hover:text-white" />
                )}
              </div>
              <span className="text-xs font-medium text-foreground dark:text-white group-hover:text-white">
                Copy Text
              </span>
            </button>

            {hasFork && (
              <button
                onClick={() => {
                  const info = useStore.getState().messageActionsInfo;
                  if (info?.onFork) {
                    info.onFork();
                  } else {
                    toast.info('Forking is coming to mobile soon!');
                  }
                  onClose();
                }}
                className="flex flex-col items-center justify-center gap-2 p-4 bg-black/5 dark:bg-white/5 hover:bg-purple-600 dark:hover:bg-purple-600 rounded-2xl transition-all group"
              >
                <div className="size-10 rounded-full bg-black/10 dark:bg-white/10 flex items-center justify-center group-hover:bg-white/20 dark:group-hover:bg-white/20">
                  <GitFork className="size-5 text-foreground dark:text-white group-hover:text-white" />
                </div>
                <span className="text-xs font-medium text-foreground dark:text-white group-hover:text-white">
                  Fork Chat
                </span>
              </button>
            )}
          </div>

          <div className="px-2 py-1 text-[10px] font-bold text-muted-foreground dark:text-white/30 uppercase tracking-widest">
            Save to Knowledge Base
          </div>

          {isLoading ? (
            <div className="py-8 flex justify-center">
              {/* Translucent mid-tone blue: reads on both themes. */}
              <Loader2 className="size-6 animate-spin text-blue-500/50" />
            </div>
          ) : kbs.length === 0 ? (
            <div className="py-4 px-3 text-center text-sm text-muted-foreground dark:text-zinc-500 bg-black/5 dark:bg-white/5 rounded-2xl italic">
              No shared knowledge bases
            </div>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-[40vh] overflow-y-auto pr-1">
              {kbs.map((kb) => (
                <button
                  key={kb.id}
                  onClick={() => handleSaveToKb(kb.id, kb.name)}
                  disabled={isSaving}
                  className="flex items-center gap-3 px-4 py-3.5 rounded-2xl bg-black/5 dark:bg-white/5 hover:bg-blue-600 dark:hover:bg-blue-600 text-foreground dark:text-zinc-300 hover:text-white dark:hover:text-white transition-all text-left disabled:opacity-50 disabled:pointer-events-none"
                >
                  <div className="size-9 rounded-full bg-black/10 dark:bg-zinc-800 flex items-center justify-center">
                    <Notebook className="size-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold truncate">
                      {kb.name}
                    </div>
                    <div className="text-[10px] opacity-50">
                      {kb.description}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="p-4 bg-black/5 dark:bg-white/5 text-center">
          <p className="text-[10px] text-muted-foreground dark:text-white/20 font-medium italic">
            Select an action to perform on this message
          </p>
        </div>
      </div>
    </div>
  );
}

function Zap({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}
