import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownContent } from './markdown-content';

const block =
  '```askuserquestion\n' +
  JSON.stringify({
    questions: [
      {
        header: 'Pick',
        question: 'Which one?',
        options: [{ label: 'Alpha' }, { label: 'Beta' }],
      },
    ],
  }) +
  '\n```';

function renderCard(send: () => void | Promise<unknown>) {
  const onSendMessage = vi.fn(send);
  render(
    <MarkdownContent onSendMessage={onSendMessage}>{block}</MarkdownContent>,
  );
  return {
    onSendMessage,
    alpha: () =>
      screen.getByRole<HTMLButtonElement>('button', { name: 'Alpha' }),
    beta: () => screen.getByRole<HTMLButtonElement>('button', { name: 'Beta' }),
  };
}

describe('QuestionCard send result', () => {
  it('re-enables the card and allows resending after a rejected send', async () => {
    const { onSendMessage, alpha, beta } = renderCard(() =>
      Promise.reject(new Error('boom')),
    );
    fireEvent.click(alpha());
    await waitFor(() => expect(alpha().disabled).toBe(false));
    expect(beta().disabled).toBe(false);
    expect(alpha().className).toContain('bg-blue-500/20');
    fireEvent.click(alpha());
    expect(onSendMessage).toHaveBeenCalledTimes(2);
  });

  it('stays disabled after a resolved send', async () => {
    const { onSendMessage, alpha, beta } = renderCard(() => Promise.resolve());
    fireEvent.click(alpha());
    await Promise.resolve();
    expect(alpha().disabled).toBe(true);
    expect(beta().disabled).toBe(true);
    expect(onSendMessage).toHaveBeenCalledTimes(1);
  });

  it('stays disabled after a void callback', () => {
    const { onSendMessage, alpha, beta } = renderCard(() => undefined);
    fireEvent.click(alpha());
    expect(alpha().disabled).toBe(true);
    expect(beta().disabled).toBe(true);
    expect(onSendMessage).toHaveBeenCalledTimes(1);
  });
});
