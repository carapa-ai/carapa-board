import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConversationListEmptyState } from './conversation-list-empty-state';

describe('ConversationListEmptyState', () => {
  it('shows an error with Retry, not the empty text, when the first page failed', () => {
    const onRetry = vi.fn();
    render(
      <ConversationListEmptyState
        conversationCount={0}
        status="error"
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText(/Could not load conversations/)).toBeTruthy();
    expect(screen.queryByText('No conversations yet.')).toBeNull();
    fireEvent.click(screen.getByText('Retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows the empty text when the load succeeded with zero rows', () => {
    render(
      <ConversationListEmptyState
        conversationCount={0}
        status="success"
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText('No conversations yet.')).toBeTruthy();
    expect(screen.queryByText('Retry')).toBeNull();
  });

  it('shows neither message while the first page is pending', () => {
    const { container } = render(
      <ConversationListEmptyState
        conversationCount={0}
        status="pending"
        onRetry={vi.fn()}
      />,
    );
    expect(container.textContent).toBe('');
  });

  it('renders nothing when conversations are populated', () => {
    const { container } = render(
      <ConversationListEmptyState
        conversationCount={3}
        status="success"
        onRetry={vi.fn()}
      />,
    );
    expect(container.textContent).toBe('');
  });
});
