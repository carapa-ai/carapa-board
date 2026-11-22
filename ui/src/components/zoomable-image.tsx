import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactEventHandler,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { SecureImage } from '@/components/secure-image';
import { cn } from '@/lib/utils';

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const DOUBLE_CLICK_SCALE = 2.5;
const SCALE_EPSILON = 0.001;
const WHEEL_ZOOM_SPEED = 0.0025;
const WHEEL_LINE_HEIGHT_PX = 16;
const DOUBLE_TAP_MS = 300;
const TAP_SLOP_PX = 24;

interface View {
  scale: number;
  x: number;
  y: number;
}

interface Point {
  x: number;
  y: number;
}

const IDENTITY_VIEW: View = { scale: MIN_SCALE, x: 0, y: 0 };

interface Size {
  width: number;
  height: number;
}

interface ZoomableImageProps {
  src: string;
  alt: string;
  /** Size caps for the image at 1x; the surface clips the zoomed image to them. */
  className?: string;
  /**
   * Largest factor the frame may grow with the zoom (1 keeps it at the 1x size).
   * While zoom is below this factor the frame grows with it, so the image keeps
   * its whole picture in view; beyond it the image zooms inside the frame.
   * The frame grows per axis, up to `getMaxFrameSize`, so it can fill the room
   * even when the image has a different aspect ratio.
   */
  maxFrameGrowth?: number;
  /** Size the frame may not exceed. Read on each gesture; unbounded when omitted. */
  getMaxFrameSize?: () => Size;
  /** Called when the image fails to load or decode. */
  onError?: ReactEventHandler<HTMLImageElement>;
}

const clampScale = (scale: number) =>
  Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

/**
 * Keeps the scaled image (`base` at 1x) covering the whole frame, which is
 * at most as large as the scaled image.
 */
function clampView(view: View, base: Size, frame: Size): View {
  const scale = clampScale(view.scale);
  // Snap float drift (e.g. 1.0000000000000004 after pinching back) to 1x.
  if (scale < MIN_SCALE + SCALE_EPSILON) return IDENTITY_VIEW;
  return {
    scale,
    x: Math.min(0, Math.max(frame.width - base.width * scale, view.x)),
    y: Math.min(0, Math.max(frame.height - base.height * scale, view.y)),
  };
}

/**
 * Zooms by `nextScale` while keeping the image point under `from` under `to`,
 * so one call covers cursor-anchored zoom, drag panning and pinch.
 */
function transformView(
  view: View,
  nextScale: number,
  from: Point,
  to: Point,
  base: Size,
  frame: Size,
): View {
  const scale = clampScale(nextScale);
  const ratio = scale / view.scale;
  return clampView(
    {
      scale,
      x: to.x - (from.x - view.x) * ratio,
      y: to.y - (from.y - view.y) * ratio,
    },
    base,
    frame,
  );
}

/**
 * Image that zooms with the wheel, double-click, double-tap and pinch, and pans by dragging
 * when zoomed. At 1x it renders exactly like the bare image. State lives only in
 * this component, so unmounting (e.g. closing a popup) resets it.
 */
