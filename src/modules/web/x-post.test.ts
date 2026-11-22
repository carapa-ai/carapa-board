import { describe, expect, test } from 'bun:test';
import { parseXStatusId, retrieveXPost } from './x-post.js';

const articleTweet = {
  url: 'https://x.com/alice/status/111',
  text: 'Read my article',
  created_at: 'Mon Oct 19 2026',
  author: { name: 'Alice', screen_name: 'alice' },
  media: { photos: [{ url: 'https://pbs.example/photo.jpg' }] },
  article: {
    id: '9',
    title: 'Deep Dive',
    preview_text: 'preview',
    cover_media: {
      media_info: { original_img_url: 'https://pbs.example/c.jpg' },
    },
    media_entities: [
      {
        media_id: '55',
        media_info: {
          __typename: 'ApiImage',
          original_img_url: 'https://pbs.example/inline.jpg',
        },
      },
    ],
    content: {
      blocks: [
        {
          key: 'a',
          type: 'header-one',
          text: 'Intro',
          inlineStyleRanges: [],
          entityRanges: [],
        },
        {
          key: 'b',
          type: 'unstyled',
          text: 'Some bold text',
          inlineStyleRanges: [{ offset: 5, length: 4, style: 'Bold' }],
          entityRanges: [],
        },
        {
          key: 'c',
          type: 'unordered-list-item',
          text: 'first item',
          inlineStyleRanges: [],
          entityRanges: [],
        },
        {
          key: 'd',
          type: 'atomic',
          text: ' ',
          inlineStyleRanges: [],
          entityRanges: [{ offset: 0, length: 1, key: 0 }],
        },
        {
          key: 'e',
          type: 'atomic',
          text: ' ',
          inlineStyleRanges: [],
          entityRanges: [{ offset: 0, length: 1, key: 1 }],
        },
      ],
      entityMap: [
        {
          key: '0',
          value: { type: 'MEDIA', data: { mediaItems: [{ mediaId: '55' }] } },
        },
        {
          key: '1',
          value: {
            type: 'MARKDOWN',
            data: { markdown: '```python\nprint(1)\n```' },
          },
        },
      ],
    },
  },
};

function jsonFetch(body: unknown, status = 200) {
  const calls: string[] = [];
  const fetchFn = async (input: Parameters<typeof fetch>[0]) => {
    calls.push(String(input));
    return new Response(JSON.stringify(body), { status });
  };
  return { fetchFn, calls };
}

describe('retrieveXPost', () => {
  test('renders an article as Markdown with code and images', async () => {
    const { fetchFn, calls } = jsonFetch({ code: 200, tweet: articleTweet });
    const md = await retrieveXPost(
      'https://x.com/alice/status/111?s=20',
      fetchFn,
    );

    expect(calls).toEqual(['https://api.fxtwitter.com/status/111']);
    expect(md).toStartWith('> **Source**: https://x.com/alice/status/111?s=20');
    expect(md).toContain('**Alice** (@alice)');
    expect(md).toContain('# Deep Dive');
    expect(md).toContain('## Intro');
    expect(md).toContain('Some **bold** text');
    expect(md).toContain('- first item');
    expect(md).toContain('![](https://pbs.example/inline.jpg)');
    expect(md).toContain('```python\nprint(1)\n```');
    expect(md).not.toContain('entityRanges');
    expect(md).not.toContain('inlineStyleRanges');
  });

  test('renders a plain tweet with header, text and photos', async () => {
    const { fetchFn } = jsonFetch({
      code: 200,
      tweet: { ...articleTweet, article: undefined },
    });
    const md = await retrieveXPost(
      'https://twitter.com/alice/status/111',
      fetchFn,
    );
    expect(md).toContain('Read my article');
    expect(md).toContain('![](https://pbs.example/photo.jpg)');
    expect(md).not.toContain('Deep Dive');
  });

  test('returns null on non-200, shape mismatch or non-status URLs', async () => {
    expect(
      await retrieveXPost(
        'https://x.com/a/status/1',
        jsonFetch({}, 404).fetchFn,
      ),
    ).toBeNull();
    expect(
      await retrieveXPost(
        'https://x.com/a/status/1',
        jsonFetch({ tweet: 'x' }).fetchFn,
      ),
    ).toBeNull();
    const { fetchFn, calls } = jsonFetch({});
    expect(
      await retrieveXPost('https://x.com/i/article/123', fetchFn),
    ).toBeNull();
    expect(calls).toEqual([]);
    expect(parseXStatusId('https://mobile.twitter.com/status/42/photo/1')).toBe(
      '42',
    );
  });
});
