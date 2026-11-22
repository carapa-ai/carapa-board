import { describe, expect, test } from 'bun:test';
import {
  assertPublicHttpUrl,
  BlockedUrlError,
  createGuardedFetch,
  type Resolver,
} from './url-guard.js';

const publicResolver: Resolver = async () => ['93.184.216.34'];

describe('assertPublicHttpUrl', () => {
  test.each([
    'http://0.0.0.0/',
    'http://10.1.2.3/',
    'http://100.64.0.1/',
    'http://127.0.0.1/',
    'http://169.254.169.254/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.0.0.8/',
    'http://192.168.1.1/',
    'http://198.19.0.1/',
    'http://224.0.0.1/',
    'http://240.0.0.1/',
    'http://255.255.255.255/',
    'http://2130706433/',
    'http://[::]/',
    'http://[::1]/',
    'http://[fc00::1]/',
    'http://[fd12::1]/',
    'http://[fe80::1]/',
    'http://[ff02::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:a00:5]/',
    'http://[::127.0.0.1]/',
    'http://[64:ff9b::a00:1]/',
    'http://[64:ff9b::7f00:1]/',
    'http://[64:ff9b:1::a00:1]/',
    'http://[2002:a00:1::]/',
    'http://[2002:7f00:1::1]/',
    'http://[::ffff:0:7f00:1]/',
    'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/',
  ])('blocks address literal %s', async (url) => {
    await expect(assertPublicHttpUrl(url, publicResolver)).rejects.toThrow(
      BlockedUrlError,
    );
  });

  test.each([
    'file:///app/.env',
    'ftp://example.test/x',
    'data:text/html,<h1>x</h1>',
    'http://user:pw@example.test/',
    'http://localhost:3100/',
    'http://app.localhost/',
    'not a url',
  ])('blocks %s before resolving', async (url) => {
    let lookups = 0;
    await expect(
      assertPublicHttpUrl(url, async () => {
        lookups += 1;
        return ['93.184.216.34'];
      }),
    ).rejects.toThrow('web_view refused URL');
    expect(lookups).toBe(0);
  });

  test('allows public literals and hostnames', async () => {
    await expect(
      assertPublicHttpUrl('https://93.184.216.34/', publicResolver),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertPublicHttpUrl('http://[2606:2800:220:1::1]/', publicResolver),
    ).resolves.toBeInstanceOf(URL);
    for (const embedded of ['64:ff9b::808:808', '2002:808:808::']) {
      await expect(
        assertPublicHttpUrl(`http://[${embedded}]/`, publicResolver),
      ).resolves.toBeInstanceOf(URL);
    }
    await expect(
      assertPublicHttpUrl('https://example.test/a?b=1', publicResolver),
    ).resolves.toBeInstanceOf(URL);
  });

  test('fails closed on private, mixed, empty or failing resolution', async () => {
    for (const resolve of [
      async () => ['172.18.0.3'],
      async () => ['93.184.216.34', '10.0.0.5'],
      async () => [],
      async () => {
        throw new Error('ENOTFOUND');
      },
    ] as Resolver[]) {
      await expect(
        assertPublicHttpUrl('http://postgres/', resolve),
      ).rejects.toThrow(BlockedUrlError);
    }
  });
});

describe('createGuardedFetch', () => {
  const redirect = (location: string, status = 302) =>
    new Response(null, { status, headers: { location } });

  test('follows public redirects manually and reports the last URL', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const guarded = createGuardedFetch(async (input, init) => {
      calls.push([String(input), init]);
      return String(input) === 'https://a.test/'
        ? redirect('/next')
        : new Response('ok');
    }, publicResolver);

    const res = await guarded('https://a.test/');
    expect(await res.text()).toBe('ok');
    expect(res.url).toBe('https://a.test/next');
    expect(calls.map(([url]) => url)).toEqual([
      'https://a.test/',
      'https://a.test/next',
    ]);
    expect(calls.every(([, init]) => init?.redirect === 'manual')).toBe(true);
  });

  test('stops at the first blocked hop and never fetches it', async () => {
    const calls: string[] = [];
    const guarded = createGuardedFetch(async (input) => {
      calls.push(String(input));
      return redirect('http://127.0.0.1/');
    }, publicResolver);
    await expect(guarded('https://a.test/')).rejects.toThrow(BlockedUrlError);
    expect(calls).toEqual(['https://a.test/']);
  });

  test('errors after more than five redirects', async () => {
    let calls = 0;
    const guarded = createGuardedFetch(async () => {
      calls += 1;
      return redirect(`https://a.test/${calls}`);
    }, publicResolver);
    await expect(guarded('https://a.test/')).rejects.toThrow('5 redirects');
    expect(calls).toBe(6);
  });

  test('returns the 3xx unchanged when the caller follows manually', async () => {
    const calls: string[] = [];
    const guarded = createGuardedFetch(async (input) => {
      calls.push(String(input));
      return redirect('http://127.0.0.1/');
    }, publicResolver);

    const res = await guarded('https://a.test/', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(calls).toEqual(['https://a.test/']);
    await expect(
      guarded('http://127.0.0.1/', { redirect: 'manual' }),
    ).rejects.toThrow(BlockedUrlError);
    expect(calls).toHaveLength(1);
  });
});
