/** Remove assistant-routing metadata before any chat content reaches the DOM. */
export function stripChatControlMetadata(content: string): string {
  return content
    .replace(
      /(?:[\t ]*\n)?[\t ]*<!--\s*persona-(?:emote|expression):\s*[^>]+?\s*-->[\t ]*(?:\n)?/gi,
      '',
    )
    .replace(
      /(?:[\t ]*\n)?[\t ]*<!--\s*talking-stick:\s*(?:pass|skip|stop|ai:[a-zA-Z0-9_-]+|[^<>\r\n]{1,120}?)\s*-->[\t ]*(?:\n)?/gi,
      '',
    )
    .trimEnd();
}
