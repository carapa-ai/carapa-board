import { afterAll, describe, expect, test } from 'bun:test';
import type { ChatAgentRunResult } from '../../agent-runner.js';
import { retrieveWithBrowserAgent } from './browser-agent.js';
import {
  convertPdfToMarkdown,
  getCachedWebView,
  isPdfResponse,
  webView,
  type WebViewDependencies,
} from './proxy.js';

const publicResolver = async () => ['93.184.216.34'];

/** webView with a stub resolver so no test performs real DNS. */
function viewPublic(
  url: string,
  dependencies: Partial<WebViewDependencies> = {},
  context?: Parameters<typeof webView>[2],
) {
  return webView(
    url,
    { resolveHost: publicResolver, ...dependencies },
    context,
  );
}

const originalFetch = globalThis.fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function pdfFixture(pageText = 'Hello PDF'): Uint8Array {
  const pageCommands = pageText
    ? `BT /F1 24 Tf 72 720 Td (${pageText}) Tj ET`
    : '';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${pageCommands.length} >>\nstream\n${pageCommands}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

function playerPage(player: object): string {
  return `<html><script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script></html>`;
}

describe('web_view PDF handling', () => {
  test('detects PDFs by content type or file signature', () => {
    expect(
      isPdfResponse('application/pdf; charset=binary', new Uint8Array()),
    ).toBe(true);
    expect(
      isPdfResponse('text/html', new TextEncoder().encode('%PDF-1.7')),
    ).toBe(true);
    expect(isPdfResponse('text/html', new TextEncoder().encode('<html>'))).toBe(
      false,
    );
  });

  test('extracts PDF text and labels it with the source URL', async () => {
    const source = 'https://example.test/report.pdf';
    const markdown = await convertPdfToMarkdown(pdfFixture(), source);
    expect(markdown).toContain(`> **Source**: ${source}`);
    expect(markdown).toContain('Hello PDF');
    expect(markdown).not.toContain('%PDF-1.4');
  });

  test('returns a Markdown extraction error instead of PDF bytes when parsing fails', async () => {
    const source = 'https://example.test/broken.pdf';
    const markdown = await convertPdfToMarkdown(
      new TextEncoder().encode('%PDF-broken\u0000binary'),
      source,
    );
    expect(markdown).toContain(`> **Source**: ${source}`);
    expect(markdown).toContain('[PDF text extraction failed:');
    expect(markdown).not.toContain('%PDF-broken');
    expect(markdown).not.toContain('binary');
  });

  test('rejects and does not cache a valid PDF with no extractable text', async () => {
    const source = 'https://example.test/empty-report.pdf';
    let fetchCalls = 0;
    const dependencies = {
      fetch: async () => {
        fetchCalls += 1;
        return new Response(pdfFixture(''), {
          headers: { 'content-type': 'application/pdf' },
        });
      },
    };

    const converted = await convertPdfToMarkdown(pdfFixture(''), source);
    expect(converted).toBe(
      `> **Source**: ${source}\n\n[No readable text could be extracted from this PDF.]`,
    );
    expect(converted).not.toContain('-- 1 of 1 --');

    await expect(viewPublic(source, dependencies)).rejects.toThrow(
      'Failed to retrieve useful page content',
    );
    await expect(viewPublic(source, dependencies)).rejects.toThrow(
      'Failed to retrieve useful page content',
    );
    expect(fetchCalls).toBe(2);
  });

  test('keeps non-PDF responses on the HTML-to-Markdown path', async () => {
    const source = 'https://example.test/page';
    const html = `<html><body><main><h1>Regular page</h1>${'Readable content '.repeat(40)}</main></body></html>`;
    globalThis.fetch = (async () =>
      new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch;

    const markdown = await viewPublic(source);
    expect(markdown).toContain('> **Source**: https://example.test/page');
    expect(markdown).toContain('# Regular page');
  });
});

describe('web_view YouTube transcript boundary', () => {
  test('resolves a shared link and returns its selected caption data', async () => {
    const videoId = 'ShArEdViD_1';
    const source = `https://www.youtube.com/watch?v=${videoId}`;
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url === 'https://share.google/transcript-fixture') {
        return new Response(null, {
          status: 302,
          headers: {
            location: `https://m.youtube.com/shorts/${videoId}?feature=share`,
          },
        });
      }
      if (url === `https://m.youtube.com/shorts/${videoId}?feature=share`) {
        return new Response('resolved');
      }
      if (url === source) {
        return new Response(
          playerPage({
            playabilityStatus: { status: 'OK' },
            captions: {
              playerCaptionsTracklistRenderer: {
                captionTracks: [
                  {
                    baseUrl: 'https://captions.test/shared',
                    languageCode: 'pt-BR',
                    name: { simpleText: 'Português (Brasil)' },
                  },
                ],
              },
            },
          }),
        );
      }
      if (url === 'https://captions.test/shared?fmt=json3') {
        return Response.json({
          events: [{ tStartMs: 0, segs: [{ utf8: 'Texto falado real.' }] }],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const markdown = await viewPublic(
      'https://share.google/transcript-fixture',
    );

    expect(markdown).toContain(`> **Source**: ${source}`);
    expect(markdown).toContain(
      '> **Caption language**: Português (Brasil) (pt-BR)',
    );
    expect(markdown).toContain('Texto falado real.');
    expect(calls).not.toContain('https://www.youtube.com/');

    const callCount = calls.length;
    expect(await viewPublic('https://share.google/transcript-fixture')).toBe(
      markdown,
    );
    expect(calls).toHaveLength(callCount);
  });

  test('keeps a shared link with a non-YouTube destination on generic extraction', async () => {
    const sharedUrl = 'https://share.google/article-fixture';
    const destination = 'https://example.test/shared-article';
    let destinationCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === sharedUrl) {
        return new Response(null, {
          status: 302,
          headers: { location: destination },
        });
      }
      if (url === destination) {
        destinationCalls += 1;
        if (destinationCalls === 1) return new Response('resolved');
        return new Response(
          `<html><body><main><h1>Shared article</h1>${'Article content. '.repeat(40)}</main></body></html>`,
          { headers: { 'content-type': 'text/html' } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const markdown = await viewPublic(sharedUrl);
    expect(markdown).toContain(`> **Source**: ${destination}`);
    expect(markdown).toContain('# Shared article');
    expect(destinationCalls).toBe(2);
  });

  test('reports missing captions explicitly and does not cache the failure', async () => {
    const videoId = 'NoCaption_1';
    const url = `https://youtu.be/${videoId}`;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(playerPage({ playabilityStatus: { status: 'OK' } }));
    }) as unknown as typeof fetch;

    await expect(viewPublic(url)).rejects.toThrow(
      'captions are disabled or missing',
    );
    await expect(viewPublic(url)).rejects.toThrow(
      'captions are disabled or missing',
    );
    expect(calls).toBe(2);
  });

  test('bounds retries and identifies an upstream rate limit', async () => {
    const url = 'https://youtube.com/watch?v=RateLimit_1';
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('rate limited', { status: 429 });
    }) as unknown as typeof fetch;

    await expect(viewPublic(url)).rejects.toThrow(
      'upstream rate limit (HTTP 429)',
    );
    expect(calls).toBe(2);
  });

  test('cancels share.google resolution through the production web_view boundary', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let calls = 0;
    const extraction = viewPublic(
      'https://share.google/cancelled-resolution',
      {
        fetch: async (_input, init) => {
          calls += 1;
          started();
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(init.signal?.reason),
              { once: true },
            );
          });
        },
      },
      { group_folder: 'web-project', signal: controller.signal },
    );

    await fetchStarted;
    controller.abort(new Error('parent stopped'));

    await expect(extraction).rejects.toThrow('parent stopped');
    expect(calls).toBe(1);
  }, 1_000);

  test('cancels YouTube transcript retrieval through the production web_view boundary', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let calls = 0;
    const extraction = viewPublic(
      'https://www.youtube.com/watch?v=Cancelled_1',
      {
        fetch: async (_input, init) => {
          calls += 1;
          started();
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(init.signal?.reason),
              { once: true },
            );
          });
        },
      },
      { group_folder: 'web-project', signal: controller.signal },
    );

    await fetchStarted;
    controller.abort(new Error('parent stopped'));

    await expect(extraction).rejects.toThrow('parent stopped');
    expect(calls).toBe(1);
  }, 1_000);
});

