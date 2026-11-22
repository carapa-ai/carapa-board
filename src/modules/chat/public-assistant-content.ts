/** Remove internal tool rendering from assistant content shown publicly. */
export function sanitizePublicAssistantContent(content: string): string {
  // Tool rendering uses quoted Markdown blocks. Public shares intentionally
  // omit those blocks, including command output and internal status callouts.
  // Remove the older generic tool form (header + JSON fence) first, then all
  // remaining quoted tool/result lines. Normal prose and fenced code authored
  // as part of the final answer remain intact.
  // Interactive AskUserQuestion calls render as an unquoted ```askuserquestion
  // JSON fence (src/lib/ask-user-question.ts); drop it as well.
  const withoutQuestions = content.replace(
    /(?:^|\n)```askuserquestion[^\n]*\n[\s\S]*?\n```[ \t]*(?=\n|$)/gi,
    '\n',
  );
  return withoutQuestions
    .replace(
      /(?:^|\n)> \*\*Using tool:[^\n]*\*\*\s*\n+```json[\s\S]*?```\s*/g,
      '\n',
    )
    .split('\n')
    .filter(
      (line) =>
        !/^\s*>/.test(line) &&
        !/^\s*<!--\s*carapa-tool:(?:request|result|error)(?:\s+tool-id="[^"]+")?\s*-->\s*$/i.test(
          line,
        ),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
