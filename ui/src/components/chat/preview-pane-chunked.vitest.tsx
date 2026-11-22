import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextPreviewChunked } from './preview-pane';

const CHUNK = 20 * 1024;

const api = vi.hoisted(() => ({
  readGroupFileContent: vi.fn(),
}));
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  readGroupFileContent: api.readGroupFileContent,
  readRepoFileContent: vi.fn(),
  readMountFileContent: vi.fn(),
  mountFileContentUrl: vi.fn(),
}));

function renderChunked(path: string, size: number) {
  return render(
    <TextPreviewChunked
      source="group"
      project_id="project"
      conversation_id={null}
      path={path}
      title={path}
      mimetype="text/plain"
      size={size}
    />,
  );
}

function offsets() {
  return api.readGroupFileContent.mock.calls.map(
    (c) => (c[2] as { offset: number }).offset,
  );
}

/**
 * Scroll the pane to its bottom and wait for the request count to grow. The
 * component re-subscribes its scroll listener in a passive effect after each
 * chunk commits, so a scroll fired right after the chunk renders can reach the
 * previous listener; re-fire it until the expected request is observed.
 */
async function scrollToBottom(container: HTMLElement, expectedCalls: number) {
  const el = container.querySelector<HTMLElement>(
    '[data-ui="text-preview-chunked-scroll"]',
  )!;
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    value: 100_000,
  });
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    value: 500,
  });
  el.scrollTop = 99_500;
  await waitFor(() => {
    fireEvent.scroll(el);
    expect(api.readGroupFileContent).toHaveBeenCalledTimes(expectedCalls);
  });
}

describe('TextPreviewChunked byte offsets', () => {
  beforeEach(() => {
    api.readGroupFileContent.mockReset();
  });
  afterEach(cleanup);

  it('loads head-first files forward chunk by chunk and stops at total', async () => {
    const total = CHUNK * 3;
    api.readGroupFileContent.mockImplementation(
      async (_p: string, _path: string, r: { offset: number }) => ({
        content: 'x'.repeat(CHUNK),
        total,
        offset: r.offset,
        length: CHUNK,
      }),
    );
    const { container } = renderChunked('data.json', total);
    await waitFor(() => expect(offsets()).toEqual([0]));
    await waitFor(() =>
      expect(container.querySelectorAll('pre')).toHaveLength(1),
    );
    await scrollToBottom(container, 2);
    await waitFor(() =>
      expect(container.querySelectorAll('pre')).toHaveLength(2),
    );
    await scrollToBottom(container, 3);
    await waitFor(() =>
      expect(container.querySelectorAll('pre')).toHaveLength(3),
    );
    expect(offsets()).toEqual([0, CHUNK, CHUNK * 2]);

    const el = container.querySelector<HTMLElement>(
      '[data-ui="text-preview-chunked-scroll"]',
    )!;
    await act(async () => {
      fireEvent.scroll(el);
    });
    expect(api.readGroupFileContent).toHaveBeenCalledTimes(3);
  });

  it('advances by the byte length, not the UTF-16 length of the content', async () => {
    const total = CHUNK * 2;
    api.readGroupFileContent.mockImplementation(
      async (_p: string, _path: string, r: { offset: number }) => ({
        // 2 bytes per char: content.length is half of length.
        content: 'ă'.repeat(CHUNK / 2),
        total,
        offset: r.offset,
        length: CHUNK,
      }),
    );
    const { container } = renderChunked('notes.txt', total);
    await waitFor(() => expect(offsets()).toEqual([0]));
    await waitFor(() =>
      expect(container.querySelectorAll('pre')).toHaveLength(1),
    );
    await scrollToBottom(container, 2);
    expect(offsets()).toEqual([0, CHUNK]);
  });

  it('starts .log files at the last 20 KiB and continues by byte offset', async () => {
    const total = CHUNK * 2 + 100;
    api.readGroupFileContent.mockImplementation(
      async (_p: string, _path: string, r: { offset: number }) => ({
        content: 'ă'.repeat(50),
        total,
        offset: r.offset,
        length: Math.min(CHUNK, total - r.offset),
      }),
    );
    const { container } = renderChunked('app.log', total);
    await waitFor(() => expect(offsets()).toEqual([total - CHUNK]));
    await waitFor(() =>
      expect(container.querySelectorAll('pre')).toHaveLength(1),
    );
    // Loaded end is already total, so scrolling must not fetch again.
    const el = container.querySelector<HTMLElement>(
      '[data-ui="text-preview-chunked-scroll"]',
    )!;
    await act(async () => {
      fireEvent.scroll(el);
    });
    expect(api.readGroupFileContent).toHaveBeenCalledTimes(1);
  });
});
