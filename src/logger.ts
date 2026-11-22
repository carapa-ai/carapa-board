import {
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import pino from 'pino';

export const MAX_STRING_LENGTH = 256;
const MAX_DIAGNOSTIC_LENGTH = 2000;
const MAX_KEY_LENGTH = 80;
export const MAX_LOG_RECORD_BYTES = 4096;
const MAX_OBJECT_KEYS = 40;
const MAX_ARRAY_ITEMS = 20;
const MAX_DEPTH = 5;

function hasPinoPretty(): boolean {
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

const isoTimestamp: pino.TimeFn = () => `,"time":"${new Date().toISOString()}"`;
export const REQUEST_LOG_REDACT_PATHS = [
  'req.body.content',
  'request.body.content',
  'body.content',
] as const;

const SECRET_KEY =
  /(?:credential|bearer|keyMaterial|key_material|password|passphrase|secret|token|authorization|cookie|session(?:[_-]?id)?|ticket|api[_-]?key|encryption|private[_-]?key)/i;
const PRIVATE_CONTENT_KEY =
  /(?:prompt|transcript|content|query|attachment|payload|arguments|body)|^(?:username|newUsername|title|name|group|message|reason)$/i;
const DIAGNOSTIC_TEXT_KEY = /^(?:err|error|output|stdout|stderr|stack)$/i;
const OPERATIONAL_SESSION_ID_KEY = /^(?:session_id|sessionId)$/;
const SAFE_DIAGNOSTIC_KEYS: Record<string, true> = {
  hasSession: true,
  isApiToken: true,
  hasUsername: true,
  configured: true,
  hasEnvironment: true,
  isLlm: true,
  promptLength: true,
  hasSystemPrompt: true,
  systemPromptLength: true,
  contentLength: true,
  cleanContentLength: true,
  queryLength: true,
  tokenLength: true,
  passwordLength: true,
  attachmentCount: true,
  messageCount: true,
  argumentLength: true,
  messageLength: true,
  outputTokens: true,
  inputTokens: true,
  totalTokens: true,
  stdoutLength: true,
  bytes: true,
  count: true,
  candidateCount: true,
  selectedCount: true,
  entries: true,
  rawEntries: true,
  routeMs: true,
  readMs: true,
  formatMs: true,
  convLookupMs: true,
  durationMs: true,
  duration_ms: true,
  sessionSweeps: true,
  prompt_tokens: true,
  completion_tokens: true,
  total_tokens: true,
  token_count: true,
  forceFreshSession: true,
};
const SAFE_ERROR_METADATA = /^[A-Za-z0-9_.:-]{1,80}$/;
const UNSAFE_ERROR_METADATA =
  /(?:token|secret|private|prompt|password|bearer|response|content|message|body|query)/i;
const SAFE_ERROR_CODES: Record<string, true> = {
  ECONNRESET: true,
  ECONNREFUSED: true,
  ETIMEDOUT: true,
  EPIPE: true,
  ENOENT: true,
  EACCES: true,
  EPERM: true,
  EADDRINUSE: true,
  UPSTREAM_FAILURE: true,
  TIMEOUT: true,
  INVALID_REQUEST: true,
  NOT_FOUND: true,
};
const SAFE_ERROR_NAMES: Record<string, true> = {
  Error: true,
  TypeError: true,
  RangeError: true,
  SyntaxError: true,
  ReferenceError: true,
  URIError: true,
};

// Fixed enum values of the objective task event hold settle reason; any other
// `reason` value stays private.
const SAFE_HOLD_SETTLE_REASONS: Record<string, true> = {
  not_handled: true,
  ack: true,
  timeout: true,
};

function isSafeDiagnosticValue(key: string, value: unknown): boolean {
  if (key === 'reason') {
    return (
      typeof value === 'string' && SAFE_HOLD_SETTLE_REASONS[value] === true
    );
  }
  if (SAFE_DIAGNOSTIC_KEYS[key]) {
    return (
      (typeof value === 'number' && Number.isFinite(value)) ||
      typeof value === 'boolean'
    );
  }
  return false;
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

function boundedString(value: string, max = MAX_STRING_LENGTH): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ');
  return normalized.length > max
    ? `${normalized.slice(0, max)}…[${normalized.length} chars]`
    : normalized;
}

/**
 * Removes credentials from text without bounding its length.
 *
 * Used where the caller applies its own bound (e.g. bounded build-failure
 * lines). The redaction chain is identical to the diagnostic scrubber; only
 * the trailing length bound differs.
 */
export function scrubSecretText(value: string): string {
  return value
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi,
      '[private key omitted]',
    )
    .replace(/\b(?:bearer|basic)\s+[^\s,;]+/gi, '[authorization omitted]')
    .replace(
      /(?:--?)(?:password|passphrase|secret|token|authorization|cookie|ticket|api[_-]?key)(?:=|\s+)\S+/gi,
      '[private option omitted]',
    )
    .replace(
      /["']?\b[\w.-]*(password|passphrase|secret|token|authorization|cookie|ticket|api[_-]?key|prompt|content|query)[\w.-]*\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s&,;]+)/gi,
      '$1=[private value omitted]',
    )
    .replace(
      /\b((?:(?:provider|upstream|server|api)\s+)?response(?:\s+body)?)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\r\n]*)/gi,
      '$1=[private value omitted]',
    )
    .replace(/https?:\/\/[^\s"']+/gi, (rawUrl) => {
      try {
        const url = new URL(rawUrl);
        return `${url.origin}${url.pathname}`;
      } catch {
        return '[invalid URL omitted]';
      }
    });
}

