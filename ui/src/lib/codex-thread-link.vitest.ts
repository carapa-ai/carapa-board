import { describe, expect, test } from 'vitest';
import { codexThreadIdFromDeepLink } from './codex-thread-link';

describe('Codex thread deep links', () => {
  test('recognizes only an exact thread deep link', () => {
    const id = '01a05dc5-1614-7d73-9052-92069de3177f';
    expect(codexThreadIdFromDeepLink(`  codex://threads/${id}\n`)).toBe(id);
    expect(codexThreadIdFromDeepLink(`codex://threads/${id}/`)).toBe(id);
    expect(codexThreadIdFromDeepLink(`continue ${id}`)).toBeNull();
    expect(
      codexThreadIdFromDeepLink(`codex://threads/${id}?open=1`),
    ).toBeNull();
  });
});
