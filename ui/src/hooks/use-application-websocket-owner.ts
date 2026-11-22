import { useEffect } from 'react';
import { useAuth } from '@/lib/auth';
import { queryClient } from '@/lib/query-client';
import { connectWebSocket, disconnectWebSocket } from '@/lib/websocket';
import { installWebSocketRecoveryListeners } from '@/lib/websocket-lifecycle';

interface WebSocketOwnerDependencies {
  connect: (force: boolean) => void;
  disconnect: () => void;
  installRecoveryListeners: (
    recover: () => void,
    canRecover: () => boolean,
  ) => () => void;
}

const defaultDependencies: WebSocketOwnerDependencies = {
  connect: (force) =>
    connectWebSocket(queryClient, force ? { force: true } : undefined),
  disconnect: disconnectWebSocket,
  installRecoveryListeners: installWebSocketRecoveryListeners,
};

function canOwnWebSocket() {
  const auth = useAuth.getState();
  return (
    auth.authRequired === false ||
    (auth.authRequired === true &&
      auth.authenticated &&
      !auth.locked &&
      auth.deviceApproved !== false)
  );
}

/** Own the application socket across auth and app-lock transitions. */
export function useApplicationWebSocketOwner(
  dependencies: WebSocketOwnerDependencies = defaultDependencies,
) {
  const allowed = useAuth((auth) =>
    auth.authRequired === false
      ? true
      : auth.authRequired === true &&
        auth.authenticated &&
        !auth.locked &&
        auth.deviceApproved !== false,
  );

  useEffect(() => {
    if (!allowed) return;
    dependencies.connect(false);
    const removeRecoveryListeners = dependencies.installRecoveryListeners(
      () => dependencies.connect(true),
      canOwnWebSocket,
    );
    return () => {
      removeRecoveryListeners();
      dependencies.disconnect();
    };
  }, [allowed, dependencies]);
}
