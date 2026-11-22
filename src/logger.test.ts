import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, describe, expect, test } from 'bun:test';
import pretty from 'pino-pretty';
import {
  createLogger,
  readLogFileOptions,
  sanitizeLogValue,
  scrubSecretText,
  serializeError,
} from './logger.js';

describe('safe process logging policy', () => {
  test('redacts nested credentials and private payload fields', () => {
    const result = sanitizeLogValue({
      request: {
        body: {
          password: 'password-value',
          profile: {
            prompt: 'private prompt',
            promptLength: 13,
            contentLength: 42,
            queryLength: 9,
            attachmentCount: 2,
            outputTokens: 7,
          },
        },
      },
      metadata: {
        id: 'run-123',
        count: 2,
        promptLength: 13,
        contentLength: 42,
        queryLength: 9,
        attachmentCount: 2,
        outputTokens: 7,
      },
    }) as Record<string, unknown>;

    expect(JSON.stringify(result)).not.toContain('password-value');
    expect(JSON.stringify(result)).not.toContain('private prompt');
    expect(result.request).toEqual({
      body: { omitted: 'private', keys: 2 },
    });
    expect(result.metadata).toEqual({
      id: 'run-123',
      count: 2,
      promptLength: 13,
      contentLength: 42,
      queryLength: 9,
      attachmentCount: 2,
      outputTokens: 7,
    });
  });

  test('redacts standalone message fields', () => {
    const result = sanitizeLogValue({
      message: 'private user message',
      messageLength: 20,
    }) as Record<string, unknown>;

    expect(result).toEqual({
      message: { omitted: 'private', chars: 20 },
      messageLength: 20,
    });
  });

  test('redacts usernames titles names and groups', () => {
    const result = sanitizeLogValue({
      username: 'private-user',
      newUsername: 'new-private-user',
      title: 'private task title',
      name: 'private group name',
      group: 'private group',
      id: 'safe-correlation-id',
    }) as Record<string, unknown>;

    expect(result).toEqual({
      username: { omitted: 'private', chars: 12 },
      newUsername: { omitted: 'private', chars: 16 },
      title: { omitted: 'private', chars: 18 },
      name: { omitted: 'private', chars: 18 },
      group: { omitted: 'private', chars: 13 },
      id: 'safe-correlation-id',
    });
  });

  test('preserves operational session IDs but redacts session secrets', () => {
    const result = sanitizeLogValue({
      session_id: 'mcp-session-123',
      sessionId: 'agent-session-456',
      sessionValue: 'private-session-cookie',
    }) as Record<string, unknown>;

    expect(result).toEqual({
      session_id: 'mcp-session-123',
      sessionId: 'agent-session-456',
      sessionValue: { omitted: 'secret' },
    });
  });

  test('keeps numeric and boolean diagnostics and absent session IDs visible', () => {
    const diagnostics = {
      sessionSweeps: 2,
      forceFreshSession: true,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      token_count: 3,
    };
    expect(sanitizeLogValue(diagnostics)).toEqual(diagnostics);

    expect(
      sanitizeLogValue({ sessionSweeps: 'x-secret', total_tokens: 'abc' }),
    ).toEqual({
      sessionSweeps: { omitted: 'secret' },
      total_tokens: { omitted: 'secret' },
    });

    expect(sanitizeLogValue({ session_id: null })).toEqual({
      session_id: null,
    });
    expect(
      JSON.stringify(sanitizeLogValue({ session_id: undefined })),
    ).not.toContain('omitted');
  });

  test('scrubs secrets from error messages while retaining diagnostics', () => {
    const error = new Error('upstream request failed: token=private-token');
    Object.assign(error, { code: 'ECONNRESET', secret: 'do-not-log' });
    const result = serializeError(error);

    expect(result).toEqual({
      name: 'Error',
      message: 'upstream request failed: token=[private value omitted]',
      messageLength: error.message.length,
      code: 'ECONNRESET',
    });
    expect(JSON.stringify(result)).not.toContain('private-token');
    expect(JSON.stringify(result)).not.toContain('do-not-log');
  });

  test('drops private and oversized error metadata strings', () => {
    const error = new Error('safe-looking failure');
    error.name = 'private prompt text';
    Object.assign(error, {
      code: 'sk-private-token',
      status: 'status=secret-token',
      statusCode: 502,
    });

    expect(serializeError(error)).toEqual({
      name: 'Error',
      message: 'safe-looking failure',
      messageLength: error.message.length,
      statusCode: 502,
    });
  });

  test('bounds values and removes URL queries without losing safe routing metadata', () => {
    const result = sanitizeLogValue({
      url: 'https://example.test/path?q=private&token=private-token',
      runHostDir: '/workspace/group/private-run',
      groupDir: '/workspace/group/private-group',
      detail: 'x'.repeat(500),
    }) as Record<string, string>;
    expect(result.url).toBe('https://example.test/[path:5 chars]');

    expect(result.runHostDir).toBe('/workspace/group/private-run');
    expect(result.groupDir).toBe('/workspace/group/private-group');
    expect(result.detail).toContain('[500 chars]');
    expect(result.detail.length).toBeLessThanOrEqual(270);
  });

  test('serializes non-Error throws without preserving private text', () => {
    const result = serializeError('request failed with bearer private-token');
    expect(result).toEqual({
      name: 'NonErrorThrown',
      message: 'request failed with [authorization omitted]',
      messageLength: 40,
    });
  });

  test('retains stringified diagnostics after scrubbing private values', () => {
    const result = sanitizeLogValue({
      error: 'prompt=private-message bearer SECRET',
      err: 'provider response: private provider response text',
      reason: 'attachment content',
      status: 'failed',
    }) as Record<string, unknown>;

    expect(result).toEqual({
      error: 'prompt=[private value omitted] [authorization omitted]',
      err: 'provider response=[private value omitted]',
      reason: { omitted: 'private', chars: 18 },
      status: 'failed',
    });
  });

  test('retains nested structured error diagnostics but omits response data', () => {
    const result = sanitizeLogValue({
      error: {
        message: 'provider response: private provider response text',
        code: 'UPSTREAM_FAILURE',
        response: { data: 'private response body' },
      },
    }) as Record<string, unknown>;

    expect(result).toEqual({
      error: {
        code: 'UPSTREAM_FAILURE',
        message: 'provider response=[private value omitted]',
        messageLength: 49,
      },
    });
    expect(JSON.stringify(result)).not.toContain('private response body');
  });

  test('validates plain structured error metadata strictly', () => {
    const result = sanitizeLogValue({
      error: {
        name: 'private prompt',
        code: 'sk-private-token',
        status: 'failed',
        statusCode: 502,
        messageLength: 24,
      },
    }) as Record<string, unknown>;

    expect(result).toEqual({
      error: {
        name: 'Error',
        status: 'failed',
        statusCode: 502,
        messageLength: 24,
      },
    });
  });

  test('retains sandbox diagnostics while scrubbing embedded secrets', () => {
    const result = sanitizeLogValue({
      stdout: 'build failed: token=private-token',
      stdoutLength: 33,
    }) as Record<string, unknown>;

    expect(result).toEqual({
      stdout: 'build failed: token=[private value omitted]',
      stdoutLength: 33,
    });
  });

  test('runtime logger emits sanitized Error metadata once', async () => {
    const chunks: Buffer[] = [];
    const written = Promise.withResolvers<void>();
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
        written.resolve();
      },
    });
    const testLogger = createLogger(false, destination, 'info');
    const error = new Error('provider response: private provider response');
    Object.assign(error, { code: 'ECONNRESET', secret: 'do-not-log' });
    testLogger.error(
      {
        err: error,
        message: 'private user message',
        credential: 'private credential',
        credentials: { api: 'private credential object' },
        bearer: 'secret bearer value',
        keyMaterial: 'private key material',
        password: 'password-value',
        ticket: 'ws-ticket-value',
        prompt: 'private prompt',
        query: 'private search query',
        attachment: 'private attachment content',
        url: 'https://example.test/private-user-id?query=secret',
      },
      'operation failed',
    );
    await written.promise;

    const record = JSON.parse(Buffer.concat(chunks).toString()) as {
      err: Record<string, unknown>;
      message: unknown;
      url: string;
    };
    expect(record.err).toEqual({
      name: 'Error',
      message: 'provider response=[private value omitted]',
      messageLength: error.message.length,
      code: 'ECONNRESET',
    });
    expect(record.message).toEqual({ omitted: 'private', chars: 20 });
    expect(record.url).toBe('https://example.test/[path:16 chars]');
    expect(JSON.stringify(record)).not.toContain('private user message');
    expect(JSON.stringify(record)).not.toContain('private prompt');
    expect(JSON.stringify(record)).not.toContain('private search query');
    expect(JSON.stringify(record)).not.toContain('private attachment content');
    expect(JSON.stringify(record)).not.toContain('password-value');
    expect(JSON.stringify(record)).not.toContain('ws-ticket-value');
    expect(JSON.stringify(record)).not.toContain('private-user-id');
    expect(JSON.stringify(record)).not.toContain('private credential');
    expect(JSON.stringify(record)).not.toContain('secret bearer value');
    expect(JSON.stringify(record)).not.toContain('private key material');
    expect(JSON.stringify(record)).not.toContain('private credential object');
    expect(JSON.stringify(record)).not.toContain('ws-ticket-value');
  });

  test('scrubSecretText removes credentials without bounding the length', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');

    const bearer = scrubSecretText('Bearer abc.def');
    expect(bearer).not.toContain('abc.def');
    expect(bearer).toContain('[authorization omitted]');

    const apiKey = scrubSecretText('API_KEY=xyz');
    expect(apiKey).not.toContain('xyz');
    expect(apiKey).toContain('[private value omitted]');

    const option = scrubSecretText('run with --token foo');
    expect(option).not.toContain('foo');
    expect(option).toContain('[private option omitted]');

    const privateKey = scrubSecretText(pem);
    expect(privateKey).not.toContain('MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn');
    expect(privateKey).toContain('[private key omitted]');

    const long = 'x'.repeat(10_000);
    expect(scrubSecretText(long)).toHaveLength(10_000);
  });

  test('does not allow diagnostic suffixes to bypass secret redaction', () => {
    const result = sanitizeLogValue({
      accessTokens: ['secret-token'],
      tokenSize: 'secret-token',
      promptCount: 'private prompt count',
      outputTokens: 7,
    }) as Record<string, unknown>;

    expect(result).toEqual({
      accessTokens: { omitted: 'secret' },
      tokenSize: { omitted: 'secret' },
      promptCount: { omitted: 'private', chars: 20 },
      outputTokens: 7,
    });
  });

  test('bounds keys messages and total runtime records', async () => {
    const chunks: Buffer[] = [];
    let resolveWrite!: () => void;
    const written = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
        resolveWrite();
      },
    });
    const testLogger = createLogger(false, destination, 'info');
    const oversizedKey = 'k'.repeat(500);
    (testLogger.info as (...args: unknown[]) => void)(
      {
        ...Object.fromEntries(
          Array.from({ length: 40 }, (_, index) => [
            `field${index}`,
            'x'.repeat(500),
          ]),
        ),
        [oversizedKey]: 'x'.repeat(500),
        nested: { value: 'y'.repeat(20_000) },
      },
      { second: 'z'.repeat(20_000) },
      'm'.repeat(20_000),
    );
    const sanitizedKey = sanitizeLogValue({ [oversizedKey]: 1 }) as Record<
      string,
      unknown
    >;
    expect(Object.keys(sanitizedKey)[0]?.length).toBe(80);
    await written;

    const serialized = Buffer.concat(chunks).toString();
    expect(serialized.length).toBeLessThan(9000);
    expect(serialized).not.toContain(oversizedKey);
    expect(serialized).toContain('logRecordTruncated');
    expect(serialized).toContain('[20000 chars]');
  });

  test('pino-pretty output omits private Error content', () => {
    const directory = mkdtempSync(join(tmpdir(), 'carapa-logger-'));
    const outputPath = join(directory, 'pretty.log');
    try {
      const prettyLogger = createLogger(
        false,
        pretty({ colorize: false, destination: outputPath, sync: true }),
        'info',
      );
      const error = new Error('private pretty provider response');
      Object.assign(error, { code: 'UPSTREAM_FAILURE' });
      prettyLogger.error(
        { err: error, message: 'private pretty user message' },
        'operation failed',
      );
      const output = readFileSync(outputPath, 'utf8');
      expect(output).toContain('Error');
      expect(output).toContain('UPSTREAM_FAILURE');
      expect(output).not.toContain('private pretty user message');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('LOG_FILE rotating file sink', () => {
  const root = mkdtempSync(join(tmpdir(), 'logger-file-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function stderrSink() {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(Buffer.from(chunk).toString());
        callback();
      },
    });
    return { lines, stream };
  }
  const readLines = (path: string) =>
    readFileSync(path, 'utf8').trim().split('\n');

  test('writes the same redacted record to stderr and the file', () => {
    const path = join(root, 'both', 'board.log');
    const { lines, stream } = stderrSink();
    const log = createLogger(
      false,
      stream,
      'info',
      2,
      readLogFileOptions({ LOG_FILE: path }),
    );
    log.info(
      { req: { body: { content: 'private-body' } }, id: 'run-1' },
      'hello',
    );

    const fileRecords = readLines(path);
    expect(fileRecords).toHaveLength(1);
    expect(JSON.parse(fileRecords[0])).toMatchObject({
      id: 'run-1',
      msg: 'hello',
    });
    expect(lines.join('')).toContain('"msg":"hello"');
    expect(readFileSync(path, 'utf8')).not.toContain('private-body');
    expect(lines.join('')).not.toContain('private-body');
  });

  test('writes plain JSON to the file while pretty output goes to stderr', () => {
    const path = join(root, 'pretty', 'board.log');
    const stderrPath = join(root, 'pretty-stderr.txt');
    const log = createLogger(
      true,
      stderrSink().stream,
      'info',
      stderrPath,
      readLogFileOptions({ LOG_FILE: path }),
    );
    log.info({ id: 'run-2' }, 'pretty hello');

    expect(JSON.parse(readLines(path)[0])).toMatchObject({
      id: 'run-2',
      msg: 'pretty hello',
    });
  });

  test('rotates by size and caps retained files', () => {
    const path = join(root, 'rotate', 'board.log');
    const { stream } = stderrSink();
    const options = readLogFileOptions({
      LOG_FILE: path,
      LOG_FILE_MAX_SIZE: '1k',
      LOG_FILE_MAX_FILES: '2',
    });
    expect(options).toMatchObject({ maxBytes: 1024, maxFiles: 2 });
    const log = createLogger(false, stream, 'info', 2, options);
    for (let index = 0; index < 60; index++) {
      log.info({ index }, 'x'.repeat(100));
    }

    expect(readdirSync(join(root, 'rotate')).sort()).toEqual([
      'board.log',
      'board.log.1',
      'board.log.2',
    ]);
    const indexes = [`${path}.2`, `${path}.1`, path].flatMap((file) =>
      readLines(file).map((line) => JSON.parse(line).index as number),
    );
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(new Set(indexes).size).toBe(indexes.length);
    expect(indexes.at(-1)).toBe(59);
  });

  test('falls back to stderr with one warning when the file is unwritable', () => {
    const blocker = join(root, 'blocker');
    writeFileSync(blocker, 'not a directory');
    const { lines, stream } = stderrSink();
    const log = createLogger(
      false,
      stream,
      'info',
      2,
      readLogFileOptions({ LOG_FILE: join(blocker, 'board.log') }),
    );
    log.info('still logging');
    log.info('again');

    const warnings = lines.filter((line) =>
      line.includes('LOG_FILE unavailable'),
    );
    expect(warnings).toHaveLength(1);
    expect(lines.join('')).toContain('still logging');
    expect(lines.join('')).toContain('again');
  });

  test('creates no file when LOG_FILE is unset', () => {
    expect(readLogFileOptions({})).toBeUndefined();
    const { stream } = stderrSink();
    const before = readdirSync(root).length;
    createLogger(false, stream, 'info', 2, readLogFileOptions({})).info('x');
    expect(readdirSync(root)).toHaveLength(before);
    expect(existsSync(join(root, 'board.log'))).toBe(false);
  });
});
