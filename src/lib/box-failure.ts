/** Maximum length of a CarapaBox failure reason surfaced in errors and logs. */
const MAX_BOX_FAILURE_LENGTH = 240;

/**
 * Reduce a CarapaBox failure payload to its first non-empty line, trimmed and
 * bounded, so logs and error messages carry the reason without leaking whole
 * multi-line output.
 */
export function summarizeBoxFailure(text: string | null | undefined): string {
  const firstLine =
    (text ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  return firstLine.slice(0, MAX_BOX_FAILURE_LENGTH);
}
