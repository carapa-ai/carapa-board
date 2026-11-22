/**
 * Transcript source profiles: editable prompts under prompts/reflector-profiles/
 * that tell the tool reflector how to interpret one kind of transcript.
 */

export type TranscriptProfile =
  | 'direct-llm-conversation'
  | 'run-agent-conversation'
  | 'kanban-task';

export const TRANSCRIPT_PROFILE_FILES: Record<TranscriptProfile, string> = {
  'direct-llm-conversation': 'reflector-profiles/direct-llm-conversation.md',
  'run-agent-conversation': 'reflector-profiles/run-agent-conversation.md',
  'kanban-task': 'reflector-profiles/kanban-task.md',
};

export type TranscriptInputKind = 'transcript' | 'conversation' | 'message';
