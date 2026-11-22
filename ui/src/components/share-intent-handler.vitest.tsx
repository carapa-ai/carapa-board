import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addListener } = vi.hoisted(() => ({ addListener: vi.fn() }));

vi.mock('@capgo/capacitor-share-target', () => ({
  CapacitorShareTarget: { addListener },
}));

import { useStore } from '@/store';
import { ShareIntentHandler } from './share-intent-handler';

describe('ShareIntentHandler', () => {
  let handler: (data: { title?: string; texts?: string[] }) => void;

  beforeEach(() => {
    useStore.getState().setSharedContent(null);
    addListener.mockReset();
    addListener.mockImplementation(
      async (_event: string, cb: typeof handler) => {
        handler = cb;
        return { remove: vi.fn() };
      },
    );
  });

  it('ignores duplicate delivery while pending but accepts the same share after it is cleared', async () => {
    const setSpy = vi.spyOn(useStore.getState(), 'setSharedContent');
    render(<ShareIntentHandler />);
    await waitFor(() => expect(addListener).toHaveBeenCalled());
    await waitFor(() => expect(handler).toBeTypeOf('function'));

    handler({ title: 'T', texts: ['https://x'] });
    handler({ title: 'T', texts: ['https://x'] });
    expect(useStore.getState().sharedContent).toEqual({
      title: 'T',
      text: 'https://x',
    });
    expect(setSpy).toHaveBeenCalledTimes(1);

    useStore.getState().setSharedContent(null);
    setSpy.mockClear();
    handler({ title: 'T', texts: ['https://x'] });
    expect(useStore.getState().sharedContent).toEqual({
      title: 'T',
      text: 'https://x',
    });
    expect(setSpy).toHaveBeenCalledTimes(1);
  });
});
