export interface AskUserQuestionItem {
  question?: string;
  header?: string;
  options?: Array<{ label?: string; description?: string; preview?: string }>;
  multiSelect?: boolean;
}

/** Coerce AskUserQuestion tool input into a non-empty question array. */
export function normalizeAskUserQuestions(
  raw: unknown,
  input?: Record<string, unknown>,
): AskUserQuestionItem[] | null {
  let questions: unknown = raw;

  if (typeof questions === 'string') {
    const trimmed = questions.trim();
    if (!trimmed) return null;
    try {
      questions = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  if (Array.isArray(questions)) {
    return questions.length > 0 ? (questions as AskUserQuestionItem[]) : null;
  }

  if (questions && typeof questions === 'object') {
    const obj = questions as Record<string, unknown>;
    if ('question' in obj || 'options' in obj || 'header' in obj) {
      return [obj as AskUserQuestionItem];
    }
  }

  // Legacy XML / flat parameter shape: { question, options?, header?, multiSelect? }
  if (input) {
    const single = input.question ?? input.prompt;
    if (single != null && String(single).trim()) {
      return [
        {
          question: String(single),
          header: input.header != null ? String(input.header) : undefined,
          options: Array.isArray(input.options)
            ? (input.options as AskUserQuestionItem['options'])
            : undefined,
          multiSelect:
            input.multiSelect === true || input.multi_select === true,
        },
      ];
    }
  }

  return null;
}

export function formatAskUserQuestionBlock(
  input: Record<string, unknown>,
): string | null {
  const questions = normalizeAskUserQuestions(input.questions, input);
  if (!questions?.length) return null;
  const payload = JSON.stringify({ questions });
  return `\n\n\`\`\`askuserquestion\n${payload}\n\`\`\`\n\n`;
}
