import { describe, expect, it } from 'vitest';
import { appLinkPath, reportFromAppLink } from './app-links';

const ORIGIN = 'http://localhost';

describe('appLinkPath', () => {
  it('keeps an in-app route with its query string', () => {
    expect(appLinkPath('/objective/carapa/obj-1?report=x.md', ORIGIN)).toBe(
      '/objective/carapa/obj-1?report=x.md',
    );
  });

  it('reduces an absolute same-origin URL to its path', () => {
    expect(
      appLinkPath(
        'http://localhost/objective/carapa/obj-1?report=x.md',
        ORIGIN,
      ),
    ).toBe('/objective/carapa/obj-1?report=x.md');
  });

  it('ignores server-handled paths', () => {
    expect(appLinkPath('/api/x', ORIGIN)).toBeNull();
    expect(appLinkPath('/artifacts/x', ORIGIN)).toBeNull();
    expect(appLinkPath('/uploads/group/file.png', ORIGIN)).toBeNull();
    expect(appLinkPath('/mcp/carapa-board', ORIGIN)).toBeNull();
    expect(appLinkPath('/oauth/consent', ORIGIN)).toBeNull();
    expect(appLinkPath('/assets/index.js', ORIGIN)).toBeNull();
    expect(appLinkPath('/share/token', ORIGIN)).toBeNull();
  });

  it('ignores other origins and non-http schemes', () => {
    expect(appLinkPath('//evil.com/x', ORIGIN)).toBeNull();
    expect(appLinkPath('https://other.example/objective/x', ORIGIN)).toBeNull();
    expect(appLinkPath('mailto:someone@example.com', ORIGIN)).toBeNull();
  });

  it('ignores paths that are not app routes', () => {
    expect(appLinkPath('/unknown/route', ORIGIN)).toBeNull();
    expect(appLinkPath('objective/carapa/obj-1', ORIGIN)).toBeNull();
  });

  it('treats the app root as an app route', () => {
    expect(appLinkPath('/', ORIGIN)).toBe('/');
    expect(appLinkPath('http://localhost/', ORIGIN)).toBe('/');
  });
});

describe('reportFromAppLink', () => {
  const OBJECTIVE = '/objective/carapa/obj-1';

  it('returns the report of a link to the given route', () => {
    expect(reportFromAppLink(`${OBJECTIVE}?report=x.md`, OBJECTIVE)).toBe(
      'x.md',
    );
  });

  it('ignores links to other routes and links without a report', () => {
    expect(
      reportFromAppLink('/objective/carapa/obj-2?report=x.md', OBJECTIVE),
    ).toBeUndefined();
    expect(reportFromAppLink(OBJECTIVE, OBJECTIVE)).toBeUndefined();
    expect(
      reportFromAppLink(`${OBJECTIVE}?other=1`, OBJECTIVE),
    ).toBeUndefined();
  });
});