describe('web_view delegated browser extraction', () => {
  test('preserves the short OpenGraph extraction used by existing mirrors', async () => {
    const url = 'https://x.com/example/status/123';
    const calls: string[] = [];
    const markdown = await viewPublic(url, {
      fetch: async (input) => {
        calls.push(String(input));
        return new Response(
          '<html><head><meta property="og:title" content="Example post"><meta property="og:description" content="A complete short mirrored post."></head><body></body></html>',
          { headers: { 'content-type': 'text/html' } },
        );
      },
    });

    expect(calls.some((c) => c.startsWith('https://fixupx.com/'))).toBe(true);
    expect(markdown).toContain('### Example post');
    expect(markdown).toContain('A complete short mirrored post.');
  });

  test('delegates an uncertain consent surface and caches only useful agent content', async () => {
    const url = 'https://example.test/consent-agent-boundary';
    const consent = `<html><body><main><h1>Your privacy choices</h1><p>We use cookies for optional advertising.</p><button>Reject all</button><button>Accept all</button></main></body></html>`;
    let fetchCalls = 0;
    let agentCalls = 0;
    const dependencies = {
      fetch: async () => {
        fetchCalls += 1;
        return new Response(consent, {
          headers: { 'content-type': 'text/html' },
        });
      },
      retrieveWithBrowserAgent: async (requestedUrl: string) => {
        agentCalls += 1;
        expect(requestedUrl).toBe(url);
        return `> **Source**: ${url}\n\n# Retrieved article\n\n${'The browser agent recovered useful article content. '.repeat(6)}`;
      },
    };

    const first = await viewPublic(url, dependencies, {
      group_folder: 'web-project',
    });
    expect(first).toContain('# Retrieved article');
    expect(first).not.toContain('Your privacy choices');
    expect(
      await viewPublic(url, dependencies, { group_folder: 'web-project' }),
    ).toBe(first);
    expect(fetchCalls).toBe(1);
    expect(agentCalls).toBe(1);
  });

  test('caches only the structurally delimited payload from a narrated browser result', async () => {
    const url = 'https://example.test/browser-result-envelope';
    const sessionId = 'web-view-envelope-session';
    const usefulContent = `# Page Layout Guide\n\nUseful article text.\n\n### Result\n\nThis heading is part of the article.`;
    const workerResult = [
      'I clicked the consent button and then extracted the article.',
      `> **Source**: ${url}`,
      '### Result',
      '[Snapshot](.playwright-cli/page.yml)',
      `<<<CARAPA_WEB_VIEW_SUCCESS ${sessionId}>>>`,
      usefulContent,
      `<<<CARAPA_WEB_VIEW_END ${sessionId}>>>`,
      'Browser work is complete.',
    ].join('\n\n');
    let fetchCalls = 0;
    let agentCalls = 0;
    const dependencies = {
      fetch: async () => {
        fetchCalls += 1;
        return new Response('<html><body><div id="root"></div></body></html>');
      },
      retrieveWithBrowserAgent: async (
        requestedUrl: string,
        context: { group_folder: string },
      ) =>
        retrieveWithBrowserAgent(requestedUrl, context, {
          getGroup: () =>
            ({ folder: context.group_folder, settings: {} }) as any,
          resolveRuntime: (() => ({ id: 'codex:test' })) as any,
          createSessionId: () => sessionId,
          timeoutMs: 2_000,
          createBrowser: async () => ({}),
          closeBrowser: async () => {},
          execInSandbox: async () => ({ stdout: '', isError: false }),
          runAgent: async (options) => {
            agentCalls += 1;
            await options.onCheckoutReady({} as any, {
              stack: 'test',
              service: 'agent',
              instance: 'test',
            });
            return {
              result: workerResult,
              failed: false,
              telemetry: undefined,
              isLlm: false,
            } satisfies ChatAgentRunResult;
          },
        }),
    };

    const expected = `> **Source**: ${url}\n\n${usefulContent}`;
    const first = await viewPublic(url, dependencies, {
      group_folder: 'web-project',
    });
    const second = await viewPublic(url, dependencies, {
      group_folder: 'web-project',
    });

    expect(first).toBe(expected);
    expect(second).toBe(expected);
    expect(first).not.toContain('I clicked');
    expect(first).not.toContain('.playwright-cli');
    expect(fetchCalls).toBe(1);
    expect(agentCalls).toBe(1);
  });

  test('does not cache an unsuccessful browser-agent attempt', async () => {
    const url = 'https://example.test/uncached-browser-failure';
    let agentCalls = 0;
    const dependencies = {
      fetch: async () =>
        new Response('<html><body><div id="root"></div></body></html>'),
      retrieveWithBrowserAgent: async () => {
        agentCalls += 1;
        throw new Error(
          'Browser agent could not retrieve useful page content: login required',
        );
      },
    };

    await expect(
      viewPublic(url, dependencies, { group_folder: 'web-project' }),
    ).rejects.toThrow('login required');
    await expect(
      viewPublic(url, dependencies, { group_folder: 'web-project' }),
    ).rejects.toThrow('login required');
    expect(agentCalls).toBe(2);
  });

  test('hands a consequence-first paywall to the browser agent', async () => {
    const url = 'https://example.test/consequence-first-paywall';
    let delegated = false;
    await expect(
      viewPublic(
        url,
        {
          fetch: async () =>
            new Response(
              '<html><body><main><p>To continue reading, subscribe now.</p></main></body></html>',
            ),
          retrieveWithBrowserAgent: async () => {
            delegated = true;
            throw new Error(
              'Browser agent could not retrieve useful page content: subscription required',
            );
          },
        },
        { group_folder: 'web-project' },
      ),
    ).rejects.toThrow('subscription required');
    expect(delegated).toBe(true);
  });

  test('hands a dismissible premium promotion to the agent instead of treating it as an access wall', async () => {
    const url = 'https://example.test/dismissible-promotion';
    let delegated = false;
    const article = `${'Independent public article content. '.repeat(12)}`;
    const markdown = await viewPublic(
      url,
      {
        fetch: async () =>
          new Response(
            `<html><body><main><article><h1>Public article</h1><p>${article}</p></article><dialog open><p>Explore premium membership benefits.</p><button>Close</button></dialog></main></body></html>`,
          ),
        retrieveWithBrowserAgent: async () => {
          delegated = true;
          return `> **Source**: ${url}\n\n# Public article\n\n${article}`;
        },
      },
      { group_folder: 'web-project' },
    );

    expect(delegated).toBe(true);
    expect(markdown).toContain('# Public article');
    expect(markdown).not.toContain('premium membership');
  });

  test('fails fast on a 404 without starting the browser agent', async () => {
    const url = 'https://example.test/missing-page';
    let agentCalls = 0;
    await expect(
      viewPublic(
        url,
        {
          fetch: async () => new Response('Not found', { status: 404 }),
          retrieveWithBrowserAgent: async () => {
            agentCalls += 1;
            return '';
          },
        },
        { group_folder: 'web-project' },
      ),
    ).rejects.toThrow('HTTP 404 Not Found');
    expect(agentCalls).toBe(0);
  });

  test('still delegates a 403 to the browser agent', async () => {
    const url = 'https://example.test/forbidden-page';
    let agentCalls = 0;
    await expect(
      viewPublic(
        url,
        {
          fetch: async () => new Response('Forbidden', { status: 403 }),
          retrieveWithBrowserAgent: async () => {
            agentCalls += 1;
            throw new Error('Browser agent could not retrieve: blocked');
          },
        },
        { group_folder: 'web-project' },
      ),
    ).rejects.toThrow('blocked');
    expect(agentCalls).toBe(1);
  });

  test('lets the original URL, not a failed mirror, decide on a 404', async () => {
    const url = 'https://x.com/example/status/404-mirror';
    let agentCalls = 0;
    const markdown = await viewPublic(
      url,
      {
        fetch: async (input) =>
          String(input).startsWith('https://fixupx.com/')
            ? new Response('Not found', { status: 404 })
            : new Response('<html><body><div id="root"></div></body></html>'),
        retrieveWithBrowserAgent: async () => {
          agentCalls += 1;
          return `> **Source**: ${url}\n\n# Post\n\n${'Recovered post content. '.repeat(6)}`;
        },
      },
      { group_folder: 'web-project' },
    );
    expect(markdown).toContain('# Post');
    expect(agentCalls).toBe(1);
  });
});

