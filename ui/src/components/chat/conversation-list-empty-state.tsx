/**
 * Sidebar placeholder shown when no conversations are loaded. A first-page
 * load failure must not read as an empty history, so it gets its own error
 * line with a Retry action, and "No conversations yet." is reserved for a
 * successful zero-row response.
 */
export function ConversationListEmptyState({
  conversationCount,
  status,
  onRetry,
}: {
  conversationCount: number;
  status: 'pending' | 'error' | 'success';
  onRetry: () => void;
}) {
  // While the first page is pending (initial visit or Retry), show neither
  // the error nor the empty-history text.
  if (conversationCount > 0 || status === 'pending') return null;

  if (status === 'error') {
    return (
      <div
        className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground"
        data-ui="conversations-load-error"
        role="alert"
      >
        <span>Could not load conversations.</span>
        <button
          type="button"
          className="hover:text-foreground"
          onClick={onRetry}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <p className="px-3 py-4 text-xs text-muted-foreground">
      No conversations yet.
    </p>
  );
}
