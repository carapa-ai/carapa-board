import { createRouter } from '@tanstack/react-router';
import { routeTree } from '../routeTree.gen';

// Singleton router instance. Exposed here so non-component modules (e.g.
// push.ts notification handlers) can navigate without going through React.
// Using a soft client-side navigation keeps the AuthGate mounted, so its
// `locked` state can gate rendering atomically — a hard `window.location`
// reload re-mounted AuthGate from scratch and let the form route render
// before the lock decision converged.
export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