export function ZoomableImage({
  src,
  alt,
  className,
  maxFrameGrowth = 1,
  getMaxFrameSize,
  onError,
}: ZoomableImageProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<View>(IDENTITY_VIEW);
  const pointersRef = useRef(new Map<number, Point>());
  // Start of a one-finger gesture that may still turn out to be a tap.
  const tapStartRef = useRef<Point | null>(null);
  const lastTapRef = useRef<{ time: number; point: Point } | null>(null);
  // Touch and pen double-taps are detected from pointer events, so the
  // browser's own dblclick for them must not toggle the zoom a second time.
  const touchInputRef = useRef(false);
  const [view, setViewState] = useState<View>(IDENTITY_VIEW);
  const [dragging, setDragging] = useState(false);
  // Explicit frame size while the frame is grown beyond the 1x image size.
  const [frame, setFrame] = useState<Size | null>(null);

  const setView = useCallback((next: View) => {
    viewRef.current = next;
    setViewState(next);
  }, []);

  const surfacePoint = useCallback(
    (clientX: number, clientY: number): Point => {
      const rect = surfaceRef.current?.getBoundingClientRect();
      return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
    },
    [],
  );

  const applyTransform = useCallback(
    (nextScale: number, from: Point, to: Point) => {
      const content = contentRef.current;
      if (!content) return;
      const base = { width: content.offsetWidth, height: content.offsetHeight };
      const scale = clampScale(nextScale);
      // The frame grows with the zoom up to the growth cap, on each axis
      // separately, until it fills the room left (so a wide or tall image
      // ends up covering the whole room, not only the axis it fits first).
      const growth = Math.max(MIN_SCALE, Math.min(scale, maxFrameGrowth));
      const room = getMaxFrameSize?.();
      const grow = (size: number, limit: number | undefined) =>
        Math.max(size, Math.min(size * growth, limit ?? Infinity));
      const nextFrame = {
        width: grow(base.width, room?.width),
        height: grow(base.height, room?.height),
      };
      const grown =
        nextFrame.width > base.width + SCALE_EPSILON ||
        nextFrame.height > base.height + SCALE_EPSILON;
      setFrame(grown ? nextFrame : null);
      setView(transformView(viewRef.current, scale, from, to, base, nextFrame));
    },
    [getMaxFrameSize, maxFrameGrowth, setView],
  );

  useEffect(() => {
    pointersRef.current.clear();
    tapStartRef.current = null;
    lastTapRef.current = null;
    setDragging(false);
    setFrame(null);
    setView(IDENTITY_VIEW);
  }, [src, setView]);

  // React registers wheel listeners as passive, which forbids preventDefault.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const deltaY =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? event.deltaY * WHEEL_LINE_HEIGHT_PX
          : event.deltaY;
      const point = surfacePoint(event.clientX, event.clientY);
      applyTransform(
        viewRef.current.scale * Math.exp(-deltaY * WHEEL_ZOOM_SPEED),
        point,
        point,
      );
    };
    surface.addEventListener('wheel', onWheel, { passive: false });
    return () => surface.removeEventListener('wheel', onWheel);
  }, [applyTransform, surfacePoint]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const point = surfacePoint(event.clientX, event.clientY);
    touchInputRef.current = event.pointerType !== 'mouse';
    tapStartRef.current = pointersRef.current.size === 0 ? point : null;
    pointersRef.current.set(event.pointerId, point);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointers have no active capture target; events still reach us.
    }
    setDragging(true);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pointers = pointersRef.current;
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    const current = surfacePoint(event.clientX, event.clientY);
    const tapStart = tapStartRef.current;
    if (
      tapStart &&
      Math.hypot(current.x - tapStart.x, current.y - tapStart.y) > TAP_SLOP_PX
    ) {
      tapStartRef.current = null;
    }
    const others = [...pointers].filter(([id]) => id !== event.pointerId);
    if (others.length === 0) {
      if (viewRef.current.scale > MIN_SCALE) {
        applyTransform(viewRef.current.scale, previous, current);
      }
    } else {
      const other = others[0][1];
      const previousDistance = Math.hypot(
        previous.x - other.x,
        previous.y - other.y,
      );
      const distance = Math.hypot(current.x - other.x, current.y - other.y);
      applyTransform(
        previousDistance > 0
          ? viewRef.current.scale * (distance / previousDistance)
          : viewRef.current.scale,
        { x: (previous.x + other.x) / 2, y: (previous.y + other.y) / 2 },
        { x: (current.x + other.x) / 2, y: (current.y + other.y) / 2 },
      );
    }
    pointers.set(event.pointerId, current);
  };

  const toggleZoom = (point: Point) => {
    applyTransform(
      viewRef.current.scale > MIN_SCALE ? MIN_SCALE : DOUBLE_CLICK_SCALE,
      point,
      point,
    );
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size === 0) setDragging(false);
    const tapStart = tapStartRef.current;
    tapStartRef.current = null;
    if (event.type !== 'pointerup' || event.pointerType === 'mouse') return;
    if (!tapStart) {
      lastTapRef.current = null;
      return;
    }
    const last = lastTapRef.current;
    if (
      last &&
      event.timeStamp - last.time <= DOUBLE_TAP_MS &&
      Math.hypot(tapStart.x - last.point.x, tapStart.y - last.point.y) <=
        TAP_SLOP_PX
    ) {
      lastTapRef.current = null;
      toggleZoom(tapStart);
    } else {
      lastTapRef.current = { time: event.timeStamp, point: tapStart };
    }
  };

  const handleDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (touchInputRef.current) return;
    toggleZoom(surfacePoint(event.clientX, event.clientY));
  };

  const zoomed = view.scale > MIN_SCALE;

  return (
    <div
      ref={surfaceRef}
      data-ui="zoomable-image"
      data-zoom={String(view.scale)}
      className={cn(
        'touch-none select-none overflow-hidden rounded-md',
        zoomed
          ? dragging
            ? 'cursor-grabbing'
            : 'cursor-grab'
          : 'cursor-zoom-in',
      )}
      style={frame ? { width: frame.width, height: frame.height } : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      // Portal events bubble through the React tree to the trigger (e.g. a file
      // row button that opens the file), so gestures here must not reach it.
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={handleDoubleClick}
    >
      <div ref={contentRef} className="w-fit">
        <SecureImage
          src={src}
          alt={alt}
          draggable={false}
          onError={onError}
          className={cn('block', className)}
          style={{
            transformOrigin: '0 0',
            transform: zoomed
              ? `translate(${view.x}px, ${view.y}px) scale(${view.scale})`
              : undefined,
          }}
        />
      </div>
    </div>
  );
}
