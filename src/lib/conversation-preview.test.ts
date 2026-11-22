import { describe, expect, it } from 'bun:test';
import { buildConversationPreview } from './conversation-preview.js';

const block =
  '[Attached files]\n- a.png: /workspace/ipc/uploads/1-a.png\n- b.txt: /workspace/ipc/uploads/2-b.txt';
const attachments = [
  { type: 'image', filename: 'a.png' },
  { type: 'document', filename: 'b.txt' },
];

describe('buildConversationPreview', () => {
  it('uses only the user text when attachments are appended', () => {
    expect(
      buildConversationPreview(
        `walk13 file type check\n\n${block}`,
        attachments,
      ),
    ).toBe('walk13 file type check');
  });

  it('uses a names-only label for attachment-only messages', () => {
    expect(buildConversationPreview(block, attachments)).toBe(
      'Attached: a.png, b.txt',
    );
  });

  it('keeps text-only messages unchanged, including literal attachment-like text', () => {
    const literal = `Explain this format:\n\n${block}`;
    expect(buildConversationPreview('hello')).toBe('hello');
    expect(buildConversationPreview(literal, [])).toBe(literal.slice(0, 120));
    expect(buildConversationPreview('x'.repeat(200))).toHaveLength(120);
  });
});
