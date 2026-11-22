import { sha256Hex } from '../../lib/hash.js';

export const MEMORY_AUDIT_JSON_SCHEMA = `{
  "items": [
    {
      "memory_id": "one allowed memory ID",
      "disposition": "keep | rewrite | merge | erase",
      "confidence": 0.95,
      "reason": "concise reason",
      "proposed_content": "required only for rewrite",
      "proposed_memory_type": "identity | project | goal | decision | preference | contact | event | task",
      "proposed_importance": 0.8,
      "proposed_tags": ["tag"],
      "merge_target_id": "required only for merge; another allowed memory ID",
      "evidence": [
        {
          "repository_root": "/workspace/repo",
          "path": "src/file.ts",
          "line_start": 1,
          "line_end": 3,
          "excerpt": "exact text from the file",
          "watched_scope": "optional/configuration-file"
        }
      ]
    }
  ]
}`;

export interface MemoryAuditJsonFailureDiagnostic {
  attempt: number;
  maxAttempts: number;
  validationError: string;
  responseLength: number;
  responseSha256: string;
  responseFormat:
    | 'empty'
    | 'json-fence'
    | 'json-object'
    | 'wrapped-json-object'
    | 'no-json-object';
  parsePosition?: number;
  /** Punctuation and whitespace are retained; letters and numbers are redacted. */
  structuralExcerpt: string;
}

function candidateDetails(output: string): {
  candidate: string;
  format: MemoryAuditJsonFailureDiagnostic['responseFormat'];
} {
  const trimmed = output.trim();
  if (!trimmed) return { candidate: '', format: 'empty' };
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced !== undefined) {
    return { candidate: fenced, format: 'json-fence' };
  }
  const first = output.indexOf('{');
  const last = output.lastIndexOf('}');
  if (first < 0 || last < first) {
    return { candidate: output, format: 'no-json-object' };
  }
  return {
    candidate: output.slice(first, last + 1),
    format:
      first === output.search(/\S/) && last === output.trimEnd().length - 1
        ? 'json-object'
        : 'wrapped-json-object',
  };
}

function parsePosition(error: string): number | undefined {
  const match = error.match(/(?:position|offset|column)\s+(\d+)/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function redactStructure(value: string): string {
  return value.replace(/[\p{L}\p{N}]/gu, '•');
}

function memoryAuditJsonFailureDiagnostic(args: {
  output: string;
  validationError: string;
  attempt: number;
  maxAttempts: number;
}): MemoryAuditJsonFailureDiagnostic {
  const details = candidateDetails(args.output);
  const position = parsePosition(args.validationError);
  const center = Math.min(position ?? 0, details.candidate.length);
  const excerptStart = Math.max(0, center - 160);
  const excerptEnd = Math.min(details.candidate.length, center + 160);
  return {
    attempt: args.attempt,
    maxAttempts: args.maxAttempts,
    validationError: args.validationError.slice(0, 2_000),
    responseLength: args.output.length,
    responseSha256: sha256Hex(args.output),
    responseFormat: details.format,
    ...(position === undefined ? {} : { parsePosition: position }),
    structuralExcerpt: redactStructure(
      details.candidate.slice(excerptStart, excerptEnd),
    ),
  };
}

function boundedPreviousOutput(output: string): string {
  const limit = 24_000;
  if (output.length <= limit) return output;
  const half = Math.floor(limit / 2);
  return `${output.slice(0, half)}\n…[truncated]…\n${output.slice(-half)}`;
}

function memoryAuditJsonRepairPrompt(args: {
  originalPrompt: string;
  previousOutput: string;
  validationError: string;
  allowedMemoryIds: string[];
}): string {
  return `${args.originalPrompt}

FORMAT CORRECTION REQUIRED

Your previous response was rejected by CarapaBoard's JSON validator:
${args.validationError.slice(0, 2_000)}

Return a corrected response as one JSON object only. Do not use Markdown fences,
commentary, tool calls, or text before or after the JSON object.

Every allowed memory ID must occur exactly once in items, and no other memory ID
may occur. Allowed memory IDs:
${JSON.stringify(args.allowedMemoryIds)}

Use exactly this response shape (omit optional fields when they do not apply):
${MEMORY_AUDIT_JSON_SCHEMA}

PREVIOUS RESPONSE TO CORRECT:
${boundedPreviousOutput(args.previousOutput)}`;
}

export function structuredJsonRepairPrompt(args: {
  originalPrompt: string;
  previousOutput: string;
  validationError: string;
  schema: string;
  requirements?: string;
}): string {
  return `${args.originalPrompt}

FORMAT CORRECTION REQUIRED

Your previous response was rejected by CarapaBoard's JSON validator:
${args.validationError.slice(0, 2_000)}

Return a corrected response as one JSON object only. Do not use Markdown fences,
commentary, tool calls, or text before or after the JSON object.
${args.requirements ? `\n${args.requirements.trim()}\n` : ''}
Use exactly this response shape (omit optional fields when they do not apply):
${args.schema}

PREVIOUS RESPONSE TO CORRECT:
${boundedPreviousOutput(args.previousOutput)}`;
}

export async function requestValidStructuredJson<T>(args: {
  originalPrompt: string;
  invoke: (prompt: string, isRepair: boolean) => Promise<string>;
  validate: (output: string) => T | Promise<T>;
  repairPrompt: (args: {
    previousOutput: string;
    validationError: string;
  }) => string;
  maxReprompts?: number;
  onValidationFailure?: (
    diagnostic: MemoryAuditJsonFailureDiagnostic,
  ) => void | Promise<void>;
}): Promise<T> {
  const maxReprompts = Math.max(0, args.maxReprompts ?? 2);
  let prompt = args.originalPrompt;
  let validationError = '';

  for (let attempt = 0; attempt <= maxReprompts; attempt += 1) {
    const output = await args.invoke(prompt, attempt > 0);
    try {
      return await args.validate(output);
    } catch (error) {
      validationError = error instanceof Error ? error.message : String(error);
      await args.onValidationFailure?.(
        memoryAuditJsonFailureDiagnostic({
          output,
          validationError,
          attempt: attempt + 1,
          maxAttempts: maxReprompts + 1,
        }),
      );
      if (attempt === maxReprompts) throw error;
      prompt = args.repairPrompt({
        previousOutput: output,
        validationError,
      });
    }
  }

  throw new Error(validationError || 'Structured JSON validation failed');
}

/**
 * Run the reflector and locally repair format/schema failures before allowing
 * the project-level retry counter to consume an attempt.
 */
export async function requestValidMemoryAuditJson<T>(args: {
  originalPrompt: string;
  allowedMemoryIds: string[];
  invoke: (prompt: string, isRepair: boolean) => Promise<string>;
  validate: (output: string) => T | Promise<T>;
  maxReprompts?: number;
  onValidationFailure?: (
    diagnostic: MemoryAuditJsonFailureDiagnostic,
  ) => void | Promise<void>;
}): Promise<T> {
  return requestValidStructuredJson({
    originalPrompt: args.originalPrompt,
    invoke: args.invoke,
    validate: args.validate,
    maxReprompts: args.maxReprompts,
    onValidationFailure: args.onValidationFailure,
    repairPrompt: ({ previousOutput, validationError }) =>
      memoryAuditJsonRepairPrompt({
        originalPrompt: args.originalPrompt,
        previousOutput,
        validationError,
        allowedMemoryIds: args.allowedMemoryIds,
      }),
  });
}
