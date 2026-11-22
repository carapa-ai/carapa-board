/** Prefilled chat prompts for post-meeting agent follow-ups. */

export type MeetingPromptKind = 'summarize' | 'action_items' | 'custom';

function artifactRef(
  relPath: string | null,
  filename: string | null,
  audioRelPaths: string[],
): string {
  const label = filename ? ` (${filename})` : '';
  const transcript = relPath
    ? `the meeting transcript at \`${relPath}\`${label}`
    : 'the meeting transcript I just recorded in this conversation';
  if (audioRelPaths.length === 0) return transcript;
  const recordings = audioRelPaths.map((path) => `\`${path}\``).join(', ');
  return `${transcript}, listen to the meeting ${audioRelPaths.length > 1 ? 'recordings' : 'recording'} at ${recordings} (the audio is the source; the transcript may contain errors)`;
}

export function buildMeetingPrompt(
  kind: MeetingPromptKind,
  artifactRelPath: string | null,
  artifactFilename: string | null,
  /** Saved recordings, passed only when the chat's model hears audio. */
  audioRelPaths: string[] = [],
): string {
  const ref = artifactRef(artifactRelPath, artifactFilename, audioRelPaths);

  switch (kind) {
    case 'summarize':
      return `Please read ${ref} and write a concise summary of the key points, decisions, and open questions.`;
    case 'action_items':
      return `Please read ${ref} and extract action items. List each with an owner and deadline when mentioned.`;
    case 'custom':
      return `Please read ${ref} and `;
  }
}
