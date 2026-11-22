import { XIcon } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { ZoomableImage } from '@/components/zoomable-image';

/** Touch and pen have no hover, so a tap is their only way to see an image larger. */
export function isTouchPointerType(pointerType: string | undefined): boolean {
  return pointerType === 'touch' || pointerType === 'pen';
}

interface ImageTapViewerProps {
  src: string;
  alt: string;
  onClose: () => void;
}

/** Full-screen, pinch-zoomable viewer for an image tapped on a touch device. */
export function ImageTapViewer({ src, alt, onClose }: ImageTapViewerProps) {
  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        {/* The overlay dims the page and locks background scrolling; the full-screen
            content sits above it, so a tap on its empty area closes the viewer.
            bg-black/85 stays in both themes: the viewer is deliberately a dark
            surface over the dimmed page. */}
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/85 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          data-ui="image-tap-viewer"
          aria-describedby={undefined}
          // Portal events bubble through the React tree (e.g. to a markdown link
          // around the image), so taps here must not reach the opener's ancestors.
          onClick={(event) => {
            event.stopPropagation();
            if (event.target === event.currentTarget) onClose();
          }}
          className="fixed inset-0 z-50 flex touch-none items-center justify-center outline-none"
        >
          <DialogPrimitive.Title className="sr-only">
            {alt || 'Image'}
          </DialogPrimitive.Title>
          <ZoomableImage
            src={src}
            alt={alt}
            className="max-h-[90dvh] max-w-[95vw] object-contain"
          />
          <DialogPrimitive.Close
            data-ui="image-tap-viewer-close"
            // Dark close button in both themes: it floats over the dimmed
            // image, so text-white on bg-black/60 keeps >= 4.5:1.
            className="fixed top-3 right-3 flex size-11 items-center justify-center rounded-full bg-black/60 text-white outline-none hover:bg-black/80 focus-visible:ring-2 focus-visible:ring-white"
          >
            <XIcon className="size-5" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
