import { describe, expect, test } from 'bun:test';
import {
  BUILD_FAILURE_LINE_CHARS,
  BUILD_FAILURE_LINE_LIMIT,
  BUILD_FAILURE_TOTAL_CHARS,
  extractBuildFailureLines,
  getServerWebBuildStatus,
  markServerWebBuildBuilding,
  markServerWebBuildFailed,
  markServerWebBuildReady,
} from './server-web-build-status.js';

describe('server-web build status output', () => {
  test('failed stores the output tail; building and ready clear it', () => {
    const big = 'x'.repeat(30_000) + 'FAIL: tail';
    const failed = markServerWebBuildFailed('boom', big);
    expect(failed.status).toBe('failed');
    expect(failed.output).toHaveLength(20_000);
    expect(failed.output!.endsWith('FAIL: tail')).toBe(true);
    expect(getServerWebBuildStatus().output).toBe(failed.output);

    expect(markServerWebBuildBuilding()).not.toHaveProperty('output');
    markServerWebBuildFailed('boom', 'again');
    const ready = markServerWebBuildReady();
    expect(ready).not.toHaveProperty('output');
    expect(ready).not.toHaveProperty('error');
  });

  test('failed without output omits the field', () => {
    expect(markServerWebBuildFailed('no output')).not.toHaveProperty('output');
    expect(markServerWebBuildFailed('empty', '')).not.toHaveProperty('output');
  });
});

describe('extractBuildFailureLines', () => {
  test('keeps the failing lines of an interleaved BuildKit log', () => {
    const noise = Array.from(
      { length: 200 },
      (_, index) => `#45 81.57 ${index} transferring docker context`,
    );
    const output = [
      ...noise,
      '#45 0.123 build backend-tests',
      '#45 0.456 (fail) foo > bar',
      '#45 0.789 error: expected 1',
      '#45 0.900 transferring docker context',
      '#45 0.910 transferring docker context',
      '#45 0.920 transferring docker context',
      'ERROR: failed to solve: process "/bin/sh -c bun test" did not complete successfully: exit code: 1',
    ].join('\n');

    const lines = extractBuildFailureLines(output);

    expect(lines).toContain('#45 0.456 (fail) foo > bar');
    expect(lines).toContain('#45 0.789 error: expected 1');
    expect(lines.some((line) => line.includes('ERROR: failed to solve'))).toBe(
      true,
    );
    expect(lines.some((line) => line.includes('exit code: 1'))).toBe(true);
  });

  test('bounds the number, length and total size of the reported lines', () => {
    const many = Array.from(
      { length: 200 },
      (_, index) => `#45 1.0 (fail) step-${index} ${'y'.repeat(500)}`,
    ).join('\n');
    const lines = extractBuildFailureLines(many);

    expect(lines.length).toBeLessThanOrEqual(BUILD_FAILURE_LINE_LIMIT);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(BUILD_FAILURE_LINE_CHARS);
    }
    expect(lines.join('\n').length).toBeLessThanOrEqual(
      BUILD_FAILURE_TOTAL_CHARS,
    );

    const short = Array.from(
      { length: BUILD_FAILURE_LINE_LIMIT + 5 },
      (_, index) => `#45 1.0 (fail) step-${index}`,
    ).join('\n');
    const kept = extractBuildFailureLines(short);
    expect(kept).toHaveLength(BUILD_FAILURE_LINE_LIMIT);
    expect(kept.at(-1)).toBe(
      `#45 1.0 (fail) step-${BUILD_FAILURE_LINE_LIMIT + 4}`,
    );
  });

  test('scrubs secrets inside a reported line', () => {
    const lines = extractBuildFailureLines(
      '#45 0.1 (fail) publish failed with TOKEN=secret123',
    );

    expect(lines.join('\n')).not.toContain('secret123');
    expect(lines.join('\n')).toContain('[private value omitted]');
  });

  test('redacts a multi-line private key that spans reported lines', () => {
    const output = [
      '#12 0.4 -----BEGIN RSA PRIVATE KEY-----',
      '#12 0.4 MIIEpAIBAAKCAQEAxyz',
      '#12 0.4 abcdefghijklmnopqrstuvwxyz0123456789',
      '#12 0.4 -----END RSA PRIVATE KEY-----',
      'ERROR: build failed',
    ].join('\n');

    const joined = extractBuildFailureLines(output).join('\n');

    expect(joined).not.toContain('MIIEpAIBAAKCAQEAxyz');
    expect(joined).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(joined).toContain('ERROR: build failed');
  });

  test('returns no lines for empty output', () => {
    expect(extractBuildFailureLines('')).toEqual([]);
  });
});
