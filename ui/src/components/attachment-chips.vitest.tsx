import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PendingAttachment } from '@/hooks/use-paste-attachments';
import { AttachmentChips } from './attachment-chips';

function attachment(name: string, type: string): PendingAttachment {
  return { file: new File(['x'], name, { type }), previewUrl: `blob:${name}` };
}

describe('AttachmentChips remove buttons', () => {
  it('names each button after its file, shows on keyboard focus, and removes by index', () => {
    const onRemove = vi.fn();
    render(
      <AttachmentChips
        attachments={[
          attachment('a.pdf', 'application/pdf'),
          attachment('b.txt', 'text/plain'),
          attachment('interview.mp3', 'audio/mpeg'),
          attachment('notes.mp3', 'audio/mpeg'),
          attachment('', 'audio/webm'),
        ]}
        onRemove={onRemove}
      />,
    );

    const first = screen.getByRole('button', { name: 'Remove a.pdf' });
    const second = screen.getByRole('button', { name: 'Remove b.txt' });
    screen.getByRole('button', { name: 'Remove interview.mp3' });
    screen.getByRole('button', { name: 'Remove notes.mp3' });
    screen.getByRole('button', { name: 'Remove audio recording' });
    expect(first.className).toContain('md:focus-visible:opacity-100');

    fireEvent.click(second);
    expect(onRemove).toHaveBeenCalledWith(1);
  });
});
