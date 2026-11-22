export interface AskUserQuestionItem {
  question?: string;
  header?: string;
  options?: Array<{ label?: string; description?: string }>;
  multiSelect?: boolean;
}

/** Coerce parsed askuserquestion JSON into a non-empty question array. */
export function normalizeAskUserQuestions(
  raw: unknown,
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
    return questions.length > 0 ? questions : null;
  }

  if (questions && typeof questions === 'object') {
    const obj = questions as Record<string, unknown>;
    if ('question' in obj || 'options' in obj || 'header' in obj) {
      return [obj as AskUserQuestionItem];
    }
  }

  return null;
}

const QUESTION_FENCE = '```askuserquestion';

/**
 * True when live chat output ends with a question card: the agent is waiting
 * for the user's answer. Scans from the end without copying the stream.
 */
export function endsWithOpenQuestion(content: string): boolean {
  let end = content.length;
  while (end > 0 && /\s/.test(content[end - 1])) end--;
  if (end < 3 || content.slice(end - 3, end) !== '```') return false;
  const open = content.lastIndexOf(QUESTION_FENCE, end - 4);
  // The card JSON is one line, so its closing fence is the first one that
  // starts a line; backticks inside previews never do.
  return (
    open >= 0 &&
    content.indexOf('\n```', open + QUESTION_FENCE.length) === end - 4
  );
}
