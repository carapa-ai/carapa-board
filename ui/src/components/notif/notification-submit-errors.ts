/**
 * Splits the server's rejection of a form answer into per-field messages and
 * one message about the whole submission. The route reports Ajv errors as
 * `details`: "/runners must be multiple of 5; /message must NOT have fewer
 * than 20 characters".
 */
export interface SubmitFailure {
  message: string;
  fieldErrors: Record<string, string>;
}

function sentence(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

export function parseSubmitFailure(
  base: string,
  details: string,
  fieldNames: readonly string[],
): SubmitFailure {
  const fieldErrors: Record<string, string> = {};
  const rest: string[] = [];
  for (const part of details.split(';')) {
    const text = part.trim();
    if (!text) continue;
    const m = /^\/([^\s/]+)\s+(.+)$/.exec(text);
    if (m && fieldNames.includes(m[1]) && !(m[1] in fieldErrors)) {
      fieldErrors[m[1]] = sentence(m[2]);
    } else {
      rest.push(text);
    }
  }
  if (Object.keys(fieldErrors).length === 0) {
    return { message: details ? `${base}: ${details}` : base, fieldErrors };
  }
  return {
    message: rest.length
      ? `${base}: ${rest.join('; ')}`
      : 'Some answers were not accepted. Fix the marked fields and send again.',
    fieldErrors,
  };
}