function scrubDiagnosticText(value: string): string {
  return boundedString(scrubSecretText(value), MAX_DIAGNOSTIC_LENGTH);
}

function privateValueSummary(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    return { omitted: 'private', chars: value.length };
  }
  if (Array.isArray(value)) {
    return { omitted: 'private', items: value.length };
  }
  if (value !== null && typeof value === 'object') {
    return { omitted: 'private', keys: Object.keys(value).length };
  }
  return { omitted: 'private', present: value !== null && value !== undefined };
}

function safeErrorMetadataValue(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (
    typeof value === 'string' &&
    SAFE_ERROR_METADATA.test(value) &&
    !UNSAFE_ERROR_METADATA.test(value)
  ) {
    return value;
  }
  return undefined;
}

function safeErrorCodeValue(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return typeof value === 'string' && SAFE_ERROR_CODES[value]
    ? value
    : undefined;
}

function safeErrorName(value: unknown): string {
  return typeof value === 'string' && SAFE_ERROR_NAMES[value] ? value : 'Error';
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const result: Record<string, unknown> = {
      name: safeErrorName(error.name),
      message: scrubDiagnosticText(error.message),
      messageLength: error.message.length,
    };
    const errorWithMetadata = error as Error & {
      code?: unknown;
      status?: unknown;
      statusCode?: unknown;
    };
    const code = safeErrorCodeValue(errorWithMetadata.code);
    if (code !== undefined) result.code = code;
    for (const key of ['status', 'statusCode'] as const) {
      const safeValue = safeErrorMetadataValue(errorWithMetadata[key]);
      if (safeValue !== undefined) result[key] = safeValue;
    }
    return result;
  }
  const message = String(error);
  return {
    name: 'NonErrorThrown',
    message: scrubDiagnosticText(message),
    messageLength: message.length,
  };
}

