// Bun supplies these test globals at runtime; the UI package intentionally
// does not depend on Bun's type declarations.
// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { hasCompleteBacktickFence, stripToolActivityMarkers } from './markdown';

describe('hasCompleteBacktickFence', () => {
  test('recognizes complete plain and language-tagged fences', () => {
    expect(
      hasCompleteBacktickFence('before\n```\nconst x = 1;\n```\nafter'),
    ).toBe(true);
    expect(hasCompleteBacktickFence('```typescript\nconst x = 1;\n```')).toBe(
      true,
    );
  });

  test('allows a closing fence at least as long as its opener', () => {
    expect(hasCompleteBacktickFence('````js\nconst x = 1;\n`````')).toBe(true);
    expect(hasCompleteBacktickFence('````js\nconst x = 1;\n```')).toBe(false);
  });

  test('leaves inline and unfinished backticks as plain text', () => {
    expect(hasCompleteBacktickFence('Use ``` as an example.')).toBe(false);
    expect(hasCompleteBacktickFence('```js\nconst x = 1;')).toBe(false);
    expect(hasCompleteBacktickFence('ordinary message')).toBe(false);
  });
});

describe('stripToolActivityMarkers', () => {
  test('removes only reserved provenance marker lines', () => {
    const markdown = [
      '<!-- carapa-tool:request -->',
      '> **webFetch**',
      '<!-- authored note -->',
      '<!-- carapa-tool:result -->',
      '> 7 files',
    ].join('\n');

    expect(stripToolActivityMarkers(markdown)).toBe(
      ['> **webFetch**', '<!-- authored note -->', '> 7 files'].join('\n'),
    );
  });
});
