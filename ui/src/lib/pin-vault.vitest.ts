import { describe, expect, it } from 'vitest';
import { validateWebVaultPin } from './pin-vault';

describe('validateWebVaultPin', () => {
  it.each(['1234', '12345678', 'abcdefgh', 'abc1234', 'a1'.repeat(33)])(
    'rejects %s',
    (pin) => {
      expect(validateWebVaultPin(pin)).toEqual(expect.any(String));
    },
  );

  it('accepts a mixed 8+ character PIN', () => {
    expect(validateWebVaultPin('abc12345')).toBeNull();
  });
});
