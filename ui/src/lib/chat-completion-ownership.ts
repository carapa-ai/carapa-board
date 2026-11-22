export function completionOwnsConversationLifecycle(args: {
  eventStreamKey?: string;
  currentStreamKey?: string;
  currentStreamCompleted: boolean;
  hasQueuedPrompts: boolean;
}): boolean {
  const { eventStreamKey, currentStreamKey } = args;
  if (
    !eventStreamKey ||
    !currentStreamKey ||
    eventStreamKey === currentStreamKey
  )
    return true;
  return args.hasQueuedPrompts && args.currentStreamCompleted;
}
