import { useCallback, useRef, type ReactNode } from 'react';
import { HoverCard as HoverCardPrimitive } from 'radix-ui';
import { ZoomableImage } from '@/components/zoomable-image';

interface ImageHoverPreviewProps {
  children: ReactNode;
  src: string;
  alt: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
}

/** Largest the image frame may grow with the zoom, relative to its 1x size. */
const MAX_FRAME_GROWTH = 2;
/** Border (1px) and padding (4px) on each side around the image frame. */
const CONTENT_CHROME_PX = 10;

export function ImageHoverPreview({
  children,
  src,
  alt,
  side = 'top',
}: ImageHoverPreviewProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  // Radix publishes the room left on the side the card opened to. Zero means
  // it is not measured yet, so fall back to the 1x size.
  const getMaxFrameSize = useCallback(() => {
    const style = contentRef.current
      ? getComputedStyle(contentRef.current)
      : null;
    const read = (name: string) =>
      Number.parseFloat(
        style?.getPropertyValue(`--radix-hover-card-content-available-${name}`) ??
          '',
      );
    return {
      width: (read('width') || 0) - CONTENT_CHROME_PX,
      height: (read('height') || 0) - CONTENT_CHROME_PX,
    };
  }, []);

  return (
    <HoverCardPrimitive.Root openDelay={150} closeDelay={100}>
      <HoverCardPrimitive.Trigger asChild data-ui="image-hover-preview-trigger">
        {children}
      </HoverCardPrimitive.Trigger>
      <HoverCardPrimitive.Portal>
        <HoverCardPrimitive.Content
          ref={contentRef}
          data-ui="image-hover-preview"
          side={side}
          sideOffset={8}
          collisionPadding={12}
          className="z-50 rounded-lg border border-border bg-popover p-1 shadow-xl outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95"
        >
          <ZoomableImage
            src={src}
            alt={alt}
            maxFrameGrowth={MAX_FRAME_GROWTH}
            getMaxFrameSize={getMaxFrameSize}
            className="max-h-[min(400px,calc(100vh-2rem))] max-w-[min(400px,calc(100vw-2rem))] object-contain"
          />
        </HoverCardPrimitive.Content>
      </HoverCardPrimitive.Portal>
    </HoverCardPrimitive.Root>
  );
}