/** Recursively redact sensitive fields and bound all provider/user-controlled values. */
export function sanitizeLogValue(
  value: unknown,
  key = '',
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (DIAGNOSTIC_TEXT_KEY.test(key) && typeof value === 'string') {
    return scrubDiagnosticText(value);
  }
  if (value instanceof Error) return serializeError(value);
  if (
    /^(?:err|error)$/i.test(key) &&
    value !== null &&
    typeof value === 'object'
  ) {
    const safeError: Record<string, unknown> = {};
    for (const safeKey of [
      'name',
      'code',
      'status',
      'statusCode',
      'messageLength',
    ]) {
      if (!(safeKey in value)) continue;
      const rawValue = (value as Record<string, unknown>)[safeKey];
      const safeValue =
        safeKey === 'name'
          ? safeErrorName(rawValue)
          : safeKey === 'code'
            ? safeErrorCodeValue(rawValue)
            : safeErrorMetadataValue(rawValue);
      if (safeValue !== undefined) safeError[safeKey] = safeValue;
    }
    const message = (value as Record<string, unknown>).message;
    if (typeof message === 'string') {
      safeError.message = scrubDiagnosticText(message);
      safeError.messageLength = message.length;
    }
    return safeError;
  }
  if (isSafeDiagnosticValue(key, value)) return value;
  if (OPERATIONAL_SESSION_ID_KEY.test(key)) {
    if (typeof value === 'string') return boundedString(value);
    if (value === null || value === undefined) return value;
  }
  if (isSecretKey(key)) return { omitted: 'secret' };
  if (PRIVATE_CONTENT_KEY.test(key)) return privateValueSummary(value);
  if (typeof value === 'string') {
    if (/url/i.test(key)) {
      try {
        const url = new URL(value);
        return boundedString(
          `${url.origin}/[path:${url.pathname.length} chars]`,
        );
      } catch {
        return '[invalid URL omitted]';
      }
    }
    return boundedString(value);
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return { omitted: 'max-depth' };
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeLogValue(item, key, depth + 1, seen));
  }
  const output: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value).slice(
    0,
    MAX_OBJECT_KEYS,
  )) {
    const boundedKey = childKey.slice(0, MAX_KEY_LENGTH);
    output[boundedKey] = sanitizeLogValue(
      childValue,
      boundedKey,
      depth + 1,
      seen,
    );
  }
  return output;
}

function boundLogValue(value: unknown): unknown {
  const sanitized = sanitizeLogValue(value);
  const serialized = JSON.stringify(sanitized);
  if (serialized.length <= MAX_LOG_RECORD_BYTES) return sanitized;
  return { logRecordTruncated: true, originalBytes: serialized.length };
}

export interface LogFileOptions {
  path: string;
  maxBytes: number;
  maxFiles: number;
}

const DEFAULT_LOG_FILE_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_LOG_FILE_MAX_FILES = 5;

/** Parses Docker-style sizes (`20m`, `512k`, `1g`, plain bytes). */
function parseLogSize(value: string | undefined): number | undefined {
  const match = /^\s*(\d+)\s*([kmg]?)b?\s*$/i.exec(value ?? '');
  if (!match) return undefined;
  const unit = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[
    match[2].toLowerCase() as '' | 'k' | 'm' | 'g'
  ];
  const bytes = Number(match[1]) * unit;
  return bytes > 0 ? bytes : undefined;
}

export function readLogFileOptions(
  env: NodeJS.ProcessEnv = process.env,
): LogFileOptions | undefined {
  const path = env.LOG_FILE?.trim();
  if (!path) return undefined;
  const files = Number.parseInt(env.LOG_FILE_MAX_FILES ?? '', 10);
  return {
    path,
    maxBytes: parseLogSize(env.LOG_FILE_MAX_SIZE) ?? DEFAULT_LOG_FILE_MAX_BYTES,
    maxFiles:
      Number.isFinite(files) && files >= 0 ? files : DEFAULT_LOG_FILE_MAX_FILES,
  };
}

/**
 * Synchronous size-rotating file sink: `file` -> `file.1` ... `file.N`.
 * Each record is a single writeSync on an append-mode fd, so records are never
 * lost or interleaved across a rotation (which is just a few renames). On any
 * I/O failure the sink disables itself and reports once via `onError`.
 */
