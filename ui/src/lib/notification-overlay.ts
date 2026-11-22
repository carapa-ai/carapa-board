import { useSyncExternalStore } from 'react';

let payloadId: string | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function openNotification(id: string): void {
  if (!id) return;
  payloadId = id;
  notify();
}

export function closeNotification(expectedId?: string): void {
  if (expectedId !== undefined && payloadId !== expectedId) return;
  if (payloadId === null) return;
  payloadId = null;
  notify();
}

function getOpenNotification(): string | null {
  return payloadId;
}

function subscribeToNotificationOverlay(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useOpenNotification(): string | null {
  return useSyncExternalStore(
    subscribeToNotificationOverlay,
    getOpenNotification,
    () => null,
  );
}