describe('web_view X post routing', () => {
  test('fetches the API URL, and falls back to the mirror when it returns 404', async () => {
    const url = 'https://x.com/someone/status/987654321';
    const calls: string[] = [];
    const markdown = await viewPublic(url, {
      fetch: async (input) => {
        const target = String(input);
        calls.push(target);
        if (target.startsWith('https://api.fxtwitter.com/')) {
          return new Response('{"code":404}', { status: 404 });
        }
        return new Response(
          '<html><head><meta property="og:title" content="Mirror post"><meta property="og:description" content="Mirror fallback text."></head><body></body></html>',
          { headers: { 'content-type': 'text/html' } },
        );
      },
    });

    expect(calls[0]).toBe('https://api.fxtwitter.com/status/987654321');
    expect(calls[1]?.startsWith('https://fixupx.com/')).toBe(true);
    expect(markdown).toContain('Mirror fallback text.');
  });
});

describe('web_view outbound URL guard', () => {
  const guarded = async (
    url: string,
    fetchImpl: WebViewDependencies['fetch'],
    resolveHost: WebViewDependencies['resolveHost'] = publicResolver,
  ) => {
    let agentCalls = 0;
    const result = webView(
      url,
      {
        fetch: fetchImpl,
        resolveHost,
        retrieveWithBrowserAgent: async () => {
          agentCalls += 1;
          return '';
        },
      },
      { group_folder: 'web-project' },
    );
    return { result, agentCalls: () => agentCalls };
  };

  test('refuses internal targets without fetching, caching or using the browser agent', async () => {
    const urls = [
      'file:///app/.env',
      'http://127.0.0.1:3000/',
      'http://[::ffff:127.0.0.1]/',
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost:3100/',
      'http://user:pw@example.test/',
      'http://postgres.test/',
    ];
    for (const url of urls) {
      let fetchCalls = 0;
      const { result, agentCalls } = await guarded(
        url,
        async () => {
          fetchCalls += 1;
          return new Response('secret');
        },
        async (host) => (host === 'postgres.test' ? ['172.18.0.3'] : []),
      );
      await expect(result).rejects.toThrow('web_view refused URL');
      expect(fetchCalls).toBe(0);
      expect(agentCalls()).toBe(0);
      expect(getCachedWebView(url)).toBeNull();
    }
  });

  test('refuses a redirect to a private target at that hop', async () => {
    for (const target of ['http://127.0.0.1/', 'file:///etc/passwd']) {
      const url = `https://example.test/redirects-to-${encodeURIComponent(target)}`;
      const fetched: string[] = [];
      const { result, agentCalls } = await guarded(url, async (input) => {
        fetched.push(String(input));
        return new Response(null, {
          status: 302,
          headers: { location: target },
        });
      });
      await expect(result).rejects.toThrow('web_view refused URL');
      expect(fetched).toEqual([url]);
      expect(agentCalls()).toBe(0);
      expect(getCachedWebView(url)).toBeNull();
    }
  });

  test('refuses a share.google link that redirects to a private host', async () => {
    const url = 'https://share.google/private-redirect';
    const fetched: string[] = [];
    const { result, agentCalls } = await guarded(url, async (input) => {
      fetched.push(String(input));
      return new Response(null, {
        status: 302,
        headers: { location: 'http://10.0.0.5/admin' },
      });
    });
    await expect(result).rejects.toThrow('web_view refused URL');
    expect(fetched).toEqual([url]);
    expect(agentCalls()).toBe(0);
  });

  test('still follows a public redirect to markdown', async () => {
    const url = 'https://example.test/old-location';
    const markdown = await viewPublic(url, {
      fetch: async (input) =>
        String(input) === url
          ? new Response(null, {
              status: 301,
              headers: { location: 'https://example.test/new-location' },
            })
          : new Response(
              `<html><body><main><h1>Moved page</h1>${'Readable content '.repeat(40)}</main></body></html>`,
              { headers: { 'content-type': 'text/html' } },
            ),
    });
    expect(markdown).toContain('# Moved page');
  });
});
