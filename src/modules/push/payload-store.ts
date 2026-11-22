import AjvImport, { type ErrorObject, type ValidateFunction } from 'ajv';
import { createNotificationPayload, type RespondToRef } from '../../db.js';
import { isRecord } from '../../lib/type-guards.js';

// Ajv 8 ships dual CJS/ESM. Under NodeNext + esModuleInterop, TS resolves the
// default import to the module namespace rather than the constructor; peel
// back via `.default` (the runtime export the CJS build provides).
type AjvCtor = new (opts?: object) => {
  compile: (schema: object) => ValidateFunction;
};
const Ajv = ((AjvImport as unknown as { default?: AjvCtor }).default ??
  (AjvImport as unknown as AjvCtor)) as AjvCtor;

export type PayloadKind = 'text' | 'json_form';

export interface CreatePayloadInput {
  user_id: string;
  kind: PayloadKind;
  summary: string;
  content: string;
  action_url?: string | null;
  /** Where the form response (if any) should be logged as a markdown user-message. */
  respond_to?: RespondToRef | null;
  ttl_ms?: number;
  /**
   * Stable source/correlation key. Used to dedupe replayed PushNotification
   * tool calls and to associate actionable forms with their originating run.
   */
  source_tool_use_id?: string | null;
}

const SUMMARY_MAX = 120;
const CONTENT_MAX = 64 * 1024;

// A fresh instance avoids retaining schemas and conflicting $id registrations.
// Shape validation remains separate from Ajv's relaxed strictness.
function newFormAjv() {
  return new Ajv({ allErrors: true, strict: false, useDefaults: false });
}

const ALLOWED_PROP_TYPES = new Set(['string', 'number', 'integer', 'boolean']);
const ALLOWED_FORMATS = new Set(['email', 'uri', 'tel', 'date', 'multiline']);

interface FieldSchema {
  type: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  format?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
}

interface FormSchema {
  type: 'object';
  title?: string;
  description?: string;
  properties: Record<string, FieldSchema>;
  required?: string[];
}

function validateFormSchemaShape(content: string): FormSchema {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('json_form content must be valid JSON');
  }
  if (!isRecord(parsed)) {
    throw new Error('json_form content must be a JSON object');
  }
  if (parsed.type !== 'object') {
    throw new Error('json_form content must have type:"object"');
  }
  const props = parsed.properties;
  if (!isRecord(props)) {
    throw new Error('json_form content must include a "properties" object');
  }
  const propEntries = Object.entries(props);
  if (propEntries.length === 0) {
    throw new Error('json_form "properties" must declare at least one field');
  }
  for (const [name, raw] of propEntries) {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`property "${name}" must be an object`);
    }
    const f = raw as FieldSchema;
    if (typeof f.type !== 'string' || !ALLOWED_PROP_TYPES.has(f.type)) {
      throw new Error(
        `property "${name}".type must be one of: ${[...ALLOWED_PROP_TYPES].join(', ')}`,
      );
    }
    if (f.format !== undefined && !ALLOWED_FORMATS.has(f.format)) {
      throw new Error(
        `property "${name}".format must be one of: ${[...ALLOWED_FORMATS].join(', ')}`,
      );
    }
    if (
      f.enum !== undefined &&
      (!Array.isArray(f.enum) || f.enum.length === 0)
    ) {
      throw new Error(`property "${name}".enum must be a non-empty array`);
    }
  }
  if (parsed.required !== undefined) {
    if (
      !Array.isArray(parsed.required) ||
      parsed.required.some((r) => typeof r !== 'string')
    ) {
      throw new Error('json_form "required" must be an array of strings');
    }
    const propNames = new Set(propEntries.map(([n]) => n));
    for (const r of parsed.required as string[]) {
      if (!propNames.has(r)) {
        throw new Error(
          `json_form "required" references unknown property "${r}"`,
        );
      }
    }
  }

  // Confirm Ajv can compile it (catches anything our shape check missed).
  try {
    newFormAjv().compile(parsed as object);
  } catch (err) {
    throw new Error(
      `json_form is not a valid JSON Schema: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return parsed as unknown as FormSchema;
}

/**
 * Compile a stored form schema into an Ajv validator. Used by the response
 * route to enforce that submitted values match the original schema.
 */
export function compileFormValidator(schemaJson: string): ValidateFunction {
  const schema = JSON.parse(schemaJson);
  return newFormAjv().compile(schema);
}

export function formatAjvErrors(
  errors: ErrorObject[] | null | undefined,
): string {
  if (!errors || errors.length === 0) return 'invalid form response';
  return errors
    .map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim())
    .join('; ');
}

function validateRespondTo(
  ref: RespondToRef | null | undefined,
): RespondToRef | null {
  if (!ref) return null;
  if (ref.kind !== 'chat' && ref.kind !== 'task' && ref.kind !== 'objective') {
    throw new Error(`respond_to.kind must be 'chat' | 'task' | 'objective'`);
  }
  if (typeof ref.id !== 'string' || !ref.id) {
    throw new Error('respond_to.id is required');
  }
  if (
    ref.kind === 'objective' &&
    (typeof ref.objective_id !== 'string' || !ref.objective_id)
  ) {
    throw new Error(
      "respond_to.objective_id is required when kind === 'objective'",
    );
  }
  return {
    kind: ref.kind,
    id: ref.id,
    objective_id: ref.kind === 'objective' ? ref.objective_id : undefined,
  };
}

/**
 * Validate, sanitize where applicable, and persist an agent-supplied
 * notification payload. Returns the opaque id (used as the FCM ping ref).
 */
export async function storePayload(
  input: CreatePayloadInput,
): Promise<{ id: string; created: boolean }> {
  if (!input.summary || input.summary.length > SUMMARY_MAX) {
    throw new Error(`summary must be 1..${SUMMARY_MAX} chars`);
  }
  if (!input.content || input.content.length > CONTENT_MAX) {
    throw new Error(`content must be 1..${CONTENT_MAX} chars`);
  }

  if (input.kind === 'json_form') {
    validateFormSchemaShape(input.content);
  } else if (input.kind !== 'text') {
    throw new Error(`unknown payload kind: ${input.kind}`);
  }

  const respond_to = validateRespondTo(input.respond_to);
  if (
    input.action_url !== undefined &&
    input.action_url !== null &&
    (!input.action_url.startsWith('/') ||
      input.action_url.startsWith('//') ||
      input.action_url.includes('\\') ||
      /[\r\n]/.test(input.action_url))
  ) {
    throw new Error('action_url must be a safe internal application path');
  }

  return createNotificationPayload({
    user_id: input.user_id,
    kind: input.kind,
    summary: input.summary,
    content: input.content,
    action_url: input.action_url ?? null,
    respond_to,
    ttl_ms: input.ttl_ms,
    source_tool_use_id: input.source_tool_use_id,
  });
}