function createRotatingFileStream(
  options: LogFileOptions,
  onError: (error: unknown) => void,
): { write(line: string): void } {
  const { path, maxBytes, maxFiles } = options;
  let fd: number | undefined;
  let size = 0;
  let disabled = false;

  const open = () => {
    fd = openSync(path, 'a');
    size = statSync(path).size;
  };
  const rotate = () => {
    closeSync(fd!);
    fd = undefined;
    if (maxFiles === 0) {
      unlinkSync(path);
    } else {
      try {
        unlinkSync(`${path}.${maxFiles}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      for (let index = maxFiles - 1; index >= 1; index--) {
        try {
          renameSync(`${path}.${index}`, `${path}.${index + 1}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      renameSync(path, `${path}.1`);
    }
    open();
  };
  const disable = (error: unknown) => {
    disabled = true;
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Already failing; nothing more to release.
      }
      fd = undefined;
    }
    onError(error);
  };

  try {
    mkdirSync(dirname(path), { recursive: true });
    open();
  } catch (error) {
    disable(error);
  }

  return {
    write(line: string) {
      if (disabled) return;
      try {
        const bytes = Buffer.byteLength(line);
        if (size > 0 && size + bytes > maxBytes) rotate();
        writeSync(fd!, line);
        size += bytes;
      } catch (error) {
        disable(error);
      }
    },
  };
}

const redact = {
  paths: [...REQUEST_LOG_REDACT_PATHS],
  remove: true,
};
const serializers = { err: (value: unknown) => value };

function createPrettyStream(
  destination: number | string,
): pino.DestinationStream {
  const module = require('pino-pretty') as
    | ((options: object) => pino.DestinationStream)
    | { default: (options: object) => pino.DestinationStream };
  const factory = typeof module === 'function' ? module : module.default;
  return factory({
    colorize: process.env.LOG_COLOR !== 'false',
    destination,
  });
}

export function createLogger(
  usePretty = hasPinoPretty(),
  destination: pino.DestinationStream = pino.destination(2),
  level = process.env.LOG_LEVEL || 'info',
  prettyDestination: number | string = 2,
  logFile: LogFileOptions | undefined = readLogFileOptions(),
): pino.Logger {
  const hooks = {
    logMethod(inputArgs: unknown[], method: (...args: unknown[]) => void) {
      inputArgs = inputArgs.map((arg) => {
        if (typeof arg === 'string') return boundedString(arg);
        if (arg && typeof arg === 'object') return boundLogValue(arg);
        return arg;
      });
      const estimatedBytes = inputArgs.reduce<number>(
        (total, arg) =>
          total +
          (typeof arg === 'string' ? arg.length : JSON.stringify(arg).length),
        64,
      );
      if (estimatedBytes > MAX_LOG_RECORD_BYTES) {
        for (let index = 0; index < inputArgs.length; index++) {
          if (inputArgs[index] && typeof inputArgs[index] === 'object') {
            inputArgs[index] = {
              logRecordTruncated: true,
              originalBytes: estimatedBytes,
            };
          }
        }
      }
      method.apply(this, inputArgs);
    },
  };
  if (usePretty && !logFile) {
    return pino({
      level,
      redact,
      serializers,
      hooks,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: process.env.LOG_COLOR !== 'false',
          destination: prettyDestination,
        },
      },
    });
  }
  const baseOptions = {
    level,
    timestamp: isoTimestamp,
    redact,
    serializers,
    hooks,
  };
  if (!logFile) return pino(baseOptions, destination);

  let fileLogger: pino.Logger | undefined;
  let pendingFailure: { error: unknown } | undefined;
  const reportFailure = (error: unknown) => {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    fileLogger!.warn(
      {
        code: typeof code === 'string' ? code : 'UNKNOWN',
        logFile: logFile.path,
      },
      'LOG_FILE unavailable; continuing with stderr logging only',
    );
  };
  const fileStream = createRotatingFileStream(logFile, (error) => {
    // Opening fails before the logger exists; report once it does.
    if (fileLogger) reportFailure(error);
    else pendingFailure = { error };
  });
  // Both sinks receive the already-redacted, size-bounded line; the logger
  // level decides what is emitted, so each sink accepts every level.
  fileLogger = pino(
    baseOptions,
    pino.multistream([
      {
        level: 'trace',
        // Pretty output stays stderr-only; the file is always plain JSON.
        stream: usePretty ? createPrettyStream(prettyDestination) : destination,
      },
      {
        level: 'trace',
        stream: { write: (line: string) => fileStream.write(line) },
      },
    ]),
  );
  if (pendingFailure) reportFailure(pendingFailure.error);
  return fileLogger;
}

export const logger = createLogger();
