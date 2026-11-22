import { useEffect, useRef, useState, type RefObject } from 'react';
import { cn } from '@/lib/utils';

const BAR_WIDTH = 2;
const BAR_GAP = 2;
/** One new bar this often; older bars scroll left like a voice memo. */
const BAR_INTERVAL_MS = 70;
/** Speech RMS rarely exceeds this, so it maps to a full-height bar. */
const FULL_SCALE_RMS = 0.25;

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Scrolling microphone waveform shown while the composer records. Reads the
 * level from a ref and paints a canvas, so recording never re-renders the
 * composer per audio frame. */
export function MicLevelMeter({
  levelRef,
  startedAt,
  className,
}: {
  /** Latest microphone level (RMS, 0..1), written by the capture loop. */
  levelRef: RefObject<number>;
  /** Wall-clock start of a voice message; shows the elapsed time when set. */
  startedAt?: number | null;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.scale(ratio, ratio);
    const count = Math.floor((width + BAR_GAP) / (BAR_WIDTH + BAR_GAP));
    const bars = new Array<number>(count).fill(0);
    const color = getComputedStyle(canvas).color;
    let peak = 0;
    let lastBar = performance.now();
    let frame = 0;
    const draw = (now: number) => {
      // Square-root scale keeps quiet speech visible without clipping loud.
      const level = Math.min(
        1,
        Math.sqrt((levelRef.current ?? 0) / FULL_SCALE_RMS),
      );
      peak = Math.max(peak, level);
      if (now - lastBar >= BAR_INTERVAL_MS) {
        bars.shift();
        bars.push(peak);
        peak = 0;
        lastBar = now;
      }
      context.clearRect(0, 0, width, height);
      context.fillStyle = color;
      bars.forEach((value, index) => {
        const barHeight = Math.max(2, value * height);
        // Older bars fade out towards the left edge.
        context.globalAlpha = 0.35 + 0.65 * (index / Math.max(1, count - 1));
        context.beginPath();
        context.roundRect(
          index * (BAR_WIDTH + BAR_GAP),
          (height - barHeight) / 2,
          BAR_WIDTH,
          barHeight,
          BAR_WIDTH / 2,
        );
        context.fill();
      });
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [levelRef]);

  useEffect(() => {
    if (!startedAt) return;
    const tick = () => setElapsed(Date.now() - startedAt);
    tick();
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  return (
    <div
      data-ui="composer-mic-level"
      aria-hidden="true"
      className={cn(
        'flex items-center gap-1.5 text-red-600 dark:text-red-500',
        className,
      )}
    >
      <canvas ref={canvasRef} className="h-5 w-16 @md:w-24" />
      {startedAt ? (
        <span className="text-xs tabular-nums text-muted-foreground">
          {formatElapsed(elapsed)}
        </span>
      ) : null}
    </div>
  );
}
