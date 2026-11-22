import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appendUploadedAttachments } from './attachment-description';

const toastSpy = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: toastSpy.error } }));

const attachment = (name: string) =>
  ({ file: new File(['x'], name) }) as Parameters<
    typeof appendUploadedAttachments
  >[0][number];

beforeEach(() => {
  toastSpy.error.mockReset();
});

describe('appendUploadedAttachments', () => {
  it('names the file and the server reason for a rejected upload', async () => {
    const result = await appendUploadedAttachments(
      [attachment('notes.txt')],
      'hello',
      () => Promise.reject(new Error('File too large')),
    );
    expect(result).toBeNull();
    const message = toastSpy.error.mock.calls[0][0] as string;
    expect(message).toContain('notes.txt');
    expect(message).toContain('File too large');
    expect(message).toContain('Nothing was sent.');
  });

  it('still shows the file name when the rejection has no message', async () => {
    const result = await appendUploadedAttachments(
      [attachment('notes.txt')],
      'hello',
      () => Promise.reject(new Error('')),
    );
    expect(result).toBeNull();
    expect(toastSpy.error.mock.calls[0][0]).toContain('notes.txt');
  });

  it('lists at most three failures and counts the rest', async () => {
    const result = await appendUploadedAttachments(
      ['a', 'b', 'c', 'd', 'e'].map((n) => attachment(`${n}.txt`)),
      'hello',
      () => Promise.reject(new Error('File too large')),
    );
    expect(result).toBeNull();
    expect(toastSpy.error.mock.calls[0][0]).toContain('and 2 more');
  });

  it('appends the attached-files block when every upload succeeds', async () => {
    const result = await appendUploadedAttachments(
      [attachment('notes.txt')],
      'hello',
      async (file) => ({ containerPath: `/tmp/${file.name}` }),
    );
    expect(result).toBe(
      'hello\n\n[Attached files]\n- notes.txt: /tmp/notes.txt',
    );
    expect(toastSpy.error).not.toHaveBeenCalled();
  });
});
