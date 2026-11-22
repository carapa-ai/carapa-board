import { describe, expect, it } from 'vitest';
import { aiUserImageKey, cacheBrowserImage, lastBrowserImageByIdentity } from './browser-image-cache';

describe('persona browser image fallback identity', () => {
  it('keeps an avatar and each emote distinct across URL versions', () => {
    expect(
      aiUserImageKey(
        'https://board.test/api/ai-users/persona/avatar?thumbnail=1&v=1',
      ),
    ).toBe('persona:avatar');
    expect(
      aiUserImageKey(
        'https://board.test/api/ai-users/persona/emotes/happy?thumbnail=1&v=1',
      ),
    ).toBe('persona:emote:happy');
    expect(
      aiUserImageKey(
        'https://board.test/api/ai-users/persona/emotes/sad?thumbnail=1',
      ),
    ).toBe('persona:emote:sad');
  });

  it('orders timestamp and base36 versions regardless of completion order', () => {
    cacheBrowserImage('persona:avatar', 'https://board.test/api/ai-users/persona/avatar?thumbnail=1&v=2025-01-02T00:00:00.000Z');
    cacheBrowserImage('persona:avatar', 'https://board.test/api/ai-users/persona/avatar?thumbnail=1&v=2024-01-01T00:00:00.000Z');
    expect(lastBrowserImageByIdentity.get('persona:avatar')).toContain('2025-01-02');
    cacheBrowserImage('persona:emote:happy', 'https://board.test/api/ai-users/persona/emotes/happy?thumbnail=1&v=zz');
    cacheBrowserImage('persona:emote:happy', 'https://board.test/api/ai-users/persona/emotes/happy?thumbnail=1&v=10');
    expect(lastBrowserImageByIdentity.get('persona:emote:happy')).toContain('v=zz');
  });
});
