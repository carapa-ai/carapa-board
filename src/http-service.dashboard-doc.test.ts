import { describe, test, expect } from 'bun:test';
import { isDashboardDocRequest } from './http-service.js';

describe('isDashboardDocRequest', () => {
  test('exempts only GET on a real dashboard document path', () => {
    expect(
      isDashboardDocRequest({
        method: 'GET',
        path: '/api/projects/p/objectives/o/dashboard/index.html',
      }),
    ).toBe(true);
    // As seen inside app.use('/api', …): the mount prefix is in baseUrl.
    expect(
      isDashboardDocRequest({
        method: 'GET',
        baseUrl: '/api',
        path: '/projects/p/objectives/o/dashboard/index.html',
      }),
    ).toBe(true);
  });

  test('does not exempt query-string smuggling, other methods or other prefixes', () => {
    expect(
      isDashboardDocRequest({
        method: 'GET',
        baseUrl: '/api',
        path: '/tasks',
      }),
    ).toBe(false);
    expect(
      isDashboardDocRequest({
        method: 'POST',
        path: '/api/projects/p/objectives/o/dashboard/index.html',
      }),
    ).toBe(false);
    expect(
      isDashboardDocRequest({
        method: 'GET',
        path: '/api/x/objectives/a/dashboard/',
      }),
    ).toBe(false);
  });
});
