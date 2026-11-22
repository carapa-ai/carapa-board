/** A background send must not close a deliberately opened blank composer. */
export function shouldEndNewConversationComposition(
  requestedConversationId: string | undefined,
  selectedConversationId: string | null,
): boolean {
  return requestedConversationId === undefined
    || requestedConversationId === selectedConversationId;
}
