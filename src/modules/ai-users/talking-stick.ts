export type TalkingStickDecision =
  | { kind: 'pass' | 'skip' | 'stop' }
  | { kind: 'select'; aiUserId?: string; personaName?: string };

const TALKING_STICK_PREFIX = '<!-- talking-stick:';
const PERSONA_EMOTE_PREFIX = '<!-- persona-emote:';
const PERSONA_EXPRESSION_PREFIX = '<!-- persona-expression:';
const CONTROL_PREFIXES = [
  TALKING_STICK_PREFIX,
  PERSONA_EMOTE_PREFIX,
  PERSONA_EXPRESSION_PREFIX,
];
const TALKING_STICK_PATTERN =
  /\s*<!--\s*talking-stick:\s*(pass|skip|stop|ai:[a-zA-Z0-9_-]+|[^<>\r\n]{1,120}?)\s*-->\s*$/i;

export function parseTalkingStickDecision(content: string): {
  content: string;
  decision: TalkingStickDecision;
} {
  const marker = content.match(TALKING_STICK_PATTERN);
  if (!marker) return { content, decision: { kind: 'pass' } };
  const rawValue = marker[1].trim();
  const value = rawValue.toLowerCase();
  let decision: TalkingStickDecision;
  if (value === 'stop' || value === 'skip' || value === 'pass') {
    decision = { kind: value };
  } else if (value.startsWith('ai:')) {
    decision = { kind: 'select', aiUserId: value.slice(3) };
  } else {
    decision = { kind: 'select', personaName: rawValue };
  }
  return {
    content: content.slice(0, marker.index).trimEnd(),
    decision,
  };
}
/** Return whether the completed output ends with a valid talking-stick marker. */
export function hasTalkingStickMarker(content: string): boolean {
  return TALKING_STICK_PATTERN.test(content);
}

/** Remove coordinator-only control metadata from already-complete prose. */
export function stripTalkingStickControl(content: string): string {
  const marker = content.match(TALKING_STICK_PATTERN);
  return marker ? content.slice(0, marker.index).trimEnd() : content;
}

/** Remove persona avatar/emote selection metadata from visible prose. */
function stripPersonaEmoteControl(content: string): string {
  return content
    .replace(/\s*<!--\s*persona-emote:\s*[^>]+?\s*-->\s*/gi, '')
    .replace(/\s*<!--\s*persona-expression:\s*[^>]+?\s*-->\s*/gi, '');
}

export function stripAiUserControlMetadata(content: string): string {
  return stripTalkingStickControl(stripPersonaEmoteControl(content));
}

/**
 * Incrementally withhold talking-stick comments from the visible chat stream.
 * A short suffix is retained so a marker split across provider chunks never
 * flashes as literal HTML-comment text in the completed streaming bubble.
 */
export class TalkingStickStreamParser {
  private pending = '';

  push(chunk: string): string {
    let input = this.pending + chunk;
    this.pending = '';
    let visible = '';

    while (input) {
      const lowerInput = input.toLowerCase();
      const starts = CONTROL_PREFIXES.map((prefix) =>
        lowerInput.indexOf(prefix),
      ).filter((index) => index >= 0);
      const start = starts.length > 0 ? Math.min(...starts) : -1;
      if (start < 0) {
        let keepLength = 0;
        const maxSuffix = Math.min(
          input.length,
          Math.max(...CONTROL_PREFIXES.map((prefix) => prefix.length)) - 1,
        );
        for (let length = maxSuffix; length > 0; length--) {
          if (
            CONTROL_PREFIXES.some((prefix) =>
              prefix.startsWith(lowerInput.slice(-length)),
            )
          ) {
            keepLength = length;
            break;
          }
        }
        visible += input.slice(0, input.length - keepLength);
        this.pending = keepLength ? input.slice(-keepLength) : '';
        return visible;
      }

      visible += input.slice(0, start);
      const end = input.indexOf('-->', start + 4);
      if (end < 0) {
        this.pending = input.slice(start);
        return visible;
      }

      const candidate = input.slice(start, end + 3);
      if (
        /^<!--\s*talking-stick:\s*(?:pass|skip|stop|ai:[a-zA-Z0-9_-]+|[^<>\r\n]{1,120}?)\s*-->$/i.test(
          candidate,
        ) ||
        /^<!--\s*persona-(?:emote|expression):\s*[^>]+?\s*-->$/i.test(candidate)
      ) {
        input = input.slice(end + 3);
      } else {
        visible += candidate;
        input = input.slice(end + 3);
      }
    }

    return visible;
  }

  finish(): string {
    const pending = this.pending;
    this.pending = '';
    return /^<!--\s*(?:talking-stick|persona-emote|persona-expression):/i.test(
      pending,
    )
      ? ''
      : pending;
  }
}
