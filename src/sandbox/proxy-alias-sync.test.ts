import { describe, expect, test } from 'bun:test';
import {
  proxyHostnameAliasesChanged,
  shouldSyncProxyHostnameAliases,
  syncProxyHostnameAliases,
} from './proxy-alias-sync.js';

describe('proxy hostname alias change detection', () => {
  test('detects aliases being added, removed, or replaced', () => {
    expect(proxyHostnameAliasesChanged([], ['app.example.com'])).toBe(true);
    expect(proxyHostnameAliasesChanged(['app.example.com'], [])).toBe(true);
    expect(
      proxyHostnameAliasesChanged(['app.example.com'], ['demo.example.com']),
    ).toBe(true);
  });

  test('does not reconcile for an unchanged semantic alias set', () => {
    expect(
      proxyHostnameAliasesChanged(
        ['APP.example.com.', 'demo.example.com'],
        [' demo.example.com ', 'app.example.com'],
      ),
    ).toBe(false);
  });

  test('does not sync an ordinary settings save', () => {
    expect(
      shouldSyncProxyHostnameAliases(
        { status: 'running' },
        ['app.example.com'],
        ['demo.example.com'],
      ),
    ).toBe(false);
  });

  test('syncs only when the alias field contains a semantic change', () => {
    expect(
      shouldSyncProxyHostnameAliases(
        { proxyHostnameAliases: ['demo.example.com'] },
        ['app.example.com'],
        ['demo.example.com'],
      ),
    ).toBe(true);
    expect(
      shouldSyncProxyHostnameAliases(
        { proxyHostnameAliases: ['APP.example.com.'] },
        ['app.example.com'],
        ['APP.example.com.'],
      ),
    ).toBe(false);
  });

  test('sends the effective stack target and aliases to CarapaBox', async () => {
    const calls: unknown[][] = [];
    const client = {
      async sandboxProxyAliases(...args: unknown[]) {
        calls.push(args);
        return { stdout: 'updated', isError: false };
      },
    };
    await syncProxyHostnameAliases(
      {
        name: 'DemoSite',
        folder: 'demo-site',
        trigger: '@demo-site',
        added_at: '2026-07-31T00:00:00.000Z',
        settings: {
          defaultSandbox: 'demo-site',
          proxyHostnameAliases: [
            'demo-site.alias.example.test',
            'demo-site.example.test',
          ],
        },
      },
      client,
      true,
    );

    expect(calls).toEqual([
      [
        'demo-site',
        ['demo-site.alias.example.test', 'demo-site.example.test'],
        'demo-site',
      ],
    ]);
  });
});
