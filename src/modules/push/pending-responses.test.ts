import { describe, test, expect } from 'bun:test';

import {
  awaitFormResponse,
  deliverFormResponse,
  pendingCount,
} from './pending-responses.js';

describe('pending-responses', () => {
  test('awaitFormResponse resolves with expired after timeout', async () => {
    const id = 'pending-test-2';
    const result = await awaitFormResponse(id, 50);
    expect(result).toEqual({ status: 'expired' });
    expect(pendingCount()).toBe(0);
  });

  test('double-deliver only fires once', async () => {
    const id = 'pending-test-4';
    const promise = awaitFormResponse(id, 5_000);
    expect(deliverFormResponse(id, { v: 1 })).toBe(true);
    expect(deliverFormResponse(id, { v: 2 })).toBe(false);
    const result = await promise;
    expect(result).toEqual({ status: 'submitted', values: { v: 1 } });
  });

  test('duplicate await replaces prior listener with cancelled', async () => {
    const id = 'pending-test-5';
    const first = awaitFormResponse(id, 5_000);
    const second = awaitFormResponse(id, 5_000);
    deliverFormResponse(id, { ok: true });
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1).toEqual({ status: 'cancelled' });
    expect(r2).toEqual({ status: 'submitted', values: { ok: true } });
  });
});
